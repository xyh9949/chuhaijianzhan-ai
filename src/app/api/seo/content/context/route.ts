import { requireActor, requirePermission } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { getSeoContentContext } from '@/server/seo-content';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'manage'); const url = new URL(request.url); return json(getSeoContentContext(url.searchParams.get('kind'), url.searchParams.get('id'), actor)); }
  catch (error) { return apiError(error); }
}
