import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readAiSource, deleteAiSource } from '@/server/ai-source-import';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
/** 动态参数可能异步解析；参数就绪后重验当前会话，私有读取和删除均不能沿用旧授权。 */
export async function GET(request: Request, context: Context) {
  try { let actor = await requireActor(request); requirePermission(actor, 'manage'); const id = (await context.params).id; actor = revalidateActor(actor, 'manage'); return json(readAiSource(id, actor)); }
  catch (error) { return apiError(error); }
}
/** 动态参数可能异步解析；参数就绪后重验当前会话，私有读取和删除均不能沿用旧授权。 */
export async function DELETE(request: Request, context: Context) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const id = (await context.params).id; actor = revalidateActor(actor, 'manage'); return json(deleteAiSource(id, actor)); }
  catch (error) { return apiError(error); }
}
