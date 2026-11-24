import { assertSameOrigin, requireActor, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { undoAiSourceMerge } from '@/server/ai-source-merge';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try { assertSameOrigin(request); const actor = await requireActor(request), input = await readJsonObject(request); revalidateActor(actor, 'manage'); return json(undoAiSourceMerge(input, actor, () => revalidateActor(actor, 'manage'))); }
  catch (error) { return apiError(error); }
}
