import { auditAuth } from '@/server/audit';
import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/database";
import { ApiError, apiError, json, readJsonObject } from "@/server/http";
import { assertSameOrigin, isRole, memberDto, requireActor, requirePermission, validatePassword, type MemberRow } from "@/server/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requirePermission(await requireActor(request), "manage");
    const members = getDatabase().prepare("SELECT id, name, email, role, banned, banExpires, createdAt FROM auth_user ORDER BY createdAt ASC").all() as MemberRow[];
    return json({ members: members.map(memberDto) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor=await requireActor(request); requirePermission(actor, "manage");
    const body = await readJsonObject(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!name || name.length > 100) throw new ApiError(400, "姓名需为 1 至 100 个字符");
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "请输入有效邮箱地址");
    if (!isRole(body.role)) throw new ApiError(400, "请选择有效角色");
    const password = validatePassword(body.password);
    // 普通 HTTP 请求必须携带当前管理员会话；不使用无 headers 的特权初始化分支。
    const result = await auditAuth(actor,'member.create',[],()=>getAuth().api.createUser({ headers: request.headers, body: { name, email, password, role: body.role as 'admin'|'editor'|'viewer' } }), result=>[result.user.id]);
    const row = getDatabase().prepare("SELECT id, name, email, role, banned, banExpires, createdAt FROM auth_user WHERE id = ?").get(result.user.id) as MemberRow;
    return json({ member: memberDto(row) }, 201);
  } catch (error) { return apiError(error); }
}
