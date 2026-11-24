import { listExcelSkuUpdates, undoExcelSkuUpdate } from '@/server/ai-source-import';
import { auditFailure } from '@/server/audit';
import { apiError, json, readJsonObject } from '@/server/http';
import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try { return json(listExcelSkuUpdates(await requireActor(request))); }
  catch (error) { return apiError(error); }
}

/** 撤销前复核当前会话与工作区版本；旧回执不会直接覆盖后来保存的字段。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request);
    requirePermission(actor, 'manage');
    const input = await readJsonObject(request);
    const current = revalidateActor(actor, 'manage');
    return json(await auditFailure(current, 'ai.source', () => undoExcelSkuUpdate(input, current), { fields: ['undoProductsBySku'] }));
  } catch (error) { return apiError(error); }
}
