import { closeSync, existsSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { createRecoveryAuth } from './auth';
import { getDatabase, getDataDirectory } from './database';
import { getAuthEnvironment } from './env';
import { recoveryMember, removeRecoveryMetadata } from './account-recovery-core';
import { recordAudit } from './audit';

type Input = { email: string; confirmationEmail: string; newPassword: string; acknowledgedStopped: boolean; port: number; backupDirectory: string };
export function localRecoveryError(message: string) { return Object.assign(new Error(message), { safeRecovery: true }); }
function activeAdmin(member: ReturnType<typeof recoveryMember>) { const ban = member?.banExpires ? typeof member.banExpires === 'number' ? member.banExpires : new Date(member.banExpires).getTime() : 0; return !!member && member.role === 'admin' && (!member.banned || !!ban && Number.isFinite(ban) && ban <= Date.now()); }
async function portClosed(port: number, host: string) {
  await new Promise<void>((done, reject) => {
    const socket = connect({ host, port });
    const finish = (error?: Error) => { socket.removeAllListeners(); socket.destroy(); error ? reject(error) : done(); };
    socket.once('connect', () => finish(localRecoveryError('检测到本机服务仍在监听，请先停止网站服务')));
    socket.once('error', error => { const code = (error as NodeJS.ErrnoException).code; finish(['ECONNREFUSED','EAFNOSUPPORT','ENETUNREACH'].includes(code || '') ? undefined : localRecoveryError('无法确认本机服务已停止，请核对端口和系统状态')); });
    socket.setTimeout(1000, () => finish(localRecoveryError('检查本机端口超时，未执行账号恢复')));
  });
}
function noSymlink(path: string) { for (let current = resolve(path); ; current = dirname(current)) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw localRecoveryError('恢复路径不能含符号链接或目录连接'); const parent = dirname(current); if (parent === current) break; } }

/** 仅本机维护入口：确认停服并探测指定本机端口，先完整备份，再原生申请和消费一次恢复令牌。 */
export async function recoverLocalAdministrator(input: Input) {
  getAuthEnvironment();
  if (!input.acknowledgedStopped) throw localRecoveryError('请先停止网站服务，并明确确认维护窗口');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw localRecoveryError('请明确填写本机网站服务端口');
  const email = input.email.trim().toLowerCase(); if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || input.confirmationEmail.trim().toLowerCase() !== email) throw localRecoveryError('确认邮箱与恢复目标不一致');
  if (input.newPassword.length < 12 || input.newPassword.length > 128) throw localRecoveryError('新密码需为12至128个字符');
  const directory = getDataDirectory(), databasePath = join(directory, 'studio.sqlite'), backupDirectory = resolve(input.backupDirectory);
  if (!existsSync(databasePath)) throw localRecoveryError('指定实例尚无数据库，恢复不能创建新账号或新实例');
  noSymlink(directory); noSymlink(databasePath); noSymlink(backupDirectory);
  if (realpathSync(directory).toLowerCase() !== resolve(directory).toLowerCase()) throw localRecoveryError('实例目录与真实路径不一致');
  const readonly = new Database(databasePath, { readonly: true, fileMustExist: true }); let target;
  try { target = readonly.prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE lower(email)=?').get(email) as ReturnType<typeof recoveryMember>; }
  catch { throw localRecoveryError('实例认证表不可读，请先核对已有实例与源码版本'); } finally { readonly.close(); }
  if (!activeAdmin(target)) throw localRecoveryError('本机恢复只允许既有且未停用的管理员，不创建、提权或解禁账号');
  await portClosed(input.port, '127.0.0.1'); await portClosed(input.port, '::1');
  if (existsSync(join(directory, '.auth-setup.lock'))) throw localRecoveryError('实例初始化尚未结束，请核对后再恢复');
  const lockPath = join(directory, '.auth-recovery.lock'); let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); } catch { throw localRecoveryError('另一个本机恢复正在执行；异常残留锁需由维护人员核对后清理'); }
  try {
    // 此锁只防止两次恢复并发，不冒充部署flock；操作者仍必须停止服务并核对实际端口。
    const require = createRequire(resolve(process.cwd(), 'package.json'));
    const { backup } = require(resolve(process.cwd(), 'scripts/operations.cjs')) as { backup(source: string, target: string): Promise<unknown> };
    await backup(directory, backupDirectory);
    await portClosed(input.port, '127.0.0.1'); await portClosed(input.port, '::1');
    let token = '';
    const activeDb = getDatabase();
    try {
    const auth = createRecoveryAuth({ delivery: async data => { if (data.userId !== target!.id) throw localRecoveryError('恢复目标已变化'); token = data.token; } });
    // 本机维护不受公开邮箱限频影响；只走同一个原生一次性恢复流程，不使用管理员会话旁路。
    const origin = getAuthEnvironment().baseURL, headers = new Headers({ origin });
    await auth.api.requestPasswordReset({ body: { email, redirectTo: `${origin}/admin?auth=reset` }, headers });
    if (!token) throw localRecoveryError('未能为当前管理员建立恢复申请，未修改密码');
    if (!activeAdmin(recoveryMember(getDatabase(), target!.id))) throw localRecoveryError('恢复期间管理员已停用或角色变化');
    await auth.api.resetPassword({ body: { token, newPassword: input.newPassword }, headers });
    await removeRecoveryMetadata((await auth.$context).internalAdapter, token); token = '';
    try { recordAudit({ id: target!.id, name: target!.name }, 'auth.recovery.local', 'success', { objectIds: [target!.id], fields: ['password','sessions'] }); } catch { /* 密码已保存，审计失败不打印任何凭据。 */ }
    return { recovered: true, backupDirectory, sessionsRevoked: true };
    } finally { activeDb.close(); }
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
