import { apiError, json } from '@/server/http';
import { requireActor, requirePermission } from '@/server/permissions';
import { readRelease } from '@/server/studio';
import { identifier } from '@/server/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 历史快照沿用工作区的读取权限和禁止缓存策略，不随每次加载、编辑或保存一并发送。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    requirePermission(await requireActor(request), 'read');
    return json({ snapshot: readRelease(identifier(id, '发布版本')) });
  } catch (error) { return apiError(error); }
}
