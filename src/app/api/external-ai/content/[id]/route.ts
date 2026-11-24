import { requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { reviewExternalAiWriting } from '@/server/external-ai-writing';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 人工审核只认本人后台会话，Bearer没有确认权限。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params; /* 私有审核正文只返回给等待后仍有效的本人会话。 */ actor = revalidateActor(actor, 'manage'); return json(reviewExternalAiWriting(id, actor)); }
  catch (error) { return apiError(error); }
}
