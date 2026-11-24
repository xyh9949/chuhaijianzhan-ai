import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import ExcelJS from 'exceljs';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { createInquiry, getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import type { Actor } from '../src/server/permissions';
import type { AiExtractedSource } from '../src/lib/ai-source-types';
import type { Product } from '../src/lib/types';
import { ApiError } from '../src/server/http';
import { uploadAiSource, readAiSource, listAiSources, deleteAiSource, previewAiSourceProducts, applyAiSourceProducts, readAiSourceJsonRequest, listExcelSkuUpdates, undoExcelSkuUpdate } from '../src/server/ai-source-import';

const admin: Actor = { id: 'source-admin', name: '资料管理员', email: 'admin@example.invalid', role: 'admin' };
const other: Actor = { id: 'source-other', name: '其他管理员', email: 'other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'source-editor', name: '编辑员', email: 'editor@example.invalid', role: 'editor' };
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-ai-source-import-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'source-import-test-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3296';
  getDraftRecord(); const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(createEmptyDraft()));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-ai-source-import-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function status(code: number) { return (error: unknown) => error instanceof ApiError && error.status === code; }
function extracted(): AiExtractedSource {
  return { kind: 'xlsx', fileName: 'private-product-catalog.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 500, sha256: '0'.repeat(64), textChars: 300, warnings: [], sheets: [
    { index: 1, name: 'Products', hidden: false, rowCount: 4, columnCount: 7, hiddenColumns: [6], rows: [
      { rowNumber: 3, cells: ['Product name', 'SKU', 'Material', 'Width (mm)', 'Enabled', 'Private cost', 'Sort'], formulaColumns: [] },
      { rowNumber: 5, cells: ['Chair', '0007', 'Wood', '0', 'false', 'PRIVATE-HIDDEN-COST', '0'], formulaColumns: [4] },
      { rowNumber: 7, cells: ['Hidden product', '0000', 'Private', '1', 'true', 'PRIVATE-HIDDEN-ROW', '1'], formulaColumns: [], hidden: true },
      { rowNumber: 9, cells: ['Desk', '0008', 'Steel', '1200', 'true', 'PRIVATE-HIDDEN-COST', '2'], formulaColumns: [] },
    ] },
  ] };
}
function store(source = extracted(), actor = admin) {
  const id = `ais-${randomUUID()}`; getDatabase().prepare('INSERT INTO cms_ai_source(id,actor_id,kind,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id, actor.id, 'source', -1, JSON.stringify(source), new Date().toISOString(), new Date(Date.now() + 7200000).toISOString()); return id;
}
function spec(extra: Record<string, unknown> = {}) { return { expectedRevision: 0, sheetIndex: 1, headerRow: 3, mapping: { c1: 'builtin:name', c2: 'builtin:sku', c3: 'builtin:material', c7: 'builtin:sortOrder' }, extraColumns: 'description', ...extra }; }

test('真实Excel上传只暂存提取文字，不修改草稿、不公开原文件或自动调用AI', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Products'); sheet.addRow(['Name', 'SKU']); sheet.addRow(['Uploaded chair', '000123']);
  const data = await workbook.xlsx.writeBuffer(), form = new FormData(); form.set('file', new File([new Uint8Array(data)], 'private-upload-products.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const before = getStudioEnvelope(), result = await uploadAiSource(new Request('http://localhost/api/ai/sources', { method: 'POST', body: form }), admin);
  assert.equal(result.source.kind, 'xlsx'); assert.equal(result.source.sheets?.[0].rows[1].cells[1], '000123'); assert.deepEqual(getStudioEnvelope(), before);
  assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_media_file').get() as { n: number }).n, 0); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_build').get() as { n: number }).n, 0);
  assert.equal(JSON.stringify(getStudioEnvelope()).includes('private-upload-products.xlsx'), false); const list = listAiSources(admin); assert.equal(list.items[0].id, result.id); assert.equal(Object.hasOwn(list.items[0], 'source'), false);
});

