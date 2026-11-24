import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { auditFailure } from '@/server/audit';
import { applyAiSiteDesign } from '@/server/ai-site-design';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request: Request) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(await auditFailure(actor, 'ai.siteDesign.apply', () => applyAiSiteDesign(input, actor))); }
  catch (error) { return apiError(error); }
}
