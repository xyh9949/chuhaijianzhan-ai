import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readJson } from '@/server/validation';
import { undoAiWritingReceipt } from '@/server/ai-writing';
import { auditFailure } from '@/server/audit';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const id = (await context.params).id, value = await readJson(request, 16 * 1024); actor = revalidateActor(actor, 'manage'); return json(await auditFailure(actor, 'ai.writing.undo', () => undoAiWritingReceipt(id, value, actor))); } catch (error) { return apiError(error); } }