test('产品预检保留0/false/前导零和单位，隐藏数据不进入导入且不写网站', () => {
  const id = store(), before = getStudioEnvelope(), result = previewAiSourceProducts(id, spec(), admin);
  assert.equal(result.errors.length, 0); assert.ok(result.previewId); assert.equal(result.rowCount, 2); assert.deepEqual(result.rows.map(row => row.row), [5, 9]); assert.equal(result.rows[0].sku, '0007'); assert.equal(result.rows[0].values.sortOrder, 0);
  assert.match(String(result.rows[0].values.description), /Width \(mm\)：0/); assert.match(String(result.rows[0].values.description), /Enabled：false/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-HIDDEN/); assert.ok(result.warnings.some(warning => warning.includes('隐藏'))); assert.ok(result.warnings.some(warning => warning.includes('公式')));
  assert.equal(Object.hasOwn(result, 'confirmation'), false); assert.deepEqual(getStudioEnvelope(), before); assert.equal(readAiSource(id, admin).source.sheets?.[0].rows[1].cells[3], '0');
});

test('仅隐藏列有值的尾行不计入可导入产品或公式统计，与审核表可见行一致', () => {
  const source = extracted(); source.sheets![0].rows[1].formulaColumns.push(6); source.sheets![0].rows.push({ rowNumber: 1000, cells: [' ', '', '', '', '', 'PRIVATE-HIDDEN-ONLY-TAIL', ''], formulaColumns: [6] }); source.sheets![0].rowCount += 1;
  const id = store(source), before = getStudioEnvelope(), checked = previewAiSourceProducts(id, spec(), admin);
  assert.deepEqual(checked.errors, []); assert.ok(checked.previewId); assert.equal(checked.rowCount, 2); assert.deepEqual(checked.rows.map(row => row.row), [5, 9]); assert.doesNotMatch(JSON.stringify(checked), /PRIVATE-HIDDEN-ONLY-TAIL/);
  assert.ok(checked.warnings.some(warning => warning.includes('含1个公式单元格')), '公式数只计入选中产品的可见列');
  const selected = previewAiSourceProducts(id, spec({ skipRows: [9] }), admin); assert.equal(selected.rowCount, 1); assert.deepEqual(selected.rows.map(row => row.row), [5]); assert.deepEqual(getStudioEnvelope(), before);
  const saved = applyAiSourceProducts(id, { previewId: checked.previewId, expectedRevision: 0 }, admin); assert.equal(saved.importedProductIds.length, 2); assert.equal(saved.state.products.length, 2);
});

test('审核编辑/跳过与忽略参数明确生效，不修改原始提取结果', () => {
  const id = store(), result = previewAiSourceProducts(id, spec({ skipRows: [9], edits: [{ row: 5, values: { c1: 'Reviewed chair', c2: '0009', c4: '10 mm' } }] }), admin);
  assert.equal(result.rowCount, 1); assert.equal(result.rows[0].title, 'Reviewed chair'); assert.equal(result.rows[0].sku, '0009'); assert.match(String(result.rows[0].values.description), /10 mm/); assert.equal(readAiSource(id, admin).source.sheets?.[0].rows[1].cells[0], 'Chair');
  const ignored = previewAiSourceProducts(id, spec({ extraColumns: 'ignore' }), admin); assert.equal(ignored.rows[0].values.description, undefined); assert.ok(ignored.warnings.some(warning => warning.includes('已明确忽略')));
});

test('确认只新增普通产品草稿，幂等重试与旧网站/询盘/公开指针保持', () => {
  const id = store(); createInquiry({ name: 'Synthetic buyer', email: 'buyer@example.invalid', message: 'Keep private enquiry' }); const before = getStudioEnvelope(), checked = previewAiSourceProducts(id, spec(), admin);
  const result = applyAiSourceProducts(id, { previewId: checked.previewId, expectedRevision: 0 }, admin), retried = applyAiSourceProducts(id, { previewId: checked.previewId, expectedRevision: 0 }, admin);
  assert.equal(result.revision, 1); assert.equal(retried.revision, 1); assert.deepEqual(retried.state, result.state); assert.equal(result.state.products.length, 2); assert.equal(result.state.products[0].status, 'draft'); assert.equal(result.state.products[0].image, ''); assert.equal(result.activeReleaseId, null);
  assert.deepEqual(result.importedProductIds, result.state.products.map(product => product.id)); assert.deepEqual(retried.importedProductIds, result.importedProductIds);
  for (const field of ['pages', 'editorData', 'media', 'settings', 'theme', 'inquiries', 'releases'] as const) assert.deepEqual(result.state[field], before.state[field]);
  assert.equal(JSON.stringify(result.state.products).includes('private-product-catalog.xlsx'), false); assert.equal(JSON.stringify(result.state.products).includes('PRIVATE-HIDDEN'), false);
  const repeated = previewAiSourceProducts(id, { ...spec(), expectedRevision: 1 }, admin); assert.ok(repeated.errors.length); assert.equal(repeated.previewId, undefined); assert.ok(repeated.errors.some(error => error.row === 5 || error.row === 9));
});

