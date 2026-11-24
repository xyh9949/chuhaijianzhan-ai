import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { generateSeoContent, listSeoContent } from '@/server/seo-content';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(listSeoContent(actor)); }
  catch (error) { return apiError(error); }
}
/** 完整输入与当前会话核对后才受理付费任务，结果始终本人私有且不修改网站。 */
export async function POST(request: Request) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(await generateSeoContent(input, actor, request.signal, () => revalidateActor(actor, 'manage')), 201); }
  catch (error) { return apiError(error); }
}
