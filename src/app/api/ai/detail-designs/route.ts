import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { auditFailure } from '@/server/audit';
import { generateAiDetailDesign, listAiDetailDesigns } from '@/server/ai-detail-design';
import { identifier } from '@/server/validation';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 模板入口只查询目标模板历史；独立外部审核入口仍可浏览本人的方案。 */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request); requirePermission(actor, 'manage');
    const templateId = new URL(request.url).searchParams.get('templateId');
    return json(listAiDetailDesigns(actor, templateId === null ? undefined : identifier(templateId, '详情模板标识')));
  } catch (error) { return apiError(error); }
}
/** 只有明确生成才调用用户模型；权限与原生候选规则由共享服务再次核对。 */
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request: Request) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const awaitInput = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(await auditFailure(actor, 'ai.detailDesign.generate', () => generateAiDetailDesign(awaitInput, actor, request.signal)), 201); } catch (error) { return apiError(error); } }
