import { listGscProperties } from '@/server/seo-sources';
import { requireActor } from '@/server/permissions';
import { json, apiError } from '@/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{return json(await listGscProperties(await requireActor(request),request.signal));}catch(error){return apiError(error);}}
