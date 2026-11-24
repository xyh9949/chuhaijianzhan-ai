import { getAiProviderSummary, saveAiProvider } from '@/server/ai-provider';
import { apiError, json, readJsonObject } from '@/server/http';
import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { requirePermission(await requireActor(request), 'manage'); return json(getAiProviderSummary()); }
  catch (error) { return apiError(error); }
}
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage');
    const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(saveAiProvider(input, actor));
  } catch (error) { return apiError(error); }
}
