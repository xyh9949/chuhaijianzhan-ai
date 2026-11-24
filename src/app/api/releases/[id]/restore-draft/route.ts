import { auditFailure } from '@/server/audit';
import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { restoreDraft } from '@/server/publication';
import { identifier, object, readJson } from '@/server/validation';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request); requirePermission(await requireActor(request), 'edit');
    const input = object(await readJson(request), '恢复请求'), { id } = await context.params;
    const actor = await requireActor(request); requirePermission(actor, 'edit');
    const permission = input.includeTemplates === true || input.includeForms === true || input.includeRedirects === true || input.includeCatalog === true || input.includeSettings === true || input.includeCode === true || (Array.isArray(input.contentModelIds) && input.contentModelIds.length > 0) ? 'manage' : 'edit';
    requirePermission(actor, permission);
    return json(await auditFailure(actor, 'draft.restore', () => restoreDraft(identifier(id), input, actor, () => revalidateActor(actor, permission))));
  } catch (error) { return apiError(error); }
}
