import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { createInquiry, listInquiries } from '@/server/studio';
import { readJson } from '@/server/validation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'read'); return json({ items: listInquiries() }); } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  // 此入口只供后台录入，读体后复核当前会话；匿名收件仍走已发布表单的独立入口。
  try { assertSameOrigin(request); const actor = await requireActor(request); requirePermission(actor, 'edit'); const input = await readJson(request, 32 * 1024); revalidateActor(actor, 'edit'); return json(createInquiry(input), 201); } catch (error) { return apiError(error); }
}
