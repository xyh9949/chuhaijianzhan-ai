import { apiError, json, readJsonObject } from '@/server/http';
import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { getInquiryPolicy, saveInquiryPolicy } from '@/server/inquiry-operations';
export const runtime = 'nodejs';
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(getInquiryPolicy()); } catch (error) { return apiError(error); } }
/** 读完慢请求体后再核对会话，不能用已撤销的管理员授权保存运行策略。 */
export async function PATCH(request: Request) { try { assertSameOrigin(request); const actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); revalidateActor(actor, 'manage'); return json(saveInquiryPolicy(input)); } catch (error) { return apiError(error); } }
