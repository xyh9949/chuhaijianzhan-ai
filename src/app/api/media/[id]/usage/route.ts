import { requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { identifier } from '@/server/validation';
import { mediaUsage } from '@/server/media-operations';
export const runtime = 'nodejs';
/** 引用明细包含未发布对象标签，params等待期间已撤销的会话不能继续读取。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { const actor = await requireActor(request); requirePermission(actor, 'read'); const { id } = await context.params; revalidateActor(actor, 'read'); return json(mediaUsage(identifier(id))); } catch (e) { return apiError(e); } }
