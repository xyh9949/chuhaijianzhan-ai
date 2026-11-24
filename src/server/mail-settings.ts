import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import type { MailSettingsInput, MailSettingsSummary, MailSettingsTestResult } from '../lib/mail-settings-types';
import { getDatabase, getDataDirectory } from './database';
import { getAuthEnvironment } from './env';
import { ApiError } from './http';
import { classifyAiAddress } from './ai-provider';
import { isMemberDisabled, requirePermission, type Actor, type MemberRow } from './permissions';
import { object, revision } from './validation';
import { recordAudit } from './audit';
import { captureServiceTestConfiguration, recordServiceTestEvidence } from './service-test-evidence';

type Config = Pick<MailSettingsInput, 'enabled' | 'host' | 'port' | 'security' | 'username' | 'from' | 'to' | 'allowLocal'>;
type Row = { revision: number; config_json: string; secret_cipher: string; updated_at: string };
export interface MailConfiguration extends Config { revision: number; source: 'environment' | 'database'; mode: 'none' | 'mock' | 'smtp'; configured: boolean; password: string; }
const AAD = Buffer.from('form-studio/mail-settings/v1');
const state = globalThis as typeof globalThis & { formStudioMailTests?: Set<string> };
export const validMailAddress = (value: string) => value.length <= 254 && /^[^\s@<>,;\u0000-\u001f\u007f]+@[^\s@<>,;\u0000-\u001f\u007f]+\.[^\s@<>,;\u0000-\u001f\u007f]+$/.test(value);
const readRow = () => getDatabase().prepare('SELECT revision,config_json,secret_cipher,updated_at FROM cms_mail_settings WHERE id=1').get() as Row | undefined;
function currentAdmin(actor: Actor): Actor {
  requirePermission(actor, 'manage');
  const member = getDatabase().prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as MemberRow | undefined;
  if (!member || isMemberDisabled(member)) throw new ApiError(401, '账号已停用或会话已失效');
  if (member.role !== 'admin') throw new ApiError(403, '邮件服务仅管理员可配置和测试');
  return { id: member.id, name: member.name, email: member.email, role: 'admin' };
}
function encryptionKey() { return createHash('sha256').update('form-studio-mail-key:v1\0').update(getAuthEnvironment().secret).digest(); }
function encryptPassword(value: string) {
  if (!value) return '';
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv); cipher.setAAD(AAD);
  const text = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), text.toString('base64url')].join('.');
}
function decryptPassword(value: string) {
  if (!value) return '';
  try {
    const [version, iv, tag, body, extra] = value.split('.'); if (version !== 'v1' || !iv || !tag || !body || extra !== undefined) throw Error();
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url')); cipher.setAAD(AAD); cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString('utf8');
  } catch { throw new ApiError(422, '邮件密码无法解密，请重新填写并保存；恢复实例时需保留原固定密钥'); }
}
function hostValue(value: string): string {
  if (!value) return '';
  const raw = value.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, ''); if (isIP(raw)) return raw;
  const ascii = domainToASCII(raw);
  if (!ascii || ascii.length > 253 || ascii.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new ApiError(422, '邮件服务器请填写主机名或IP，不含协议、端口或路径');
  return ascii;
}
function ready(config: Config, hasPassword: boolean) {
  try { if (!hostValue(config.host)) return false; } catch { return false; }
  return Number.isInteger(config.port) && config.port > 0 && config.port <= 65535 && validMailAddress(config.from) && config.to.length > 0 && config.to.length <= 5 && config.to.every(validMailAddress) && (!config.username || hasPassword);
}
/** 无私有覆盖行时沿用部署环境；读取不会迁移、启用或向服务器外发配置。 */
function current() {
  const row = readRow();
  if (row) { const config = JSON.parse(row.config_json) as Config; return { row, config, source: 'database' as const, mode: config.enabled ? 'smtp' as const : 'none' as const, hasPassword: !!row.secret_cipher }; }
  const mode = process.env.FORM_STUDIO_NOTIFY_TRANSPORT === 'mock' ? 'mock' as const : process.env.FORM_STUDIO_NOTIFY_TRANSPORT === 'smtp' ? 'smtp' as const : 'none' as const;
  const port = Number(process.env.FORM_STUDIO_SMTP_PORT || 587);
  const config: Config = { enabled: mode !== 'none', host: (process.env.FORM_STUDIO_SMTP_HOST || '').trim().toLowerCase(), port, security: port === 465 || process.env.FORM_STUDIO_SMTP_SECURE === 'true' ? 'tls' : 'starttls', username: process.env.FORM_STUDIO_SMTP_USER || '', from: (process.env.FORM_STUDIO_SMTP_FROM || '').trim(), to: (process.env.FORM_STUDIO_NOTIFY_TO || '').split(',').map(value => value.trim()).filter(Boolean), allowLocal: mode === 'smtp' };
  return { row: undefined, config, source: 'environment' as const, mode, hasPassword: !!process.env.FORM_STUDIO_SMTP_PASSWORD };
}
/** 管理端永不返回密码或密文；configured仅说明字段就绪，与自动通知开关分开。 */
export function getMailSettingsSummary(actor: Actor): MailSettingsSummary {
  currentAdmin(actor); return mailRuntimeSummary();
}
/** 运行状态无需解密口令；损坏的旧密码仍能由管理员读取表单并重新填写。 */
export function mailRuntimeSummary(): MailSettingsSummary {
  const value = current();
  return { ...value.config, revision: value.row?.revision || 0, source: value.source, mode: value.mode, hasPassword: value.hasPassword, configured: value.mode === 'mock' || ready(value.config, value.hasPassword), updatedAt: value.row?.updated_at || '' };
}
/** 队列在一次投递中持有同一份配置，不能在组装邮件与连接SMTP之间切换收件人或凭据。 */
export function loadMailConfiguration(): MailConfiguration {
  const value = current(); return { ...value.config, revision: value.row?.revision || 0, source: value.source, mode: value.mode, configured: value.mode === 'mock' || ready(value.config, value.hasPassword), password: value.row ? decryptPassword(value.row.secret_cipher) : process.env.FORM_STUDIO_SMTP_PASSWORD || '' };
}
function stringValue(value: unknown, name: string, max: number, trim = true): string { if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(422, `${name}格式无效`); return trim ? value.trim() : value; }
function identity(config: Config) { return JSON.stringify([config.host.toLowerCase().replace(/\.$/, ''), config.port, config.security, config.username]); }

