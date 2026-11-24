import { listInquiryFollowUps } from '@/server/inquiry-followup';
import { apiError, json } from '@/server/http';
import { requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { identifier } from '@/server/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 等待params后重新验证会话，内部跟进不能返回给等待期间已退出或被撤会话的账号。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request); requirePermission(actor, 'read');
    const { id } = await context.params; revalidateActor(actor, 'read');
    return json(listInquiryFollowUps(identifier(id)));
  } catch (error) { return apiError(error); }
}