test('重复SKU/错误字段映射按原工作表行号报错，用户不能注入新目标或隐藏列', () => {
  const source = extracted(); source.sheets![0].rows[3].cells[1] = '0007'; const id = store(source), result = previewAiSourceProducts(id, spec(), admin);
  assert.ok(result.errors.some(error => error.row === 9 && error.message.includes('重复'))); assert.equal(result.previewId, undefined);
  assert.throws(() => previewAiSourceProducts(id, spec({ mapping: { c1: 'builtin:name', c2: 'builtin:sku', c6: 'builtin:description' } }), admin), status(422));
  assert.throws(() => previewAiSourceProducts(id, spec({ mapping: { c1: 'builtin:name', c2: 'builtin:sku', c3: 'builtin:image' } }), admin), status(422));
  assert.throws(() => previewAiSourceProducts(id, spec({ edits: [{ row: 999, values: { c1: 'Injected' } }] }), admin), status(422));
  assert.throws(() => previewAiSourceProducts(id, spec({ extraColumns: ['description'] }), admin), status(422));
  assert.equal(getDraftRecord().revision, 0);
});

test('并发修改与五分钟确认到期均拒绝，源资料仍能重新免费检查', () => {
  const id = store(), first = previewAiSourceProducts(id, spec(), admin), stamp = Date.now();
  assert.throws(() => applyAiSourceProducts(id, { previewId: first.previewId, expectedRevision: 0 }, admin, stamp + 300001), status(409));
  const theme = { ...getDraftRecord().content.theme, primary: '#123456' }; patchStudio({ expectedRevision: 0, patch: { theme } }, admin);
  assert.throws(() => applyAiSourceProducts(id, { previewId: first.previewId, expectedRevision: 0 }, admin), status(409));
  const latest = previewAiSourceProducts(id, { ...spec(), expectedRevision: 1 }, admin); assert.ok(latest.previewId); const result = applyAiSourceProducts(id, { previewId: latest.previewId, expectedRevision: 1 }, admin); assert.equal(result.revision, 2); assert.equal(result.state.theme.primary, '#123456');
});

test('来源和预检仅创建者管理员可用，停用/降权/过期与删除都不越权', () => {
  const id = store(), checked = previewAiSourceProducts(id, spec(), admin);
  assert.throws(() => readAiSource(id, other), status(404)); assert.throws(() => readAiSource(id, editor), status(403)); assert.equal(listAiSources(other).items.length, 0); assert.throws(() => applyAiSourceProducts(id, { previewId: checked.previewId, expectedRevision: 0 }, other), status(404));
  getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); assert.throws(() => applyAiSourceProducts(id, { previewId: checked.previewId, expectedRevision: 0 }, admin), status(403));
  getDatabase().prepare("UPDATE auth_user SET role='admin',banned=1 WHERE id=?").run(admin.id); assert.throws(() => readAiSource(id, admin), status(401)); getDatabase().prepare('UPDATE auth_user SET banned=0 WHERE id=?').run(admin.id);
  const another = store(extracted(), other); deleteAiSource(id, admin); assert.throws(() => readAiSource(id, admin), status(404)); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_source WHERE actor_id=?').get(admin.id) as { n: number }).n, 0); assert.equal(readAiSource(another, other).id, another);
  getDatabase().prepare('UPDATE cms_ai_source SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', another); assert.throws(() => readAiSource(another, other), status(410));
});

test('超500行不能静默截取，选择分批与容量/请求大小边界明确拒绝', async () => {
  const source = extracted(); source.sheets![0].rows = [{ rowNumber: 1, cells: ['Name', 'SKU'], formulaColumns: [] }, ...Array.from({ length: 501 }, (_, index) => ({ rowNumber: index + 2, cells: [`Product ${index}`, `SKU-${index}`], formulaColumns: [] }))]; source.sheets![0].columnCount = 2; source.sheets![0].hiddenColumns = [];
  const id = store(source); assert.throws(() => previewAiSourceProducts(id, spec({ headerRow: 1, mapping: { c1: 'builtin:name', c2: 'builtin:sku' } }), admin), status(422)); const selected = previewAiSourceProducts(id, spec({ headerRow: 1, mapping: { c1: 'builtin:name', c2: 'builtin:sku' }, skipRows: [502] }), admin); assert.equal(selected.rowCount, 500);
  for (let index = 0; index < 28; index++) store(); const form = new FormData(); form.set('file', new File(['not parsed at capacity'], 'invalid.xlsx')); await assert.rejects(uploadAiSource(new Request('http://localhost', { method: 'POST', body: form }), admin), status(429));
  await assert.rejects(readAiSourceJsonRequest(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(2 * 1024 * 1024 + 1) })), status(413));
});

