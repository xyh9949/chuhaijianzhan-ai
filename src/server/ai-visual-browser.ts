import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, request as browserRequest, type APIRequestContext, type Browser, type BrowserContext, type Frame, type Locator } from 'playwright-core';
import type { AiVisualCaptureMode, AiVisualDevice, AiVisualInteractionState, AiVisualObservation, AiVisualPageCoverage, AiVisualSection, AiVisualStatus } from '../lib/ai-visual-types';
import { getAuthEnvironment } from './env';
import { getAiProviderSummary } from './ai-provider';
import { ApiError } from './http';
import { getDataDirectory } from './database';

export const VISUAL_VIEWPORTS: Record<AiVisualDevice, { width: number; height: number }> = {
  desktop: { width: 1280, height: 900 }, tablet: { width: 768, height: 1024 }, mobile: { width: 390, height: 844 },
};
export interface VisualNode { id: string; tag: string; x: number; y: number; width: number; height: number; }
export interface VisualCaptureOptions { mode: AiVisualCaptureMode; startSection: number; maxSections: number; inspectInteractions: boolean; }
export interface CapturedVisualImage { id: string; device: AiVisualDevice; bytes: Buffer; width: number; height: number; nodes: VisualNode[]; warnings: string[]; coverage: 'viewport' | 'page-segment' | 'interaction'; section?: AiVisualSection; state?: AiVisualInteractionState; }
export interface VisualCaptureResult { images: CapturedVisualImage[]; pageCoverage: AiVisualPageCoverage[]; observations: AiVisualObservation[]; warnings: string[]; }
const DEFAULT_OPTIONS: VisualCaptureOptions = { mode: 'viewport', startSection: 1, maxSections: 4, inspectInteractions: false };
const IMAGE_LIMIT = 1024 * 1024, GROUP_BINARY_LIMIT = 8 * 1024 * 1024;

