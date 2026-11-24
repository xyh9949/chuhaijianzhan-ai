import { auditFailure } from '@/server/audit';
import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { publishSite } from '@/server/publication';
import { readJson } from '@/server/validation';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); requirePermission(await requireActor(request), 'publish');
    const input = await readJson(request);
    // 请求体可缓慢到达；完整读取后重新认证，不能把读取前的权限当作提交授权。
    const actor = await requireActor(request); requirePermission(actor, 'publish');
    return json(await auditFailure(actor, 'release.publish', () => publishSite(input, actor, () => revalidateActor(actor, 'publish'))), 201);
  } catch (error) { return apiError(error); }
}
