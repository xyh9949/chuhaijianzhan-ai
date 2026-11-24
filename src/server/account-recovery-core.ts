import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getAuthEnvironment } from './env';
import { getDataDirectory } from './database';
import { deliverConfiguredMail, loadMailConfiguration, mailRuntimeSummary, validMailAddress } from './mail-settings';
import { ApiError } from './http';
import { recordAudit } from './audit';
import { PRODUCT_NAME } from '../lib/product-brand';

type Verification = { value: string; expiresAt: Date };
/** 只使用认证库公开配置钩子及原生verification适配器，不接触密码哈希写入。 */
export interface RecoveryAdapter {
  createVerificationValue(value: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  findVerificationValue(identifier: string): Promise<Verification | null>;
  deleteVerificationByIdentifier(identifier: string): Promise<unknown>;
}
export interface RecoveryContext { internalAdapter: RecoveryAdapter; }
export type RecoveryDelivery = (value: { userId: string; url: string; token: string }) => Promise<void>;
export type RecoveryMember = { id: string; name: string; email: string; role: string; banned: number | null; banExpires: number | string | null };
type Stamp = { userId: string; email: string; role: string; credential: string };
export const RECOVERY_LIFETIME_SECONDS = 15 * 60;
const metaId = (token: string) => `studio-recovery:${createHash('sha256').update(token).digest('hex')}`;
export function validRecoveryToken(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value); }
function disabled(member: RecoveryMember) { const expiry = typeof member.banExpires === 'number' ? member.banExpires : member.banExpires ? new Date(member.banExpires).getTime() : 0; return !!member.banned && (!expiry || !Number.isFinite(expiry) || expiry > Date.now()); }
export function recoveryMember(db: Database.Database, id: string) { return db.prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(id) as RecoveryMember | undefined; }
function stamp(db: Database.Database, member: RecoveryMember): Stamp {
  const account = db.prepare("SELECT password FROM auth_account WHERE userId=? AND providerId='credential'").get(member.id) as { password: string | null } | undefined;
  return { userId: member.id, email: member.email.toLowerCase(), role: member.role, credential: createHash('sha256').update(account?.password || '').digest('hex') };
}
const invalid = () => new ApiError(400, '恢复链接无效或已过期，请重新申请');

/** 元数据使用独立标识；角色、邮箱、密码或停用状态后改后，旧链接不能恢复原权限上下文。 */
export async function assertRecoveryToken(db: Database.Database, adapter: RecoveryAdapter, token: unknown, nativeRequired = true): Promise<RecoveryMember> {
  if (!validRecoveryToken(token)) throw invalid();
  const [native, metadata] = await Promise.all([adapter.findVerificationValue(`reset-password:${token}`), adapter.findVerificationValue(metaId(token))]);
  const validExpiry = (value: Verification | null) => !!value && Number.isFinite(new Date(value.expiresAt).getTime()) && new Date(value.expiresAt).getTime() > Date.now();
  if (!validExpiry(metadata) || nativeRequired && !validExpiry(native)) throw invalid();
  if (!metadata) throw invalid();
  let saved: Stamp; try { saved = JSON.parse(metadata.value) as Stamp; } catch { throw invalid(); }
  if (native && native.value !== saved.userId) throw invalid();
  const member = recoveryMember(db, saved.userId);
  if (!member || disabled(member) || !['admin','editor','viewer'].includes(member.role) || JSON.stringify(stamp(db, member)) !== JSON.stringify(saved)) throw invalid();
  return member;
}

function safeAudit(member: RecoveryMember, result: 'started' | 'success' | 'failure', fields: string[]) {
  try { recordAudit({ id: member.id, name: member.name }, 'auth.recovery.request', result, { objectIds: [member.id], fields }); } catch { /* 回执不暴露账号或审计故障；不记录地址、令牌和邮件正文。 */ }
}
/** 原生库创建token后调用；真实HTTP在after中等待该工作，公开响应不会等待SMTP或泄露账号存在。 */
export async function deliverRecoveryToken(db: Database.Database, adapter: RecoveryAdapter, data: { user: { id: string }; token: string }, customDelivery?: RecoveryDelivery) {
  const member = recoveryMember(db, data.user.id), directory = getDataDirectory();
  if (!member || disabled(member) || !['admin','editor','viewer'].includes(member.role) || !validRecoveryToken(data.token)) { await adapter.deleteVerificationByIdentifier(`reset-password:${data.token}`); return; }
  const url = new URL('/admin', getAuthEnvironment().baseURL); url.searchParams.set('auth', 'reset'); url.searchParams.set('token', data.token);
  const issued = stamp(db, member);
  await adapter.createVerificationValue({ identifier: metaId(data.token), value: JSON.stringify(issued), expiresAt: new Date(Date.now() + RECOVERY_LIFETIME_SECONDS * 1000) });
  safeAudit(member, 'started', ['request']);
  try {
    if (customDelivery) { await customDelivery({ userId: member.id, token: data.token, url: url.href }); safeAudit(member, 'success', ['local-delivery']); return; }
    const config = loadMailConfiguration();
    if (config.mode !== 'mock' && (!config.host || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !validMailAddress(config.from) || config.username && !config.password)) throw new ApiError(422, '恢复邮件服务未配置');
    const check = () => { if (getDataDirectory() !== directory) throw invalid(); const current = recoveryMember(db, member.id), mail = mailRuntimeSummary(); if (!current || disabled(current) || JSON.stringify(stamp(db, current)) !== JSON.stringify(issued) || mail.revision !== config.revision || mail.source !== config.source) throw invalid(); };
    // 询盘自动通知可关闭；恢复邮件只发给已登记邮箱，不使用询盘收件人或客户资料。
    await deliverConfiguredMail({ ...config, mode: config.mode === 'mock' ? 'mock' : 'smtp', configured: true, to: [member.email] }, { from: config.mode === 'mock' ? 'local-mock@example.invalid' : config.from, to: [member.email], subject: `[${PRODUCT_NAME}] 重置登录密码`, text: `你收到了一次登录密码恢复申请。\n\n请在15分钟内打开以下链接设置新密码：\n${url.href}\n\n若不是你申请的，请忽略此邮件。链接只能使用一次，重置成功后旧登录会话将失效。`, disableFileAccess: true, disableUrlAccess: true }, undefined, check);
    safeAudit(member, 'success', [config.mode === 'mock' ? 'mock-delivery' : 'smtp-delivery']);
  } catch {
    await adapter.deleteVerificationByIdentifier(`reset-password:${data.token}`).catch(() => {}); await adapter.deleteVerificationByIdentifier(metaId(data.token)).catch(() => {});
    safeAudit(member, 'failure', ['delivery']);
  }
}
export async function removeRecoveryMetadata(adapter: RecoveryAdapter, token: string) { await adapter.deleteVerificationByIdentifier(metaId(token)).catch(() => {}); }
