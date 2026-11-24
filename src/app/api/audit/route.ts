import { requireActor, requirePermission } from '@/server/permissions';
import { apiError,json } from '@/server/http';
import { listAudit } from '@/server/audit';
export const runtime='nodejs';
export async function GET(request:Request){try{const actor=await requireActor(request);requirePermission(actor,'manage');return json(listAudit(new URL(request.url).searchParams));}catch(e){return apiError(e);}}
