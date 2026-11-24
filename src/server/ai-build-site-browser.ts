import type { BrowserContext, Frame, Page } from 'playwright-core';
import type { AiBuildCheckEditorTarget, AiBuildCheckIssueCode, AiBuildCheckJourney, AiBuildCheckLocation, AiBuildCheckPage, AiBuildMobileMeasurement } from '../lib/ai-build-site-check-types';
import { safePreviewNavigation } from '../lib/site-code-render';
import { ApiError } from './http';
import { settleVisibleImages, VISUAL_VIEWPORTS, withVisualBrowser } from './ai-visual-browser';

interface BuildBrowserNode { renderedId: string; blockId?: string; sourceId?: string; }
export interface BuildBrowserTarget {
  pageId: string;
  title: string;
  path?: string;
  dynamic: boolean;
  entry?: AiBuildCheckJourney['entry'];
  skipReason?: string;
  editableNode?: (node: BuildBrowserNode) => AiBuildCheckEditorTarget | undefined;
}

interface ProbeIssue { code: AiBuildCheckIssueCode; reference?: BuildBrowserNode; }
interface ReadLink { index: number; href: string; label: string; action: boolean; menu: boolean; reference?: BuildBrowserNode; }
type InquiryForm = { fields: number; unlabelled: number; available: boolean; reference?: BuildBrowserNode };
interface PageProbe { links: ReadLink[]; primary?: { link?: ReadLink; reference?: BuildBrowserNode }; form?: InquiryForm; disabledActions: (BuildBrowserNode | undefined)[]; limited: boolean; }

const VIEW_WIDTHS = [390, 375] as const, ROUTE_STEPS = 3, LINK_LIMIT = 120;
const anchors = '.editor-site a[href]';
const mobileMenu = 'details.site-menu-mobile > summary';
const demoForms = '.editor-site form.site-contact-form[data-form-demo="true"]';
const messages: Record<AiBuildCheckIssueCode, string> = {
  overflow: '页面发生横向溢出，可检查宽度、内边距和布局。',
  'heading-count': '页面应有且只有一个可见的一级标题。',
  'split-heading': '一级标题有英文单词被拆行。',
  'small-button': '按钮触控区域小于 44 × 44 px。',
  'broken-image': '首屏图片未能加载，请核对素材。',
  'pending-image': '首屏图片仍在加载，可以重新检查。',
  'disabled-button': '正文按钮不可用，请核对链接目标。',
  'unvisited-link': '按钮指向本次未检查的站内页面，可单独打开核对。',
  form: '询盘表单缺少可用按钮、字段或字段标签。',
};

/** 定位只返回真实 DOM 节点；编辑归属再与当前版本的原生树核对。 */
function locationFor(target: BuildBrowserTarget, prefix: string, reference?: BuildBrowserNode, viewportWidth = VISUAL_VIEWPORTS.mobile.width): AiBuildCheckLocation | undefined {
  if (!target.path || !reference?.renderedId || reference.renderedId.length > 512 || /[\u0000-\u001f<>]/.test(reference.renderedId)) return undefined;
  const editor = target.editableNode?.(reference);
  return { pageId: target.pageId, path: target.path, previewPath: `${prefix}${target.path === '/' ? '' : target.path}`, nodeId: reference.renderedId, viewportWidth, ...(editor ? { target: editor } : {}) };
}

async function readFrame(page: Page) {
  const iframe = page.locator('iframe[title="网站草稿隔离预览"]');
  await iframe.waitFor({ state: 'visible', timeout: 6000 });
  const frame = await (await iframe.elementHandle())?.contentFrame();
  if (!frame) throw new Error('Preview frame unavailable');
  await frame.waitForSelector('.editor-site main', { timeout: 5000 });
  return frame;
}

