import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { selectSiteTranslation } from '@/server/ai-site-translation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request,context:{params:Promise<{id:string}>}) { try { assertSameOrigin(request); let actor=await requireActor(request); requirePermission(actor,'manage'); const {id}=await context.params,input=await readJsonObject(request); actor=revalidateActor(actor,'manage'); return json(selectSiteTranslation(id,input,actor,()=>revalidateActor(actor,'manage')),201); } catch(error) { return apiError(error); } }
