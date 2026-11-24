import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readAiDetailDesign, deleteAiDetailDesign } from '@/server/ai-detail-design';
import { identifier } from '@/server/validation';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
function templateScope(request: Request) {
  const templateId = new URL(request.url).searchParams.get('templateId');
  return templateId === null ? undefined : identifier(templateId, '详情模板标识');
}
/** 动态参数可能异步解析；参数就绪后重验当前会话，私有读取和删除均不能沿用旧授权。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { let actor = await requireActor(request); requirePermission(actor, 'manage'); const id = (await context.params).id; actor = revalidateActor(actor, 'manage'); return json(readAiDetailDesign(id, actor, templateScope(request))); } catch (error) { return apiError(error); } }
/** 动态参数可能异步解析；参数就绪后重验当前会话，私有读取和删除均不能沿用旧授权。 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const id = (await context.params).id; actor = revalidateActor(actor, 'manage'); return json(deleteAiDetailDesign(id, actor, templateScope(request))); } catch (error) { return apiError(error); } }
