import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { auditFailure } from '@/server/audit';
import { getDatabase } from '@/server/database';
import { selectAiDetailDesign } from '@/server/ai-detail-design';
import { inheritExternalAiTemplateSelection } from '@/server/external-ai-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 读取完整输入后复核同源管理员；派生预览和外部来源归属原子登记，不应用草稿。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage');
    const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage');
    return json(await auditFailure(actor, 'ai.detailDesign.select', () => getDatabase().transaction(() => {
      const preview = selectAiDetailDesign(input, actor); inheritExternalAiTemplateSelection(preview, actor); return preview;
    }).immediate()), 201);
  } catch (error) { return apiError(error); }
}
