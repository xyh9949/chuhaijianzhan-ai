import { requireActor, requirePermission, revalidateActor, assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject, ApiError } from '@/server/http';
import { generateBatchItem, applyBatchItem, undoBatchItem } from '@/server/ai-batch';
import { getStudioEnvelope } from '@/server/studio';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
/** 等完整参数/请求体后重核会话；模型结果私有保留，采用与撤销沿原生版本和回执。 */
export async function POST(request:Request,context:{params:Promise<{id:string;position:string;action:string}>}){
  try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const {id,position,action}=await context.params,input=await readJsonObject(request);actor=revalidateActor(actor,'manage');const check=()=>revalidateActor(actor,'manage');
    if(action==='generate')return json(await generateBatchItem(id,position,input,actor,check));
    if(action!=='apply'&&action!=='undo')throw new ApiError(404,'没有此批量操作');
    const batch=action==='apply'?applyBatchItem(id,position,input,actor,check):undoBatchItem(id,position,input,actor,check);return json({...getStudioEnvelope(),batch});
  }catch(error){return apiError(error);}
}
