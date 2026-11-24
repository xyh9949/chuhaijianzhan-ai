import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { Data } from '@puckeditor/core';
import type { AiSiteDesignPreview } from '../src/lib/ai-site-design-types';
import type { Actor } from '../src/server/permissions';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { ApiError } from '../src/server/http';
import { uploadMedia } from '../src/server/media';
import { applyAiSiteDesign, createExternalSiteDesignCandidate, readAiSiteDesign, resolveAiSiteDesignPreview, selectAiSiteDesign, undoAiSiteDesign } from '../src/server/ai-site-design';

const admin: Actor = { id: 'selection-owner', name: '范围采用管理员', email: 'selection-owner@example.invalid', role: 'admin' };
const other: Actor = { id: 'selection-other', name: '其他管理员', email: 'selection-other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'selection-editor', name: '编辑员', email: 'selection-editor@example.invalid', role: 'editor' };
const denied = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
let directory = '', previous: NodeJS.ProcessEnv;

function data(id: string): Data {
  return { root: { props: { title: id, brand: '', showChrome: 'yes' } }, zones: {}, content: [
    { type: 'Heading', props: { id: `${id}-title`, text: `Original ${id}`, level: 'h1' } },
    { type: 'Text', props: { id: `${id}-copy`, text: `ORIGINAL_SELECTION_${id}` } },
    ...(id === 'home' ? [{ type: 'ProductList', props: { id: 'home-products', title: 'Products', description: '', category: '', columns: 3, count: 3, padding: 24, background: 'transparent' } }] : []),
  ] } as Data;
}

beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-site-selection-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3294'; process.env.BETTER_AUTH_SECRET = 'synthetic-selection-unit-secret-'.repeat(3);
  getDraftRecord(); const draft = createEmptyDraft();
  draft.settings.name = 'Synthetic selection company'; draft.settings.description = 'Supplied company facts.'; draft.settings.email = 'selection@example.invalid';
  draft.pages = ['home', 'contact', 'spare'].map(id => ({ id, title: id, slug: id === 'home' ? '/' : `/${id}`, type: '普通页面', status: 'draft', updated: '' }));
  draft.editorData = Object.fromEntries(draft.pages.map(page => [page.id, data(page.id)]));
  draft.products = [{ id: 'selection-product', name: 'Real supplied chair', sku: 'S-C01', category: 'Chairs', material: 'Wood', description: 'Original product facts.', image: '', status: 'draft' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-site-selection-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 全部方案通过现有外部编译器真实产生；不配置模型、不直写候选布局来模拟采用成功。 */
function source() {
  return createExternalSiteDesignCandidate({ expectedRevision: getDraftRecord().revision, instruction: '调整两个页面、动态产品卡片、页眉页脚导航与品牌色，随后选择满意部分。', targets: { pageIds: ['home', 'contact', 'spare'], header: true, footer: true, navigation: true, style: true }, preserveText: false }, {
    summary: '准备跨页设计与独立动态卡片。', warnings: [], operations: [
      { kind: 'page', pageId: 'home', operations: [{ kind: 'text', id: 'home-copy', text: 'AI_SELECTION_HOME' }, { kind: 'productCard', id: 'home-products', operations: [{ kind: 'design', id: 'card-home-products-title', design: { desktop: { fontSize: 31 } } }] }] },
      { kind: 'page', pageId: 'contact', operations: [{ kind: 'text', id: 'contact-copy', text: 'AI_SELECTION_CONTACT' }] },
      { kind: 'chrome', slot: 'header', operations: [{ kind: 'design', id: 'site-header-frame', design: { desktop: { paddingTop: 32 } } }] },
      { kind: 'chrome', slot: 'footer', operations: [{ kind: 'design', id: 'site-footer-frame', design: { desktop: { paddingTop: 72 } } }] },
      { kind: 'navigation', slot: 'header', items: [{ label: 'Home', pageId: 'home' }, { label: 'Contact', pageId: 'contact' }] },
      { kind: 'theme', theme: { primary: '#234567' } },
    ],
  }, admin, () => {});
}
const select = (value: AiSiteDesignPreview, unitIds: string[]) => selectAiSiteDesign({ designId: value.designId, expectedRevision: getDraftRecord().revision, unitIds }, admin);
const row = (id: string) => getDatabase().prepare('SELECT payload_json,applied_revision,undone_revision,expires_at FROM cms_ai_site_design WHERE id=?').get(id) as { payload_json: string; applied_revision: number | null; undone_revision: number | null; expires_at: string };
const count = () => (getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n;
const preview = (value: AiSiteDesignPreview, side: 'before' | 'after', path: string[] = []) => resolveAiSiteDesignPreview(value.designId, side, admin, path)!;

async function imageSource() {
  // 素材必须经真实上传路径登记，不绕过不可直接新增文件地址的草稿保护。
  async function upload(name: string, color: string) {
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).png().toBuffer(), form = new FormData();
    form.set('file', new File([new Uint8Array(bytes)], name, { type: 'image/png' })); form.set('folder', 'Products'); form.set('expectedRevision', String(getDraftRecord().revision));
    return (await uploadMedia(form)).media;
  }
  const used = await upload('selection-used.png', '#234567'), unused = await upload('selection-unused.png', '#987654');
  const view = createExternalSiteDesignCandidate({ expectedRevision: getDraftRecord().revision, instruction: '只在首页加入已上传的真实照片。', targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false }, preserveText: false }, { summary: '使用真实素材的首页候选。', warnings: [], operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'insert', parentId: '$page', index: 1, node: { tempId: 'new-selection-photo', type: 'Image', mediaId: used.id, alt: 'Supplied photograph' } }] }] }, admin, () => {});
  return { view, used, unused };
}

