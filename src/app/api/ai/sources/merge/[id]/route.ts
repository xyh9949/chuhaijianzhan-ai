import { requireActor, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readAiSourceMerge } from '@/server/ai-source-merge';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const actor = await requireActor(request), { id } = await context.params; revalidateActor(actor, 'manage'); return json(readAiSourceMerge(id, actor)); }
  catch (error) { return apiError(error); }
}
