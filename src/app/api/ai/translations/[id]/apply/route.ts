import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { applyAiTranslation } from '@/server/ai-translation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 只能采用服务器冻结候选的勾选字段，不接受整站补丁或模型确认标记。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params, input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(applyAiTranslation(id, input, actor, () => revalidateActor(actor, 'manage'))); }
  catch (error) { return apiError(error); }
}
