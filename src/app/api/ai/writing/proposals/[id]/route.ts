import { requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readAiWritingProposal } from '@/server/ai-writing';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 动态参数可能异步解析；参数就绪后重验当前会话，私有读取和删除均不能沿用旧授权。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { let actor = await requireActor(request); requirePermission(actor, 'manage'); const id = (await context.params).id; actor = revalidateActor(actor, 'manage'); return json(readAiWritingProposal(id, actor)); } catch (error) { return apiError(error); } }
