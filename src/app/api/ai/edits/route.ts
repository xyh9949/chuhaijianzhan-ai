import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { auditFailure } from '@/server/audit';
import { generateAiPageEdit, listAiPageEdits } from '@/server/ai-page-edit';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const actor = await requireActor(request); requirePermission(actor, 'manage'); const url = new URL(request.url); return json(listAiPageEdits(actor, url.searchParams.get('pageId') ?? undefined)); }
  catch (error) { return apiError(error); }
}
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request: Request) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(await auditFailure(actor, 'ai.edit.generate', () => generateAiPageEdit(input, actor, request.signal)), 201); }
  catch (error) { return apiError(error); }
}