/** 保存只写实例私有配置；留空保留同服务口令，变更服务身份必须重新提供或明确移除。 */
export function saveMailSettings(value: unknown, actor: Actor): MailSettingsSummary {
  const input = object(value, '邮件配置'), keys = ['expectedRevision','enabled','host','port','security','username','from','to','password','clearPassword','allowLocal'];
  if (Object.keys(input).some(key => !keys.includes(key)) || typeof input.enabled !== 'boolean' || typeof input.allowLocal !== 'boolean' || input.clearPassword !== undefined && typeof input.clearPassword !== 'boolean') throw new ApiError(422, '邮件配置包含无效字段');
  const expected = revision(input.expectedRevision), host = hostValue(stringValue(input.host, '邮件服务器', 253));
  if (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535 || !['tls','starttls'].includes(String(input.security))) throw new ApiError(422, '请选择有效端口和加密连接方式');
  if (host && isIP(host) && (classifyAiAddress(host) === 'blocked' || classifyAiAddress(host) === 'local' && !input.allowLocal)) throw new ApiError(422, '该邮件地址不允许连接；本机或内网服务需明确允许');
  const username = stringValue(input.username, '登录账号', 320), from = stringValue(input.from, '发件邮箱', 254);
  if (from && !validMailAddress(from) || !Array.isArray(input.to) || input.to.length > 5 || input.to.some(item => typeof item !== 'string' || !validMailAddress(item.trim())) || new Set(input.to.map(item => String(item).trim().toLowerCase())).size !== input.to.length) throw new ApiError(422, '请填写有效且不重复的收件邮箱，最多5个');
  const password = input.password === undefined ? '' : stringValue(input.password, '邮件密码或授权码', 4096, false);
  if (password && input.clearPassword) throw new ApiError(422, '不能同时填写新密码和移除密码');
  const config: Config = { enabled: input.enabled, host, port: Number(input.port), security: input.security as Config['security'], username, from, to: input.to.map(item => String(item).trim()), allowLocal: input.allowLocal };
  return getDatabase().transaction(() => {
    actor = currentAdmin(actor); const before = current(); if ((before.row?.revision || 0) !== expected) throw new ApiError(409, '邮件配置已被其他窗口修改，请读取最新配置后核对');
    if (before.hasPassword && !password && !input.clearPassword && identity(before.config) !== identity(config)) throw new ApiError(422, '邮件服务或账号已变化，请重新填写对应密码，或明确移除旧密码');
    const cipher = input.clearPassword ? '' : password ? encryptPassword(password) : before.row?.secret_cipher || encryptPassword(process.env.FORM_STUDIO_SMTP_PASSWORD || '');
    if (config.enabled && !ready(config, !!cipher)) throw new ApiError(422, '启用前请填写邮件服务器、发件邮箱、收件邮箱，以及登录账号对应的密码');
    getDatabase().prepare('INSERT INTO cms_mail_settings(id,revision,config_json,secret_cipher,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,secret_cipher=excluded.secret_cipher,updated_at=excluded.updated_at').run(expected + 1, JSON.stringify(config), cipher, new Date().toISOString());
    recordAudit(actor, 'mail.settings', 'success', { revision: expected + 1, fields: ['enabled','host','port','security','username','from','to','allowLocal', ...(password || input.clearPassword ? ['password'] : [])] });
    return getMailSettingsSummary(actor);
  }).immediate();
}

