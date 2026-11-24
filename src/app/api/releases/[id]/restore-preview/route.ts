import { requireActor, requirePermission, assertSameOrigin } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { previewRestoreDraft } from '@/server/publication';
import { identifier, object, readJson } from '@/server/validation';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request); requirePermission(await requireActor(request), 'edit');
    const input = object(await readJson(request), '恢复请求'), { id } = await context.params;
    const actor = await requireActor(request); requirePermission(actor, 'edit');
    if (input.includeTemplates === true || input.includeForms === true || input.includeRedirects === true || input.includeCatalog === true || input.includeSettings === true || input.includeCode === true || (Array.isArray(input.contentModelIds) && input.contentModelIds.length > 0)) requirePermission(actor, 'manage');
    return json(previewRestoreDraft(identifier(id), input));
  } catch (error) { return apiError(error); }
}
