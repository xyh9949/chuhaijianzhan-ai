import { requireActor, requirePermission } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { listAiWritingReceipts } from '@/server/ai-writing';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); const query = new URL(request.url).searchParams; return json(listAiWritingReceipts(actor, query.get('kind') || undefined, query.get('id') || undefined)); } catch (error) { return apiError(error); } }
