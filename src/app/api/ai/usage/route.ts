import { requireActor, requirePermission } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { listAiUsage } from '@/server/ai-usage';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{const actor=await requireActor(request);requirePermission(actor,'manage');const query=new URL(request.url).searchParams;return json(listAiUsage(actor,{...(query.has('page')?{page:query.get('page')}:{}),...(query.get('task')?{task:query.get('task')}:{} )}));}catch(error){return apiError(error);}}
