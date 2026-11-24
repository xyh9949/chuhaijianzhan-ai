import { recordAudit } from '@/server/audit';
import { getDatabase } from "@/server/database";
import { ApiError, apiError, json, readJsonObject } from "@/server/http";
import { assertSameOrigin, isMemberDisabled, isRole, memberDto, requireActor, requirePermission, revalidateActor, type MemberRow } from "@/server/permissions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    let actor=await requireActor(request); requirePermission(actor, "manage");
    const { id } = await context.params;
    const body = await readJsonObject(request);
    if (!Object.keys(body).length || Object.keys(body).some((key) => !["name", "role", "disabled"].includes(key))) throw new ApiError(400, "只允许修改姓名、角色或停用状态");
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100)) throw new ApiError(400, "姓名需为 1 至 100 个字符");
    if (body.role !== undefined && !isRole(body.role)) throw new ApiError(400, "请选择有效角色");
    if (body.disabled !== undefined && typeof body.disabled !== "boolean") throw new ApiError(400, "停用状态无效");
    const db = getDatabase();
    // 参数/请求体可能长时间等待；事务内先复核操作者当前会话与角色，再检查最后管理员并撤销目标会话。
    const member = db.transaction(() => {
      actor = revalidateActor(actor, 'manage');
      const row = db.prepare("SELECT id, name, email, role, banned, banExpires, createdAt FROM auth_user WHERE id = ?").get(id) as MemberRow | undefined;
      if (!row) throw new ApiError(404, "成员不存在");
      const role = body.role === undefined ? row.role : body.role as MemberRow["role"];
      const disabled = body.disabled === undefined ? isMemberDisabled(row) : body.disabled as boolean;
      if (row.role === "admin" && !isMemberDisabled(row) && (role !== "admin" || disabled)) {
        const admins = db.prepare("SELECT banned, banExpires FROM auth_user WHERE role = 'admin'").all() as MemberRow[];
        if (admins.filter((item) => !isMemberDisabled(item)).length <= 1) throw new ApiError(409, "至少需要保留一名可用管理员");
      }
      const name = body.name === undefined ? row.name : (body.name as string).trim();
      db.prepare("UPDATE auth_user SET name = ?, role = ?, banned = ?, banReason = ?, banExpires = NULL, updatedAt = ? WHERE id = ?").run(name, role, disabled ? 1 : 0, disabled ? "由管理员停用" : null, Date.now(), id);
      if (role !== row.role || disabled !== isMemberDisabled(row)) db.prepare("DELETE FROM auth_session WHERE userId = ?").run(id);
      recordAudit(actor,'member.update','success',{objectIds:[id],role,disabled,fields:Object.keys(body)});
      return memberDto({ ...row, name, role, banned: disabled ? 1 : 0, banExpires: null });
    }).immediate();
    return json({ member });
  } catch (error) { return apiError(error); }
}