const existingProducts: Product[] = [
  { id: 'existing-chair', name: 'Existing chair', sku: '0007', category: 'Furniture', image: '/images/chair.jpg', description: 'Established copy', material: 'Metal', slug: 'keep-chair-url', status: 'draft' },
  { id: 'existing-desk', name: 'Existing desk', sku: '0008', category: 'Furniture', image: '', description: '', material: 'Oak', slug: 'keep-desk-url', status: 'draft' },
];
function updateSpec(extra: Record<string, unknown> = {}) { return spec({ mode: 'update', expectedRevision: 1, extraColumns: 'ignore', mapping: { c2: 'builtin:sku', c3: 'builtin:material', c7: 'builtin:sortOrder' }, ...extra }); }

test('按SKU更新预览只比较选中行列，保留旧身份、网址、未映射字段和可撤销回执', () => {
  const seed = patchStudio({ expectedRevision: 0, patch: { products: existingProducts } }), id = store(), now = Date.now();
  assert.throws(() => previewAiSourceProducts(id, updateSpec({ mapping: { c2: 'builtin:sku', c3: 'builtin:slug' } }), admin), status(422));
  const checked = previewAiSourceProducts(id, updateSpec({ skipRows: [9], edits: [{ row: 5, values: { c3: '  ' } }] }), admin, now);
  assert.deepEqual(checked.errors, []); assert.ok(checked.previewId); assert.deepEqual(checked.updates?.map(row => row.row), [5]);
  assert.deepEqual(checked.updates?.[0].changes, [{ field: 'sortOrder', label: '排序', before: null, beforePresent: false, after: 0 }]);
  assert.deepEqual(getStudioEnvelope(), seed);
  const apply = { previewId: checked.previewId, expectedRevision: seed.revision };
  assert.throws(() => applyAiSourceProducts(id, apply, other, now), status(404));
  assert.throws(() => applyAiSourceProducts(id, apply, admin, now + 300001), status(410));
  const saved = applyAiSourceProducts(id, apply, admin, now + 1);
  assert.equal(saved.revision, seed.revision + 1); assert.equal(saved.state.products[0].sortOrder, 0);
  for (const field of ['id', 'sku', 'name', 'slug', 'description', 'material'] as const) assert.equal(saved.state.products[0][field], existingProducts[0][field]);
  assert.deepEqual(saved.state.products[1], seed.state.products[1]); assert.equal(saved.activeReleaseId, seed.activeReleaseId);
  deleteAiSource(id, admin); assert.throws(() => readAiSource(id, admin), status(404));
  assert.equal(applyAiSourceProducts(id, apply, admin, now + 2).revision, saved.revision);
  assert.equal(listExcelSkuUpdates(admin, now + 2).items[0].rowCount, 1); assert.deepEqual(listExcelSkuUpdates(other, now).items, []);
  const later = patchStudio({ expectedRevision: saved.revision, patch: { products: saved.state.products.map(product => product.id === existingProducts[0].id ? { ...product, description: 'Later manual description' } : product) } });
  const undo = { id: checked.previewId, expectedRevision: later.revision };
  assert.throws(() => undoExcelSkuUpdate(undo, other, now + 3), status(404));
  const restored = undoExcelSkuUpdate(undo, admin, now + 3);
  assert.equal(Object.hasOwn(restored.state.products[0], 'sortOrder'), false);
  assert.equal(restored.state.products[0].description, 'Later manual description');
  assert.equal(undoExcelSkuUpdate(undo, admin, now + 4).revision, restored.revision);
  assert.equal(restored.updateReceipt.undone, true);
});

