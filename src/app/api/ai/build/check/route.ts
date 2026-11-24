import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { checkAiBuildSite } from '@/server/ai-build-site-check';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 145;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    let actor = await requireActor(request);
    requirePermission(actor, 'manage');
    const input = await readJsonObject(request);
    actor = revalidateActor(actor, 'manage');
    return json(await checkAiBuildSite(input, actor, request.headers.get('cookie') || '', request.signal, () => revalidateActor(actor, 'manage')));
  } catch (error) { return apiError(error); }
}
