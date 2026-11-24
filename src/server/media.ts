import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { getDatabase, getDataDirectory } from './database';
import { ApiError } from './http';
import { collectReferences, object, revision, text, validateDraft } from './validation';
import { getDraftRecord, getStudioEnvelope, writeDraft } from './studio';
import type { MediaItem } from '../lib/types';
import { IMAGE_WIDTHS } from '../lib/media-images';
import { validatePdf } from './pdf-validation';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
export async function parseUpload(request: Request): Promise<FormData> {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data;')) throw new ApiError(415, '请使用文件上传表单');
  const limit = MAX_VIDEO_BYTES + 1024 * 1024;
  if (Number(request.headers.get('content-length') || 0) > limit) throw new ApiError(413, '上传文件不能超过 40 MB');
  const reader = request.body?.getReader(); if (!reader) throw new ApiError(400, '缺少上传内容');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > limit) { await reader.cancel(); throw new ApiError(413, '上传文件不能超过 40 MB'); } chunks.push(value); }
  try { return await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers.get('content-type')! } }).formData(); }
  catch { throw new ApiError(400, '上传表单无法解析'); }
}
export async function uploadMedia(form: FormData, checkAccess?: () => void) {
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) throw new ApiError(422, '请选择素材文件');
  const video = ['video/mp4', 'video/webm'].includes(file.type);
  const document = file.type === 'application/pdf';
  if (file.size > (video ? MAX_VIDEO_BYTES : document ? MAX_PDF_BYTES : MAX_FILE_BYTES)) throw new ApiError(413, video ? '视频不能超过 40 MB' : document ? 'PDF不能超过 10 MB' : '图片不能超过 8 MB');
  const submittedRevision = form.get('expectedRevision');
  if (typeof submittedRevision !== 'string' || !/^\d+$/.test(submittedRevision)) throw new ApiError(422, '上传缺少工作区版本，请刷新后重试');
  const expected = revision(Number(submittedRevision));
  const folder = text(form.get('folder') || '未分类', '素材目录', 100, true);
  if (!video && !document && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new ApiError(415, '仅支持 JPEG、PNG、WebP 图片、PDF目录及 MP4、WebM 视频，不支持 SVG 或其他文件');
  if (getDraftRecord().revision !== expected) throw new ApiError(409, '工作区已变化，请刷新后重新上传');
  let bytes: Buffer; let extension = 'webp'; const mime = video || document ? file.type : 'image/webp';
  let dimensions: Pick<MediaItem, 'width' | 'height' | 'pages' | 'variants'> = {};
  if (document) {
    if (!/\.pdf$/i.test(file.name)) throw new ApiError(422, 'PDF目录需要.pdf扩展名');
    bytes = Buffer.from(await file.arrayBuffer()); dimensions.pages = await validatePdf(bytes); extension = 'pdf';
  } else if (video) {
    bytes = Buffer.from(await file.arrayBuffer());
    // 检查容器签名而非只信扩展名；不执行或转码视频，解码能力由访客浏览器决定。
    const mp4 = bytes.length >= 32 && bytes.toString('ascii', 4, 8) === 'ftyp' && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length && bytes.includes(Buffer.from('mdat')) && (bytes.includes(Buffer.from('moov')) || bytes.includes(Buffer.from('moof')));
    const webm = bytes.length >= 32 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && bytes.subarray(0, 4096).includes(Buffer.from('webm'));
    if (!(file.type === 'video/mp4' ? mp4 : webm)) throw new ApiError(422, '视频容器签名无效，请上传有效 MP4 / WebM');
    extension = file.type === 'video/mp4' ? 'mp4' : 'webm';
  } else try {
    const source = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || !metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw new Error('unsupported');
    // 实际解码并重编码，拒绝伪扩展名、SVG、损坏图片及动画；同时剥离 EXIF 等原文件元数据。
    const output = await source.rotate().webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    bytes = output.data; dimensions = { width: output.info.width, height: output.info.height, variants: IMAGE_WIDTHS.filter(w => w < output.info.width).map(width => ({ width, height: Math.max(1, Math.round(output.info.height * width / output.info.width)) })) };
  } catch { throw new ApiError(422, '图片无法解码，或超过 4000 万像素；请上传有效的静态 JPEG、PNG、WebP'); }
  // 图片解码/PDF校验可能持续较久；先阻止已撤权请求写缓存，最终草稿事务还会再次核对。
  checkAccess?.();
  const hash = createHash('sha256').update(bytes).digest('hex');
  const filename = `${hash}.${extension}`; const directory = join(getDataDirectory(), 'media'); mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  if (!existsSync(path)) { try { writeFileSync(path, bytes, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
  const id = `media-${randomUUID()}`;
  // 派生文件以原内容哈希命名，可重建，不改变原ID/URL/哈希；写入竞争只接受同内容已存在。
  if (!video && !document) for (const variant of dimensions.variants || []) await writeImageVariant(bytes, hash, variant.width);
  const media: MediaItem = { id, name: file.name.replace(/[\u0000-\u001f\/\\]/g, '').slice(0, 240) || `media.${extension}`, url: `/api/media/${id}`, kind: video ? 'video' : document ? 'document' : 'image', folder, size: `${Math.ceil(bytes.length / 1024)} KB`, bytes: bytes.length, ...dimensions, alt: '' };
  getDatabase().transaction(() => {
    checkAccess?.();
    const current = getDraftRecord();
    if (current.revision !== expected) throw new ApiError(409, '工作区已变化，图片尚未加入素材库，请刷新后重试');
    getDatabase().prepare('INSERT INTO cms_media_file (id, filename, mime, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, filename, mime, bytes.length, hash, new Date().toISOString());
    writeDraft(validateDraft({ ...current.content, media: [...current.content.media, media] }), expected);
  }).immediate();
  return { ...getStudioEnvelope(), media };
}
export function isPublishedMedia(id: string): boolean {
  // 历史版本仍可回滚，所以历史快照引用的不可变文件也保持可访问。
  return !!getDatabase().prepare("SELECT 1 FROM cms_release r, json_each(r.manifest_json, '$.media') m WHERE json_extract(m.value, '$.url') = ? LIMIT 1").get(`/api/media/${id}`);
}
export function readMediaFile(id: string) {
  const row = getDatabase().prepare('SELECT filename, mime, sha256 FROM cms_media_file WHERE id = ?').get(id) as { filename: string; mime: string; sha256: string } | undefined;
  if (!row || !/^[a-f0-9]{64}\.(webp|jpg|png|mp4|webm|pdf)$/.test(row.filename)) throw new ApiError(404, '素材文件不存在');
  const path = join(getDataDirectory(), 'media', row.filename);
  if (!existsSync(path)) throw new ApiError(404, '素材文件缺失');
  return { bytes: readFileSync(path), mime: row.mime, etag: row.sha256 };
}
async function writeImageVariant(bytes: Buffer, hash: string, width: number) {
  const directory = join(getDataDirectory(), 'media'); mkdirSync(directory, { recursive: true });
  const path = join(directory, `${hash}.w${width}.webp`);
  if (!existsSync(path)) { const output = await sharp(bytes, { limitInputPixels: 40_000_000 }).resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(); try { writeFileSync(path, output, { flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
  return path;
}
export async function readImageVariant(id: string, width: number) {
  if (!(IMAGE_WIDTHS as readonly number[]).includes(width)) throw new ApiError(422, '图片尺寸只支持320、768、1440');
  const source = readMediaFile(id); if (!['image/webp', 'image/jpeg', 'image/png'].includes(source.mime)) throw new ApiError(422, '只有图片可以选择衍生尺寸');
  const bytes = readFileSync(await writeImageVariant(source.bytes, source.etag, width));
  return { bytes, mime: 'image/webp', etag: createHash('sha256').update(bytes).digest('hex') };
}
export function hasDraftMedia(id: string) { return getDraftRecord().content.media.some((media) => media.id === id); }
export function deleteMedia(id: string, value: unknown) {
  const expected = revision(object(value, '删除素材').expectedRevision);
  getDatabase().transaction(() => {
    const current = getDraftRecord();
    if (current.revision !== expected) throw new ApiError(409, '素材库已变化，请刷新后重试');
    const item = current.content.media.find((media) => media.id === id); if (!item) throw new ApiError(404, '素材不存在');
    if (collectReferences(current.content).urls.has(item.url)) throw new ApiError(422, '素材仍被草稿页面、同步区块、产品或内容记录引用，请先替换引用');
    // 删除仅移出素材库，不删除历史版本使用的文件；后续清理只能处理无引用的孤立文件。
    writeDraft({ ...current.content, media: current.content.media.filter((media) => media.id !== id) }, expected);
  }).immediate();
  return getStudioEnvelope();
}
