import { syncGscReport } from '@/server/seo-sources';
import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { json, apiError, readJsonObject } from '@/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request:Request){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const input=await readJsonObject(request);actor=revalidateActor(actor,'manage');return json(await syncGscReport(input,actor,request.signal));}catch(error){return apiError(error);}}
