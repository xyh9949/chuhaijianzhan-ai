import { requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readAiWritingSaveAttempt } from '@/server/ai-writing';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 失联后仅核对本人完成记录，不重放保存或模型请求。 */
/** 动态参数可能异步解析；参数就绪后重验当前会话，私有读取和删除均不能沿用旧授权。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params; actor = revalidateActor(actor, 'manage'); return json(readAiWritingSaveAttempt(id, actor)); } catch (error) { return apiError(error); } }
