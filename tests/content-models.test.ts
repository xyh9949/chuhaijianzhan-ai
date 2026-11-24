import protocol from '../src/lib/protocol.json';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { getDatabase } from '../src/server/database';
import { ApiError } from '../src/server/http';
import { deleteMedia, isPublishedMedia, uploadMedia } from '../src/server/media';
import { activateRelease, getActiveSiteSnapshot, previewPublication, publishSite, restoreDraft } from '../src/server/publication';
import { getDraftRecord, getStudioEnvelope, patchStudio, readRelease } from '../src/server/studio';
import { collectReferences } from '../src/server/validation';
import { formatFieldValue, isEmptyFieldValue, validateFieldValue } from '../src/lib/content-models';
import type { ContentField, ContentModel, ContentEntry } from '../src/lib/types';
import type { DraftContent, PublicationSelection } from '../src/server/types';

const actor = { id: 'model-test-admin', name: '内容模型测试管理员' };
let directory = ''; let previousDirectory: string | undefined;
beforeEach(() => { previousDirectory = process.env.FORM_STUDIO_DATA_DIR; directory = mkdtempSync(join(tmpdir(), 'form-studio-model-test-')); process.env.FORM_STUDIO_DATA_DIR = directory; });
afterEach(() => {
  getDatabase().close();
  // 只清理本测试创建的临时实例，不读写主实例数据库。
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-model-test-`)) rmSync(directory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.FORM_STUDIO_DATA_DIR; else process.env.FORM_STUDIO_DATA_DIR = previousDirectory;
});
const field = (id = 'width', type: ContentField['type'] = 'number', extra: Partial<ContentField> = {}): ContentField => ({ id, key: id, label: id, type, required: false, ...extra });
const model = (id = 'product-model', target: ContentModel['target'] = 'product', fields = [field()]): ContentModel => ({ id, target, name: id, description: '', updated: '', fields });
const entry = (values: ContentEntry['customFields'] = {}): ContentEntry => ({ id: 'entry-case', modelId: 'case-model', title: '项目案例', status: 'draft', updated: '', customFields: values });
const node = (id: string, fieldKey: string, extra = {}) => ({ type: 'Text', props: { id, text: 'fallback', bindings: { text: { source: 'product', mode: 'fixed', recordId: 'p1', modelId: 'product-model', field: fieldKey, ...extra } } } });
const page = (...content: unknown[]) => ({ root: { props: { title: '模型验收' } }, content });
const save = (patch: Partial<DraftContent>) => patchStudio({ expectedRevision: getDraftRecord().revision, patch });
function selection(extra: Partial<PublicationSelection> = {}): PublicationSelection { const state = getStudioEnvelope(); return { expectedRevision: state.revision, baseReleaseId: state.activeReleaseId, pageIds: ['home'], productIds: ['p1'], includeTheme: true, includeSettings: true, ...extra }; }
function setupProduct(fields = [field()], values: Record<string, unknown> = { width: 0 }) {
  const draft = getDraftRecord().content;
  save({ contentModels: [model('product-model', 'product', fields)], products: draft.products.map((item) => item.id === 'p1' ? { ...item, modelId: 'product-model', customFields: values as never } : item), editorData: { ...draft.editorData, home: page(node('width-bound', 'field:width')) } });
}
function reject(action: () => unknown, message?: RegExp) { assert.throws(action, (error) => error instanceof ApiError && error.status === 422 && (!message || message.test(error.message))); }

test('字段值区分0、false与缺失，并按选项标签和单位展示', () => {
  assert.equal(isEmptyFieldValue(0), false); assert.equal(isEmptyFieldValue(false), false);
  assert.deepEqual(validateFieldValue(field('required', 'number', { required: true }), 0, { required: true }), []);
  assert.deepEqual(validateFieldValue(field('available', 'boolean', { required: true }), false, { required: true }), []);
  assert.equal(formatFieldValue(field('width', 'number', { unit: 'mm' }), 0), '0 mm');
  assert.equal(formatFieldValue(field('available', 'boolean'), false), 'No');
  const options = [{ label: '天然木纹', value: 'wood' }, { label: '金属', value: 'metal' }];
  assert.equal(formatFieldValue(field('finish', 'select', { options }), 'wood'), '天然木纹');
  assert.equal(formatFieldValue(field('finish', 'multiselect', { options }), ['wood', 'metal']), '天然木纹, 金属');
});

test('草稿允许必填项暂缺，发布时严格检查所选模型及记录', () => {
  setupProduct([field('width', 'number', { required: true, min: 0, max: 400 })], {});
  const errors = previewPublication(selection({ contentModelIds: ['product-model'] })).errors;
  assert.ok(errors.some((error) => error.includes('必填')));
  const current = getDraftRecord().content;
  save({ products: current.products.map((product) => product.id === 'p1' ? { ...product, customFields: { width: 0 } } : product) });
  const release = publishSite(selection({ contentModelIds: ['product-model'] }), actor);
  assert.equal(readRelease(release.releaseId).products[0].customFields?.width, 0);
  assert.equal(readRelease(release.releaseId).schemaVersion, protocol.snapshot);
});

test('数字日期选项与图片链接严格校验，不接受错误类型或危险协议', () => {
  for (const [definition, value] of [[field('n', 'number'), []], [field('n', 'number'), '12'], [field('n', 'number', { min: 1 }), 0], [field('b', 'boolean'), 'false'], [field('d', 'date'), '2026-02-30'], [field('s', 'select', { options: [{ label: 'A', value: 'a' }] }), 'b'], [field('m', 'multiselect', { options: [{ label: 'A', value: 'a' }] }), ['a', 'a']], [field('img', 'image'), 'https://example.com/file.svg'], [field('gallery', 'gallery'), Array(21).fill('/images/chair.jpg')], [field('link', 'url'), 'javascript:alert(1)']] as const) assert.ok(validateFieldValue(definition as ContentField, value).length);
  assert.deepEqual(validateFieldValue(field('date', 'date'), '2024-02-29'), []);
});

test('模型与固定记录需要显式加入发布，部分发布保留未选草稿', () => {
  setupProduct();
  assert.ok(previewPublication(selection()).errors.some((error) => error.includes('模型')));
  const first = publishSite(selection({ contentModelIds: ['product-model'] }), actor);
  const before = readRelease(first.releaseId), draft = getDraftRecord().content;
  save({ products: draft.products.map((product) => product.id === 'p1' ? { ...product, customFields: { width: 88 } } : product), contentModels: [{ ...draft.contentModels![0], name: '未发布模型名' }] });
  publishSite(selection({ productIds: [], includeTheme: false, includeSettings: false }), actor);
  assert.equal(getActiveSiteSnapshot()!.products[0].customFields?.width, 0);
  assert.equal(getActiveSiteSnapshot()!.contentModels![0].name, before.contentModels![0].name);
  assert.equal(readRelease(first.releaseId).products[0].customFields?.width, 0);
});

test('独立内容记录支持明确发布、删除引用保护及相同快照绑定', () => {
  const draft = getDraftRecord().content;
  save({ contentModels: [model('case-model', 'content', [field('location', 'text')])], contentEntries: [entry({ location: 'Paris' })], editorData: { ...draft.editorData, home: page(node('entry-bound', 'field:location', { source: 'entry', modelId: 'case-model', recordId: 'entry-case' })) } });
  assert.ok(previewPublication(selection({ productIds: [], contentModelIds: ['case-model'] })).errors.some((error) => error.includes('entry-case')));
  const published = publishSite(selection({ productIds: [], contentModelIds: ['case-model'], contentEntryIds: ['entry-case'] }), actor);
  assert.equal(readRelease(published.releaseId).contentEntries![0].customFields.location, 'Paris');
  reject(() => save({ contentEntries: [] }), /不存在/);
  const changed = { ...entry({ location: 'Berlin' }), updated: '伪造时间' };
  save({ contentEntries: [changed] });
  assert.notEqual(getDraftRecord().content.contentEntries![0].updated, '伪造时间');
  publishSite(selection({ pageIds: [], productIds: [], contentEntryIds: ['entry-case'], includeTheme: false, includeSettings: false }), actor);
  assert.equal(getActiveSiteSnapshot()!.contentEntries![0].customFields.location, 'Berlin');
});

test('字段键和类型及模型用途冻结，删除已被值或绑定引用的字段被拒绝', () => {
  setupProduct(); const current = getDraftRecord().content;
  reject(() => save({ contentModels: [model('product-model', 'product', [field('width', 'number', { key: 'new_width' })])] }), /创建后/);
  reject(() => save({ contentModels: [model('product-model', 'product', [field('width', 'text')])] }));
  reject(() => save({ contentModels: [model('product-model', 'content')] }));
  reject(() => save({ contentModels: [model('product-model', 'product', [])] }), /不存在字段/);
  reject(() => save({ contentModels: [] }), /模型不存在/);
  save({ products: current.products.map((product) => product.id === 'p1' ? { ...product, customFields: {} } : product) });
  reject(() => save({ contentModels: [model('product-model', 'product', [])] }), /字段.*不存在/);
});

test('模型发布不能破坏未选线上产品，兼容更新需同时发布记录', () => {
  setupProduct(); publishSite(selection({ contentModelIds: ['product-model'] }), actor);
  const draft = getDraftRecord().content;
  save({ contentModels: [model('product-model', 'product', [field(), field('finish', 'text', { required: true })])], products: draft.products.map((product) => product.id === 'p1' ? { ...product, customFields: { width: 0, finish: 'Oak' } } : product) });
  const partial = selection({ pageIds: [], productIds: [], contentModelIds: ['product-model'], includeTheme: false, includeSettings: false });
  assert.ok(previewPublication(partial).errors.some((error) => error.includes('finish')));
  publishSite({ ...partial, productIds: ['p1'] }, actor);
  assert.equal(getActiveSiteSnapshot()!.products[0].customFields?.finish, 'Oak');
});

test('选项值正在使用时不能删除，未知字段及重复字段键不可保存', () => {
  const draft = getDraftRecord().content, choice = field('finish', 'select', { options: [{ label: '木材', value: 'wood' }, { label: '金属', value: 'metal' }] });
  save({ contentModels: [model('product-model', 'product', [choice])], products: draft.products.map((product) => product.id === 'p1' ? { ...product, modelId: 'product-model', customFields: { finish: 'wood' } } : product) });
  reject(() => save({ contentModels: [model('product-model', 'product', [{ ...choice, options: [{ label: '金属', value: 'metal' }] }])] }), /不在模型选项/);
  reject(() => save({ contentModels: [model('product-model', 'product', [choice, { ...choice, id: 'other' }])] }), /字段键不能重复/);
  reject(() => save({ products: getDraftRecord().content.products.map((product) => product.id === 'p1' ? { ...product, customFields: { missing: 1 } } : product) }), /不存在字段/);
});

test('移除旧选项前须迁移草稿记录，模型与线上旧记录需同时发布', () => {
  const draft = getDraftRecord().content;
  const choice = field('finish', 'select', { options: [{ label: '木材', value: 'wood' }, { label: '金属', value: 'metal' }] });
  save({ contentModels: [model('case-model', 'content', [choice])], contentEntries: [entry({ finish: 'wood' })], editorData: { ...draft.editorData, home: page() } });
  const first = publishSite(selection({ productIds: [], contentModelIds: ['case-model'], contentEntryIds: ['entry-case'] }), actor);

  // 草稿先迁移到现有新选项，再删除旧选项；线上记录仍保持原版本，不能只替换结构。
  save({ contentEntries: [entry({ finish: 'metal' })] });
  save({ contentModels: [model('case-model', 'content', [{ ...choice, options: [{ label: '金属', value: 'metal' }] }])] });
  assert.equal(getDraftRecord().content.contentModels![0].fields[0].options!.length, 1);
  const partial = selection({ pageIds: [], productIds: [], contentModelIds: ['case-model'], includeTheme: false, includeSettings: false });
  assert.ok(previewPublication(partial).errors.some(error => error.includes('不在模型选项')));
  reject(() => publishSite(partial, actor), /不在模型选项/);
  assert.equal(getActiveSiteSnapshot()!.releaseId, first.releaseId);
  assert.equal(getStudioEnvelope().state.releases.length, 1);
  assert.equal(getActiveSiteSnapshot()!.contentEntries![0].customFields.finish, 'wood');

  publishSite({ ...partial, contentEntryIds: ['entry-case'] }, actor);
  assert.equal(getActiveSiteSnapshot()!.contentEntries![0].customFields.finish, 'metal');
  assert.deepEqual(getActiveSiteSnapshot()!.contentModels![0].fields[0].options, [{ label: '金属', value: 'metal' }]);
  assert.equal(readRelease(first.releaseId).contentEntries![0].customFields.finish, 'wood');
  assert.equal(readRelease(first.releaseId).contentModels![0].fields[0].options!.length, 2);
});

test('模型、内容与产品可选择恢复，线上切换不覆盖草稿且旧版本保留定义', () => {
  setupProduct(); const first = publishSite(selection({ contentModelIds: ['product-model'] }), actor);
  const draft = getDraftRecord().content;
  save({ contentModels: [{ ...draft.contentModels![0], name: '新模型名称' }], products: draft.products.map((product) => product.id === 'p1' ? { ...product, customFields: { width: 90 } } : product) });
  const second = publishSite(selection({ contentModelIds: ['product-model'] }), actor);
  const before = getDraftRecord();
  activateRelease(first.releaseId, { expectedActiveReleaseId: second.releaseId }, actor);
  assert.deepEqual(getDraftRecord(), before);
  restoreDraft(first.releaseId, { expectedRevision: before.revision, pageIds: [], productIds: ['p1'], contentModelIds: ['product-model'] }, actor);
  assert.equal(getDraftRecord().content.products[0].customFields?.width, 0);
  assert.equal(getDraftRecord().content.contentModels![0].name, 'product-model');
  assert.equal(getStudioEnvelope().activeReleaseId, first.releaseId);
});

test('扩展图片集纳入删除保护、发布素材与历史恢复', async () => {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#223344' } }).png().toBuffer();
  const form = new FormData(); form.set('file', new File([bytes], 'model.png', { type: 'image/png' })); form.set('expectedRevision', String(getDraftRecord().revision));
  const media = (await uploadMedia(form)).media, draft = getDraftRecord().content;
  save({ contentModels: [model('product-model', 'product', [field('photos', 'gallery')])], products: draft.products.map((product) => product.id === 'p1' ? { ...product, modelId: 'product-model', customFields: { photos: [media.url] } } : product) });
  assert.equal(collectReferences(getDraftRecord().content).urls.has(media.url), true);
  reject(() => deleteMedia(media.id, { expectedRevision: getDraftRecord().revision }), /仍被/);
  const first = publishSite(selection({ contentModelIds: ['product-model'] }), actor);
  assert.ok(readRelease(first.releaseId).media.some((item) => item.id === media.id)); assert.equal(isPublishedMedia(media.id), true);
  save({ products: getDraftRecord().content.products.map((product) => product.id === 'p1' ? { ...product, customFields: {} } : product) });
  deleteMedia(media.id, { expectedRevision: getDraftRecord().revision });
  restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: [], productIds: ['p1'], contentModelIds: ['product-model'] }, actor);
  assert.ok(getDraftRecord().content.media.some((item) => item.id === media.id));
});

test('模型标识和值对象拒绝错误的缺省类型，图片绑定后备值参与依赖', () => {
  const draft = getDraftRecord().content;
  for (const modelId of [false, 0, null]) reject(() => save({ products: draft.products.map((product) => product.id === 'p1' ? { ...product, modelId } : product) } as unknown as Partial<DraftContent>), /模型.*格式不正确/);
  setupProduct();
  reject(() => save({ products: getDraftRecord().content.products.map((product) => product.id === 'p1' ? { ...product, customFields: null } : product) } as unknown as Partial<DraftContent>), /扩展字段必须是对象/);
  const source = { ...getDraftRecord().content, editorData: { home: page({ type: 'Image', props: { id: 'image-fallback', src: '', bindings: { src: { source: 'product', mode: 'fixed', recordId: 'p1', field: 'builtin:image', fallback: '/api/media/fallback-only' } } } }) } };
  assert.equal(collectReferences(source).urls.has('/api/media/fallback-only'), true);
});
