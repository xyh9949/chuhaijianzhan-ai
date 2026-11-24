import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
import { getTranslationGlossary, saveTranslationGlossary } from '@/server/ai-site-translation-glossary';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { const actor=await requireActor(request); requirePermission(actor,'manage'); return json(getTranslationGlossary(actor)); } catch(error) { return apiError(error); } }
export async function PATCH(request: Request) { try { assertSameOrigin(request); let actor=await requireActor(request); requirePermission(actor,'manage'); const input=await readJsonObject(request); actor=revalidateActor(actor,'manage'); return json(saveTranslationGlossary(input,actor,()=>revalidateActor(actor,'manage'))); } catch(error) { return apiError(error); } }
export async function PUT(request: Request) { return PATCH(request); }