const ERROR_LABELS: Record<string, string> = { EAUTH: '账号验证失败，请核对登录账号和授权码', ECONNECTION: '无法连接邮件服务器，请核对地址、端口和网络', ETIMEDOUT: '连接超时，请核对服务和网络后再试', ESOCKET: '邮件连接中断，请检查加密方式', EENVELOPE: '发件人或收件地址被邮件服务拒绝', EMESSAGE: '测试邮件被邮件服务拒绝', EDNS: '无法解析邮件服务器地址', ETLS: '加密连接失败，请检查证书和连接方式' };
export function mailDeliveryErrorCode(error: unknown) { const code = String((error as { code?: unknown })?.code); return Object.hasOwn(ERROR_LABELS, code) ? code : 'SEND_FAILED'; }
export function mailDeliveryErrorMessage(error: unknown) { return ERROR_LABELS[mailDeliveryErrorCode(error)] || '邮件测试未完成，请检查配置后重试'; }
async function resolveMailTarget(config: MailConfiguration, signal?: AbortSignal) {
  const host = hostValue(config.host); let addresses: { address: string; family: number }[];
  let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
  try {
    if (signal?.aborted) throw new ApiError(499, '邮件测试已取消');
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Mail DNS timeout'), { code: 'ETIMEDOUT' })), 5000); cancel = () => reject(new ApiError(499, '邮件测试已取消')); signal?.addEventListener('abort', cancel, { once: true }); }),
    ]);
  } catch (error) { if (error instanceof ApiError || (error as { code?: string })?.code === 'ETIMEDOUT') throw error; throw Object.assign(new Error('Mail DNS failed'), { code: 'EDNS' }); }
  finally { if (timer) clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel); }
  if (!addresses.length || addresses.some(item => classifyAiAddress(item.address) === 'blocked' || classifyAiAddress(item.address) === 'local' && !config.allowLocal)) throw new ApiError(422, '邮件服务解析到不允许的网络地址；内网服务需明确允许，保留地址不能使用');
  return { host, address: (addresses.find(item => item.family === 4) || addresses[0]).address };
}
/** 只连接预先校验的IP，TLS仍校验原服务器名；从不忽略证书错误或降级为明文。 */
export async function deliverConfiguredMail(config: MailConfiguration, mail: SendMailOptions, signal?: AbortSignal, checkAccess?: () => void): Promise<string> {
  if (!config.configured) throw new ApiError(422, '邮件配置尚未完整，请先填写并保存配置');
  if (signal?.aborted) throw new ApiError(499, '邮件测试已取消');
  if (config.mode === 'mock') { checkAccess?.(); const result = await nodemailer.createTransport({ jsonTransport: true }).sendMail(mail); return String(result.messageId || 'local-mock').slice(0, 250); }
  const target = await resolveMailTarget(config, signal); checkAccess?.(); if (signal?.aborted) throw new ApiError(499, '邮件测试已取消');
  const transport = nodemailer.createTransport({ host: target.address, port: config.port, secure: config.security === 'tls', requireTLS: config.security !== 'tls', tls: { servername: isIP(target.host) ? undefined : target.host, rejectUnauthorized: true }, auth: config.username ? { user: config.username, pass: config.password } : undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, dnsTimeout: 5000 });
  const cancel = () => transport.close(); signal?.addEventListener('abort', cancel, { once: true });
  try { const result = await transport.sendMail(mail); if (result.rejected?.length) throw Object.assign(new Error('Recipients rejected'), { code: 'EENVELOPE' }); return String(result.messageId || '').slice(0, 250); }
  finally { signal?.removeEventListener('abort', cancel); transport.close(); }
}

