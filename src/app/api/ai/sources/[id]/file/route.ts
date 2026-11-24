import { requireActor, revalidateActor } from '@/server/permissions';
import { apiError } from '@/server/http';
import { readAiSourceOriginal } from '@/server/ai-source-enhance';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const actor = await requireActor(request), { id } = await context.params; revalidateActor(actor, 'manage'); const source = readAiSourceOriginal(id, actor); return new Response(new Uint8Array(source.bytes), { headers: { 'Content-Type': source.mime, 'Content-Disposition': `attachment; filename="source.${source.mime === 'application/pdf' ? 'pdf' : 'xlsx'}"; filename*=UTF-8''${encodeURIComponent(source.fileName)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "sandbox; default-src 'none'" } }); }
  catch (error) { return apiError(error); }
}