async function measureMobile(frame: Frame): Promise<{ metrics: AiBuildMobileMeasurement; issues: ProbeIssue[] }> {
  await settleVisibleImages(frame);
  return frame.evaluate(() => {
    const headings = [...document.querySelectorAll('.editor-site main h1')].filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    const issues: { code: AiBuildCheckIssueCode; element?: Element }[] = [];
    const range = document.createRange();
    let splitWords = 0;
    // 只统计同一个文本节点内完整的拉丁单词，避免把自然的中日韩换行当成拆词。
    for (const title of headings.slice(0, 8)) {
      const text = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
      let scanned = 0, node = text.nextNode();
      const previous = splitWords;
      while (node && scanned < 60) {
        for (const word of (node.textContent || '').matchAll(/[A-Za-z]{6,}/g)) {
          if (scanned++ >= 60) break;
          range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
          if (new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size > 1) splitWords++;
        }
        node = text.nextNode();
      }
      if (splitWords > previous) issues.push({ code: 'split-heading', element: title });
    }
    if (!headings.length) issues.push({ code: 'heading-count' });
    if (headings.length > 1) issues.push(...headings.slice(1, 7).map(element => ({ code: 'heading-count' as const, element })));
    const overflow = Math.max(0, Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth));
    if (overflow > 2) {
      // 只指向实际越出视口的元素；无可信几何原因时保留为页面问题。
      const outside = [...document.querySelectorAll('.editor-site [data-site-node-id]')].flatMap(element => {
        const rect = element.getBoundingClientRect(), excess = Math.max(-rect.left, rect.right - innerWidth);
        return rect.width > 0 && rect.height > 0 && excess > 2 && getComputedStyle(element).visibility !== 'hidden' ? [{ element, excess }] : [];
      }).sort((first, second) => second.excess - first.excess);
      issues.push({ code: 'overflow', element: outside[0]?.element });
    }
    const small = [...document.querySelectorAll('.editor-site main a.editor-site-action[href]')].slice(0, 120).filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.height < 43.5 || rect.width < 43.5) && getComputedStyle(element).visibility !== 'hidden';
    });
    issues.push(...small.slice(0, 6).map(element => ({ code: 'small-button' as const, element })));
    const images = [...document.images].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && getComputedStyle(element).visibility !== 'hidden';
    });
    const broken = images.filter(image => image.complete && !!image.getAttribute('src') && !image.naturalWidth), pending = images.filter(image => !image.complete);
    issues.push(...broken.slice(0, 6).map(element => ({ code: 'broken-image' as const, element })), ...pending.slice(0, 6).map(element => ({ code: 'pending-image' as const, element })));
    return {
      metrics: { width: innerWidth, overflow, headings: headings.length, splitWords, smallActions: small.length, brokenImages: broken.length, pendingImages: pending.length },
      issues: issues.map(({ code, element }) => {
        const node = element?.closest<HTMLElement>('[data-site-node-id]');
        return { code, ...(node?.dataset.siteNodeId ? { reference: { renderedId: node.dataset.siteNodeId, sourceId: node.dataset.siteSourceNodeId, blockId: node.closest<HTMLElement>('[data-shared-block-content]')?.dataset.sharedBlockId } } : {}) };
      }),
    };
  });
}

/** 只遍历已打开的页面DOM；表单仅核对原生预览字段与按钮，无填写、提交或外发动作。 */
async function readPage(frame: Frame, anchorId?: string, openMenu = true): Promise<PageProbe> {
  const toggle = frame.locator(mobileMenu).first();
  // details 的 open 是布尔属性；空字符串也表示已打开，避免再次关闭面板。
  if (openMenu && await toggle.isVisible() && await toggle.locator('..').getAttribute('open') === null) await toggle.click({ timeout: 2000 }).catch(() => {});
  return frame.evaluate(({ anchors, limit, anchorId, demoForms }) => {
    const all = document.querySelectorAll<HTMLAnchorElement>(anchors), candidates = [...all].slice(0, limit);
    const disabled = [...document.querySelectorAll('.editor-site main button.editor-site-action:disabled,.editor-site main .editor-site-action[aria-disabled=true],.editor-site main a.editor-site-action:not([href])')].slice(0, limit).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    const target = anchorId && document.getElementById(anchorId);
    const form = [...document.querySelectorAll<HTMLFormElement>(demoForms)].find(element => {
      if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false;
      // 有明确锚点就只承认目标区块内或已经进入视口的表单，不能把不相关的页尾表单算作到达。
      const rect = element.getBoundingClientRect();
      return !anchorId || !!target && (target.contains(element) || element.contains(target) || rect.bottom > 0 && rect.top < innerHeight);
    });
    const primary = [...document.querySelectorAll('.editor-site main .editor-site-action')].find(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('footer,header,[data-shared-block$="-footer"],.site-managed-navigation'));
    const references = new Map([...candidates, ...disabled, ...(form ? [form] : []), ...(primary ? [primary] : [])].map(element => {
      const node = element.closest<HTMLElement>('[data-site-node-id]');
      return [element, node?.dataset.siteNodeId ? { renderedId: node.dataset.siteNodeId, sourceId: node.dataset.siteSourceNodeId, blockId: node.closest<HTMLElement>('[data-shared-block-content]')?.dataset.sharedBlockId } : undefined] as const;
    }));
    // 将浏览器可见性检查留在内联回调，开发态转译不会引入浏览器中不存在的函数命名助手。
    const links = candidates.flatMap((element, index) => {
      const href = element.getAttribute('href') || '';
      if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden' || !href || href.length > 700 || element.getAttribute('aria-disabled') === 'true') return [];
      const action = element.matches('main a.editor-site-action')
        && !element.closest('footer,header,[data-shared-block$="-footer"],.site-managed-navigation');
      return [{ index, href, label: (element.textContent || '').trim().slice(0, 90), action, menu: !!element.closest('details.site-menu-mobile'), reference: references.get(element) }];
    });
    const fields = form ? [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:not([type=hidden]):not(:disabled),textarea:not(:disabled),select:not(:disabled)')].filter(element => !element.closest('.site-form-honeypot') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden') : [];
    const submit = form ? [...form.querySelectorAll('button[type=submit]:not(:disabled),input[type=submit]:not(:disabled)')].some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && element.getAttribute('aria-disabled') !== 'true') : false;
    return {
      links, ...(primary ? { primary: { link: links.find(link => candidates[link.index] === primary), reference: references.get(primary) } } : {}),
      ...(form ? { form: { fields: fields.length, unlabelled: fields.filter(field => !field.labels?.length && !field.getAttribute('aria-label') && !field.getAttribute('aria-labelledby')).length, available: !!fields.length && submit, reference: references.get(form) } } : {}),
      disabledActions: disabled.slice(0, 6).map(element => references.get(element)),
      limited: all.length > limit,
    };
  }, { anchors, limit: LINK_LIMIT, anchorId, demoForms });
}

