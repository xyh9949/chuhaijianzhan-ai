import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { getSiteTranslationContext } from '@/server/ai-site-translation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { const actor=await requireActor(request); requirePermission(actor,'manage'); return json(getSiteTranslationContext(actor)); } catch(error) { return apiError(error); } }
