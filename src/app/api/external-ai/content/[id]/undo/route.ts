import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { undoExternalAiWriting } from '@/server/external-ai-writing';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 写入必须经过管理员浏览器同源确认，使用原生草稿版本及冲突校验。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage');
    const { id } = await context.params, input = await readJsonObject(request);
    // 撤销也不能复用请求开始时的旧会话授权。
    actor = revalidateActor(actor, 'manage'); return json(await undoExternalAiWriting(id, input, actor));
  }
  catch (error) { return apiError(error); }
}
