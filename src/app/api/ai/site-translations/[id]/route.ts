import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { readSiteTranslation, deleteSiteTranslation } from '@/server/ai-site-translation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(request: Request,context:Context) { try { let actor=await requireActor(request); requirePermission(actor,'manage'); const {id}=await context.params; actor=revalidateActor(actor,'manage'); return json(readSiteTranslation(id,actor)); } catch(error) { return apiError(error); } }
export async function DELETE(request: Request,context:Context) { try { assertSameOrigin(request); let actor=await requireActor(request); requirePermission(actor,'manage'); const {id}=await context.params; actor=revalidateActor(actor,'manage'); return json(deleteSiteTranslation(id,actor,()=>revalidateActor(actor,'manage'))); } catch(error) { return apiError(error); } }
