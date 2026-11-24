import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { reviseAiSitePlan } from '@/server/ai-builder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 接收完整编辑内容后复核角色，再保存私有版本。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request);
    requirePermission(actor, 'manage');
    // 完整页面集合可含多语正文；字节上限只作用于这条私有修订接口。
    const input = await readJsonObject(request, 3 * 1024 * 1024);
    return json(reviseAiSitePlan(input, revalidateActor(actor, 'manage')));
  } catch (error) { return apiError(error); }
}
