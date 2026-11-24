import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { deleteSeoContent, readSeoContent } from '@/server/seo-content';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params; actor = revalidateActor(actor, 'manage'); return json(readSeoContent(id, actor)); }
  catch (error) { return apiError(error); }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params; actor = revalidateActor(actor, 'manage'); return json(deleteSeoContent(id, actor, () => revalidateActor(actor, 'manage'))); }
  catch (error) { return apiError(error); }
}
