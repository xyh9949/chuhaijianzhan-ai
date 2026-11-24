import {readOAuthConsent,confirmOAuthConsent} from '@/server/mcp-oauth';
import {requireActor,requirePermission,revalidateActor,assertSameOrigin} from '@/server/permissions';
import {apiError,json,readJsonObject} from '@/server/http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){try{let actor=await requireActor(request);requirePermission(actor,'manage');const {id}=await context.params;actor=revalidateActor(actor,'manage');return json(readOAuthConsent(id,actor));}catch(error){return apiError(error);}}
/** Cookie授权必须同源、读完整参数/正文后重核会话；只接受管理员明确提交的范围。 */
export async function POST(request:Request,context:Context){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const {id}=await context.params,input=await readJsonObject(request);actor=revalidateActor(actor,'manage');return json(confirmOAuthConsent(id,input,actor,()=>revalidateActor(actor,'manage')));}catch(error){return apiError(error);}}
