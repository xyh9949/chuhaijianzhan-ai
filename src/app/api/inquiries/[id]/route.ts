import { deleteInquiryRecord } from '@/server/inquiry-operations';
import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { updateInquiry } from '@/server/studio';
import { identifier, readJson } from '@/server/validation';
export const runtime = 'nodejs';
/** 参数和请求体读取后使用当前角色，已撤会话不能靠旧DTO写入内部跟进信息。 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'edit'); const { id } = await context.params; const input = await readJson(request, 32 * 1024); actor = revalidateActor(actor, 'edit'); return json(updateInquiry(identifier(id), input, actor)); } catch (error) { return apiError(error); }
}

/** 删除在全部异步读取结束后再次鉴权，防止挂起请求跨越成员降权或撤会话。 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); const actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params; const input = await readJson(request, 1024); revalidateActor(actor, 'manage'); return json(deleteInquiryRecord(identifier(id), input)); } catch (error) { return apiError(error); }
}
