import { apiError, json, readJsonObject } from '@/server/http';
import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { previewInquiryCleanup, applyInquiryCleanup } from '@/server/inquiry-operations';
export const runtime = 'nodejs';
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(previewInquiryCleanup()); } catch (error) { return apiError(error); } }
/** 清理确认不是长期授权；请求体到齐后必须重新核对操作者，随后同步执行删除。 */
export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); revalidateActor(actor, 'manage'); return json(applyInquiryCleanup(input)); } catch (error) { return apiError(error); } }
