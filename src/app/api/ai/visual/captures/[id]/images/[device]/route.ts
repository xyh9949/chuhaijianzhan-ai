import { requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError } from '@/server/http';
import { readAiVisualImage } from '@/server/ai-visual';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string; device: string }> }) {
  try { let actor = await requireActor(request); requirePermission(actor, 'manage'); const { id, device } = await context.params; actor = revalidateActor(actor, 'manage'); const image = readAiVisualImage(id, device, actor); return new Response(new Uint8Array(image.bytes), { headers: { 'Content-Type': image.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' } }); } catch (error) { return apiError(error); }
}
