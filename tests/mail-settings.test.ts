import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, createInquiry } from '../src/server/studio';
import { getMailSettingsSummary, saveMailSettings, testMailSettings, loadMailConfiguration, deliverConfiguredMail, mailDeliveryErrorMessage } from '../src/server/mail-settings';
import { enqueueNotification, listNotificationJobs, processNotificationJob, notificationStatus, startNotificationWorker, stopNotificationWorker, retryNotification } from '../src/server/notification-jobs';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';
const admin: Actor = { id: 'mail-admin', name: 'Synthetic mail admin', email: 'admin@example.invalid', role: 'admin' };
const editor: Actor = { id: 'mail-editor', name: 'Synthetic editor', email: 'editor@example.invalid', role: 'editor' };
const errorStatus = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
let directory = '', previous: NodeJS.ProcessEnv;
const input = (extra = {}) => ({ expectedRevision: getMailSettingsSummary(admin).revision, enabled: false, host: 'smtp.example.invalid', port: 587, security: 'starttls', username: 'sender@example.invalid', password: 'synthetic-mail-password', from: 'sender@example.invalid', to: ['sales@example.invalid'], allowLocal: false, ...extra });
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-mail-settings-')); process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3299'; process.env.BETTER_AUTH_SECRET = 'synthetic-mail-settings-secret-'.repeat(3);
  for (const name of Object.keys(process.env)) if (name.startsWith('FORM_STUDIO_SMTP_') || name === 'FORM_STUDIO_NOTIFY_TO') delete process.env[name]; process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'none';
  getDraftRecord(); const db = getDatabase(); db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); for (const actor of [admin, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(() => { stopNotificationWorker(); getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-mail-settings-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
function envSmtp() { Object.assign(process.env, { FORM_STUDIO_NOTIFY_TRANSPORT: 'smtp', FORM_STUDIO_SMTP_HOST: 'smtp.example.invalid', FORM_STUDIO_SMTP_PORT: '587', FORM_STUDIO_SMTP_USER: 'sender@example.invalid', FORM_STUDIO_SMTP_PASSWORD: 'legacy-environment-password', FORM_STUDIO_SMTP_FROM: 'sender@example.invalid', FORM_STUDIO_NOTIFY_TO: 'sales@example.invalid' }); }

test('默认不通知，读取沿用原环境但不写私表；公开草稿与密码分离', () => {
  const before = getStudioEnvelope(), summary = getMailSettingsSummary(admin); assert.equal(summary.mode, 'none'); assert.equal(summary.source, 'environment'); assert.equal(summary.revision, 0); assert.equal(summary.allowLocal, false); assert.equal(summary.configured, false);
  assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_mail_settings').get() as { n: number }).n, 0);
  envSmtp(); const env = getMailSettingsSummary(admin); assert.equal(env.mode, 'smtp'); assert.equal(env.hasPassword, true); assert.equal(env.configured, true); assert.equal(env.allowLocal, true); assert.doesNotMatch(JSON.stringify(env), /legacy-environment-password|secret_cipher/); assert.deepEqual(getStudioEnvelope(), before);
});
test('保存加密口令且只返回是否存在，私有配置立即生效而草稿/发布指针不变', () => {
  const before = getStudioEnvelope(), saved = saveMailSettings(input(), admin); assert.equal(saved.source, 'database'); assert.equal(saved.revision, 1); assert.equal(saved.enabled, false); assert.equal(saved.configured, true); assert.equal(saved.hasPassword, true); assert.deepEqual(notificationStatus(), { mode: 'none', configured: false });
  const row = getDatabase().prepare('SELECT * FROM cms_mail_settings').get() as { secret_cipher: string; config_json: string }; assert.ok(row.secret_cipher.startsWith('v1.')); assert.doesNotMatch(JSON.stringify(row), /synthetic-mail-password/); assert.equal(loadMailConfiguration().password, 'synthetic-mail-password'); assert.deepEqual(getStudioEnvelope(), before);
  assert.doesNotMatch(JSON.stringify(getMailSettingsSummary(admin)), /synthetic-mail-password|secret_cipher/); assert.doesNotMatch(JSON.stringify(getDatabase().prepare('SELECT details_json FROM cms_audit').all()), /synthetic-mail-password|sender@|sales@/);
});
test('旧环境同身份留空可加密承接；换服务/账号/加密方式/端口不可带走旧口令', () => {
  envSmtp(); const saved = saveMailSettings(input({ password: '', allowLocal: true }), admin); assert.equal(saved.hasPassword, true); assert.equal(loadMailConfiguration().password, 'legacy-environment-password');
  for (const extra of [{ host: 'other.example.invalid' }, { username: 'other@example.invalid' }, { security: 'tls' }, { port: 465 }]) assert.throws(() => saveMailSettings(input({ password: '', ...extra }), admin), errorStatus(422));
  const updated = saveMailSettings(input({ host: 'other.example.invalid', password: 'new-other-password' }), admin); assert.equal(updated.revision, 2); assert.equal(loadMailConfiguration().password, 'new-other-password');
});
test('留空保留、明确清除、重复密钥操作和坏密文可恢复，原固定密钥不得静默替换', () => {
  saveMailSettings(input(), admin); saveMailSettings(input({ password: '' }), admin); assert.equal(loadMailConfiguration().password, 'synthetic-mail-password');
  assert.throws(() => saveMailSettings(input({ password: 'new', clearPassword: true }), admin), errorStatus(422));
  getDatabase().prepare("UPDATE cms_mail_settings SET secret_cipher='v1.broken.cipher.body'").run(); assert.equal(getMailSettingsSummary(admin).hasPassword, true); assert.throws(() => loadMailConfiguration(), errorStatus(422));
  saveMailSettings(input({ password: 'replacement-after-corruption' }), admin); assert.equal(loadMailConfiguration().password, 'replacement-after-corruption');
  saveMailSettings(input({ password: '', clearPassword: true }), admin); assert.equal(getMailSettingsSummary(admin).hasPassword, false); assert.equal(getMailSettingsSummary(admin).configured, false);
});
test('保存校验同源安全输入、收件人边界、连接方式与当前版本，失败不留半配置', () => {
  for (const extra of [{ host: 'https://smtp.example.invalid/path' }, { host: 'bad host' }, { port: 0 }, { security: 'plain' }, { from: 'a@example.invalid\r\nBcc:x@example.invalid' }, { to: ['bad'] }, { to: Array.from({ length: 6 }, (_, n) => `test${n}@example.invalid`) }, { to: ['same@example.invalid','SAME@example.invalid'] }, { username: 'bad\nname' }, { ignoredField: 'not allowed' }]) assert.throws(() => saveMailSettings(input(extra), admin), errorStatus(422));
  assert.equal(getMailSettingsSummary(admin).revision, 0); saveMailSettings(input(), admin); assert.throws(() => saveMailSettings(input({ expectedRevision: 0 }), admin), errorStatus(409)); assert.equal(getMailSettingsSummary(admin).revision, 1);
});
test('启用需完整收发配置；管理员当前角色/停用和缓存角色不能绕过', async () => {
  assert.throws(() => saveMailSettings(input({ enabled: true, from: '' }), admin), errorStatus(422)); assert.throws(() => saveMailSettings(input(), editor), errorStatus(403)); assert.throws(() => getMailSettingsSummary(editor), errorStatus(403));
  getDatabase().prepare("UPDATE auth_user SET role='viewer' WHERE id=?").run(admin.id); assert.throws(() => saveMailSettings(input(), admin), errorStatus(403)); await assert.rejects(testMailSettings({ expectedRevision: 0, recipient: 'test@example.invalid' }, admin), errorStatus(403));
  getDatabase().prepare("UPDATE auth_user SET role='admin',banned=1 WHERE id=?").run(admin.id); assert.throws(() => getMailSettingsSummary(admin), errorStatus(401));
});
test('默认拒本机/内网与保留地址，明确内网许可也不允许元数据网段', () => {
  assert.throws(() => saveMailSettings(input({ host: '127.0.0.1' }), admin), errorStatus(422));
  for (const host of ['169.254.169.254','0.0.0.0','100.100.100.200','::','fd00:ec2::254']) assert.throws(() => saveMailSettings(input({ host, allowLocal: true }), admin), errorStatus(422));
  const saved = saveMailSettings(input({ host: '127.0.0.1', allowLocal: true }), admin); assert.equal(saved.host, '127.0.0.1'); assert.equal(saved.allowLocal, true);
});
test('测试邮件mock真实走发送模块，明确单一收件人、不建询盘或任务、跨进程桶限频', async () => {
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock'; const before = getStudioEnvelope(); const result = await testMailSettings({ expectedRevision: 0, recipient: 'explicit-test@example.invalid' }, admin); assert.equal(result.status, 'mock_sent'); assert.match(result.message, /没有向真实邮箱发送/); assert.deepEqual(getStudioEnvelope(), before); assert.equal(listNotificationJobs().length, 0);
  await assert.rejects(testMailSettings({ expectedRevision: 0, recipient: 'explicit-test@example.invalid' }, admin), errorStatus(429)); getDatabase().close(); await assert.rejects(testMailSettings({ expectedRevision: 0, recipient: 'explicit-test@example.invalid' }, admin), errorStatus(429));
});
test('测试输入、未配置、旧版本和取消在任何网络或测试成功回执之前拒绝', async () => {
  await assert.rejects(testMailSettings({ expectedRevision: 0, recipient: 'bad' }, admin), errorStatus(422)); await assert.rejects(testMailSettings({ expectedRevision: 0, recipient: 'test@example.invalid' }, admin), errorStatus(422));
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock'; await assert.rejects(testMailSettings({ expectedRevision: 1, recipient: 'test@example.invalid' }, admin), errorStatus(409));
  const controller = new AbortController(); controller.abort(); await assert.rejects(testMailSettings({ expectedRevision: 0, recipient: 'test@example.invalid' }, admin, controller.signal), errorStatus(499));
  assert.equal((getDatabase().prepare("SELECT count(*) n FROM cms_audit WHERE action='mail.test' AND result='success'").get() as { n: number }).n, 0);
});
test('默认hostname解析后的本机地址也被阻止，错误不回显SMTP服务原始秘密', async () => {
  saveMailSettings(input({ host: 'localhost' }), admin); let connected = 0; const server = createServer(socket => { connected++; socket.destroy(); }); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try { const address = server.address(); assert.ok(address && typeof address !== 'string'); const config = loadMailConfiguration(); await assert.rejects(deliverConfiguredMail({ ...config, mode: 'smtp', port: address.port }, { from: config.from, to: config.to, text: 'Synthetic' }), errorStatus(422)); assert.equal(connected, 0); }
  finally { await new Promise<void>(done => server.close(() => done())); }
  const error = Object.assign(new Error('password=DO_NOT_EXPOSE provider private text'), { code: 'EAUTH' }); assert.match(mailDeliveryErrorMessage(error), /账号验证失败/); assert.doesNotMatch(mailDeliveryErrorMessage(error), /DO_NOT_EXPOSE|password|provider/);
});
test('STARTTLS服务器拒绝加密升级时停止，不把账号口令降级发送到明文连接', { timeout: 10000 }, async () => {
  let commands = ''; const server = createServer(socket => { socket.setEncoding('utf8'); socket.on('error', () => {}); socket.write('220 localhost Synthetic plaintext fixture\r\n'); socket.on('data', chunk => { commands += chunk; if (String(chunk).startsWith('EHLO')) socket.write('250 localhost\r\n'); else if (String(chunk).startsWith('STARTTLS')) socket.write('454 TLS unavailable\r\n'); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try { const address = server.address(); assert.ok(address && typeof address !== 'string'); saveMailSettings(input({ host: '127.0.0.1', port: address.port, allowLocal: true }), admin); const config = loadMailConfiguration(); await assert.rejects(deliverConfiguredMail({ ...config, mode: 'smtp' }, { from: config.from, to: config.to, text: 'Not to send' }), error => (error as { code?: string }).code === 'ETLS'); assert.match(commands, /STARTTLS/); assert.doesNotMatch(commands, /AUTH|MAIL FROM|synthetic-mail-password/); }
  finally { await new Promise<void>(done => server.close(() => done())); }
});
test('配置关闭/启用立即影响新任务，DB启用不补发历史未配置；显式重试才能发送旧任务', async () => {
  const first = createInquiry({ name: 'Earlier visitor', email: 'earlier@example.invalid', message: 'Earlier inquiry' }).item; const oldId = enqueueNotification(first.id); assert.equal(listNotificationJobs()[0].status, 'unconfigured');
  saveMailSettings(input({ enabled: true }), admin); assert.equal(notificationStatus().configured, true); assert.equal(await processNotificationJob(Date.now(), async () => 'not-used'), false); assert.equal(listNotificationJobs()[0].status, 'unconfigured');
  retryNotification(oldId); let sentTo: unknown; assert.equal(await processNotificationJob(Date.now(), async mail => { sentTo = mail.to; return 'synthetic-provider'; }), true); assert.deepEqual(sentTo, ['sales@example.invalid']); assert.equal(listNotificationJobs()[0].status, 'sent');
  saveMailSettings(input({ enabled: false, password: '' }), admin); const next = createInquiry({ name: 'Later visitor', email: 'later@example.invalid', message: 'Later inquiry' }).item; enqueueNotification(next.id); assert.equal(await processNotificationJob(Date.now(), async () => 'not-used'), false); assert.equal(listNotificationJobs().find(job => job.inquiry_id === next.id)?.status, 'unconfigured');
});
test('投递冻结模式/收件地址，发送中配置变化不会篡改这一次邮件或记成新模式', async () => {
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock'; const inquiry = createInquiry({ name: 'Frozen visitor', email: 'visitor@example.invalid', message: 'Synthetic private message' }).item; enqueueNotification(inquiry.id);
  await processNotificationJob(Date.now(), async mail => { assert.deepEqual(mail.to, ['local-receiver@example.invalid']); saveMailSettings(input({ enabled: true }), admin); return 'already-accepted'; }); assert.equal(listNotificationJobs()[0].status, 'mock_sent');
});
test('保存后的配置重开数据库保持，env改变不会覆盖管理员保存值', () => {
  saveMailSettings(input(), admin); getDatabase().close(); envSmtp(); process.env.FORM_STUDIO_NOTIFY_TO = 'different-env@example.invalid'; const saved = getMailSettingsSummary(admin); assert.equal(saved.source, 'database'); assert.deepEqual(saved.to, ['sales@example.invalid']); assert.equal(saved.enabled, false); assert.equal(loadMailConfiguration().password, 'synthetic-mail-password');
});
test('旧实例定时器在目录切换时自停，不创建或处理下一实例数据库', async () => {
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock'; startNotificationWorker(); const original = process.env.FORM_STUDIO_DATA_DIR; process.env.FORM_STUDIO_DATA_DIR = join(directory, 'must-not-be-created');
  try { await new Promise(done => setTimeout(done, 2150)); assert.equal(existsSync(join(directory, 'must-not-be-created', 'studio.sqlite')), false); }
  finally { process.env.FORM_STUDIO_DATA_DIR = original; }
});

test('真实本机TLS SMTP认证与单封测试投递，保留SNI/证书验证且不发送询盘内容或配置收件人', { timeout: 15000 }, async () => {
  const cert = resolve('tests/fixtures/mail/localhost-cert.pem'), key = resolve('tests/fixtures/mail/localhost-key.pem');
  let mail = '', sni = '', authenticated = false, recipients: string[] = [];
  const server = createTlsServer({ cert: readFileSync(cert), key: readFileSync(key) }, socket => {
    sni = socket.servername || ''; socket.setEncoding('utf8'); socket.write('220 localhost Synthetic SMTP fixture\r\n'); let buffer = '', receiving = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      while (true) {
        if (receiving) { const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return; mail += buffer.slice(0, end); buffer = buffer.slice(end + 5); receiving = false; socket.write('250 Synthetic test accepted\r\n'); continue; }
        const end = buffer.indexOf('\r\n'); if (end < 0) return; const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (/^EHLO|^HELO/.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /.test(line)) { authenticated = Buffer.from(line.slice(11), 'base64').toString() === '\0fixture-smtp-user\0fixture-smtp-password'; socket.write(authenticated ? '235 Authenticated\r\n' : '535 Rejected\r\n'); }
        else if (/^MAIL FROM:/.test(line)) socket.write('250 Sender accepted\r\n');
        else if (/^RCPT TO:/.test(line)) { recipients.push(line); socket.write('250 Recipient accepted\r\n'); }
        else if (line === 'DATA') { receiving = true; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') { socket.end('221 Bye\r\n'); return; }
        else socket.write('250 OK\r\n');
      }
    });
  });
  server.on('tlsClientError', () => {}); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/fixtures/mail/smtp-client.ts', directory, String(address.port)], { cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 12000 });
    assert.equal(JSON.parse(result.stdout.trim()).passed, true); assert.equal(authenticated, true); assert.equal(sni, 'localhost'); assert.deepEqual(recipients, ['RCPT TO:<explicit-test@example.invalid>']); assert.doesNotMatch(mail, /PRIVATE_INQUIRY_MUST_NOT_APPEAR|configured-sales@example.invalid|fixture-smtp-password/); assert.match(mail, /From: sender@example.invalid/);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
