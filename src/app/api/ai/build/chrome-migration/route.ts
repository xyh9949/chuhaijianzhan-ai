import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { previewAiBuildChromeMigration } from '@/server/ai-builder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 冻结前后布局供本人核对；这里不写网站草稿或调用模型。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    let actor = await requireActor(request);
    requirePermission(actor, 'manage');
    const input = await readJsonObject(request);
    actor = revalidateActor(actor, 'manage');
    return json(previewAiBuildChromeMigration(input, actor));
  } catch (error) {
    return apiError(error);
  }
}
