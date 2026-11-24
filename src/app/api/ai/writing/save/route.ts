import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readJson } from '@/server/validation';
import { saveAiWritingDraft } from '@/server/ai-writing';
import { auditFailure } from '@/server/audit';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request: Request) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const value = await readJson(request); actor = revalidateActor(actor, 'manage'); return json(await auditFailure(actor, 'ai.writing.save', () => saveAiWritingDraft(value, actor))); } catch (error) { return apiError(error); } }
