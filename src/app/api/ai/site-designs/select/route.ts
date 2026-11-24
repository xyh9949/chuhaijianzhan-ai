import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { auditFailure } from '@/server/audit';
import { getDatabase } from '@/server/database';
import { selectAiSiteDesign } from '@/server/ai-site-design';
import { inheritExternalAiDesignSelection } from '@/server/external-ai-design';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 选择只建立新的真实预览；本人同源会话仍需另行确认采用，外部来源归属与候选原子登记。 */
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage');
    const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage');
    return json(await auditFailure(actor, 'ai.siteDesign.select', () => getDatabase().transaction(() => {
      const preview = selectAiSiteDesign(input, actor);
      inheritExternalAiDesignSelection(preview, actor);
      return preview;
    }).immediate()), 201);
  } catch (error) { return apiError(error); }
}
