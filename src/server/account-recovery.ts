import { createHmac } from 'node:crypto';
import type { AccountRecoveryAccepted, AccountRecoveryCompleted } from '../lib/account-recovery-types';
import { getAuth, type createRecoveryAuth } from './auth';
import { assertRecoveryToken, removeRecoveryMetadata } from './account-recovery-core';
import { getDatabase, getDataDirectory } from './database';
import { getAuthEnvironment } from './env';
import { ApiError } from './http';
import { recordAudit } from './audit';
import { object } from './validation';

type RecoveryAuth = ReturnType<typeof createRecoveryAuth>;
type Schedule = (work: () => Promise<void>) => void;
const accepted: AccountRecoveryAccepted = { accepted: true, message: '如果该邮箱可用于恢复，系统会尝试发送恢复邮件。请检查收件箱和垃圾邮件；未收到时可稍后重试或联系管理员。' };
const emailPattern = /^[^\s@<>\u0000-\u001f\u007f]+@[^\s@<>\u0000-\u001f\u007f]+\.[^\s@<>\u0000-\u001f\u007f]+$/;
function only(input: Record<string, unknown>, keys: string[]) { if (Object.keys(input).some(key => !keys.includes(key))) throw new ApiError(422, '恢复请求包含无效字段'); }
function limit(key: string, max: number, duration: number) {
  const db = getDatabase(), now = Date.now();
  db.transaction(() => { const row = db.prepare('SELECT count,expires_at FROM cms_public_rate WHERE bucket=?').get(key) as { count: number; expires_at: number } | undefined;
    if (row && row.expires_at > now && row.count >= max) throw new ApiError(429, '恢复操作较频繁，请稍后再试');
    db.prepare('INSERT INTO cms_public_rate(bucket,count,expires_at) VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET count=excluded.count,expires_at=excluded.expires_at').run(key, row && row.expires_at > now ? row.count + 1 : 1, row && row.expires_at > now ? row.expires_at : now + duration);
    db.prepare("DELETE FROM cms_public_rate WHERE bucket LIKE 'account-recovery:%' AND expires_at<=?").run(now);
  }).immediate();
}

/** 公开请求先统一回执；路由只通过代码注入Next after，SMTP与账号查询不影响响应时间。 */
export async function requestAccountRecovery(value: unknown, schedule?: Schedule, auth: RecoveryAuth = getAuth()): Promise<AccountRecoveryAccepted> {
  const input = object(value, '账号恢复'); only(input, ['email']);
  if (typeof input.email !== 'string' || input.email.length > 254 || !emailPattern.test(input.email.trim())) throw new ApiError(422, '请填写有效的登录邮箱');
  const email = input.email.trim().toLowerCase(), env = getAuthEnvironment(), directory = getDataDirectory();
  const id = createHmac('sha256', env.secret).update(email).digest('hex');
  limit('account-recovery:all-requests', 30, 60000); limit(`account-recovery:email:${id}`, 3, 15 * 60000);
  const work = async () => {
    if (getDataDirectory() !== directory) return;
    try { await auth.api.requestPasswordReset({ body: { email, redirectTo: `${env.baseURL}/admin?auth=reset` }, headers: new Headers({ origin: env.baseURL }) }); }
    catch { /* 未知账号、停用、配置或投递失败始终相同回执；库钩子另存安全的内部结果。 */ }
  };
  if (schedule) schedule(work); else await work();
  return { ...accepted };
}

/** 真正修改完全交原生库：一次消费token、撤全部会话、写认证密码，禁止直接写哈希。 */
export async function resetAccountPassword(value: unknown, auth: RecoveryAuth = getAuth()): Promise<AccountRecoveryCompleted> {
  const input = object(value, '重置密码'); only(input, ['token','newPassword']);
  if (typeof input.newPassword !== 'string' || input.newPassword.length < 12 || input.newPassword.length > 128) throw new ApiError(422, '新密码需为12至128个字符');
  limit('account-recovery:all-resets', 60, 60000);
  const ctx = await auth.$context, db = getDatabase(); let member;
  try { member = await assertRecoveryToken(db, ctx.internalAdapter, input.token); }
  catch { throw new ApiError(400, '恢复链接无效或已过期，请重新申请'); }
  try { await auth.api.resetPassword({ body: { token: input.token as string, newPassword: input.newPassword }, headers: new Headers({ origin: getAuthEnvironment().baseURL }) }); }
  catch { throw new ApiError(400, '恢复链接无效或已过期，请重新申请'); }
  await removeRecoveryMetadata(ctx.internalAdapter, input.token as string);
  try { recordAudit({ id: member.id, name: member.name }, 'auth.recovery.reset', 'success', { objectIds: [member.id], fields: ['password','sessions'] }); } catch { /* 密码已原子保存，不能用审计失败误报重置失败。 */ }
  return { reset: true, message: '密码已更新，请使用新密码重新登录' };
}
