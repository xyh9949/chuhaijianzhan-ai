import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { readBatch, controlBatch, deleteBatch } from '@/server/ai-batch';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){try{let actor=await requireActor(request);requirePermission(actor,'manage');const {id}=await context.params;actor=revalidateActor(actor,'manage');return json(readBatch(id,actor));}catch(error){return apiError(error);}}
export async function PATCH(request:Request,context:Context){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const {id}=await context.params,input=await readJsonObject(request);actor=revalidateActor(actor,'manage');return json(controlBatch(id,input,actor,()=>revalidateActor(actor,'manage')));}catch(error){return apiError(error);}}
export async function DELETE(request:Request,context:Context){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const {id}=await context.params;actor=revalidateActor(actor,'manage');return json(deleteBatch(id,actor,()=>revalidateActor(actor,'manage')));}catch(error){return apiError(error);}}
