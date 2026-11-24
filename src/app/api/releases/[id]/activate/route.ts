import { auditFailure } from '@/server/audit';
import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { activateRelease } from '@/server/publication';
import { identifier, readJson } from '@/server/validation';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); requirePermission(await requireActor(request), 'publish'); const { id } = await context.params, input = await readJson(request); const actor = await requireActor(request); requirePermission(actor, 'publish'); return json(await auditFailure(actor, 'release.activate', () => activateRelease(identifier(id), input, actor, () => revalidateActor(actor, 'publish')))); } catch (error) { return apiError(error); }
}
