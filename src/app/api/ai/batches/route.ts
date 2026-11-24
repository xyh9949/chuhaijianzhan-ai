import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { createBatch, listBatches } from '@/server/ai-batch';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const actor=await requireActor(request);requirePermission(actor,'manage');return json(listBatches(actor));}catch(error){return apiError(error);}}
/** 创建只冻结本人任务；不调用模型，也不改产品或文章。 */
export async function POST(request:Request){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const input=await readJsonObject(request);actor=revalidateActor(actor,'manage');return json(createBatch(input,actor,()=>revalidateActor(actor,'manage')),201);}catch(error){return apiError(error);}}
