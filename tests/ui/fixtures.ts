import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StudioState } from '../../src/lib/types';

interface RunConfig { origin: string; modelOrigin: string; dataDirectory?: string; adminAuth: string; viewerAuth: string; fixture: { longName: string; longSku: string; longPagePath: string; productCount: number; entryCount: number; mediaId: string; mediaName: string } }
if (!process.env.UI_TEST_RUN_CONFIG) throw new Error('UI测试只能由隔离包装器运行');
export const runtime = JSON.parse(readFileSync(process.env.UI_TEST_RUN_CONFIG, 'utf8')) as RunConfig;
const sessionClock = join(dirname(process.env.UI_TEST_RUN_CONFIG), 'ui-session-reads.json');
function recentSessionReads(now = Date.now()): number[] {
  const saved: unknown = existsSync(sessionClock) ? JSON.parse(readFileSync(sessionClock, 'utf8')) : [];
  if (!Array.isArray(saved) || saved.some(time => typeof time !== 'number' || !Number.isFinite(time))) throw new Error('隔离实例会话节流记录无效');
  const reads = saved as number[];
  // Better Auth 1.7.18以最后成功请求计静默期，不能按普通滑动窗口丢弃早先计数。
  return reads.length && reads[reads.length - 1] > now - 61_000 ? reads : [];
}
/** 正式限流保持；用例开始前留出完整静默期和密集导航余量，不隐藏429或重放请求。 */
async function paceSessionReads() {
  if (recentSessionReads().length < 40) return 0;
  // 从当前时刻等待，覆盖上一用例通过API客户端发出的少量会话读取；不改认证库状态。
  const delay = 61_001;
  await new Promise(resolve => setTimeout(resolve, delay));
  writeFileSync(sessionClock, '[]', { mode: 0o600 });
  return delay;
}
type ResponseFixture = { status: number; value: unknown; used: number };
type ExpectedConflict = ['PATCH', '/api/ai/design-guidance' | '/api/studio', 409] | ['POST', `/api/releases/${string}/activate`, 409];
export interface UiAudit {
  closeOwnedPage(): Promise<void>;
  allowWrite(method: 'PATCH' | 'POST' | 'DELETE', path: string): void;
  jsonGet(path: string, value: unknown): void;
  failOnce(method: 'PATCH' | 'POST', path: string, status: 503, message: string): void;
  expectHttpError(...request: ExpectedConflict): void;
  studio(fn: (state: StudioState) => void): void;
  writes: { method: string; path: string }[];
}