test('按SKU更新拒绝不匹配及重复型号，过期预览和后来同字段编辑不能覆盖', () => {
  patchStudio({ expectedRevision: 0, patch: { products: existingProducts } });
  const id = store(), unknown = previewAiSourceProducts(id, updateSpec({ edits: [{ row: 9, values: { c2: 'bad-sku' } }] }), admin);
  assert.equal(unknown.previewId, undefined); assert.equal(unknown.errors[0].row, 9); assert.match(unknown.errors[0].message, /找不到现有型号/);
  const duplicate = previewAiSourceProducts(id, updateSpec({ edits: [{ row: 9, values: { c2: '0007 ' } }] }), admin);
  assert.equal(duplicate.previewId, undefined); assert.match(duplicate.errors[0].message, /重复型号/);
  const checked = previewAiSourceProducts(id, updateSpec(), admin); assert.equal(checked.errors.length, 0);
  const saved = applyAiSourceProducts(id, { previewId: checked.previewId, expectedRevision: 1 }, admin);
  const later = patchStudio({ expectedRevision: saved.revision, patch: { products: saved.state.products.map(product => product.id === 'existing-desk' ? { ...product, material: 'Later hand edit' } : product) } });
  assert.throws(() => undoExcelSkuUpdate({ id: checked.previewId, expectedRevision: saved.revision }, admin), status(409));
  assert.throws(() => undoExcelSkuUpdate({ id: checked.previewId, expectedRevision: later.revision }, admin), status(409));
  assert.deepEqual(getStudioEnvelope(), later);
});

test('按SKU更新保留参数的数字0和布尔false，拒绝更新不属于对应参数组的产品', () => {
  const modelId = 'chair-properties', fields = [{ id: 'width', key: 'width', label: '宽度', type: 'number', required: false }, { id: 'active', key: 'active', label: '景点', type: 'boolean', required: false }];
  patchStudio({ expectedRevision: 0, patch: { contentModels: [{ id: modelId, name: '椅子参数', description: '', target: 'product', fields, updated: '' }], products: [{ ...existingProducts[0], modelId, customFields: { width: 10, active: true } }, existingProducts[1]] } });
  const id = store(), req = updateSpec({ modelId, mapping: { c2: 'builtin:sku', c4: 'field:width', c5: 'field:active' } });
  const wrongModel = previewAiSourceProducts(id, req, admin); assert.ok(wrongModel.errors.some(issue => issue.row === 9 && issue.message.includes('参数分组')));
  const checked = previewAiSourceProducts(id, { ...req, skipRows: [9] }, admin);
  assert.deepEqual(checked.errors, []); assert.deepEqual(checked.updates?.[0].changes.map(change => change.after), [0, false]);
  const saved = applyAiSourceProducts(id, { previewId: checked.previewId, expectedRevision: 1 }, admin);
  assert.deepEqual(saved.state.products[0].customFields, { width: 0, active: false });
  assert.deepEqual(undoExcelSkuUpdate({ id: checked.previewId, expectedRevision: saved.revision }, admin).state.products[0].customFields, { width: 10, active: true });
});

test('按SKU更新的封面只使用本表已入库图片，撤销时复原旧相册形态', () => {
  const media = { id: 'sku-cover', name: 'Synthetic selected picture', url: '/api/media/sku-cover', kind: 'image' as const, folder: 'Tests', size: '1 KB', alt: 'Test picture' };
  const original = { ...createEmptyDraft(), products: existingProducts, media: [media] };
  getDatabase().prepare('UPDATE cms_draft SET revision=1,content_json=? WHERE id=1').run(JSON.stringify(original));
  const source = extracted();
  source.images = [{ id: 'workbook-cover', mime: 'image/webp', width: 6, height: 6, bytes: 100, sha256: '0'.repeat(64), adoptedMediaId: media.id, source: { kind: 'xlsx', sheetIndex: 1, sheetName: 'Products', row: 5, column: 1, hidden: false } }];
  const id = store(source), request = updateSpec({ mapping: { c2: 'builtin:sku' }, skipRows: [9], rowImages: [{ row: 5, imageId: 'workbook-cover' }] });
  assert.throws(() => previewAiSourceProducts(id, { ...request, rowImages: [{ row: 5, imageId: 'forged-image' }] }, admin), status(422));
  const checked = previewAiSourceProducts(id, request, admin);
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.updates?.[0].changes.map(change => change.field), ['image', 'images']);
  const saved = applyAiSourceProducts(id, { previewId: checked.previewId, expectedRevision: 1 }, admin);
  assert.equal(saved.state.products[0].image, media.url);
  assert.deepEqual(saved.state.products[0].images, [media.url, existingProducts[0].image]);
  const reverted = undoExcelSkuUpdate({ id: checked.previewId, expectedRevision: saved.revision }, admin);
  assert.equal(reverted.state.products[0].image, existingProducts[0].image);
  assert.equal(Object.hasOwn(reverted.state.products[0], 'images'), false);
});