/** 重叠分段保留上下文；计划只按真实测得高度生成，不能凭页数猜测全页已覆盖。 */
export function planVisualSections(pageHeight: number, viewportHeight: number, startSection = 1, maxSections = 4) {
  if (![pageHeight, viewportHeight, startSection, maxSections].every(Number.isSafeInteger) || pageHeight < 1 || viewportHeight < 100 || pageHeight > 100_000 || viewportHeight > 1400 || startSection < 1 || startSection > 200 || maxSections < 1 || maxSections > 6) throw new ApiError(422, '页段范围无效');
  const step = Math.max(1, Math.floor(viewportHeight * .85)), lastOffset = Math.max(0, pageHeight - viewportHeight), totalSections = Math.ceil(lastOffset / step) + 1;
  const sections = Array.from({ length: Math.max(0, Math.min(maxSections, totalSections - startSection + 1)) }, (_, i) => { const number = startSection + i, from = Math.min(lastOffset, (number - 1) * step); return { number, from, to: Math.min(pageHeight, from + viewportHeight), pageHeight }; });
  return { sections, totalSections, step };
}
function browserChoice() {
  if (process.env.FORM_STUDIO_VISUAL_DISABLED === '1') return undefined;
  const requested = process.env.FORM_STUDIO_VISUAL_BROWSER_CHANNEL, channels = requested ? [requested] : ['chromium', 'chrome', 'msedge'];
  if (channels.some(channel => !['chromium', 'chrome', 'msedge'].includes(channel))) return undefined;
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((v): v is string => !!v);
  for (const channel of channels) {
    if (channel === 'chromium') { if (existsSync(chromium.executablePath())) return { channel }; continue; }
    if (process.platform === 'win32') {
      const relative = channel === 'chrome' ? 'Google/Chrome/Application/chrome.exe' : 'Microsoft/Edge/Application/msedge.exe';
      if (roots.some(root => existsSync(join(root, relative)))) return { channel };
    } else if (existsSync(channel === 'chrome' ? '/opt/google/chrome/chrome' : '/opt/microsoft/msedge/msedge')) return { channel };
  }
  return undefined;
}
/** 查看状态不启动浏览器、不下载依赖、不调用模型。 */
export function aiVisualStatus(): AiVisualStatus {
  const provider = getAiProviderSummary(), available = !!browserChoice();
  return { available, ...(available ? {} : { reason: '当前服务器尚未启用截图浏览器，可继续手工预览；部署人员可按视觉检查指南安装或启用浏览器。' }), providerReady: provider.enabled && !!provider.baseUrl && !!provider.model, ...(provider.visionModel || provider.model ? { visionModel: provider.visionModel || provider.model } : {}) };
}
export function visualOrigin() {
  const base = new URL(getAuthEnvironment().baseURL), raw = process.env.FORM_STUDIO_VISUAL_ORIGIN;
  if (!raw) return base.origin;
  let url: URL; try { url = new URL(raw); } catch { throw new ApiError(422, '截图内部地址配置无效'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new ApiError(422, '截图地址只可使用本站来源或本机内部服务');
  return url.origin;
}
/** 浏览器只准读固定候选与本站静态／媒体资源；本地交互也不会扩大网络权限。 */
export function visualRequestAllowed(url: string, method: string, origin: string, previewPaths: string | ReadonlySet<string>, permittedQueries?: ReadonlySet<string>) {
  if (method !== 'GET') return false;
  if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank' || url === 'about:srcdoc') return true;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin || parsed.username || parsed.password) return false;
    if ((typeof previewPaths === 'string' ? parsed.pathname === previewPaths : previewPaths.has(parsed.pathname)) && (!parsed.search || permittedQueries?.has(parsed.pathname + parsed.search))) return true;
    return /^\/_next\/static\//.test(parsed.pathname) || /^\/(images|fonts)\/[a-zA-Z0-9_./-]+$/.test(parsed.pathname) || /^\/api\/media\/[a-zA-Z0-9_-]+(?:\/variant)?$/.test(parsed.pathname);
  } catch { return false; }
}
function abortError(signal?: AbortSignal) { if (signal?.aborted) throw new ApiError(499, '截图已取消，网站保持原样'); }

const state = globalThis as typeof globalThis & { formStudioVisualBusy?: Set<string> };

/** 本机整站检查与已有截图共用单实例并发位，避免同时开启多组浏览器。 */
export function reserveVisualBrowser() {
  const key = getDataDirectory(), busy = state.formStudioVisualBusy ??= new Set();
  if (busy.has(key)) throw new ApiError(429, '当前已有页面检查或截图任务，请等待完成');
  busy.add(key);
  return () => { busy.delete(key); };
}

/** 所有候选路径由服务端冻结数据提供。访问静态资源和同一份候选的只读请求走同一个隔离通道。 */
export async function withVisualBrowser<T>(paths: readonly string[], cookie: string, signal: AbortSignal | undefined, task: (scope: { context: BrowserContext; origin: string; blocked: Set<string>; permitQuery: (url: URL) => void }) => Promise<T>): Promise<T> {
  const choice = browserChoice();
  if (!choice) throw new ApiError(422, '服务器截图浏览器不可用，请先按部署指南启用；仍可使用原真实预览');
  const origin = visualOrigin(), allowedPaths = new Set(paths);
  if (!allowedPaths.size || allowedPaths.size > 12 || paths.some(path => !path.startsWith('/preview/~') || path.includes('?') || path.includes('#'))) throw new ApiError(422, '页面检查只接受本站已有候选');
  if (!cookie || /[\r\n]/.test(cookie)) throw new ApiError(401, '请使用本人已登录的后台检查页面');
  abortError(signal);
  let browser: Browser | undefined, context: BrowserContext | undefined, transport: APIRequestContext | undefined;
  const cancel = () => { void browser?.close().catch(() => {}); void transport?.dispose().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    try { browser = await chromium.launch({ ...(choice.channel === 'chromium' ? {} : { channel: choice.channel }), headless: true, timeout: 15_000 }); }
    catch { throw new ApiError(422, '截图浏览器未能启动，请检查浏览器安装及运行权限；网站和原预览不受影响'); }
    abortError(signal);
    context = await browser.newContext({ viewport: VISUAL_VIEWPORTS.desktop, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce' });
    transport = await browserRequest.newContext({ timeout: 20_000 });
    const blocked = new Set<string>();
    const permittedQueries = new Set<string>();
    // 仅供询盘路径的真实点击：临时允许候选名单里的精确查询串，截图流程仍不开放任意查询。
    const permitQuery = (url: URL) => {
      if (url.origin !== origin || !allowedPaths.has(url.pathname) || !url.search || url.search.length > 700 || permittedQueries.size >= 12) return;
      permittedQueries.add(url.pathname + url.search);
    };
    await context.routeWebSocket('**/*', socket => { void socket.close(); });
    await context.route('**/*', async route => {
      const request = route.request();
      if (visualRequestAllowed(request.url(), request.method(), origin, allowedPaths, permittedQueries)) {
        if (!request.url().startsWith(`${origin}/`)) return route.continue();
        // 独立本站GET传输禁跳转和重试，响应不写入页面Cookie仓。
        try {
          const response = await transport!.get(request.url(), { headers: { ...request.headers(), cookie }, maxRedirects: 0, maxRetries: 0 });
          try { const headers = response.headers(); delete headers['set-cookie']; await route.fulfill({ response, headers }); }
          finally { await response.dispose(); }
        } catch { blocked.add('部分本站预览资源读取失败。'); await route.abort().catch(() => {}); }
        return;
      }
      blocked.add('部分外部或非预览资源未纳入检查。');
      await route.abort();
    });
    return await task({ context, origin, blocked, permitQuery });
  } finally {
    signal?.removeEventListener('abort', cancel);
    await context?.close().catch(() => {});
    await transport?.dispose().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function pageMetrics(frame: Frame) {
  return frame.evaluate(() => ({ height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, innerHeight)), viewport: innerHeight, top: Math.round(scrollY) }));
}
export async function settleVisibleImages(frame: Frame) {
  await frame.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise<void>(done => setTimeout(done, 1500))]);
    const visible = [...document.images].filter(image => { const r = image.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }).slice(0, 80);
    await Promise.all(visible.map(image => image.complete ? Promise.resolve() : new Promise<void>(done => { const timer = setTimeout(done, 1500); image.addEventListener('load', () => { clearTimeout(timer); done(); }, { once: true }); image.addEventListener('error', () => { clearTimeout(timer); done(); }, { once: true }); })));
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
}
export async function imageState(frame: Frame) {
  return frame.evaluate(() => {
    // 浏览器回调只用内联函数，避免TS执行器为局部具名函数注入浏览器不存在的__name辅助器。
    const images = [...document.images].filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && getComputedStyle(element).visibility !== 'hidden'; });
    return { broken: images.filter(i => i.complete && !!i.getAttribute('src') && !i.naturalWidth).length, pending: images.filter(i => !i.complete).length,
      nodes: [...document.querySelectorAll('[data-site-node-id]')].filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && getComputedStyle(element).visibility !== 'hidden'; }).slice(0, 80).map(element => { const r = element.getBoundingClientRect(); return { id: element.getAttribute('data-site-node-id')!, tag: element.tagName, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; }) };
  });
}

