import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { generateAiTranslation, listAiTranslations } from '@/server/ai-translation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'manage'); const url = new URL(request.url); return json(listAiTranslations(actor, url.searchParams.get('kind') ?? undefined, url.searchParams.get('id') ?? undefined)); }
  catch (error) { return apiError(error); }
}
/** 模型只由本人主动请求；读体及受理前重查会话，受理后仅保留本人私有结果，使用时再核会话。 */
export async function POST(request: Request) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(await generateAiTranslation(input, actor, request.signal, () => revalidateActor(actor, 'manage')), 201); }
  catch (error) { return apiError(error); }
}
