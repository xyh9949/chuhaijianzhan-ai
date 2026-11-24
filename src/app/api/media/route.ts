import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { parseUpload, uploadMedia } from '@/server/media';
import { mediaInventory } from '@/server/media-operations';
export const runtime = 'nodejs';
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'read'); return json(mediaInventory()); } catch (e) { return apiError(e); } }
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); requirePermission(await requireActor(request), 'edit');
    const form = await parseUpload(request), actor = await requireActor(request); requirePermission(actor, 'edit');
    return json(await uploadMedia(form, () => revalidateActor(actor, 'edit')), 201);
  } catch (error) { return apiError(error); }
}