/** 表单、链接只读检查；不读取输入值、不填表、不访问链接目标或触发提交。 */
async function inspectReadOnly(frame: Frame, device: AiVisualDevice): Promise<AiVisualObservation[]> {
  const rows = await frame.evaluate(() => {
    const rows: { kind: 'form' | 'anchor' | 'navigation'; status: 'checked' | 'warning' | 'skipped'; title: string; detail: string; nodeId?: string }[] = [];
    const forms = [...document.querySelectorAll('form.site-contact-form')];
    for (const form of forms.slice(0, 10)) {
      const fields = [...form.querySelectorAll('input:not([type=hidden]),textarea,select')].filter(el => !el.closest('.site-form-honeypot')) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
      const unlabeled = fields.filter(el => !el.labels?.length && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).length;
      const required = fields.filter(el => el.required || el.getAttribute('aria-required') === 'true').length, nodeId = form.closest('[data-site-node-id]')?.getAttribute('data-site-node-id')?.slice(0, 100);
      rows.push({ kind: 'form', status: unlabeled ? 'warning' : 'checked', title: '表单标注与必填项', detail: `只读检查${fields.length}个字段，其中${required}个声明必填，${unlabeled}个缺少关联标签。未填写、校验或提交，不能据此证明询盘送达。`, ...(nodeId ? { nodeId } : {}) });
    }
    if (forms.length > 10) rows.push({ kind: 'form', status: 'skipped', title: '表单检查数量已达上限', detail: `本次仅检查前10个原生表单，其余${forms.length - 10}个未检查。` });
    const links = [...document.querySelectorAll('a[href]')].slice(0, 120), anchors = links.filter(a => a.getAttribute('href')?.startsWith('#'));
    let missing = 0; for (const a of anchors) { const id = a.getAttribute('href')!.slice(1); if (id && !document.getElementById(id)) missing++; }
    if (anchors.length) rows.push({ kind: 'anchor', status: missing ? 'warning' : 'checked', title: '同页按钮与锚点目标', detail: `只读核对${anchors.length}个同页目标，${missing}个未找到；未访问新页面，未触发表单。` });
    const navigation = document.querySelectorAll('.site-managed-navigation a[href]').length;
    if (navigation) rows.push({ kind: 'navigation', status: 'skipped', title: '导航页面目标需另外查看', detail: `本页含${navigation}个导航链接。本次只检查菜单展开与同页目标，不访问其他页面或外链，不把目标格式正确当成页面可用。` });
    if (document.querySelectorAll('a[href]').length > 120) rows.push({ kind: 'anchor', status: 'skipped', title: '链接检查数量已达上限', detail: '只核对前120个链接中的同页锚点；其余未检查。' });
    return rows;
  });
  return rows.map((row, i) => ({ ...row, id: `${device}-read-${i + 1}`, device }));
}

