import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { previewPublication } from '@/server/publication';
import { readJson } from '@/server/validation';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); requirePermission(await requireActor(request), 'publish');
    const input = await readJson(request), actor = await requireActor(request);
    // 完整读取范围后再确认当前会话有权生成私有预览。
    return json(previewPublication(input, actor, () => revalidateActor(actor, 'publish')));
  } catch (error) { return apiError(error); }
}
