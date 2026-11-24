import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { createExternalAiToken, listExternalAiTokens } from '@/server/external-ai-tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json({ items: listExternalAiTokens(actor) }); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage');
    // 持久机器凭据不能由读体期间已撤销的浏览器会话创建。
    const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage');
    return json(createExternalAiToken(input, actor), 201);
  }
  catch (error) { return apiError(error); }
}
