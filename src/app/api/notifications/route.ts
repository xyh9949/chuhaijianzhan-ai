import { apiError, json } from '@/server/http';
import { requireActor, requirePermission } from '@/server/permissions';
import { listNotificationJobs, notificationStatus } from '@/server/notification-jobs';
import { identifier } from '@/server/validation';
import { getDatabase } from '@/server/database';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request); requirePermission(actor, 'read');
    const inquiry = new URL(request.url).searchParams.get('inquiryId'); if (inquiry) identifier(inquiry);
    const jobs = listNotificationJobs(inquiry || undefined).map(j => ({ id: j.id, inquiryId: j.inquiry_id, status: j.status, attempts: j.attempts, nextAttempt: j.next_attempt, errorCode: j.error_code, createdAt: j.created_at, updatedAt: j.updated_at }));
    const total = (getDatabase().prepare(`SELECT count(*) AS count FROM cms_notification_job${inquiry ? ' WHERE inquiry_id=?' : ''}`).get(...(inquiry ? [inquiry] : [])) as { count: number }).count;
    return json({ jobs, total, configuration: notificationStatus() });
  } catch (error) { return apiError(error); }
}
