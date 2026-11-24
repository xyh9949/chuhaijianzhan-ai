import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { listAiSources, uploadAiSource } from '@/server/ai-source-import';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(listAiSources(actor)); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { assertSameOrigin(request); const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(await uploadAiSource(request, actor, () => revalidateActor(actor, 'manage')), 201); }
  catch (error) { return apiError(error); }
}