test('按实际变动提供可选单位，派生预览不改原候选/草稿/模型配置', () => {
  const original = getStudioEnvelope(), provider = getDatabase().prepare('SELECT * FROM cms_ai_provider').get(), first = source(), stored = row(first.designId);
  assert.deepEqual(first.selectionUnits?.map(unit => unit.id).sort(), ['footer', 'header', 'page:contact', 'page:home', 'style']);
  const chosen = select(first, ['page:home']);
  assert.notEqual(chosen.designId, first.designId); assert.equal(chosen.appliedRevision, null); assert.deepEqual(chosen.selection, { sourceDesignId: first.designId, unitIds: ['page:home'] });
  assert.deepEqual(getStudioEnvelope(), original); assert.deepEqual(row(first.designId), stored); assert.deepEqual(getDatabase().prepare('SELECT * FROM cms_ai_provider').get(), provider);
  assert.match(JSON.stringify(preview(chosen, 'after').resolved.data), /AI_SELECTION_HOME/); assert.match(JSON.stringify(preview(chosen, 'after', ['contact']).resolved.data), /ORIGINAL_SELECTION_contact/);
  assert.deepEqual(preview(chosen, 'after').snapshot.theme, original.state.theme); assert.equal(preview(chosen, 'after').snapshot.siteLayout, original.state.siteLayout);
});

test('只采用首页时自动带入该页动态卡片，预览与实际落库一致且不夹带头尾/主题/另一页', () => {
  const original = getStudioEnvelope(), first = source(), chosen = select(first, ['page:home']);
  const frozen = preview(chosen, 'after'), blocks = frozen.snapshot.sharedBlocks || [];
  assert.equal(blocks.length, 1); assert.match(blocks[0].name, /产品卡片/); assert.equal(frozen.snapshot.siteLayout?.menus?.length || 0, 0);
  const after = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, admin);
  // patchStudio将新资产updated写为真实保存时间；渲染、身份与名称必须仍与冻结预览完全一致。
  assert.deepEqual(after.state.editorData, frozen.snapshot.editorData); assert.deepEqual(after.state.sharedBlocks?.map(({ updated: _savedAt, ...block }) => block), blocks.map(({ updated: _previewAt, ...block }) => block)); assert.ok(after.state.sharedBlocks?.every(block => Number.isFinite(Date.parse(block.updated)))); assert.deepEqual(after.state.theme, original.state.theme); assert.equal(after.state.siteLayout, original.state.siteLayout);
  assert.deepEqual(after.state.products, original.state.products); assert.equal(after.activeReleaseId, original.activeReleaseId); assert.equal(row(first.designId).applied_revision, null);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: after.revision }, admin);
  assert.deepEqual(undone.state.editorData, original.state.editorData); assert.equal(undone.state.sharedBlocks?.length || 0, 0); assert.equal(undone.activeReleaseId, original.activeReleaseId);
});

