import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { AiSourceEnhanceRequest, AiSourceImage } from '../lib/ai-source-types';
import { readAiSource, type AiSourceRecord } from './ai-source-import';
import { enhanceAiSourceFile } from './ai-source-enhance-files';
import { cleanAiSourcePrivate, readAiSourcePrivate, writeAiSourcePrivate } from './ai-source-private';
import { getDatabase } from './database';
import { ApiError } from './http';
import { readMediaFile, uploadMedia } from './media';
import { recordAudit } from './audit';
import { getDraftRecord, getStudioEnvelope } from './studio';
import { object, revision } from './validation';
import type { Actor } from './permissions';

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
function only(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).some(key => !keys.includes(key))) throw new ApiError(422, '资料增强请求包含不支持的字段'); }
function encoded(value: unknown) { const json = JSON.stringify(value); if (Buffer.byteLength(json) > MAX_RECORD_BYTES) throw new ApiError(413, '识别后来源资料过大，请拆分文件'); return json; }

/** 只有用户主动选择页码和处理方式才进行离线增强，上传不自动运行OCR或提取公开素材。 */
export async function enhanceAiSource(id: string, value: unknown, actor: Actor, signal?: AbortSignal, checkAccess?: () => void): Promise<AiSourceRecord> {
  const input = object(value, '资料增强'); only(input, ['pageNumbers', 'ocr', 'images', 'language']);
  const record = readAiSource(id, actor); if (!record.source.enhancementAvailable) throw new ApiError(410, '这份旧记录未保留私有原件，请重新上传后使用离线识别和抽图');
  cleanAiSourcePrivate(actor.id);
  const options = input as unknown as AiSourceEnhanceRequest;
  if (record.source.kind === 'pdf' && Array.isArray(options.pageNumbers) && options.pageNumbers.some(page => !record.source.pages?.some(item => item.pageNumber === page))) throw new ApiError(422, '请选择当前文件已有页码');
  const bytes = readAiSourcePrivate(actor.id, id); if (createHash('sha256').update(bytes).digest('hex') !== record.source.sha256) throw new ApiError(409, '私有原件与来源记录不一致，请重新上传');
  const result = await enhanceAiSourceFile(bytes, record.source.kind, options, signal);
  checkAccess?.();
  return getDatabase().transaction(() => {
    checkAccess?.(); const current = readAiSource(id, actor);
    if (JSON.stringify(current.source) !== JSON.stringify(record.source)) throw new ApiError(409, '资料在处理期间已改变，请重新选择；未覆盖后来的识别结果');
    const images = new Map((current.source.images || []).map(image => [image.id, image]));
    for (const image of result.images) { const { data, ...metadata } = image; if (images.size >= 80 && !images.has(image.id)) throw new ApiError(413, '单份资料最多保留80张提取图片，请拆分文件'); writeAiSourcePrivate(actor.id, id, `${image.id}.webp`, data); images.set(image.id, { ...metadata, ...(images.get(image.id)?.adoptedMediaId ? { adoptedMediaId: images.get(image.id)!.adoptedMediaId } : {}) }); }
    const pages = current.source.pages?.map(page => { const ocr = result.pages.find(item => item.pageNumber === page.pageNumber); return ocr ? { ...page, originalText: page.originalText ?? page.text, text: ocr.text, needsOcr: !ocr.text.trim(), ocr: { text: ocr.text, confidence: ocr.confidence, language: options.language, createdAt: new Date().toISOString(), needsReview: true as const } } : page; });
    const source = { ...current.source, ...(pages ? { pages, textChars: pages.reduce((count, page) => count + page.text.length, 0) } : {}), images: [...images.values()], enhancementWarnings: [...new Set([...(current.source.enhancementWarnings || []), ...result.warnings])] };
    if ((source.textChars || 0) > 150000 && source.kind === 'pdf') throw new ApiError(413, '识别后PDF文字超过150000字符，请拆分文件');
    getDatabase().prepare("UPDATE cms_ai_source SET payload_json=? WHERE id=? AND actor_id=? AND kind='source'").run(encoded(source), id, actor.id);
    recordAudit(actor, 'ai.source', 'success', { objectIds: [id], fields: [options.ocr ? 'offlineOcr' : 'embeddedImages'] }); return readAiSource(id, actor);
  }).immediate();
}

