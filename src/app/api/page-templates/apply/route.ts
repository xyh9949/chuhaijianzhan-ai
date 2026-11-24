import { auditFailure } from '@/server/audit';
import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { applyPageTemplate } from '@/server/page-templates';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'edit');
    const input = await readJsonObject(request); actor = revalidateActor(actor, 'edit');
    // 是否允许复制代码以等待后的角色判断，不能继承请求开始时的管理员身份。
    return json(await auditFailure(actor, 'draft.update', () => applyPageTemplate(input, actor.role === 'admin', actor)));
  } catch (e) { return apiError(e); }
}
