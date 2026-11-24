import { importKeywordCsv } from '@/server/seo-sources';
import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { json, apiError, ApiError, readBodyBytes } from '@/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request:Request){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new ApiError(415,'请使用JSON请求');let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBodyBytes(request,3*1024*1024)));}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'CSV导入请求JSON无效');}actor=revalidateActor(actor,'manage');return json(importKeywordCsv(value,actor));}catch(error){return apiError(error);}}
