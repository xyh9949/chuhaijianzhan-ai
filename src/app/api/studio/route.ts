import { auditFailure } from '@/server/audit';
import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { getStudioEnvelope, patchStudio } from '@/server/studio';
import { object, readJson } from '@/server/validation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'read'); return json(getStudioEnvelope()); } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request); requirePermission(await requireActor(request), 'edit');
    const input = object(await readJson(request), '保存请求'); const patch = object(input.patch, '保存内容');
    const actor = await requireActor(request); requirePermission(actor, 'edit');
    // 网站设置、源码与模型结构不能通过通用保存接口绕过管理员权限；主题和同步区块属于内容编辑权限。
    const permission = Object.hasOwn(patch, 'pageTemplates') || Object.hasOwn(patch, 'forms') || Object.hasOwn(patch, 'settings') || Object.hasOwn(patch, 'customCode') || Object.hasOwn(patch, 'contentModels') || Object.hasOwn(patch, 'taxonomies') || Object.hasOwn(patch, 'redirects') ? 'manage' : 'edit';
    requirePermission(actor, permission);
    return json(await auditFailure(actor, 'draft.update', () => patchStudio(input, actor, 'draft.update', { checkAccess: () => revalidateActor(actor, permission) })));
  } catch (error) { return apiError(error); }
}
