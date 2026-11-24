import { requireActor, requirePermission } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { mediaInventory } from '@/server/media-operations';
export const runtime = 'nodejs';
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(mediaInventory(true)); } catch (e) { return apiError(e); } }
