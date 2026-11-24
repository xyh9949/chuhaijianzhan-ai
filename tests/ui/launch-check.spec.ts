import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import type { LaunchCheckReport } from '../../src/lib/launch-check-types';
import type { StudioState } from '../../src/lib/types';

/** 只访问包装器的随机实例；不回显认证头，也不触发DNS、SMTP、模型或搜索接口。 */
async function api<T>(control: APIRequestContext, path: string): Promise<T> {
  let response;
  try { response = await control.get(path); } catch { throw new Error('Isolated launch check read failed'); }
  expect(response.status(), 'Isolated launch check read status').toBe(200); return response.json();
}
type Envelope = { revision: number; activeReleaseId: string | null; state: StudioState };

test('上线检查真实本机证据、工作台和第五步入口、修复定位及手机阅读', async ({ page, ui }, testInfo) => {
  test.setTimeout(100000); page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ baseURL: runtime.origin, storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  ui.allowWrite('POST', '/api/launch-check/check');
  try {
    const before = await api<Envelope>(control, '/api/studio');
    await page.goto('/admin'); await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
    await textButton(page, '上线检查').click();
    const panel = page.getByRole('tabpanel', { name: /上线检查/ });
    await expect(panel).toBeVisible(); await expect(textButton(panel, '检查本站资料')).toBeEnabled();
    await expect(panel).toContainText('没有执行或缺少证据的项目会继续显示待验证');
    await expect(panel).toContainText('当前为JSON模拟模式，不会给真实邮箱投递');
    expect(ui.writes).toEqual([]);
    const initialReport = await api<LaunchCheckReport>(control, '/api/launch-check');
    expect(initialReport.items.find(item => item.id === 'mail-config')?.status).toBe('unverified');
    expect(initialReport.items.filter(item => item.id.startsWith('public-')).filter(item => item.status === 'passed')).toEqual([]);
    const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/launch-check/check' && response.request().method() === 'POST');
    await textButton(panel, '检查本站资料').click(); const response = await checked; expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ expectedRevision: before.revision, expectedReleaseId: before.activeReleaseId, checks: ['local'] });
    const report = await response.json() as LaunchCheckReport;
    expect(report.lastCheck?.checks).toEqual(['local']); expect(report.lastCheck?.id).toBeTruthy();
    await expect(panel).toContainText('最近主动检查：'); await expect(textButton(panel, '检查本站资料')).toBeEnabled();
    const after = await api<Envelope>(control, '/api/studio');
    expect(after.revision).toBe(before.revision); expect(after.activeReleaseId).toBe(before.activeReleaseId); expect(after.state).toEqual(before.state);
    await testInfo.attach('launch-check-desktop', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 844 }); await noOverflow(page, panel);
      await testInfo.attach(`launch-check-mobile-${width}`, { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    const mailItem = panel.getByRole('listitem').filter({ hasText: '邮件服务资料' });
    await textButton(mailItem, '配置邮件通知').click(); await expect(page.getByRole('tabpanel', { name: /邮件通知/ })).toBeVisible();
    await page.goto('/admin#site-journey'); await expect(page.getByRole('heading', { name: '建站流程', exact: true })).toBeVisible();
    await page.getByText('检查并发布', { exact: true }).click();
    const inline = page.getByRole('region', { name: '上线检查', exact: true });
    await expect(inline).toBeVisible(); await expect(textButton(inline, '检查本站资料')).toBeEnabled();
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/launch-check/check' }]);
  } finally { await ui.closeOwnedPage(); await control.dispose(); }
});

test.describe('只读上线检查', () => {
  test.use({ storageState: runtime.viewerAuth });
  test('只读成员直达检查仍返回工作台，不读取管理员证据或执行检查', async ({ page, ui }) => {
    const requests: string[] = []; page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/launch-check')) requests.push(request.method()); });
    await page.goto('/admin?settings=launch#settings');
    await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: /上线检查/ })).toHaveCount(0); await expect(textButton(page, '检查本站资料')).toHaveCount(0);
    expect(requests).toEqual([]); expect(ui.writes).toEqual([]);
  });
});

test('检查回执到期只GET重读，旧回执不触发零延时循环，重获可见性再次核对', async ({ page, ui }) => {
  page.setDefaultTimeout(10000); ui.allowWrite('POST', '/api/launch-check/check');
  // 官方Clock约定在导航前安装，页面期限及Ant动画必须从创建起就共用同一套timer。
  await page.clock.install({ time: new Date() });
  await page.goto('/admin?settings=launch#settings');
  const panel = page.getByRole('tabpanel', { name: /上线检查/ }); await expect(textButton(panel, '检查本站资料')).toBeEnabled();
  const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/launch-check/check' && response.request().method() === 'POST');
  await textButton(panel, '检查本站资料').click(); const report = await (await checked).json() as LaunchCheckReport;
  expect(report.lastCheck?.expiresAt).toBeTruthy(); await expect(textButton(panel, '检查本站资料')).toBeEnabled();
  let reads = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/launch-check' && request.method() === 'GET') reads++; });
  // 只推进浏览器时间，服务端保持真实时间：相同旧回执会再次返回，可实际验证去重而非用假接口伪造通过。
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/launch-check' && response.request().method() === 'GET');
  await page.clock.fastForward(Date.parse(report.lastCheck!.expiresAt) - Date.parse(report.generatedAt) + 100);
  expect((await refreshed).status()).toBe(200); await expect(textButton(panel, '检查本站资料')).toBeEnabled();
  await expect(panel).toContainText('部分检查依据已到期，需要重新核对');
  await page.clock.fastForward(1000); expect(reads).toBe(1);
  const resumed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/launch-check' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); expect((await resumed).status()).toBe(200);
  await expect(textButton(panel, '检查本站资料')).toBeEnabled(); await page.clock.fastForward(1000); expect(reads).toBe(2);
  expect(ui.writes).toEqual([{ method: 'POST', path: '/api/launch-check/check' }]);
});