type StatePicture = (state: AiVisualInteractionState) => Promise<string | undefined>;
/** 固定选择器仅操作平台原生控件；不执行用户提供的JS、任意选择器或提交／跳转按钮。 */
async function inspectNativeStates(frame: Frame, device: AiVisualDevice, picture: StatePicture, signal?: AbortSignal): Promise<AiVisualObservation[]> {
  const rows: AiVisualObservation[] = []; let sequence = 0;
  const add = (kind: AiVisualInteractionState['kind'], status: AiVisualObservation['status'], title: string, detail: string, nodeId?: string, imageId?: string) => rows.push({ id: `${device}-state-${++sequence}`, device, kind, status, title, detail, ...(nodeId ? { nodeId } : {}), ...(imageId ? { imageId } : {}) });
  const idOf = async (locator: Locator) => locator.evaluate(el => el.closest('[data-site-node-id]')?.getAttribute('data-site-node-id') || undefined);
  for (const [kind, selector, name] of [['menu', '.site-managed-navigation details', '导航菜单'], ['accordion', '.site-accordion details', '折叠内容']] as const) {
    const all = frame.locator(selector), visible = frame.locator(`${selector}:visible`), count = await all.count(), visibleCount = await visible.count(); let inspected = 0, pictureTaken = false;
    for (let i = 0; i < Math.min(visibleCount, 6); i++) {
      abortError(signal); const detail = visible.nth(i), summary = detail.locator(':scope > summary').first();
      if (!await summary.isVisible()) continue;
      const before = await detail.evaluate(el => (el as HTMLDetailsElement).open), nodeId = await idOf(detail); let changed = false;
      try {
        await summary.scrollIntoViewIfNeeded({ timeout: 3000 });
        if (!before) { await summary.click({ timeout: 3000 }); changed = true; }
        const open = await detail.evaluate(el => (el as HTMLDetailsElement).open), visible = await detail.evaluate(el => { const content = [...el.children].filter(el => el.tagName !== 'SUMMARY'); return content.some(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); });
        const label = (await summary.innerText()).trim().slice(0, 120) || name;
        const imageId = open && visible && !pictureTaken ? await picture({ kind, label }) : undefined; if (imageId) pictureTaken = true;
        add(kind, open && visible ? 'checked' : 'warning', `${name}展开`, open && visible ? '已在真实浏览器展开并看到内容，随后恢复原状态；没有点击跳转或提交。' : '原生控件未显示预期内容，请人工核对。', nodeId, imageId); inspected++;
      } catch { add(kind, 'warning', `${name}未完成检查`, '原生控件不可操作或超出本次可见区域，未将其标为通过。', nodeId); }
      finally { if (changed) await summary.click({ timeout: 2000 }).catch(() => {}); }
    }
    if (count > inspected) add(kind, 'skipped', `${name}部分覆盖`, `${count}个控件中实际检查${inspected}个；隐藏控件或超过6个的部分未检查。`);
  }
  const groups = frame.locator('.site-tabs'), groupCount = await groups.count(); let tabPicture = false;
  for (let i = 0; i < Math.min(groupCount, 3); i++) {
    abortError(signal); const group = groups.nth(i), inputs = group.locator(':scope > .site-tab > input[type="radio"]'), labels = group.locator(':scope > .site-tab > label'), count = await inputs.count(), nodeId = await idOf(group);
    if (!count) continue;
    let original = 0; for (let n = 0; n < count; n++) if (await inputs.nth(n).isChecked()) original = n;
    let inspected = 0;
    try {
      for (let n = 0; n < Math.min(count, 4); n++) {
        if (n === original || !await labels.nth(n).isVisible()) continue;
        await labels.nth(n).scrollIntoViewIfNeeded({ timeout: 3000 }); await labels.nth(n).click({ timeout: 3000 });
        const visible = await inputs.nth(n).isChecked() && await group.locator(':scope > .site-tab').nth(n).locator('section').first().isVisible();
        const label = (await labels.nth(n).innerText()).trim().slice(0, 120) || '标签页';
        const imageId = visible && !tabPicture ? await picture({ kind: 'tabs', label }) : undefined; if (imageId) tabPicture = true;
        add('tabs', visible ? 'checked' : 'warning', '标签页切换', visible ? '实际点击原生标签，单选状态与内容显示一致；已恢复原标签。' : '标签状态与可见内容不一致，请人工核对。', nodeId, imageId); inspected++;
      }
    } catch { add('tabs', 'warning', '标签页未完成检查', '当前标签无法在本次视口正常操作；未标为通过。', nodeId); }
    finally { if (await labels.nth(original).isVisible()) await labels.nth(original).click({ timeout: 2000 }).catch(() => {}); }
    if (count > 4) add('tabs', 'skipped', '标签页部分覆盖', `本组${count}个标签，仅检查前4个中的非默认标签，其余未检查。`, nodeId);
    if (!inspected && count === 1) add('tabs', 'skipped', '标签页只有一项', '没有可切换的第二项，未假定交互已经检查。', nodeId);
  }
  if (groupCount > 3) add('tabs', 'skipped', '标签组数量超过本次范围', `实际检查前3组，其余${groupCount - 3}组未检查。`);
  const tracks = frame.locator('.site-carousel-track'), trackCount = await tracks.count(); let carouselPicture = false;
  for (let i = 0; i < Math.min(trackCount, 3); i++) {
    abortError(signal); const track = tracks.nth(i), figures = track.locator(':scope > figure'), count = await figures.count(), nodeId = await idOf(track);
    if (count < 2 || !await track.isVisible()) { add('carousel', 'skipped', '轮播未切换', '当前轮播不可见或不足两项，未声称已检查其他项。', nodeId); continue; }
    const original = await track.evaluate(el => el.scrollLeft);
    try {
      const next = figures.first().locator('a[aria-label="Next slide"]').first(), target = await next.getAttribute('href');
      const valid = await track.evaluate((el, href) => typeof href === 'string' && href.startsWith('#') && [...el.children].some(child => child.id === href.slice(1)), target);
      if (!valid) { add('carousel', 'warning', '轮播目标无效', '原生下一项未指向本轮播的真实片段，没有点击。', nodeId); continue; }
      await next.scrollIntoViewIfNeeded({ timeout: 3000 }); await next.click({ timeout: 3000 });
      await frame.waitForFunction(({ selectorIndex, before }) => { const el = document.querySelectorAll('.site-carousel-track')[selectorIndex]; return !!el && el.scrollLeft > before + 10; }, { selectorIndex: i, before: original }, { timeout: 1500 }).catch(() => {});
      const moved = await track.evaluate((el, before) => el.scrollLeft > before + 10, original);
      const imageId = moved && !carouselPicture ? await picture({ kind: 'carousel', label: '原生轮播第二项' }) : undefined; if (imageId) carouselPicture = true;
      add('carousel', moved ? 'checked' : 'warning', '轮播下一项', moved ? '实际点击原生下一项，横向位置已变化；恢复原位置。只检查到第二项。' : '点击后未观察到预期滚动，请人工核对。', nodeId, imageId);
    } catch { add('carousel', 'warning', '轮播未完成检查', '原生下一项当前不可操作；未标为通过。', nodeId); }
    finally { await track.evaluate((el, left) => el.scrollTo({ left, behavior: 'instant' }), original).catch(() => {}); }
  }
  if (trackCount > 3) add('carousel', 'skipped', '轮播数量超过本次范围', `实际检查前3个轮播，其余${trackCount - 3}个未检查。`);
  const anchors = frame.locator('a.editor-site-action[href^="#"]'), anchorCount = await anchors.count();
  for (let i = 0; i < Math.min(anchorCount, 6); i++) {
    abortError(signal); const button = anchors.nth(i), nodeId = await idOf(button), originalTop = (await pageMetrics(frame)).top;
    try {
      const target = await button.getAttribute('href'), exists = await frame.evaluate(href => typeof href === 'string' && href.startsWith('#') && !!document.getElementById(href.slice(1)), target);
      if (!exists || !await button.isVisible()) { rows.push({ id: `${device}-anchor-${i}`, device, kind: 'anchor', status: 'warning', title: '同页按钮未完成检查', detail: '按钮隐藏或目标不存在，没有点击或访问其他地址。', ...(nodeId ? { nodeId } : {}) }); continue; }
      await button.scrollIntoViewIfNeeded({ timeout: 3000 }); await button.click({ timeout: 3000 });
      await frame.waitForFunction(href => { if (typeof href !== 'string') return false; const el = document.getElementById(href.slice(1)), r = el?.getBoundingClientRect(); return !!r && r.bottom > 0 && r.top < innerHeight; }, target, { timeout: 1500 }).catch(() => {});
      const visible = await frame.evaluate(href => { if (typeof href !== 'string') return false; const r = document.getElementById(href.slice(1))?.getBoundingClientRect(); return !!r && r.bottom > 0 && r.top < innerHeight; }, target);
      rows.push({ id: `${device}-anchor-${i}`, device, kind: 'anchor', status: visible ? 'checked' : 'warning', title: '同页按钮实际点击', detail: visible ? '已点击平台原生锚点按钮，并观察到目标进入可见范围；随后恢复位置。' : '点击后目标没有进入可见范围，请人工核对。', ...(nodeId ? { nodeId } : {}) });
    } catch { rows.push({ id: `${device}-anchor-${i}`, device, kind: 'anchor', status: 'warning', title: '同页按钮未完成检查', detail: '原生按钮当前无法安全操作，未标为通过。', ...(nodeId ? { nodeId } : {}) }); }
    finally { await frame.evaluate(y => scrollTo({ top: y, behavior: 'instant' }), originalTop).catch(() => {}); }
  }
  if (anchorCount > 6) rows.push({ id: `${device}-anchor-limit`, device, kind: 'anchor', status: 'skipped', title: '同页按钮部分覆盖', detail: `仅尝试前6个原生锚点按钮，其余${anchorCount - 6}个未检查。` });
  return rows.slice(0, 60);
}

