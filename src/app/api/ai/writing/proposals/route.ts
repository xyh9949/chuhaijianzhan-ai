import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readJson } from '@/server/validation';
import { generateAiWritingProposal, listAiWritingProposals } from '@/server/ai-writing';
import { auditFailure } from '@/server/audit';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); const query = new URL(request.url).searchParams; return json(listAiWritingProposals(actor, query.get('kind') || undefined, query.get('id') || undefined)); } catch (error) { return apiError(error); } }
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request: Request) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const value = await readJson(request, 1024 * 1024); actor = revalidateActor(actor, 'manage'); return json(await auditFailure(actor, 'ai.writing.generate', () => generateAiWritingProposal(value, actor, request.signal)), 201); } catch (error) { return apiError(error); } }
