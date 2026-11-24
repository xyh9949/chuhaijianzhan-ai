import { beforeEach, afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { getMigrations } from 'better-auth/db/migration';
import { createRecoveryAuth } from '../src/server/auth';
import { getDatabase } from '../src/server/database';
import { getStudioEnvelope } from '../src/server/studio';
import { requestAccountRecovery, resetAccountPassword } from '../src/server/account-recovery';
import { recoverLocalAdministrator } from '../src/server/local-account-recovery';
import { ApiError } from '../src/server/http';
import nodemailer from 'nodemailer';
import { saveMailSettings } from '../src/server/mail-settings';

let directory = '', previous: NodeJS.ProcessEnv, auth: ReturnType<typeof createRecoveryAuth>;
let captured: { userId: string; url: string; token: string }[], user: { id: string; email: string };
const originalPassword = 'Synthetic-original-password-123';
const newPassword = 'Synthetic-replaced-password-456';
const status = (value: number) => (error: unknown) => error instanceof ApiError && error.status === value;
beforeEach(async () => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-account-recovery-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3299'; process.env.BETTER_AUTH_SECRET = 'synthetic-account-recovery-secret-'.repeat(3); process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'none';
  for (const name of Object.keys(process.env)) if (name.startsWith('FORM_STUDIO_SMTP_') || name === 'FORM_STUDIO_NOTIFY_TO') delete process.env[name];
  getStudioEnvelope(); captured = []; auth = createRecoveryAuth({ delivery: async value => { captured.push(value); } });
  await (await getMigrations(auth.options)).runMigrations();
  const created = await auth.api.createUser({ body: { name: 'Synthetic administrator', email: 'recover-admin@example.invalid', password: originalPassword, role: 'admin' } }); user = created.user;
});
afterEach(() => { mock.restoreAll(); getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-account-recovery-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const issue = async () => { await requestAccountRecovery({ email: user.email }, undefined, auth); assert.equal(captured.length > 0, true); return captured.at(-1)!.token; };
async function login(password = originalPassword) { const response = await auth.api.signInEmail({ body: { email: user.email, password }, asResponse: true }); assert.equal(response.status, 200); return new Headers({ origin: process.env.BETTER_AUTH_URL!, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }); }
async function freePort() { const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string'); await new Promise<void>(done => server.close(() => done())); return address.port; }

test('原生恢复链接固定可信来源与15分钟，元数据独立，未知/已停用请求统一泛化回执', async () => {
  const before = getStudioEnvelope(), known = await requestAccountRecovery({ email: user.email }, undefined, auth), unknown = await requestAccountRecovery({ email: 'unregistered@example.invalid' }, undefined, auth);
  assert.deepEqual(known, unknown); assert.equal(captured.length, 1); assert.equal(new URL(captured[0].url).origin, process.env.BETTER_AUTH_URL); assert.equal(new URL(captured[0].url).pathname, '/admin'); assert.equal(new URL(captured[0].url).searchParams.get('auth'), 'reset');
  const native = await (await auth.$context).internalAdapter.findVerificationValue(`reset-password:${captured[0].token}`); assert.equal(native?.value, user.id); assert.ok(native && new Date(native.expiresAt).getTime() - Date.now() <= 900000);
  getDatabase().prepare('UPDATE auth_user SET banned=1 WHERE id=?').run(user.id); assert.deepEqual(await requestAccountRecovery({ email: user.email }, undefined, auth), known); assert.equal(captured.length, 1); assert.deepEqual(getStudioEnvelope(), before);
});

test('原生一次重置撤全部旧会话且不自动登录，旧密码失效，新密码可登录，重放拒绝', async () => {
  const headers = await login(), token = await issue(); assert.ok(await auth.api.getSession({ headers }));
  const result = await resetAccountPassword({ token, newPassword }, auth); assert.deepEqual(result, { reset: true, message: '密码已更新，请使用新密码重新登录' });
  assert.equal(await auth.api.getSession({ headers }), null); assert.equal((getDatabase().prepare('SELECT count(*) n FROM auth_session WHERE userId=?').get(user.id) as { n: number }).n, 0);
  await assert.rejects(auth.api.signInEmail({ body: { email: user.email, password: originalPassword } })); await login(newPassword); await assert.rejects(resetAccountPassword({ token, newPassword }, auth), status(400));
});

test('过期、缺少独立meta、后改邮箱/角色/停用不能重置，原密码与会话保持', async () => {
  const token = await issue(); getDatabase().prepare('UPDATE auth_verification SET expiresAt=? WHERE identifier=?').run(Date.now() - 1000, `reset-password:${token}`); await assert.rejects(resetAccountPassword({ token, newPassword }, auth), status(400));
  getDatabase().prepare("DELETE FROM cms_public_rate WHERE bucket LIKE 'account-recovery:%'").run();
  for (const change of [{ role: 'editor' }, { email: 'moved@example.invalid' }, { banned: 1 }]) {
    const next = await issue(), field = Object.keys(change)[0], value = Object.values(change)[0]; getDatabase().prepare(`UPDATE auth_user SET ${field}=? WHERE id=?`).run(value, user.id); await assert.rejects(resetAccountPassword({ token: next, newPassword }, auth), status(400));
    getDatabase().prepare('UPDATE auth_user SET email=?,role=?,banned=0 WHERE id=?').run(user.email, 'admin', user.id); getDatabase().prepare("DELETE FROM cms_public_rate WHERE bucket LIKE 'account-recovery:%'").run();
  }
  const forged = 'synthetic-forged-native-token-only'; await (await auth.$context).internalAdapter.createVerificationValue({ identifier: `reset-password:${forged}`, value: user.id, expiresAt: new Date(Date.now() + 900000) }); await assert.rejects(resetAccountPassword({ token: forged, newPassword }, auth), status(400)); await login();
});

test('另一条成功重置或原密码变更使以前所有链接失效，不能再恢复旧上下文', async () => {
  const first = await issue(), second = await issue(); await resetAccountPassword({ token: second, newPassword }, auth); await assert.rejects(resetAccountPassword({ token: first, newPassword: originalPassword }, auth), status(400));
  getDatabase().prepare("DELETE FROM cms_public_rate WHERE bucket LIKE 'account-recovery:%'").run(); const third = await issue(); const headers = await login(newPassword); await auth.api.changePassword({ body: { currentPassword: newPassword, newPassword: originalPassword, revokeOtherSessions: true }, headers }); await assert.rejects(resetAccountPassword({ token: third, newPassword }, auth), status(400));
});

test('并发消费同一原生token只成功一次；失败不会把旧会话标为新登录', async () => {
  const token = await issue(), results = await Promise.allSettled([resetAccountPassword({ token, newPassword }, auth), resetAccountPassword({ token, newPassword }, auth)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1); await login(newPassword);
});

test('请求按邮箱摘要限频，错误字段与密码长度拒绝，不记录原邮箱或token', async () => {
  for (let i = 0; i < 3; i++) await requestAccountRecovery({ email: user.email }, undefined, auth); await assert.rejects(requestAccountRecovery({ email: user.email }, undefined, auth), status(429));
  await assert.rejects(requestAccountRecovery({ email: user.email, redirectTo: 'https://other.invalid' }, undefined, auth), status(422)); await assert.rejects(resetAccountPassword({ token: captured[0].token, newPassword: 'short' }, auth), status(422));
  const rates = JSON.stringify(getDatabase().prepare("SELECT bucket FROM cms_public_rate WHERE bucket LIKE 'account-recovery:%'").all()), audit = JSON.stringify(getDatabase().prepare("SELECT details_json FROM cms_audit WHERE action LIKE 'auth.recovery.%'").all()); assert.equal(rates.includes(user.email), false); assert.equal(audit.includes(user.email), false); assert.equal(captured.some(item => audit.includes(item.token)), false);
});

test('路由after调度前不查账号或发邮件；未配服务/实际模拟不向用户声称已发送', async () => {
  let task: (() => Promise<void>) | undefined; const result = await requestAccountRecovery({ email: user.email }, work => { task = work; }, auth); assert.equal(captured.length, 0); assert.equal(result.accepted, true); assert.equal(Boolean(task), true); await task!(); assert.equal(captured.length, 1);
  const ordinary = createRecoveryAuth(), unavailable = await requestAccountRecovery({ email: user.email }, undefined, ordinary); assert.deepEqual(unavailable, result);
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock'; const mock = await requestAccountRecovery({ email: user.email }, undefined, ordinary); assert.deepEqual(mock, result); assert.equal(JSON.stringify(mock).includes('sent'), false);
});

test('本机恢复停服确认/角色/端口守卫拒绝时不写密码或备份', async () => {
  const input = { email: user.email, confirmationEmail: user.email, newPassword, acknowledgedStopped: false, port: await freePort(), backupDirectory: join(directory, 'backups', 'guard') };
  await assert.rejects(recoverLocalAdministrator(input), /维护窗口/); assert.equal(existsSync(input.backupDirectory), false);
  const server = createServer(); await new Promise<void>(done => server.listen(input.port, '127.0.0.1', done)); try { await assert.rejects(recoverLocalAdministrator({ ...input, acknowledgedStopped: true }), /仍在监听/); } finally { await new Promise<void>(done => server.close(() => done())); }
  getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(user.id); await assert.rejects(recoverLocalAdministrator({ ...input, acknowledgedStopped: true }), /既有且未停用/); assert.equal(existsSync(input.backupDirectory), false);
});

test('询盘通知关闭时仍可投递恢复信，收件人只取登记邮箱，响应和审计均不含链接', async () => {
  saveMailSettings({ expectedRevision: 0, enabled: false, host: '127.0.0.1', port: 465, security: 'tls', username: 'synthetic-account', password: 'synthetic-smtp-private-password', from: 'sender@example.invalid', to: ['unrelated-inquiry-recipient@example.invalid'], allowLocal: true }, { id: user.id, name: 'Synthetic administrator', email: user.email, role: 'admin' });
  const actual = nodemailer.createTransport.bind(nodemailer), messages: unknown[] = [];
  mock.method(nodemailer, 'createTransport', () => { const transport = actual({ jsonTransport: true }); const send = transport.sendMail.bind(transport); transport.sendMail = ((mail: unknown) => { messages.push(mail); return send(mail as Parameters<typeof send>[0]); }) as typeof transport.sendMail; return transport; });
  const result = await requestAccountRecovery({ email: user.email }, undefined, createRecoveryAuth()); assert.equal(result.accepted, true); assert.equal(messages.length, 1);
  const mail = messages[0] as { to: string[]; text: string }; assert.deepEqual(mail.to, [user.email]); assert.equal(mail.text.includes('/admin?auth=reset&token='), true); assert.equal(mail.text.includes('unrelated-inquiry-recipient'), false); assert.equal(JSON.stringify(result).includes('token='), false);
  const audit = JSON.stringify(getDatabase().prepare("SELECT details_json FROM cms_audit WHERE action LIKE 'auth.recovery.%'").all()); assert.equal(audit.includes('token='), false);
});

test('真实CLI只用stdin恢复既有管理员，先备份、原生撤会话、不输出密码/令牌、业务保持', { timeout: 25000 }, async () => {
  const before = getStudioEnvelope(); await login(); const port = await freePort(), envFile = join(directory, 'instance.env'), backupDirectory = join(directory, 'backups', 'cli');
  writeFileSync(envFile, `BETTER_AUTH_SECRET=${process.env.BETTER_AUTH_SECRET}\nBETTER_AUTH_URL=${process.env.BETTER_AUTH_URL}\nFORM_STUDIO_DATA_DIR=${process.env.FORM_STUDIO_DATA_DIR}\n`, { mode: 0o600 });
  // 仅保留进程退出/超时类别用于排查资源压力；错误原文、环境、stdin和stderr仍不写进报告。
  const result = await new Promise<{ stdout: string; stderr: string }>((done, reject) => { const child = execFile(process.execPath, ['--import','tsx','scripts/auth-recover.ts','--env-file',envFile,'--email',user.email,'--port',String(port),'--backup-dir',backupDirectory,'--acknowledge-stopped','--stdin'], { cwd: process.cwd(), env: { ...process.env }, timeout: 20000 }, (error, stdout, stderr) => error ? reject(new Error(`Synthetic CLI recovery failed ${JSON.stringify({code:error.code??null,signal:error.signal??null,killed:!!error.killed})}`)) : done({ stdout, stderr })); child.stdin!.end(JSON.stringify({ email: user.email, confirmationEmail: user.email, newPassword, confirmPassword: newPassword })); });
  const output = JSON.parse(result.stdout.trim()); assert.equal(output.recovered, true); assert.equal(output.sessionsRevoked, true); assert.equal(existsSync(join(backupDirectory, 'BACKUP.json')), true); assert.equal((result.stdout + result.stderr).includes(newPassword), false); assert.equal((result.stdout + result.stderr).includes('token='), false); assert.equal(existsSync(join(directory, 'data', '.auth-recovery.lock')), false); assert.deepEqual(getStudioEnvelope(), before); assert.equal((getDatabase().prepare('SELECT count(*) n FROM auth_session WHERE userId=?').get(user.id) as { n: number }).n, 0); await login(newPassword);
  const manifest = JSON.parse(readFileSync(join(backupDirectory, 'BACKUP.json'), 'utf8')); assert.equal(manifest.format, 'form-studio-backup');
});