export async function captureVisualScreens(previewPath: string, devices: AiVisualDevice[], cookie: string, signal?: AbortSignal, supplied: Partial<VisualCaptureOptions> = {}): Promise<VisualCaptureResult> {
  const options = { ...DEFAULT_OPTIONS, ...supplied };
  let phase = '准备浏览器';
  try {
    return await withVisualBrowser([previewPath], cookie, signal, async ({ context, origin, blocked }) => {
    const result: VisualCaptureResult = { images: [], pageCoverage: [], observations: [], warnings: [] }; let totalBytes = 0, budgetReached = false;
    for (const device of devices) {
      const viewport = VISUAL_VIEWPORTS[device];
      if (budgetReached) { result.pageCoverage.push({ device, mode: options.mode, viewportHeight: viewport.height, pageHeight: 0, startSection: options.startSection, endSection: options.startSection - 1, totalSections: 0, complete: false, intervals: [], nextStartSection: options.startSection, reason: '本组图片预算已满，此设备尚未截图。' }); continue; }
      abortError(signal); const page = await context.newPage();
      try {
        phase = '设置设备'; await page.setViewportSize(viewport);
        phase = '读取候选'; const response = await page.goto(`${origin}${previewPath}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        if (!response?.ok()) throw new ApiError(response?.status() === 404 ? 404 : 422, '本人候选暂时无法渲染，请重新打开真实预览后再截图');
        phase = '准备隔离预览'; const iframe = page.locator('iframe[title="网站草稿隔离预览"]'); await iframe.waitFor({ state: 'visible', timeout: 15_000 }); const element = await iframe.elementHandle(), frame = await element?.contentFrame();
        if (!frame) throw new ApiError(422, '真实预览尚未就绪，没有保存空白截图');
        phase = '等待页面正文'; await frame.waitForSelector('body > div', { timeout: 12_000 }); phase = '等待页面图片'; await settleVisibleImages(frame);
        const intervals: { from: number; to: number }[] = []; let lastSection = options.startSection - 1, reason: string | undefined, stateNumber = 0;
        const take = async (id: string, coverage: CapturedVisualImage['coverage'], section?: AiVisualSection, state?: AiVisualInteractionState) => {
          abortError(signal); phase = '等待当前区域图片'; await settleVisibleImages(frame); phase = '测量当前区域'; const measured = await imageState(frame), box = await iframe.boundingBox();
          if (!box || box.width < 200 || box.height < 100) throw new ApiError(422, '预览可见区域太小，没有保存无效截图');
          phase = '保存真实截图'; let bytes = await iframe.screenshot({ type: 'jpeg', quality: 78, animations: 'disabled', timeout: 10_000 });
          if (bytes.length > IMAGE_LIMIT) bytes = await iframe.screenshot({ type: 'jpeg', quality: 55, animations: 'disabled', timeout: 10_000 });
          if (bytes.length > IMAGE_LIMIT || totalBytes + bytes.length > GROUP_BINARY_LIMIT) { budgetReached = true; reason = '本组截图已达大小预算，保留已完成的真实页段；请减少设备或从下一段继续。'; return undefined; }
          const warnings = [...blocked]; if (measured.broken || measured.pending) warnings.push(`当前区域${measured.broken}张图片未正常显示、${measured.pending}张未完成；不能将缺图当成设计结论。`);
          if (state) warnings.push('此图是原生交互后的局部状态；定位后请在预览打开相同状态，不能据此声称所有交互已检查。');
          result.images.push({ id, device, bytes, width: Math.round(box.width), height: Math.round(box.height), nodes: measured.nodes, warnings, coverage, ...(section ? { section } : {}), ...(state ? { state } : {}) }); totalBytes += bytes.length; return id;
        };
        const start = options.mode === 'viewport' ? 1 : options.startSection, count = options.mode === 'viewport' ? 1 : options.maxSections;
        for (let n = start; n < start + count; n++) {
          phase = '计算页面高度'; const metrics = await pageMetrics(frame); if (metrics.height > 100_000) { reason = '页面超过100000像素，本次不冒称完整检查；请拆成较短页面或人工核对。'; break; }
          const plan = planVisualSections(metrics.height, metrics.viewport, n, 1), section = plan.sections[0]; if (!section) { if (!intervals.length) reason = '当前设备没有所选起始页段，请从第1段重新检查。'; break; }
          phase = '滚动页面'; await frame.evaluate(y => scrollTo({ top: y, behavior: 'instant' }), section.from); await settleVisibleImages(frame);
          phase = '读取滚动位置'; const actual = await pageMetrics(frame), realSection = { number: n, from: actual.top, to: Math.min(actual.height, actual.top + actual.viewport), pageHeight: actual.height };
          if (!await take(options.mode === 'viewport' ? device : `${device}-section-${n}`, options.mode === 'viewport' ? 'viewport' : 'page-segment', options.mode === 'page' ? realSection : undefined)) break;
          intervals.push({ from: realSection.from, to: realSection.to }); lastSection = n;
          if (realSection.to >= actual.height) break;
        }
        const final = await pageMetrics(frame), plan = final.height <= 100_000 ? planVisualSections(final.height, final.viewport, 1, 1) : { totalSections: Math.ceil(final.height / final.viewport) };
        const scrollScan = await frame.evaluate(() => { const elements = [...document.querySelectorAll('.editor-site,.editor-site *')]; return { limited: elements.length > 2000, count: elements.slice(0, 2000).filter(el => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 100 && /^(auto|scroll)$/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 4; }).length }; });
        const finalTo = intervals.at(-1)?.to || 0, complete = options.mode === 'page' && start === 1 && intervals.length > 0 && finalTo >= final.height && !scrollScan.count && !scrollScan.limited;
        if (scrollScan.count || scrollScan.limited) {
          reason = scrollScan.count ? `${scrollScan.count}个独立纵向滚动区域未逐一遍历，本组文档分段不能冒称覆盖其中全部内容。` : '独立滚动区域探测仅覆盖前2000个元素，不能据此声称整页内容均已检查。';
          result.observations.push({ id: `${device}-nested-scrolls`, device, kind: 'coverage', status: 'skipped', title: '独立滚动区域需另行查看', detail: reason });
        }
        if (!complete && !reason) reason = options.mode === 'viewport' ? '只检查首屏，下方内容尚未截图。' : start > 1 && finalTo >= final.height ? '仅检查中后段，前面的页段未包含在本组。' : '已到本次页段上限，下方内容未检查；可从下一段继续。';
        result.pageCoverage.push({ device, mode: options.mode, viewportHeight: final.viewport, pageHeight: final.height, startSection: start, endSection: lastSection, totalSections: plan.totalSections, complete, intervals, ...(finalTo < final.height && lastSection >= start ? { nextStartSection: lastSection + 1 } : {}), ...(reason ? { reason } : {}) });
        if (options.inspectInteractions && !budgetReached) {
          phase = '只读检查标注'; result.observations.push(...await inspectReadOnly(frame, device));
          phase = '观察原生交互'; result.observations.push(...await inspectNativeStates(frame, device, state => stateNumber >= 4 ? Promise.resolve(undefined) : take(`${device}-state-${++stateNumber}`, 'interaction', undefined, state), signal));
        } else if (options.inspectInteractions) result.observations.push({ id: `${device}-interaction-budget`, device, kind: 'coverage', status: 'skipped', title: '本设备交互检查未执行', detail: '本组图片预算已满，没有把未执行的交互标成通过。' });
      } finally { await page.close().catch(() => {}); }
    }
    if (!result.images.length) throw new ApiError(422, '所选范围没有生成可用截图，请从第1段或较少设备重新检查');
    if (budgetReached) result.warnings.push('本组达到图片预算，只有已经列出的真实截图可检查；尚未覆盖的设备／页段不算完成。');
    result.warnings.push('分段覆盖只描述截图范围；外部资源、业务事实、未列出的交互与实际提交结果仍需人工核对。');
    return result;
    });
  } catch (error) { if (signal?.aborted) throw new ApiError(499, '截图已取消，网站保持原样'); if (error instanceof ApiError) throw error; throw new ApiError(422, `截图未完成（${phase}${error instanceof ReferenceError ? '：浏览器上下文不兼容' : ''}），请核对真实预览和浏览器运行环境；网站保持原样`); }
}