function targetOf(href: string, current: URL, prefix: string) {
  try {
    const url = new URL(href, current);
    if (url.origin !== current.origin || !safePreviewNavigation(url.pathname + url.search + url.hash, current.origin, prefix)) return undefined;
    const hash = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
    if (hash && (hash.length > 512 || /[\u0000-\u0020\u007f<>]/.test(hash))) return undefined;
    return { url, path: url.pathname === prefix ? '/' : url.pathname.slice(prefix.length), anchor: hash, sameDocument: url.pathname === current.pathname && url.search === current.search };
  } catch { return undefined; }
}

/** 到达主按钮目标后，按已检查页面寻找后续路径；带查询的实际页面会重新读取，而不借旧探针判通过。 */
function nextInquiryLink(current: URL, currentProbe: PageProbe, probes: Map<string, PageProbe>, visited: Set<string>, prefix: string, remaining: number): ReadLink | undefined {
  const queue = [{ url: current, probe: currentProbe, depth: 0, first: undefined as ReadLink | undefined }], seen = new Set(visited);
  for (const { url, probe, depth, first } of queue) {
    const rank = (link: ReadLink) => link.action ? 0 : link.menu ? 2 : 1;
    for (const link of [...probe.links].sort((a, b) => rank(a) - rank(b))) {
      const next = targetOf(link.href, url, prefix), probe = next && probes.get(next.path);
      if (!next || !probe || seen.has(next.url.href) || next.sameDocument && !next.anchor) continue;
      if (probe.form?.available || next.sameDocument && next.anchor && currentProbe.form?.available) return first || link;
      seen.add(next.url.href);
      if (depth + 1 < remaining && !next.anchor) queue.push({ url: next.url, probe, depth: depth + 1, first: first || link });
    }
  }
}

async function visit(context: BrowserContext, page: Page, url: string) {
  if (page.context() !== context) throw new Error('Preview scope changed');
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 9000 });
  if (!response?.ok() || page.url() !== url) throw new Error('Candidate route not available');
  return readFrame(page);
}

