import { apiError, readJsonObject } from '@/server/http';
import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { inquiriesCsv } from '@/server/inquiry-operations';
export const runtime = 'nodejs';
/** CSV含客户资料，慢请求读完后仍须保有当前编辑权限和有效会话。 */
export async function POST(request: Request) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'edit'); const input = await readJsonObject(request); actor = revalidateActor(actor, 'edit'); const csv = inquiriesCsv(input, actor.id); return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="website-inquiries.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); } catch (error) { return apiError(error); }
}
