import { requireActor, requirePermission } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { batchContext } from '@/server/ai-batch';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const actor=await requireActor(request);requirePermission(actor,'manage');const query=new URL(request.url).searchParams;return json(batchContext(actor,Object.fromEntries(query)));}catch(error){return apiError(error);}}
