import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { batchMedia } from '@/server/media-operations';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'edit');
    const input = await readJsonObject(request);
    // 批处理输入可延迟到达；权限撤销后不能继续重命名、移动或移除素材记录。
    actor = revalidateActor(actor, 'edit');
    return json(batchMedia(input));
  } catch (e) { return apiError(e); }
}
