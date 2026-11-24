import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { createAiVisualReview, listAiVisualReviews } from '@/server/ai-visual';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'manage'); const query = new URL(request.url).searchParams; return json(listAiVisualReviews(actor, { targetKind: query.get('targetKind'), targetId: query.get('targetId'), ...(query.has('pageId') ? { pageId: query.get('pageId') } : {}) })); } catch (error) { return apiError(error); }
}
/** 截图已由用户选择；单次模型请求只产出私人建议，不能采用或发布网站。 */
export async function POST(request: Request) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(await createAiVisualReview(input, actor, request.signal, () => revalidateActor(actor, 'manage')), 201); } catch (error) { return apiError(error); }
}
