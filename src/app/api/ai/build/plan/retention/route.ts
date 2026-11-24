import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { setAiSitePlanRetention } from '@/server/ai-builder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 保存或移出本人长期方案，只写私有建站记录。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request);
    requirePermission(actor, 'manage');
    const input = await readJsonObject(request);
    return json(setAiSitePlanRetention(input, revalidateActor(actor, 'manage')));
  } catch (error) { return apiError(error); }
}
