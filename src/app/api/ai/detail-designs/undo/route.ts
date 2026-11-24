import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { auditFailure } from '@/server/audit';
import { undoAiDetailDesign } from '@/server/ai-detail-design';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 本人同源浏览器确认后才合并原生模板布局，模型布尔值不能代替此动作。 */
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request: Request) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(await auditFailure(actor, 'ai.detailDesign.undo', () => undoAiDetailDesign(input, actor))); } catch (error) { return apiError(error); } }