/** 每个用例独立上下文；只放行明确声明的同源写入，异常不能靠重试或忽略console掩盖。 */
export const test = base.extend<{ ui: UiAudit }>({
  ui: [async ({ context, page }, use, testInfo) => {
    const sessionCooldownMs = await paceSessionReads(); let sessionReads = 0;
    const allowed = new Set<string>(), fixtures = new Map<string, unknown>(), failures = new Map<string, ResponseFixture>();
    const errors: string[] = [], consoleErrors: { text: string; path: string }[] = [], failedRequests: string[] = [], detachedImageAborts: unknown[] = [], requestFailureDetails: unknown[] = [], outside: string[] = [], forbidden: string[] = [], writes: { method: string; path: string }[] = [];
    const expectedHttp = new Map<string, { path: string; responses: number }>();
    const knownImage = (path: string) => ['/images/chair.jpg', '/images/interior.jpg', `/api/media/${runtime.fixture.mediaId}`].includes(path);
    const finishedImages = new Map<string, { sequence: number; status: number; frameUrl: string; parentFrameUrl: string }>(), finishedChecks: Promise<void>[] = [];
    const editorImageAborts: { key: string; sequence: number; label: string; detail: Record<string, unknown> }[] = [], recoveredEditorImages: unknown[] = [], closedPageImageAborts: unknown[] = [];
    let networkSequence = 0, closingOwnedPage = false;
    let override: ((state: StudioState) => void) | undefined;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (url.origin !== runtime.origin) { outside.push(url.origin); return route.abort(); }
      if (request.method() === 'GET' && url.pathname === '/api/auth/get-session') {
        sessionReads++; writeFileSync(sessionClock, JSON.stringify([...recentSessionReads(), Date.now()]), { mode: 0o600 });
      }
      const key = `${request.method()} ${url.pathname}`;
      const failure = failures.get(key);
      if (failure && failure.used === 0) { failure.used++; return route.fulfill({ status: failure.status, json: failure.value }); }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        writes.push({ method: request.method(), path: url.pathname });
        if (!allowed.has(key)) { forbidden.push(key); return route.abort(); }
      }
      if (request.method() === 'GET' && fixtures.has(url.pathname)) return route.fulfill({ status: 200, json: fixtures.get(url.pathname) });
      if (request.method() === 'GET' && url.pathname === '/api/studio' && override) { const response = await route.fetch(); const value = await response.json(); override(value.state); return route.fulfill({ response, json: value }); }
      return route.continue();
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') { let path = ''; try { path = new URL(message.location().url).pathname; } catch {} consoleErrors.push({ text: message.text(), path }); } });
    // 只有事先明确声明且浏览器真实收到的一次409，才允许相应资源console；不模拟服务器或隐藏重复失败。
    page.on('response', response => { const request = response.request(), url = new URL(response.url()), key = `${request.method()} ${url.pathname} ${response.status()}`; if (url.origin === runtime.origin && expectedHttp.has(key)) expectedHttp.get(key)!.responses++; });
    page.on('requestfinished', request => {
      const url = new URL(request.url());
      if (request.method() !== 'GET' || request.resourceType() !== 'image' || url.origin !== runtime.origin || !knownImage(url.pathname)) return;
      let frameUrl = '', parentFrameUrl = '';
      try { frameUrl = request.frame().url(); parentFrameUrl = request.frame().parentFrame()?.url() || ''; } catch { return; }
      // 只能由同一受控Puck编辑上下文恢复，其他预览即使加载相同图片也不能替失败兜底。
      if (frameUrl !== 'about:srcdoc' || parentFrameUrl !== `${runtime.origin}/admin#editor`) return;
      const sequence = ++networkSequence;
      // requestfinished确认响应体传完；单有200响应头不能证明被取消的图片已经恢复。
      finishedChecks.push(request.response().then(response => { if (response?.ok() && sequence > (finishedImages.get(url.href)?.sequence || 0)) finishedImages.set(url.href, { sequence, status: response.status(), frameUrl, parentFrameUrl }); }));
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url()), reason = request.failure()?.errorText, label = `${request.method()} ${url.pathname}: ${reason}`;
      let detached = false, frameUrl = '', parentFrameUrl = '';
      try { detached = request.frame().isDetached(); frameUrl = request.frame().url(); parentFrameUrl = request.frame().parentFrame()?.url() || ''; } catch { detached = false; /* 无frame来源的失败不享受取消例外。 */ }
      // 切换候选或Puck目标会销毁旧iframe；只识别已销毁frame中受控图片的浏览器取消，活跃页面失败仍严格报错。
      const detail = { method: request.method(), path: url.pathname, reason, resourceType: request.resourceType(), detachedAtFailure: detached, frameUrl, parentFrameUrl };
      const controlledAbort = request.method() === 'GET' && request.resourceType() === 'image' && reason === 'net::ERR_ABORTED' && url.origin === runtime.origin && knownImage(url.pathname);
      if (controlledAbort && closingOwnedPage) closedPageImageAborts.push({ ...detail, explicitOwnedPageClose: true });
      else if (controlledAbort && detached) detachedImageAborts.push(detail);
      // Puck会重挂srcdoc中的组件而保留frame对象；活跃frame取消必须有之后同URL完整成功的真实请求作恢复证据。
      else if (controlledAbort && frameUrl === 'about:srcdoc' && parentFrameUrl === `${runtime.origin}/admin#editor`) editorImageAborts.push({ key: url.href, sequence: ++networkSequence, label, detail });
      else { failedRequests.push(label); requestFailureDetails.push(detail); }
    });
    await use({ closeOwnedPage: async () => { closingOwnedPage = true; await page.close(); }, allowWrite: (method, path) => allowed.add(`${method} ${path}`), jsonGet: (path, value) => fixtures.set(path, value), failOnce: (method, path, status, message) => failures.set(`${method} ${path}`, { status, value: { error: message }, used: 0 }), expectHttpError: (method, path, status) => { if (status !== 409 || !(method === 'PATCH' && ['/api/studio', '/api/ai/design-guidance'].includes(path) || method === 'POST' && /^\/api\/releases\/[\w-]+\/activate$/.test(path))) throw Error('Only explicit known conflict paths may be expected'); const key = `${method} ${path} ${status}`; if (expectedHttp.has(key)) throw Error('Expected HTTP error registered twice'); expectedHttp.set(key, { path, responses: 0 }); }, studio: fn => { override = fn; }, writes });
    await Promise.all(finishedChecks);
    for (const aborted of editorImageAborts) {
      const recovery = finishedImages.get(aborted.key);
      if (recovery && recovery.sequence > aborted.sequence) recoveredEditorImages.push({ ...aborted.detail, cancelledAtSequence: aborted.sequence, recovery, recoveredWithComplete2xx: true });
      else { failedRequests.push(aborted.label); requestFailureDetails.push({ ...aborted.detail, recoveredWithComplete2xx: false }); }
    }
    const expected503 = [...failures.values()].reduce((sum, value) => sum + value.used, 0);
    const expectedConsole = consoleErrors.filter(row => row.path === '/api/studio' && row.text === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)');
    const expectedHttpConsole = consoleErrors.filter(row => [...expectedHttp.values()].some(value => value.responses === 1 && row.path === value.path && row.text === 'Failed to load resource: the server responded with a status of 409 (Conflict)'));
    const unexpectedConsole = consoleErrors.filter(row => !expectedConsole.includes(row) && !expectedHttpConsole.includes(row));
    await testInfo.attach('browser-audit', { body: Buffer.from(JSON.stringify({ browserVersion: context.browser()?.version(), sessionReadPacing: { observedReads: sessionReads, cooldownMs: sessionCooldownMs }, getResponseFixturePaths: [...fixtures.keys()], studioGetOverrideUsed: !!override, pageErrors: errors, unexpectedConsole, expected503Console: expectedConsole.length, expectedHttpConsole: expectedHttpConsole.length, expectedHttpResponses: [...expectedHttp.values()], failedRequests, requestFailureDetails, expectedDetachedImageAborts: detachedImageAborts, recoveredEditorImages, expectedClosedPageImageAborts: closedPageImageAborts, blockedOrigins: outside, forbiddenWrites: forbidden, allowedWrites: writes }, null, 2)), contentType: 'application/json' });
    expect(errors, '不应出现页面异常').toEqual([]);
    expect(failedRequests, '不应出现网络请求失败').toEqual([]);
    expect(outside, '不得向测试实例之外请求').toEqual([]);
    expect(forbidden, '不得执行未声明的写操作').toEqual([]);
    expect(unexpectedConsole, '不应出现意外console错误').toEqual([]);
    expect(expectedConsole.length, '503资源提示必须只来自本用例显式失败夹具').toBeLessThanOrEqual(expected503);
    for (const value of expectedHttp.values()) expect(value.responses, '明确声明的409必须真实发生一次').toBe(1);
    expect(expectedHttpConsole.length, '409资源提示数量不能超过实际声明响应').toBeLessThanOrEqual(expectedHttp.size);
  // 独立fixture超时只容纳限流静默期，不放大实际测试或断言的超时。
  }, { auto: true, timeout: 90_000 }],
});
export { expect };

