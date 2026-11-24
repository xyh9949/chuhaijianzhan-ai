import { requireActor, revalidateActor } from '@/server/permissions';
import { apiError } from '@/server/http';
import { readAiSourceImage } from '@/server/ai-source-enhance';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string; imageId: string }> }) {
  try { const actor = await requireActor(request), { id, imageId } = await context.params; revalidateActor(actor, 'manage'); const image = await readAiSourceImage(id, imageId, actor, true, () => revalidateActor(actor, 'manage')); return new Response(new Uint8Array(image.bytes), { headers: { 'Content-Type': image.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' } }); }
  catch (error) { return apiError(error); }
}
