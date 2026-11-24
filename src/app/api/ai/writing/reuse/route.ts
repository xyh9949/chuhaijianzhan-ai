import { requireActor, requirePermission } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readWritingReuse } from '@/server/ai-writing-reuse';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); const query = new URL(request.url).searchParams; return json(readWritingReuse(actor, query.get('sourceId') || undefined, query.get('productId') || undefined)); } catch (error) { return apiError(error); } }
