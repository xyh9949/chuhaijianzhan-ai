import {requireActor,requirePermission,assertSameOrigin,revalidateActor} from '@/server/permissions';
import {json,apiError,readJsonObject} from '@/server/http';
import {createDiscoveryPreset} from '@/server/discovery-presets';
export const runtime='nodejs';
export async function POST(request:Request){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const v=await readJsonObject(request);/* 预设会同时建立模型和页面，不能复用旧管理员授权。 */actor=revalidateActor(actor,'manage');return json(createDiscoveryPreset(String(v.kind),Number(v.expectedRevision),actor));}catch(e){return apiError(e);}}
