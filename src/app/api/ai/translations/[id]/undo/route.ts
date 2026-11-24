import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { undoAiTranslation } from '@/server/ai-translation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 撤销由本人明确操作，保留最新会话、修订及引用保护，不自动回退公开网站。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params, input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(undoAiTranslation(id, input, actor, () => revalidateActor(actor, 'manage'))); }
  catch (error) { return apiError(error); }
}
