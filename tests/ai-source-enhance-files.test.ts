import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { enhanceAiSourceFile } from '../src/server/ai-source-enhance-files';
import { ApiError } from '../src/server/http';

let directory = '', previous: string | undefined;
beforeEach(() => { previous = process.env.FORM_STUDIO_DATA_DIR; directory = mkdtempSync(join(tmpdir(), 'studio-source-enhance-')); process.env.FORM_STUDIO_DATA_DIR = directory; });
afterEach(() => { if (previous === undefined) delete process.env.FORM_STUDIO_DATA_DIR; else process.env.FORM_STUDIO_DATA_DIR = previous; if (resolve(directory).startsWith(resolve(tmpdir()) + sep + 'studio-source-enhance-')) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
async function scannedPdf() { const surface = createCanvas(1400, 800), context = surface.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1400, 800); context.fillStyle = '#111'; context.font = '64px Arial'; context.fillText('FACTORY MATERIALS', 80, 170); context.font = '48px Arial'; context.fillText('Steel sample MODEL 25', 80, 290); const doc = await PDFDocument.create(), image = await doc.embedPng(surface.toBuffer('image/png')), page = doc.addPage([700, 400]); page.drawImage(image, { x: 0, y: 0, width: 700, height: 400 }); return doc.save(); }

test('真实扫描PDF离线OCR及实际嵌入位图同时提取，不返回页面截图作为产品图', { timeout: 90000 }, async () => {
  const bytes = await scannedPdf(), original = Buffer.from(bytes), value = await enhanceAiSourceFile(bytes, 'pdf', { pageNumbers: [1], ocr: true, images: true, language: 'eng' });
  assert.match(value.pages[0].text, /FACTORY MATERIALS/i); assert.match(value.pages[0].text, /MODEL 25/i); assert.ok(value.pages[0].confidence > 50); assert.equal(value.images.length, 1); assert.equal(value.images[0].width, 1400); assert.equal(value.images[0].height, 800); assert.equal(value.images[0].source.kind, 'pdf'); assert.ok(value.warnings.some(item => item.includes('需人工核对'))); assert.deepEqual(Buffer.from(bytes), original); assert.equal((await sharp(value.images[0].data).metadata()).format, 'webp');
});

test('Excel真实单元格锚点配图包含工作表行列，隐藏状态保留且不下载外部图', async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Products'); sheet.addRow(['Name', 'SKU']); sheet.addRow(['Steel sample', '025']); const raw = await sharp({ create: { width: 200, height: 120, channels: 3, background: '#334455' } }).png().toBuffer(), imageId = book.addImage({ buffer: raw as never, extension: 'png' }); sheet.addImage(imageId, { tl: { col: 2, row: 1 }, ext: { width: 200, height: 120 } }); const hidden = book.addWorksheet('Internal'); hidden.state = 'hidden'; hidden.addImage(imageId, 'B4:C5');
  const value = await enhanceAiSourceFile(new Uint8Array(await book.xlsx.writeBuffer()), 'xlsx', { ocr: false, images: true, language: 'eng' }); assert.equal(value.images.length, 2); const first = value.images[0].source; assert.equal(first.kind, 'xlsx'); if (first.kind === 'xlsx') { assert.equal(first.sheetName, 'Products'); assert.equal(first.row, 2); assert.equal(first.column, 3); assert.equal(first.hidden, false); } const second = value.images[1].source; assert.equal(second.kind, 'xlsx'); if (second.kind === 'xlsx') assert.equal(second.hidden, true); assert.ok(value.warnings.some(item => item.includes('不能自动确认'))); assert.equal(value.pages.length, 0);
});

test('中英扫描图使用随包eng+chi_sim数据真实离线识别，Linux复用同一合成位图不依赖中文系统字体', { timeout: 90000 }, async () => {
  const doc = await PDFDocument.create(), raw = readFileSync(join(process.cwd(), 'tests/fixtures/source-ocr-en-zh.png')), image = await doc.embedPng(raw), page = doc.addPage([800, 325]); page.drawImage(image, { x: 0, y: 0, width: 800, height: 325 }); const value = await enhanceAiSourceFile(await doc.save(), 'pdf', { pageNumbers: [1], ocr: true, images: false, language: 'eng+chi_sim' }); assert.match(value.pages[0].text.replace(/\s/g, ''), /工厂资料/); assert.match(value.pages[0].text, /STEEL SAMPLE/i); assert.equal(value.images.length, 0);
});

test('跨页重复嵌入位图可从PDF真实共享对象读取，每张保留所在页而非丢失后续页', async () => {
  const doc = await PDFDocument.create(), raw = readFileSync(join(process.cwd(), 'tests/fixtures/source-ocr-en-zh.png')), image = await doc.embedPng(raw); for (let index = 0; index < 3; index++) doc.addPage([800, 325]).drawImage(image, { x: 0, y: 0, width: 800, height: 325 }); const result = await enhanceAiSourceFile(await doc.save(), 'pdf', { pageNumbers: [1, 2, 3], ocr: false, images: true, language: 'eng' }); assert.equal(result.images.length, 3); assert.deepEqual(result.images.map(image => image.source.kind === 'pdf' ? image.source.pageNumber : -1), [1, 2, 3]);
});

test('页数/处理方式/语言边界在worker前拒绝，取消真实OCR释放单实例处理位', { timeout: 90000 }, async () => {
  const bytes = await scannedPdf(); await assert.rejects(enhanceAiSourceFile(bytes, 'pdf', { ocr: true, images: false, language: 'eng', pageNumbers: [1, 2, 3, 4, 5, 6] }), status(422)); await assert.rejects(enhanceAiSourceFile(bytes, 'xlsx', { ocr: true, images: false, language: 'eng' }), status(422));
  const controller = new AbortController(), pending = enhanceAiSourceFile(bytes, 'pdf', { ocr: true, images: true, language: 'eng+chi_sim', pageNumbers: [1] }, controller.signal); await assert.rejects(enhanceAiSourceFile(bytes, 'pdf', { ocr: false, images: true, language: 'eng', pageNumbers: [1] }), status(429)); controller.abort(); await assert.rejects(pending, status(499)); assert.equal((await enhanceAiSourceFile(bytes, 'pdf', { ocr: false, images: true, language: 'eng', pageNumbers: [1] })).images.length, 1);
});
