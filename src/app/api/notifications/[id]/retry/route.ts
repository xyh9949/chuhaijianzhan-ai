import { apiError, json } from '@/server/http';
import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { retryNotification } from '@/server/notification-jobs';
import { identifier } from '@/server/validation';
export const runtime = 'nodejs';
/** 重排队列前复核等待params期间的撤权，不能用旧管理员会话触发后续外发。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { try { assertSameOrigin(request); const actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params; revalidateActor(actor, 'manage'); retryNotification(identifier(id)); return json({ queued: true }); } catch (error) { return apiError(error); } }
