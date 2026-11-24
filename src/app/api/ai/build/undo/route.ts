import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { auditFailure } from '@/server/audit';
import { undoAiSite } from '@/server/ai-builder';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 接收完整输入后及写事务内复核会话；撤销只使用本人服务端回执，不接受客户端旧站快照。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage');
    const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage');
    return json(await auditFailure(actor, 'ai.undo', () => undoAiSite(input, actor, () => revalidateActor(actor, 'manage'))));
  } catch (error) { return apiError(error); }
}
