import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { ApiError, apiError, json } from '@/server/http';
import { deleteMedia, hasDraftMedia, isPublishedMedia, readMediaFile, readImageVariant } from '@/server/media';
import { identifier, readJson } from '@/server/validation';
import { mediaByteRange } from '@/lib/media-range';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = identifier((await context.params).id); const published = isPublishedMedia(id);
    if (!published) { const actor = await requireActor(request); requirePermission(actor, 'read'); if (!hasDraftMedia(id)) throw new ApiError(404, '素材不存在'); }
    const width = new URL(request.url).searchParams.get('width');
    if (width !== null && !/^(320|768|1440)$/.test(width)) throw new ApiError(422, '图片尺寸只支持320、768、1440');
    const file = width === null ? readMediaFile(id) : await readImageVariant(id, Number(width));
    const rangeHeader = request.headers.get('range');
    if (file.mime.startsWith('video/') && rangeHeader && (!request.headers.has('if-range') || request.headers.get('if-range') === `"${file.etag}"`)) {
      const range = mediaByteRange(rangeHeader, file.bytes.length);
      if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.bytes.length}`, 'Cache-Control': 'no-store' } });
      return new Response(new Uint8Array(file.bytes.subarray(range.start, range.end + 1)), { status: 206, headers: { 'Content-Type': file.mime, 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${file.bytes.length}`, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'ETag': `"${file.etag}"`, 'Cache-Control': published ? 'public, max-age=31536000, immutable' : 'private, no-store' } });
    }
    return new Response(new Uint8Array(file.bytes), { headers: { 'Content-Type': file.mime, 'Content-Length': String(file.bytes.length), 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': file.mime === 'application/pdf' ? `attachment; filename="catalog-${id}.pdf"` : 'inline', ...(file.mime === 'application/pdf' ? { 'Content-Security-Policy': "sandbox; default-src 'none'" } : {}), 'ETag': `"${file.etag}"`, 'Cache-Control': published ? 'public, max-age=31536000, immutable' : 'private, no-store' } });
  } catch (error) { return apiError(error); }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'edit');
    const { id } = await context.params, input = await readJson(request);
    // 完整读取路径与请求体后重新校验，避免挂起的删除请求继续使用旧会话。
    actor = revalidateActor(actor, 'edit');
    return json(deleteMedia(identifier(id), input));
  } catch (error) { return apiError(error); }
}
