import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { createAiVisualCapture, listAiVisualCaptures } from '@/server/ai-visual';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
/** 读取本人同一候选的暂存，不触发截图、模型、清理或网站写入。 */
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'manage'); const url = new URL(request.url); return json(listAiVisualCaptures(actor, { targetKind: url.searchParams.get('targetKind'), targetId: url.searchParams.get('targetId'), ...(url.searchParams.get('pageId') ? { pageId: url.searchParams.get('pageId') } : {}) })); } catch (error) { return apiError(error); }
}
/** 真实会话与完整输入确认后才启动浏览器，浏览器结束及真正落库前再次核对。 */
export async function POST(request: Request) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(await createAiVisualCapture(input, actor, request.headers.get('cookie') || '', request.signal, () => revalidateActor(actor, 'manage')), 201); } catch (error) { return apiError(error); }
}