export async function go(page: Page, screen: string) {
  await page.goto(`/admin#${screen}`);
  await expect(page.locator('.shell-layout')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
export async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: value }).click();
}
export async function noOverflow(page: Page, locator?: Locator) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (locator) await expect.poll(() => locator.evaluate(element => element.scrollWidth <= element.clientWidth + 2)).toBe(true);
}
export async function hit(locator: Locator) {
  await expect.poll(() => locator.evaluate(element => { const r = element.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && (top === element || element.contains(top)); })).toBe(true);
}
export function textButton(scope: Page | Locator, name: string) { return scope.getByRole('button').filter({ hasText: new RegExp(`^${name}$`) }); }
export async function leave(page: Page, target: string, label: string) {
  const navigation = page.getByRole('dialog', { name: '工作空间', exact: true });
  if (await page.getByRole('button', { name: '打开主导航', exact: true }).isVisible()) {
    // “继续编辑”取消离开后，手机导航可能仍展开；再次导航直接使用当前抽屉。
    if (!(await navigation.isVisible())) await page.getByRole('button', { name: '打开主导航', exact: true }).click();
    await navigation.getByRole('menuitem').filter({ hasText: label }).click();
  } else await page.locator('aside.shell-sidebar').getByRole('menuitem').filter({ hasText: label }).click();
  if (!(await page.getByRole('dialog').filter({ hasText: '输入尚未提交' }).isVisible().catch(() => false))) await expect(page).toHaveURL(new RegExp(`#${target}$`));
}
