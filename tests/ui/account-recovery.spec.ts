import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { test, expect, runtime, noOverflow, textButton } from './fixtures';

// 找回流程含一次性令牌，即使其他回归显式开启trace，此组也不录制原始网络与表单。
test.use({ trace: 'off' });

async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown, status = 200): Promise<T> {
  let response;
  try { response = await control.fetch(path, { method, ...(data === undefined ? {} : { data }) }); }
  catch { throw new Error(`Isolated recovery ${method} request failed`); }
  expect(response.status(), `Isolated recovery ${method} status`).toBe(status); return response.json();
}

/** 仅测试控制端读自己随机实例的原生验证表；不加生产令牌接口，断言及报告不输出令牌。 */
function nativeResetToken(email: string): string | undefined {
  if (!runtime.dataDirectory || new URL(runtime.origin).port === '3200') throw new Error('Recovery test lacks an isolated data directory');
  const directory = realpathSync(runtime.dataDirectory), prefix = join(realpathSync(tmpdir()), 'form-studio-ui-');
  if (!directory.startsWith(prefix)) throw new Error('Recovery test data directory is outside its temporary instance');
  const db = new Database(join(directory, 'studio.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const user = db.prepare('SELECT id FROM auth_user WHERE email=?').get(email) as { id: string } | undefined; if (!user) return;
    const row = db.prepare("SELECT identifier FROM auth_verification WHERE value=? AND identifier LIKE 'reset-password:%' ORDER BY createdAt DESC LIMIT 1").get(user.id) as { identifier: string } | undefined;
    const token = row?.identifier.slice('reset-password:'.length);
    if (!token || !/^[a-zA-Z0-9_-]{16,128}$/.test(token)) return;
    const metadata = db.prepare('SELECT 1 FROM auth_verification WHERE identifier=?').get(`studio-recovery:${createHash('sha256').update(token).digest('hex')}`);
    return metadata ? token : undefined;
  } finally { db.close(); }
}

test('账号找回真实请求、已登录成员进入重置、令牌清理和旧会话失效', async ({ page, context, ui }, testInfo) => {
  test.setTimeout(100000); page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ baseURL: runtime.origin, storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  const email = `ui-recovery-${randomUUID()}@example.invalid`, originalPassword = `Ui-old-${randomUUID()}-aA1!`, newPassword = `Ui-new-${randomUUID()}-aA1!`;
  let memberId = '', oldSession: APIRequestContext | undefined;
  for (const path of ['/api/account-recovery/request', '/api/account-recovery/reset', '/api/auth/sign-in/email']) ui.allowWrite('POST', path);
  try {
    const created = await api<{ member: { id: string } }>(control, '/api/members', 'POST', { name: 'UI recovery member', email, role: 'editor', password: originalPassword }, 201); memberId = created.member.id;
    await context.clearCookies(); await page.goto('/admin');
    await textButton(page, '忘记密码？').click(); await expect(page.getByRole('heading', { name: '找回登录密码', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '恢复账号的邮箱', exact: true }).fill(email); await textButton(page, '申请恢复邮件').click();
    await expect(page.getByRole('alert').filter({ hasText: '如果该邮箱可用于恢复' })).toBeVisible();
    await expect.poll(() => Boolean(nativeResetToken(email))).toBe(true);
    const token = nativeResetToken(email)!;
    await textButton(page, '返回登录').click();
    await page.getByRole('textbox', { name: '登录邮箱', exact: true }).fill(email); await page.getByLabel('登录密码', { exact: true }).fill(originalPassword); await page.getByRole('button', { name: /登录工作区/ }).click();
    await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
    oldSession = await playwrightRequest.newContext({ baseURL: runtime.origin, storageState: await context.storageState(), extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
    await api(oldSession, '/api/members/me');
    // 用浏览器内存导航，测试步骤标题不包含带令牌的地址。
    try {
      const navigated = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() });
      await page.evaluate(secret => location.assign(`/admin?auth=reset&token=${encodeURIComponent(secret)}`), token); await navigated;
    } catch { throw new Error('Private recovery navigation failed'); }
    await expect(page.getByRole('heading', { name: '设置新密码', exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.has('token')).toBe(false);
    expect(await page.evaluate(secret => JSON.stringify(history.state).includes(secret) || Object.values(sessionStorage).join('\n').includes(secret) || Object.values(localStorage).join('\n').includes(secret), token)).toBe(false);
    await expect(page.getByRole('heading', { name: '工作台', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    await testInfo.attach('account-reset-mobile', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    await page.getByLabel('恢复账号的新密码', { exact: true }).fill(newPassword); await page.getByLabel('再次输入恢复密码', { exact: true }).fill(newPassword);
    await textButton(page, '确认更新密码').click(); await expect(page.getByRole('heading', { name: '密码已更新', exact: true })).toBeVisible();
    await api(oldSession, '/api/members/me', 'GET', undefined, 401);
    await textButton(page, '返回登录').click(); await expect(page.getByRole('heading', { name: '欢迎回到工作区', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '登录邮箱', exact: true }).fill(email); await page.getByLabel('登录密码', { exact: true }).fill(newPassword); await page.getByRole('button', { name: /登录工作区/ }).click();
    await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
    expect(ui.writes.filter(value => value.path === '/api/account-recovery/request')).toHaveLength(1); expect(ui.writes.filter(value => value.path === '/api/account-recovery/reset')).toHaveLength(1);
  } finally {
    await ui.closeOwnedPage(); await oldSession?.dispose();
    if (memberId) await api(control, `/api/members/${memberId}`, 'PATCH', { disabled: true }); await control.dispose();
  }
});

test('失效恢复入口提供重新申请路径，普通登录仍可进入找回', async ({ page, context, ui }) => {
  await context.clearCookies(); await page.goto('/admin?auth=reset&error=INVALID_TOKEN');
  await expect(page.getByText('这个重置链接暂不可用', { exact: true })).toBeVisible();
  await expect(page.getByLabel('恢复账号的新密码', { exact: true })).toHaveCount(0);
  await textButton(page, '重新申请恢复邮件').click(); await expect(page.getByRole('heading', { name: '找回登录密码', exact: true })).toBeVisible();
  await expect(page.getByText('没有收到邮件？', { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('error')).toBe(false); expect(ui.writes).toEqual([]);
});