test('页眉与导航作为一组，依赖菜单自动带入而页脚/卡片/主题保持', () => {
  const original = getStudioEnvelope(), first = source(), chosen = select(first, ['header']), frozen = preview(chosen, 'after').snapshot;
  assert.equal(frozen.siteLayout?.header.mode, 'block'); assert.equal(frozen.siteLayout?.footer.mode || 'default', 'default'); assert.equal(frozen.sharedBlocks?.length, 1); assert.equal(frozen.siteLayout?.menus?.length, 2);
  const header = frozen.sharedBlocks!.find(block => block.id === frozen.siteLayout!.header.blockId)!; assert.match(JSON.stringify(header.data), /site-header-navigation/); assert.doesNotMatch(JSON.stringify(frozen.sharedBlocks), /site-footer-frame|card-home-products/);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, admin); assert.deepEqual(applied.state.siteLayout, frozen.siteLayout); assert.deepEqual(applied.state.editorData, original.state.editorData); assert.deepEqual(applied.state.theme, original.state.theme);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, admin); assert.equal(undone.state.siteLayout?.header.mode, 'default'); assert.equal(undone.state.sharedBlocks?.length || 0, 0); assert.equal(undone.state.siteLayout?.menus?.length || 0, 0);
});

test('后来无关页面和产品编辑纳入新基线，未选方案内容不覆盖人工修改', () => {
  const first = source(), current = getStudioEnvelope(), contact = structuredClone(current.state.editorData.contact) as Data; contact.content[1].props.text = 'MANUAL_CONTACT_AFTER_SOURCE';
  const changed = patchStudio({ expectedRevision: current.revision, patch: { editorData: { ...current.state.editorData, contact }, products: current.state.products.map(product => ({ ...product, description: 'MANUAL_PRODUCT_AFTER_SOURCE' })) } }, admin);
  const chosen = select(first, ['page:home']); assert.equal(chosen.baseRevision, changed.revision);
  const before = preview(chosen, 'before').snapshot, after = preview(chosen, 'after').snapshot;
  assert.match(JSON.stringify(before.editorData.contact), /MANUAL_CONTACT_AFTER_SOURCE/); assert.match(JSON.stringify(after.editorData.contact), /MANUAL_CONTACT_AFTER_SOURCE/); assert.equal(after.products[0].description, 'MANUAL_PRODUCT_AFTER_SOURCE');
  const saved = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: changed.revision }, admin); assert.deepEqual(saved.state.editorData.contact, contact);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: saved.revision }, admin); assert.deepEqual(undone.state.editorData, changed.state.editorData); assert.deepEqual(undone.state.products, changed.state.products);
});

test('主题单位只采用实际改变字段，后来其他主题字段保持且不带入页面或资产', () => {
  const first = source(), original = getStudioEnvelope(); const changed = patchStudio({ expectedRevision: original.revision, patch: { theme: { ...original.state.theme, text: '#667788' } } }, admin);
  const chosen = select(first, ['style']), next = preview(chosen, 'after').snapshot; assert.equal(next.theme.primary, '#234567'); assert.equal(next.theme.text, '#667788'); assert.deepEqual(next.editorData, changed.state.editorData); assert.equal(next.sharedBlocks?.length || 0, 0);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: changed.revision }, admin), undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, admin); assert.deepEqual(undone.state.theme, changed.state.theme);
});

test('所选页面/主题已有手改或版本不匹配时原子拒绝，原候选与手改均保留', () => {
  const first = source(), original = getStudioEnvelope(), home = structuredClone(original.state.editorData.home) as Data; home.content[1].props.text = 'MANUAL_SELECTED_HOME';
  const changed = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home }, theme: { ...original.state.theme, primary: '#998877' } } }, admin), number = count(), stored = row(first.designId);
  assert.throws(() => selectAiSiteDesign({ designId: first.designId, expectedRevision: original.revision, unitIds: ['page:contact'] }, admin), denied(409));
  assert.throws(() => select(first, ['page:home']), denied(409)); assert.throws(() => select(first, ['style']), denied(409));
  assert.equal(count(), number); assert.deepEqual(row(first.designId), stored); assert.deepEqual(getStudioEnvelope(), changed);
});

