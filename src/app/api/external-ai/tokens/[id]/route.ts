import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { revokeExternalAiToken } from '@/server/external-ai-tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await params; /* 参数等待后也须保留当前会话权限。 */ actor = revalidateActor(actor, 'manage'); return json({ credential: revokeExternalAiToken(id, actor) }); }
  catch (error) { return apiError(error); }
}
