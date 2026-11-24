import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { applyExternalAiWriting } from '@/server/external-ai-writing';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 写入必须经过管理员浏览器同源确认，使用原生草稿版本及冲突校验。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage');
    const { id } = await context.params, input = await readJsonObject(request);
    // params和body全部读完后复核，再进入原生同步确认事务。
    actor = revalidateActor(actor, 'manage'); return json(await applyExternalAiWriting(id, input, actor));
  }
  catch (error) { return apiError(error); }
}