test('新增全站锁不能经主题/页眉选择绕过，未锁定页面仍可单独采用', () => {
  const first = source(), original = getStudioEnvelope(), spare = structuredClone(original.state.editorData.spare) as Data; spare.content[1].props.locked = true;
  const changed = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, spare } } }, admin), number = count();
  assert.throws(() => select(first, ['style']), denied(409)); assert.throws(() => select(first, ['header']), denied(409)); assert.equal(count(), number);
  const chosen = select(first, ['page:home']); assert.deepEqual(preview(chosen, 'after').snapshot.editorData.spare, changed.state.editorData.spare);
});

test('新资产ID被手工作品占用时拒绝，不覆盖同名卡片也不留下半条候选', () => {
  const first = source(), card = preview(first, 'after').snapshot.sharedBlocks!.find(block => block.name.includes('产品卡片'))!, current = getStudioEnvelope();
  const collision = { ...structuredClone(card), name: 'MANUAL_COLLIDING_CARD' }; const changed = patchStudio({ expectedRevision: current.revision, patch: { sharedBlocks: [collision] } }, admin), number = count();
  assert.throws(() => select(first, ['page:home']), denied(409)); assert.equal(count(), number); assert.deepEqual(getStudioEnvelope(), changed);
});

test('选择使用图片的范围时重新检查素材仍存在，未选素材删除不会扩大冲突', async () => {
  const { view: first, unused } = await imageSource(), initial = getStudioEnvelope();
  const unusedRemoved = patchStudio({ expectedRevision: initial.revision, patch: { media: initial.state.media.filter(item => item.id !== unused.id) } }, admin);
  assert.ok(select(first, ['page:home']).designId); assert.deepEqual(getStudioEnvelope(), unusedRemoved);
  const usedRemoved = patchStudio({ expectedRevision: unusedRemoved.revision, patch: { media: [] } }, admin), number = count();
  assert.throws(() => select(first, ['page:home']), denied(409)); assert.equal(count(), number); assert.deepEqual(getStudioEnvelope(), usedRemoved);
});

test('素材仅重命名和修改说明时保留最新资料，图片身份/地址不变的范围仍可采用', async () => {
  const { view: first, used } = await imageSource(), initial = getStudioEnvelope();
  const renamed = patchStudio({ expectedRevision: initial.revision, patch: { media: initial.state.media.map(item => item.id === used.id ? { ...item, name: 'MANUAL_RENAMED_PHOTO', alt: 'MANUAL_UPDATED_LIBRARY_DESCRIPTION' } : item) } }, admin);
  const selected = select(first, ['page:home']), after = preview(selected, 'after').snapshot;
  assert.deepEqual(after.media, renamed.state.media); assert.ok(JSON.stringify(after.editorData.home).includes(used.url)); assert.deepEqual(getStudioEnvelope(), renamed);
});

test('旧候选按实际差异恢复单位，空/重复/不存在的选择及未知字段均拒绝', () => {
  const first = source(), stored = row(first.designId), legacy = JSON.parse(stored.payload_json); delete legacy.view.selectionUnits; delete legacy.view.selection;
  getDatabase().prepare('UPDATE cms_ai_site_design SET payload_json=? WHERE id=?').run(JSON.stringify(legacy), first.designId);
  const loaded = readAiSiteDesign(first.designId, admin); assert.deepEqual(loaded.selectionUnits?.map(unit => unit.id).sort(), ['footer', 'header', 'page:contact', 'page:home', 'style']);
  const number = count(); for (const value of [[], ['style', 'style'], ['page:spare'], ['missing'], null]) assert.throws(() => selectAiSiteDesign({ designId: first.designId, expectedRevision: getDraftRecord().revision, unitIds: value }, admin), denied(422));
  assert.throws(() => selectAiSiteDesign({ designId: first.designId, expectedRevision: getDraftRecord().revision, unitIds: ['style'], confirmation: true }, admin), denied(422)); assert.equal(count(), number);
  assert.ok(select(loaded, ['page:contact']).designId);
});

