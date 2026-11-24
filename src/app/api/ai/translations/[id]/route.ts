import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { deleteAiTranslation, readAiTranslation } from '@/server/ai-translation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params; actor = revalidateActor(actor, 'manage'); return json(readAiTranslation(id, actor)); }
  catch (error) { return apiError(error); }
}
/** 删除的是本人私有记录，不删除已采用译文；参数等待期间撤权仍拒绝。 */
export async function DELETE(request: Request, context: Context) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params; actor = revalidateActor(actor, 'manage'); return json(deleteAiTranslation(id, actor, () => revalidateActor(actor, 'manage'))); }
  catch (error) { return apiError(error); }
}
