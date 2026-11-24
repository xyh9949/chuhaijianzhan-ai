import { auditFailure } from '@/server/audit';
import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { savePageAsTemplate } from '@/server/page-templates';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage');
    // 模板创建会复制页面与代码，读取请求体后必须复核管理员会话。
    const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage');
    return json(await auditFailure(actor, 'draft.update', () => savePageAsTemplate(input, actor)), 201);
  } catch (e) { return apiError(e); }
}
