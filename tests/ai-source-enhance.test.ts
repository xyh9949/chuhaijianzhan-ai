import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { deleteAiSource, readAiSource, uploadAiSource, previewAiSourceProducts, applyAiSourceProducts } from '../src/server/ai-source-import';
import { adoptAiSourceImage, enhanceAiSource, readAiSourceImage, readAiSourceOriginal } from '../src/server/ai-source-enhance';
import { readAiSourcePrivate } from '../src/server/ai-source-private';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';

const actor: Actor = { id: 'source-enhance-admin', role: 'admin', name: 'Admin', email: 'source@example.invalid' }, other = { ...actor, id: 'source-enhance-other' };
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => { previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-source-enhance-service-')); process.env.FORM_STUDIO_DATA_DIR = directory; process.env.BETTER_AUTH_SECRET = 'source-enhance-secret-'.repeat(4); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3298'; getDraftRecord(); const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(createEmptyDraft())); db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); for (const value of [actor, other]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(value.id, value.name, value.email, value.role); });
afterEach(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(resolve(tmpdir()) + sep + 'studio-source-enhance-service-')) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
async function upload(bytes: Uint8Array, name: string, checkAccess?: () => void) { const form = new FormData(); form.set('file', new File([new Uint8Array(bytes)], name)); return uploadAiSource(new Request('http://127.0.0.1/api/ai/sources', { method: 'POST', body: form }), actor, checkAccess); }
async function spreadsheet() { const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Products'); sheet.addRow(['Product name', 'SKU']); sheet.addRow(['Steel sample', '00025']); const raw = await sharp({ create: { width: 180, height: 120, channels: 3, background: '#334455' } }).png().toBuffer(), imageId = book.addImage({ buffer: raw as never, extension: 'png' }); sheet.addImage(imageId, { tl: { col: 2, row: 1 }, ext: { width: 180, height: 120 } }); return new Uint8Array(await book.xlsx.writeBuffer()); }

test('原件短存私有目录、真实抽图只留本人来源，解码后fresh核对、过期和删除均不能越权读取', async () => {
  const bytes = await spreadsheet(), before = getStudioEnvelope(), record = await upload(bytes, 'private-products.xlsx'); assert.equal(record.source.enhancementAvailable, true); assert.equal(createHash('sha256').update(readAiSourcePrivate(actor.id, record.id)).digest('hex'), record.source.sha256); assert.deepEqual(getStudioEnvelope(), before);
  assert.deepEqual(readAiSourceOriginal(record.id, actor).bytes, Buffer.from(bytes)); assert.throws(() => readAiSourceOriginal(record.id, other), status(404)); const enhanced = await enhanceAiSource(record.id, { images: true, ocr: false, language: 'eng' }, actor); assert.equal(enhanced.source.images?.length, 1); assert.deepEqual(getStudioEnvelope(), before); const image = enhanced.source.images![0]; assert.equal(image.adoptedMediaId, undefined); const thumbnail = await readAiSourceImage(record.id, image.id, actor); assert.equal((await sharp(thumbnail.bytes).metadata()).format, 'webp');
  await assert.rejects(readAiSourceImage(record.id, image.id, other), status(404)); await assert.rejects(readAiSourceImage(record.id, image.id, actor, true, () => { throw new ApiError(401, 'expired test session'); }), status(401)); assert.deepEqual(getStudioEnvelope(), before);
  getDatabase().prepare('UPDATE cms_ai_source SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), record.id); await assert.rejects(readAiSourceImage(record.id, image.id, actor), status(410)); getDatabase().prepare('UPDATE cms_ai_source SET expires_at=? WHERE id=?').run(new Date(Date.now() + 100000).toISOString(), record.id); deleteAiSource(record.id, actor); assert.throws(() => readAiSourcePrivate(actor.id, record.id), status(410)); assert.throws(() => readAiSourcePrivate(actor.id, '../escape'), status(422));
});

test('明确采用才经原素材器入库、重复与失联恢复不新增，XLSX行配图须人工确认后才导入', async () => {
  const record = await upload(await spreadsheet(), 'products.xlsx'), enhanced = await enhanceAiSource(record.id, { images: true, ocr: false, language: 'eng' }, actor), image = enhanced.source.images![0]; const spec = { expectedRevision: 0, sheetIndex: 1, headerRow: 1, mapping: { c1: 'builtin:name', c2: 'builtin:sku' }, extraColumns: 'ignore' };
  assert.equal(previewAiSourceProducts(record.id, spec, actor).rows[0].values.image, undefined); assert.throws(() => previewAiSourceProducts(record.id, { ...spec, rowImages: [{ row: 2, imageId: image.id }] }, actor), status(422));
  const adopted = await adoptAiSourceImage(record.id, { imageId: image.id, expectedRevision: 0 }, actor); assert.equal(adopted.revision, 1); assert.equal(adopted.state.media.length, 1); assert.equal(adopted.state.products.length, 0); assert.equal(adopted.activeReleaseId, null); const repeated = await adoptAiSourceImage(record.id, { imageId: image.id, expectedRevision: 0 }, actor); assert.equal(repeated.revision, 1); assert.equal(repeated.media.id, adopted.media.id);
  // 模拟素材已提交而来源回执响应失联，名称和真实重编码hash可恢复同一采用。
  const source = readAiSource(record.id, actor).source; delete source.images![0].adoptedMediaId; getDatabase().prepare('UPDATE cms_ai_source SET payload_json=? WHERE id=?').run(JSON.stringify(source), record.id); const recovered = await adoptAiSourceImage(record.id, { imageId: image.id, expectedRevision: 0 }, actor); assert.equal(recovered.revision, 1); assert.equal(recovered.source.source.images![0].adoptedMediaId, adopted.media.id);
  assert.throws(() => previewAiSourceProducts(record.id, { ...spec, expectedRevision: 1, rowImages: [{ row: 2, imageId: 'img-invented' }] }, actor), status(422));
  const preview = previewAiSourceProducts(record.id, { ...spec, expectedRevision: 1, rowImages: [{ row: 2, imageId: image.id }] }, actor); assert.equal(preview.errors.length, 0); assert.equal(preview.rows[0].values.image, adopted.media.url); const saved = applyAiSourceProducts(record.id, { expectedRevision: 1, previewId: preview.previewId }, actor); assert.equal(saved.state.products[0].image, adopted.media.url); assert.equal(saved.state.media.length, 1); assert.equal(saved.activeReleaseId, null);
});

test('增强后来源改动/撤权/失效会话拒绝落库，旧来源无原件不伪称支持OCR', async () => {
  const record = await upload(await spreadsheet(), 'products.xlsx'), before = JSON.stringify(record.source); await assert.rejects(enhanceAiSource(record.id, { images: true, ocr: false, language: 'eng' }, actor, undefined, () => { throw new ApiError(401, 'session revoked'); }), status(401)); assert.equal(JSON.stringify(readAiSource(record.id, actor).source), before);
  const controller = new AbortController(), pending = enhanceAiSource(record.id, { images: true, ocr: false, language: 'eng' }, actor, controller.signal); getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(actor.id); await assert.rejects(pending, status(403)); getDatabase().prepare("UPDATE auth_user SET role='admin' WHERE id=?").run(actor.id); assert.equal(JSON.stringify(readAiSource(record.id, actor).source), before);
  const source = record.source; delete source.enhancementAvailable; getDatabase().prepare('UPDATE cms_ai_source SET payload_json=? WHERE id=?').run(JSON.stringify(source), record.id); await assert.rejects(enhanceAiSource(record.id, { images: true, ocr: false, language: 'eng' }, actor), status(410));
});

test('PDF文字层与OCR稿分开保留，人工核对标识不会写入企业或公开内容', async () => {
  const doc = await PDFDocument.create(); doc.addPage().drawText('Factory original supplied text', { x: 40, y: 700, size: 24 }); const record = await upload(await doc.save(), 'company.pdf'), before = getStudioEnvelope(), result = await enhanceAiSource(record.id, { images: false, ocr: true, language: 'eng', pageNumbers: [1] }, actor); assert.match(result.source.pages![0].originalText!, /Factory original supplied text/); assert.match(result.source.pages![0].ocr!.text, /Factory original supplied text/); assert.equal(result.source.pages![0].ocr!.needsReview, true); assert.equal(result.source.pages![0].needsOcr, false); assert.deepEqual(getStudioEnvelope(), before);
});
