import { headers } from "next/headers";
import { getAuth } from "./auth";
import { getDatabase } from "./database";
import { getAuthEnvironment } from "./env";
import { ApiError } from "./http";

export type Role = "admin" | "editor" | "viewer";
export type Actor = { id: string; name: string; email: string; role: Role };
type Permission = "read" | "edit" | "publish" | "manage";
// 会话仅绑定到本次鉴权产生的对象，不进入Actor DTO、日志或内部CLI的可信身份。
const actorSessions = new WeakMap<Actor, string>();
export type MemberRow = Actor & { banned: number | null; banExpires: number | string | null; createdAt: number | string };
export function isRole(value: unknown): value is Role { return value === "admin" || value === "editor" || value === "viewer"; }
export function isMemberDisabled(member: Pick<MemberRow, "banned" | "banExpires">): boolean {
  if (!member.banned) return false;
  if (!member.banExpires) return true;
  const expiry = typeof member.banExpires === "number" ? member.banExpires : new Date(member.banExpires).getTime();
  return !Number.isFinite(expiry) || expiry > Date.now();
}

export async function requireActor(request?: Request): Promise<Actor> {
  const session = await getAuth().api.getSession({ headers: request?.headers ?? await headers(), query: { disableCookieCache: true } });
  if (!session) throw new ApiError(401, "请先登录");
  // 每次使用当前数据库角色和停用状态；旧页面或旧会话不能保留已撤销的权限。
  const row = getDatabase().prepare('SELECT id, name, email, role, banned, banExpires FROM auth_user WHERE id = ?').get(session.user.id) as MemberRow | undefined;
  if (!row || isMemberDisabled(row)) throw new ApiError(401, "账号已停用或会话已失效");
  if (!isRole(row.role)) throw new ApiError(403, "账号角色尚未配置");
  const actor: Actor = { id: row.id, name: row.name, email: row.email, role: row.role };
  actorSessions.set(actor, session.session.id);
  return actor;
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (permission === "read" || actor.role === "admin" || (permission === "edit" && actor.role === "editor")) return;
  throw new ApiError(403, "当前账号没有执行此操作的权限");
}

/** 异步读取/处理后在同步写事务内复核；降权、停用或撤会话不能继续使用请求开始时的授权。 */
export function revalidateActor(actor: Actor, permission: Permission): Actor {
  const db = getDatabase(), row = db.prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as MemberRow | undefined;
  if (!row || isMemberDisabled(row)) throw new ApiError(401, "账号已停用或会话已失效");
  if (!isRole(row.role)) throw new ApiError(403, "账号角色尚未配置");
  const sessionId = actorSessions.get(actor);
  // 此helper仅供requireActor产生的HTTP身份；内部可信服务使用不带回调的原调用方式。
  if (!sessionId) throw new ApiError(401, "请重新登录后再操作");
  const session = db.prepare('SELECT userId,expiresAt FROM auth_session WHERE id=?').get(sessionId) as { userId: string; expiresAt: number | string } | undefined;
  const expiry = session && (typeof session.expiresAt === 'number' ? session.expiresAt : new Date(session.expiresAt).getTime());
  if (!session || session.userId !== actor.id || !Number.isFinite(expiry) || Number(expiry) <= Date.now()) throw new ApiError(401, "账号已停用或会话已失效");
  requirePermission(row, permission);
  const fresh: Actor = { id: row.id, name: row.name, email: row.email, role: row.role };
  actorSessions.set(fresh, sessionId);
  return fresh;
}

export function assertSameOrigin(request: Request): void {
  // 修改接口只接受部署配置中的明确来源，不信任客户端 Host 或缺失的 Origin。
  if (request.headers.get("origin") !== getAuthEnvironment().baseURL) throw new ApiError(403, "请求来源不受信任");
}

export function memberDto(row: MemberRow) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, disabled: isMemberDisabled(row), createdAt: row.createdAt };
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) throw new ApiError(400, "密码长度必须为 12 至 128 个字符");
  return value;
}
