import { readSeoReport, deleteSeoReport } from '@/server/seo-sources';
import { assertSameOrigin, requireActor } from '@/server/permissions';
import { json, apiError } from '@/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){try{return json(readSeoReport((await context.params).id,await requireActor(request)));}catch(error){return apiError(error);}}
export async function DELETE(request:Request,context:Context){try{assertSameOrigin(request);return json(deleteSeoReport((await context.params).id,await requireActor(request)));}catch(error){return apiError(error);}}
