import { auditFailure } from '@/server/audit';
import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { commitContentImport, readImportRequest } from '@/server/content-import';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'edit');
    const input = await readImportRequest(request); actor = revalidateActor(actor, 'edit');
    // 导入解析后到草稿事务均为同步调用，旧会话不能借延迟请求体继续保存。
    return json(await auditFailure(actor, 'content.import', () => commitContentImport(input, Date.now(), actor)));
  } catch (e) { return apiError(e); }
}
