import { startGscAuthorization } from '@/server/seo-sources';
import { assertSameOrigin, requireActor } from '@/server/permissions';
import { json, apiError } from '@/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(request:Request){try{assertSameOrigin(request);return json(startGscAuthorization(await requireActor(request)));}catch(error){return apiError(error);}}
