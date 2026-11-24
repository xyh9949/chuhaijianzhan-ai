import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { generateSiteTranslation, listSiteTranslations } from '@/server/ai-site-translation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(request: Request) { try { const actor=await requireActor(request); requirePermission(actor,'manage'); return json(listSiteTranslations(actor)); } catch(error) { return apiError(error); } }
/** 完整读体及fresh会话确认后才受理模型任务；生成不改草稿。 */
export async function POST(request: Request) { try { assertSameOrigin(request); let actor=await requireActor(request); requirePermission(actor,'manage'); const input=await readJsonObject(request); actor=revalidateActor(actor,'manage'); return json(await generateSiteTranslation(input,actor,request.signal,()=>revalidateActor(actor,'manage')),201); } catch(error) { return apiError(error); } }
