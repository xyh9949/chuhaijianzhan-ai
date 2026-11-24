import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { applySeoContent } from '@/server/seo-content';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 服务器冻结的分组与本人明确选择共同决定范围，不接收模型或浏览器整站补丁。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id } = await context.params, input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(applySeoContent(id, input, actor, () => revalidateActor(actor, 'manage'))); }
  catch (error) { return apiError(error); }
}
