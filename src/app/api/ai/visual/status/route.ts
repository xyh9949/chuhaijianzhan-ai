import { requireActor, requirePermission } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { aiVisualStatus } from '@/server/ai-visual';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { requirePermission(await requireActor(request), 'manage'); return json(aiVisualStatus()); } catch (error) { return apiError(error); }
}
