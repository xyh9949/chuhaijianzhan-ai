import { auditAuth } from '@/server/audit';
import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/database";
import { ApiError, apiError, json, readJsonObject } from "@/server/http";
import { assertSameOrigin, requireActor, requirePermission, validatePassword } from "@/server/permissions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request);
    requirePermission(actor, "manage");
    const { id } = await context.params;
    if (id === actor.id) throw new ApiError(400, "请在账户安全中使用当前密码修改自己的密码");
    if (!getDatabase().prepare("SELECT id FROM auth_user WHERE id = ?").get(id)) throw new ApiError(404, "成员不存在");
    const password = validatePassword((await readJsonObject(request)).password);
    await auditAuth(actor,'member.password',[id],async()=>{await getAuth().api.setUserPassword({ headers: request.headers, body: { userId: id, newPassword: password } });
    // 密码写入由认证库负责；管理员重置后使该成员所有旧会话失效。
    getDatabase().prepare("DELETE FROM auth_session WHERE userId = ?").run(id);
    });
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
