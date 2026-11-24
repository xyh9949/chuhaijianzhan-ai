import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { getAiPricing, saveAiPricing } from '@/server/ai-usage';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{const actor=await requireActor(request);requirePermission(actor,'manage');return json(getAiPricing(actor));}catch(error){return apiError(error);}}
/** 价格只影响估算，仍须本人明确保存；完整读体后复核当前会话与配置修订。 */
export async function PATCH(request:Request){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const input=await readJsonObject(request);actor=revalidateActor(actor,'manage');return json(saveAiPricing(input,actor,()=>revalidateActor(actor,'manage')));}catch(error){return apiError(error);}}
