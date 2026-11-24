import {requireActor,requirePermission,assertSameOrigin,revalidateActor} from '@/server/permissions';
import {json,apiError,readJsonObject} from '@/server/http';
import {discoveryStatus,addObservations,deleteObservation} from '@/server/discovery-runtime';
export const runtime='nodejs';
export async function GET(request:Request){try{const a=await requireActor(request);requirePermission(a,'manage');return json(discoveryStatus(Number(new URL(request.url).searchParams.get('before')||Number.MAX_SAFE_INTEGER)));}catch(e){return apiError(e);}}
export async function POST(request:Request){try{assertSameOrigin(request);let a=await requireActor(request);requirePermission(a,'manage');const v=await readJsonObject(request);/* 观测增删无异步服务，再次鉴权后同步提交。 */a=revalidateActor(a,'manage');if(v.action==='delete')deleteObservation(Number(v.id),a);else if(v.action==='record')addObservations(v.rows,a);else return json({error:'未知操作'},422);return json(discoveryStatus());}catch(e){return apiError(e);}}