test('跨账号/降权/过期/已采用源不能创建可采用派生方案，鉴权失败事务不写候选', () => {
  const first = source(), value = { designId: first.designId, expectedRevision: getDraftRecord().revision, unitIds: ['page:contact'] }, number = count();
  assert.throws(() => selectAiSiteDesign(value, other), denied(404)); assert.throws(() => selectAiSiteDesign(value, editor), denied(403));
  assert.throws(() => selectAiSiteDesign(value, admin, () => { throw new ApiError(403, '连接在提交前已撤销'); }), denied(403)); assert.equal(count(), number);
  getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); assert.throws(() => selectAiSiteDesign(value, admin), denied(403)); getDatabase().prepare("UPDATE auth_user SET role='admin' WHERE id=?").run(admin.id);
  getDatabase().prepare('UPDATE cms_ai_site_design SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', first.designId); assert.throws(() => select(first, ['style']), denied(410));
  getDatabase().prepare('UPDATE cms_ai_site_design SET expires_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', first.designId); const applied = applyAiSiteDesign({ designId: first.designId, expectedRevision: getDraftRecord().revision }, admin);
  assert.throws(() => selectAiSiteDesign({ ...value, expectedRevision: applied.revision }, admin), denied(409));
});

test('连续选择不延长源期限且最多六层，派生请求仅保留实际采用范围', () => {
  const first = source(), cutoff = new Date(Date.now() + 5 * 60000).toISOString(); getDatabase().prepare('UPDATE cms_ai_site_design SET expires_at=? WHERE id=?').run(cutoff, first.designId);
  let chosen = first;
  for (let depth = 0; depth < 6; depth++) {
    chosen = select(chosen, ['page:contact']); assert.ok(Date.parse(chosen.expiresAt) <= Date.parse(cutoff));
    assert.deepEqual(chosen.request.targets, { pageIds: ['contact'], header: false, footer: false, navigation: false, style: false });
  }
  const number = count(); assert.throws(() => select(chosen, ['page:contact']), denied(422)); assert.equal(count(), number); assert.equal(row(first.designId).expires_at, cutoff);
});

test('内置头尾固化的企业事实变化后拒绝采用旧资料，其他独立范围保持可选', () => {
  const first = source(), original = getStudioEnvelope(); const changed = patchStudio({ expectedRevision: original.revision, patch: { settings: { ...original.state.settings, name: 'MANUAL_NEW_COMPANY_NAME', email: 'new-contact@example.invalid' } } }, admin), number = count();
  assert.throws(() => select(first, ['header']), denied(409)); assert.throws(() => select(first, ['footer']), denied(409)); assert.equal(count(), number);
  const selected = select(first, ['style']); assert.deepEqual(preview(selected, 'after').snapshot.settings.name, changed.state.settings.name); assert.deepEqual(getStudioEnvelope(), changed);
});

test('范围派生同样受本人待确认容量限制，不靠选择接口绕过候选上限', () => {
  const first = source(); for (let index = 1; index < 30; index++) source();
  const before = getStudioEnvelope(); assert.equal(count(), 30); assert.throws(() => select(first, ['page:contact']), denied(429)); assert.equal(count(), 30); assert.deepEqual(getStudioEnvelope(), before);
});

test('派生方案撤销仍保护后续人工改动和新增引用，原方案不被连带撤销', () => {
  const original = getStudioEnvelope(), first = source(), chosen = select(first, ['page:home']), applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, admin), cardId = applied.state.sharedBlocks![0].id;
  const spare = structuredClone(applied.state.editorData.spare) as Data; spare.content.push({ type: 'SharedBlock', props: { id: 'manual-selection-card-ref', blockId: cardId } });
  const changed = patchStudio({ expectedRevision: applied.revision, patch: { editorData: { ...applied.state.editorData, spare } } }, admin);
  assert.throws(() => undoAiSiteDesign({ designId: chosen.designId, expectedRevision: changed.revision }, admin), denied(409)); assert.deepEqual(getStudioEnvelope(), changed); assert.equal(row(first.designId).undone_revision, null);
  const released = patchStudio({ expectedRevision: changed.revision, patch: { editorData: { ...changed.state.editorData, spare: applied.state.editorData.spare } } }, admin);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: released.revision }, admin); assert.deepEqual(undone.state.editorData.home, original.state.editorData.home); assert.equal(row(first.designId).applied_revision, null);
});
