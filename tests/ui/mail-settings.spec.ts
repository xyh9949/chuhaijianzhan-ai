import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import type { MailSettingsSummary, MailSettingsTestResult } from '../../src/lib/mail-settings-types';

/** 设置验证只连接包装器临时实例；失败只报告状态，不回显私有请求头或口令。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  let response;
  try { response = await control.fetch(path, { method, ...(data === undefined ? {} : { data }) }); }
  catch { throw new Error(`Isolated mail ${method} request failed`); }
  expect(response.status(), `Isolated mail ${method} status`).toBe(200);
  return response.json();
}

test('邮件设置真实模拟测试、保存刷新、密码保护、手机排版和询盘入口', async ({ page, ui }, testInfo) => {
  test.setTimeout(100000); page.setDefaultTimeout(10000);
  expect(new URL(runtime.origin).port).not.toBe('3200');
  const control = await playwrightRequest.newContext({ baseURL: runtime.origin, storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  ui.allowWrite('PATCH', '/api/notifications/settings'); ui.allowWrite('POST', '/api/notifications/settings/test');
  let changed = false;
  try {
    const original = await api<MailSettingsSummary>(control, '/api/notifications/settings');
    // 包装器明确使用本地JSON transport，测试按钮真实经过API但绝不连接外部SMTP。
    expect(original.source).toBe('environment'); expect(original.mode).toBe('mock');
    await page.goto('/admin?settings=mail#settings');
    const panel = page.getByRole('tabpanel', { name: /邮件通知/ });
    await expect(panel).toBeVisible(); await expect(panel).toContainText('当前为本地模拟，不会发送真实邮件');
    await panel.getByLabel('测试收件邮箱', { exact: true }).fill('ui-mail-test@example.invalid');
    const tested = page.waitForResponse(response => new URL(response.url()).pathname === '/api/notifications/settings/test' && response.request().method() === 'POST');
    await textButton(panel, '发送测试邮件').click(); const testResponse = await tested; expect(testResponse.status()).toBe(200);
    const result = await testResponse.json() as MailSettingsTestResult; expect(result.status).toBe('mock_sent'); await expect(panel).toContainText(result.message);
    const enabled = panel.getByRole('switch', { name: '启用询盘邮件通知', exact: true });
    if (await enabled.getAttribute('aria-checked') === 'true') await enabled.click();
    await expect(enabled).toHaveAttribute('aria-checked', 'false');
    await panel.getByLabel('发件邮箱', { exact: true }).fill('ui-mail-sender@example.invalid');
    await panel.getByLabel('SMTP服务器', { exact: true }).fill('smtp.example.invalid');
    await panel.getByLabel('邮件登录账号', { exact: true }).fill('ui-mail-sender@example.invalid');
    await panel.getByLabel('邮箱密码或授权码', { exact: true }).fill('ui-mail-synthetic-secret-only');
    await panel.getByLabel('接收询盘的邮箱', { exact: true }).fill('ui-mail-recipient@example.invalid');
    await expect(textButton(panel, '发送测试邮件')).toBeDisabled();
    await textButton(panel, '保存邮件设置').click(); await expect(panel).toContainText('邮件设置已保存，立即生效。未发送测试邮件。'); changed = true;
    const saved = await api<MailSettingsSummary>(control, '/api/notifications/settings');
    expect(saved.source).toBe('database'); expect(saved.enabled).toBe(false); expect(saved.hasPassword).toBe(true); expect(saved.configured).toBe(true);
    expect(JSON.stringify(saved)).not.toMatch(/ui-mail-synthetic-secret-only|secret_cipher|password/);
    expect(ui.writes.filter(item => item.path === '/api/notifications/settings/test')).toHaveLength(1);
    await page.reload(); await expect(panel.getByLabel('SMTP服务器', { exact: true })).toHaveValue('smtp.example.invalid');
    await expect(panel.getByLabel('邮箱密码或授权码', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('邮箱密码或授权码', { exact: true })).toHaveAttribute('placeholder', '已保存 · 留空保持');
    await panel.getByLabel('发件邮箱', { exact: true }).fill('ui-mail-renamed@example.invalid');
    await textButton(panel, '保存邮件设置').click(); await expect(panel).toContainText('邮件设置已保存，立即生效。未发送测试邮件。');
    expect((await api<MailSettingsSummary>(control, '/api/notifications/settings')).hasPassword).toBe(true);
    const beforeAbandon = await api<MailSettingsSummary>(control, '/api/notifications/settings');
    await panel.getByLabel('邮箱密码或授权码', { exact: true }).fill('ui-mail-unsubmitted-memory-only');
    expect(await page.evaluate(() => Object.values(sessionStorage).join('\n') + Object.values(localStorage).join('\n'))).not.toContain('ui-mail-unsubmitted-memory-only');
    await page.getByRole('tab').filter({ hasText: '网站资料' }).click();
    const guard = page.getByRole('dialog', { name: '放弃尚未保存的邮件设置？', exact: true });
    await textButton(guard, '继续编辑').click(); await expect(panel.getByLabel('邮箱密码或授权码', { exact: true })).toHaveValue('ui-mail-unsubmitted-memory-only');
    await page.getByRole('tab').filter({ hasText: '网站资料' }).click(); await textButton(guard, '放弃修改并离开').click();
    await page.getByRole('tab').filter({ hasText: '邮件通知' }).click();
    await expect(panel.getByLabel('邮箱密码或授权码', { exact: true })).toHaveValue('');
    expect((await api<MailSettingsSummary>(control, '/api/notifications/settings')).revision).toBe(beforeAbandon.revision);
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 844 }); await noOverflow(page, panel);
      await testInfo.attach(`mail-settings-mobile-${width}`, { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole('tab').filter({ hasText: '询盘与通知' }).click(); await textButton(page, '配置邮件通知').click();
    await expect(panel).toBeVisible(); await expect(panel.getByLabel('SMTP服务器', { exact: true })).toHaveValue('smtp.example.invalid');
    expect(ui.writes.filter(item => item.path === '/api/notifications/settings/test')).toHaveLength(1);
  } finally {
    await ui.closeOwnedPage();
    if (changed) {
      const current = await api<MailSettingsSummary>(control, '/api/notifications/settings');
      await api(control, '/api/notifications/settings', 'PATCH', { expectedRevision: current.revision, enabled: false, host: '', port: 587, security: 'starttls', username: '', from: '', to: [], clearPassword: true, allowLocal: false });
    }
    await control.dispose();
  }
});

test.describe('只读邮件设置', () => {
  test.use({ storageState: runtime.viewerAuth });
  test('只读成员直达邮件入口仍返回工作台，不读取邮件配置或执行发送', async ({ page, ui }) => {
    const mailRequests: string[] = []; page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/notifications/settings')) mailRequests.push(request.method()); });
    await page.goto('/admin?settings=mail#settings');
    // 首屏路由已把非管理员拦回工作台，不能要求根本未挂载的设置组件显示提示。
    await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: /邮件通知/ })).toHaveCount(0);
    await expect(page.getByLabel('邮箱密码或授权码', { exact: true })).toHaveCount(0);
    await expect(textButton(page, '发送测试邮件')).toHaveCount(0); expect(mailRequests).toEqual([]); expect(ui.writes).toEqual([]);
  });
});
