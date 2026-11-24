import { requireActor, requirePermission } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { listAiBuildRuns } from '@/server/ai-builder';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 本人长期方案与近期运行摘要供主动恢复；GET不执行生成、采用或过期清理。 */
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(listAiBuildRuns(actor)); }
  catch (error) { return apiError(error); }
}