async function confirmJourney(context: BrowserContext, origin: string, prefix: string, target: BuildBrowserTarget, pathTargets: Map<string, BuildBrowserTarget>, probes: Map<string, PageProbe>, permitQuery: (url: URL) => void, signal?: AbortSignal): Promise<AiBuildCheckJourney> {
  const start = target.path, entry = target.entry!;
  const probe = start ? probes.get(start) : undefined;
  if (!start || !probe) return { entry, status: 'skipped', steps: [], note: '入口没有可用的已检查样本。' };
  const first = probe.primary?.link;
  if (!first && !probe.primary && probe.form?.available) return { entry, status: 'form-only', steps: [], form: { path: start, fields: probe.form.fields, unlabelled: probe.form.unlabelled }, note: '入口页有原生询盘表单，本次没有可点击的主要按钮可验证。', location: locationFor(target, prefix, probe.form.reference) };
  if (!first) return { entry, status: probe.limited && !!probe.primary ? 'skipped' : 'warning', steps: [], note: probe.primary ? '主要按钮不可用或未在链接抽查范围内，请在手机预览核对。' : '入口页没有可用的主要按钮或询盘表单。', location: locationFor(target, prefix, probe.primary?.reference || probe.form?.reference) };
  const steps: AiBuildCheckJourney['steps'] = [];
  const page = await context.newPage();
  let current = new URL(`${origin}${prefix}${start === '/' ? '' : start}`), path = start, link: ReadLink | undefined = first;
  let message = '入口页未能重新加载，未执行主按钮验证。', inspectedStart = false;
  const visited = new Set([current.href]);
  const location = () => locationFor(pathTargets.get(path) || target, prefix, link?.reference);
  try {
    await page.setViewportSize(VISUAL_VIEWPORTS.mobile);
    let frame = await visit(context, page, current.href);
    inspectedStart = true;
    for (let index = 0; link && index < ROUTE_STEPS; index++) {
      if (signal?.aborted) throw new Error('Cancelled');
      const destination = targetOf(link.href, current, prefix);
      if (!destination || !probes.has(destination.path)) return { entry, status: 'skipped', steps, note: '主要按钮的目标是外链或不在本次可检查的页面范围，请单独核对。', location: location() };
      message = '实际点击没有走完整条询盘路径，请核对这个按钮。';
      if (destination.sameDocument && !destination.anchor) return { entry, status: 'warning', steps, note: '主要按钮只回到当前页，未指定表单或新的页面。', location: location() };
      const locator = frame.locator(anchors).nth(link.index);
      if (link.menu && !await locator.isVisible()) await frame.locator(mobileMenu).first().click({ timeout: 2000 });
      if (await locator.getAttribute('href', { timeout: 2000 }) !== link.href) throw new Error('Button changed');
      if (destination.sameDocument) await locator.click({ timeout: 3500 });
      else {
        permitQuery(destination.url);
        const [response] = await Promise.all([
          page.waitForResponse(res => res.url() === destination.url.origin + destination.url.pathname + destination.url.search && res.request().isNavigationRequest(), { timeout: 6000 }),
          page.waitForURL(destination.url.href, { waitUntil: 'domcontentloaded', timeout: 6000 }),
          locator.click({ timeout: 3500 }),
        ]);
        if (!response.ok()) throw new Error('Button target did not load');
        frame = await readFrame(page);
      }
      steps.push({ from: path, to: destination.path, label: link.label || '站内链接' });
      if (destination.anchor) {
        message = '实际点击后没有到达指定锚点，请核对按钮和目标区块。';
        await frame.waitForFunction(id => {
          const element = document.getElementById(id), rect = element?.getBoundingClientRect();
          return !!rect && rect.height > 0 && rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight && getComputedStyle(element!).visibility !== 'hidden';
        }, destination.anchor, { timeout: 3000 });
      }
      if (page.url() !== (destination.sameDocument ? current.href : destination.url.href)) throw new Error('Button opened an unexpected page');
      const actual = await readPage(frame, destination.anchor, !destination.anchor);
      const form = actual.form;
      if (form?.available) return { entry, status: form.unlabelled ? 'warning' : 'checked', steps, form: { path: destination.path, fields: form.fields, unlabelled: form.unlabelled }, note: form.unlabelled ? '已走到询盘表单，部分字段缺少关联标签。' : '已在手机预览中实际点击至原生询盘表单。', ...(form.unlabelled ? { location: locationFor(pathTargets.get(destination.path) || target, prefix, form.reference) } : {}) };
      if (destination.anchor) return { entry, status: 'warning', steps, note: '已到达指定锚点，但该位置未找到可用的询盘表单。', location: location() };
      const next = nextInquiryLink(destination.url, actual, probes, visited, prefix, ROUTE_STEPS - index - 1);
      if (!next) return { entry, status: 'skipped', steps, note: '已实际验证按钮目标，在本次页面与步数范围内未能继续确认询盘表单。', location: location() };
      current = destination.url; path = destination.path; link = next; visited.add(current.href);
    }
    return { entry, status: 'skipped', steps, note: '本次点击步数内未找到可用的询盘表单。', location: location() };
  } catch {
    return { entry, status: inspectedStart ? 'warning' : 'skipped', steps, note: message, location: location() };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function inspectAiBuildSite(targets: BuildBrowserTarget[], prefix: string, cookie: string, signal?: AbortSignal) {
  const pages: AiBuildCheckPage[] = targets.map(({ pageId, title, path, dynamic, skipReason }) => ({
    pageId, title, path, dynamic, status: 'skipped', mobile: [], issues: [],
    ...(path ? { previewPath: `${prefix}${path === '/' ? '' : path}` } : {}),
    notes: path ? [] : [skipReason || '当前动态页面缺少可访问样本。'],
  }));
  const paths = pages.flatMap(page => page.previewPath ? [page.previewPath] : []);
  if (!paths.length) return { pages, journeys: [] as AiBuildCheckJourney[], coverage: ['没有可打开的页面或详情样本。'] };
  return withVisualBrowser(paths, cookie, signal, async ({ context, origin, blocked, permitQuery }) => {
    const probes = new Map<string, PageProbe>();
    const pathTargets = new Map(targets.flatMap(target => target.path ? [[target.path, target] as const] : []));
    for (const [index, target] of targets.entries()) {
      if (signal?.aborted) throw new ApiError(499, '整站检查已取消');
      const row = pages[index], { path, previewPath } = row;
      if (!path || !previewPath) continue;
      // 两种宽度命中同一问题时合并，但保留确切的节点和发生宽度。
      const addIssue = ({ code, reference }: ProbeIssue, width: number) => {
        const location = locationFor(target, prefix, reference, width);
        const existing = row.issues.find(issue => issue.code === code && issue.location?.nodeId === location?.nodeId);
        if (existing) { if (!existing.widths.includes(width)) existing.widths.push(width); }
        else row.issues.push({ code, message: messages[code], widths: [width], ...(location ? { location } : {}) });
      };
      const page = await context.newPage();
      try {
        await page.setViewportSize(VISUAL_VIEWPORTS.mobile);
        const frame = await visit(context, page, `${origin}${previewPath}`);
        for (const width of VIEW_WIDTHS) {
          await page.setViewportSize({ ...VISUAL_VIEWPORTS.mobile, width });
          const { metrics, issues } = await measureMobile(frame);
          if (metrics.width !== width) throw Error('Mobile viewport not settled');
          row.mobile.push(metrics);
          for (const issue of issues) addIssue(issue, width);
        }
        await page.setViewportSize(VISUAL_VIEWPORTS.mobile);
        const probe = await readPage(frame); probes.set(path, probe);
        const width = VISUAL_VIEWPORTS.mobile.width;
        for (const reference of probe.disabledActions) addIssue({ code: 'disabled-button', reference }, width);
        const unresolved = probe.links.filter(link => {
          const to = targetOf(link.href, new URL(`${origin}${previewPath}`), prefix);
          return link.action && to && !pathTargets.has(to.path);
        });
        for (const link of unresolved.slice(0, 6)) addIssue({ code: 'unvisited-link', reference: link.reference }, width);
        if (probe.form && (!probe.form.available || probe.form.unlabelled)) addIssue({ code: 'form', reference: probe.form.reference }, width);
        if (probe.limited) row.notes.push(`只分析前${LINK_LIMIT}个链接，其余链接未检查。`);
        row.status = row.notes.length || row.issues.length ? 'warning' : 'checked';
      } catch {
        row.notes.push('实际预览未能加载完成，请在预览中重新打开本页。');
        // 保留已取得的部分尺寸，但两个断点或链接探测没有做完时不计作完成。
      } finally {
        await page.close().catch(() => {});
      }
    }
    const journeys: AiBuildCheckJourney[] = [];
    for (const target of targets.filter(target => target.entry)) {
      if (signal?.aborted) throw new ApiError(499, '整站检查已取消');
      journeys.push(await confirmJourney(context, origin, prefix, target, pathTargets, probes, permitQuery, signal));
    }
    if (signal?.aborted) throw new ApiError(499, '整站检查已取消');
    return { pages, journeys, coverage: [
      '每页检查375px与390px手机宽度，图片检查范围为首屏。动态详情每类抽查一条真实记录。',
      '同一种问题最多列出同一宽度的 6 个位置。没有确定区块的问题按整页报告。',
      `询盘路径从正文第一个可见的按钮开始，最多实际点击${ROUTE_STEPS}次，只读取表单字段和提交按钮。`,
      ...blocked,
    ] };
  });
}
