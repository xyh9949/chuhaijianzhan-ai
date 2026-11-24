import { listInquiryAssignees } from '@/server/inquiry-followup';
import { apiError, json } from '@/server/http';
import { requireActor, requirePermission } from '@/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    requirePermission(await requireActor(request), 'read');
    return json({ items: listInquiryAssignees() });
  } catch (error) { return apiError(error); }
}
