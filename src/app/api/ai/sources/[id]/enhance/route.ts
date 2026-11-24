import { assertSameOrigin, requireActor, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { enhanceAiSource } from '@/server/ai-source-enhance';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); const actor = await requireActor(request), input = await readJsonObject(request), { id } = await context.params; revalidateActor(actor, 'manage'); return json(await enhanceAiSource(id, input, actor, request.signal, () => revalidateActor(actor, 'manage'))); }
  catch (error) { return apiError(error); }
}