/** 原件仅以本人鉴权附件下载供逐页核对，不提供公开URL或内联执行文档的入口。 */
export function readAiSourceOriginal(id: string, actor: Actor) { const record = readAiSource(id, actor); if (!record.source.enhancementAvailable) throw new ApiError(410, '旧来源没有保留原件，请重新上传'); const bytes = readAiSourcePrivate(actor.id, id); if (createHash('sha256').update(bytes).digest('hex') !== record.source.sha256) throw new ApiError(409, '原件与来源不一致，请重新上传'); return { bytes, mime: record.source.mime, fileName: record.source.fileName }; }

/** 来源图片始终先核对私有归属与期限；接口不能用UUID直接绕过来源记录获取图片。 */
export async function readAiSourceImage(id: string, imageId: string, actor: Actor, thumbnail = true, checkAccess?: () => void) {
  const record = readAiSource(id, actor), image = record.source.images?.find(image => image.id === imageId); if (!image) throw new ApiError(404, '找不到当前资料的图片');
  let bytes = readAiSourcePrivate(actor.id, id, imageId); if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new ApiError(409, '来源图片已变化，请重新提取');
  if (thumbnail) bytes = await sharp(bytes, { limitInputPixels: 6000000 }).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  checkAccess?.(); readAiSource(id, actor); return { bytes, mime: 'image/webp', etag: createHash('sha256').update(bytes).digest('hex') };
}
function adoptionName(id: string, image: AiSourceImage) { return `${id}-${image.id}.webp`; }
/** 明确采用单张才走原素材上传器重编码；网络失联后的同一来源采用可按固定名称和内容哈希恢复回执。 */
export async function adoptAiSourceImage(id: string, value: unknown, actor: Actor, checkAccess?: () => void) {
  const input = object(value, '采用资料图片'); only(input, ['imageId', 'expectedRevision']); const expected = revision(input.expectedRevision), record = readAiSource(id, actor), image = record.source.images?.find(image => image.id === input.imageId);
  if (!image) throw new ApiError(422, '请选择当前资料中实际提取的图片'); const before = getDraftRecord();
  const name = adoptionName(id, image), file = await readAiSourceImage(id, image.id, actor, false, checkAccess), existing = before.content.media.find(media => media.kind === 'image' && (media.id === image.adoptedMediaId || media.name === name && media.folder === '资料导入'));
  if (existing) {
    // 与原上传器同样重编码，不能只凭用户可修改的素材名误认一次失联的采用。
    const normalized = await sharp(file.bytes, { limitInputPixels: 6000000 }).rotate().webp({ quality: 90 }).toBuffer();
    if (readMediaFile(existing.id).etag !== createHash('sha256').update(normalized).digest('hex')) throw new ApiError(409, '同名素材与来源图片不一致，请在素材中心核对');
    return getDatabase().transaction(() => {
      checkAccess?.(); const current = readAiSource(id, actor), media = getDraftRecord().content.media.find(item => item.id === existing.id && item.url === existing.url && item.kind === 'image');
      // 重编码等待期间另一窗口可能移除素材；不可用仍保留的不可变文件冒充素材库中的成功采用。
      if (!media) throw new ApiError(409, '原采用素材已从素材库移除或替换，请读取最新资料后重新采用');
      const source = { ...current.source, images: current.source.images?.map(item => item.id === image.id ? { ...item, adoptedMediaId: media.id } : item) };
      getDatabase().prepare("UPDATE cms_ai_source SET payload_json=? WHERE id=? AND actor_id=? AND kind='source'").run(encoded(source), id, actor.id);
      return { ...getStudioEnvelope(), media, source: readAiSource(id, actor) };
    }).immediate();
  }
  if (getDraftRecord().revision !== expected) throw new ApiError(409, '工作区已变化，请读取最新内容后采用图片');
  const form = new FormData(); form.set('file', new File([new Uint8Array(file.bytes)], name, { type: 'image/webp' })); form.set('expectedRevision', String(expected)); form.set('folder', '资料导入');
  const result = await uploadMedia(form, () => { checkAccess?.(); readAiSource(id, actor); });
  return getDatabase().transaction(() => {
    checkAccess?.(); const current = readAiSource(id, actor), source = { ...current.source, images: current.source.images?.map(item => item.id === image.id ? { ...item, adoptedMediaId: result.media.id } : item) };
    getDatabase().prepare("UPDATE cms_ai_source SET payload_json=? WHERE id=? AND actor_id=? AND kind='source'").run(encoded(source), id, actor.id); recordAudit(actor, 'ai.source', 'success', { objectIds: [id, result.media.id], fields: ['adoptImage'] }); return { ...result, source: readAiSource(id, actor) };
  }).immediate();
}
