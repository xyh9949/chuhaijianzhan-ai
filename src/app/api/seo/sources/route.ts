import { getSeoSourceSummary } from '@/server/seo-sources';
import { requireActor } from '@/server/permissions';
import { json, apiError } from '@/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{return json(getSeoSourceSummary(await requireActor(request)));}catch(error){return apiError(error);}}