/** 明确点击才发一封不带客户内容的测试；数据库限频跨进程生效，成功只代表服务接受。 */
export async function testMailSettings(value: unknown, actor: Actor, signal?: AbortSignal): Promise<MailSettingsTestResult> {
  actor = currentAdmin(actor); const input = object(value, '邮件测试');
  if (Object.keys(input).some(key => !['expectedRevision','recipient'].includes(key))) throw new ApiError(422, '测试邮件字段无效');
  const expected = revision(input.expectedRevision), recipient = stringValue(input.recipient, '测试收件邮箱', 254); if (!validMailAddress(recipient)) throw new ApiError(422, '请填写有效测试收件邮箱');
  const config = loadMailConfiguration(), evidence = captureServiceTestConfiguration('mail'); if (config.revision !== expected || evidence.revision !== config.revision || evidence.source !== config.source) throw new ApiError(409, '邮件配置已变化，请读取最新配置后再测试');
  if (config.mode !== 'mock' && !ready(config, !!config.password)) throw new ApiError(422, '请先保存完整邮件配置再测试');
  const key = `${getDataDirectory()}:${actor.id}`, busy = state.formStudioMailTests ??= new Set<string>(); if (busy.has(key)) throw new ApiError(409, '测试邮件正在发送，请等待结果后再试');
  const now = Date.now(); getDatabase().transaction(() => { currentAdmin(actor); const bucket = `mail-test:${actor.id}`, old = getDatabase().prepare('SELECT expires_at FROM cms_public_rate WHERE bucket=?').get(bucket) as { expires_at: number } | undefined; if (old && old.expires_at > now) throw new ApiError(429, '测试邮件每分钟最多发送一次，请稍后再试'); getDatabase().prepare('INSERT INTO cms_public_rate(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=1,expires_at=excluded.expires_at').run(bucket, now + 60000); }).immediate();
  const check = () => { currentAdmin(actor); if ((readRow()?.revision || 0) !== expected) throw new ApiError(409, '发送前邮件配置已变化，请核对最新配置后再测试'); };
  busy.add(key);
  try {
    // 关闭自动通知仍可验证已保存SMTP；测试从不取询盘、公司私有内容或其他收件人。
    const testConfig = { ...config, mode: config.mode === 'mock' ? 'mock' as const : 'smtp' as const, configured: true };
    await deliverConfiguredMail(testConfig, { from: config.mode === 'mock' ? 'local-mock@example.invalid' : config.from, to: [recipient], subject: '[Form Studio] 邮件配置测试', text: '这是一封邮件配置测试邮件。\n若收到此邮件，说明当前邮件服务已接受并投递本次测试。\n本邮件不包含客户询盘或网站私有资料。', disableFileAccess: true, disableUrlAccess: true }, signal, check);
    recordAudit(actor, 'mail.test', 'success', { revision: expected });
    recordServiceTestEvidence(evidence, actor, { mode: config.mode === 'mock' ? 'mock' : 'smtp', status: config.mode === 'mock' ? 'mock_sent' : 'sent' });
    return config.mode === 'mock' ? { mode: 'mock', status: 'mock_sent', message: '本机模拟测试完成，没有向真实邮箱发送邮件。' } : { mode: 'smtp', status: 'sent', message: '邮件服务已接受测试邮件，请到收件邮箱核对；这不等于保证已进入收件箱。' };
  } catch (error) { recordServiceTestEvidence(evidence, actor, { mode: config.mode === 'mock' ? 'mock' : 'smtp', status: 'failed', errorCode: mailDeliveryErrorCode(error) }); if (error instanceof ApiError) throw error; throw new ApiError(502, mailDeliveryErrorMessage(error)); }
  finally { busy.delete(key); }
}
