import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { ComponentData, Data } from '@puckeditor/core';
import type { AiSiteDesignPreview } from '../src/lib/ai-site-design-types';
import type { AiPageEditOperation } from '../src/lib/ai-page-edit-types';
import type { Actor } from '../src/server/permissions';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { ApiError } from '../src/server/http';
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
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-section-selection-'));
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
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-section-selection-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

function section(value: AiSiteDesignPreview, nodeId: string) {
  const unit = value.sectionUnits?.find(item => item.nodeIds.includes(nodeId)); assert.ok(unit); return unit.id;
}

test('页面内正文与动态产品区分别选择，只取正文不夹带卡片/主题/头尾且无草稿写入', () => {
  const original = getStudioEnvelope(), first = source(), provider = getDatabase().prepare('SELECT * FROM cms_ai_provider').get();
  const chosen = select(first, [section(first, 'home-copy')]), next = preview(chosen, 'after').snapshot;
  assert.match(JSON.stringify(next.editorData.home), /AI_SELECTION_HOME/); assert.equal(next.sharedBlocks?.length || 0, 0);
  assert.deepEqual((next.editorData.home as Data).content[2], (original.state.editorData.home as Data).content[2]);
  assert.deepEqual(next.theme, original.state.theme); assert.deepEqual(next.siteLayout, original.state.siteLayout);
  assert.deepEqual(getStudioEnvelope(), original); assert.deepEqual(getDatabase().prepare('SELECT * FROM cms_ai_provider').get(), provider);
  assert.equal(row(first.designId).applied_revision, null);
});

test('只选产品区按精确子树带入卡片，真实采用与撤销均保持正文和公开版本', () => {
  const original = getStudioEnvelope(), first = source(), chosen = select(first, [section(first, 'home-products')]);
  const frozen = preview(chosen, 'after').snapshot; assert.equal(frozen.sharedBlocks?.length, 1);
  assert.match(JSON.stringify(frozen.editorData.home), /ORIGINAL_SELECTION_home/); assert.doesNotMatch(JSON.stringify(frozen.editorData.home), /AI_SELECTION_HOME/);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, admin);
  assert.deepEqual(applied.state.editorData, frozen.editorData); assert.equal(applied.activeReleaseId, original.activeReleaseId);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, admin);
  assert.deepEqual(undone.state.editorData, original.state.editorData); assert.equal(undone.state.sharedBlocks?.length || 0, 0); assert.equal(row(first.designId).applied_revision, null);
});

test('同页未选手改和新锁保留，选中区块已有手改则原子拒绝', () => {
  const first = source(), original = getStudioEnvelope(), home = structuredClone(original.state.editorData.home) as Data;
  home.content[0].props.text = 'MANUAL_UNSELECTED_SAME_PAGE'; home.content[0].props.locked = true;
  const manual = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, admin);
  const chosen = select(first, [section(first, 'home-copy')]); assert.deepEqual((preview(chosen, 'after').snapshot.editorData.home as Data).content[0], home.content[0]);
  assert.deepEqual(getStudioEnvelope(), manual);
  home.content[1].props.text = 'MANUAL_SELECTED_SAME_PAGE'; const changed = patchStudio({ expectedRevision: manual.revision, patch: { editorData: { ...manual.state.editorData, home } } }, admin), number = count();
  assert.throws(() => select(first, [section(first, 'home-copy')]), denied(409)); assert.equal(count(), number); assert.deepEqual(getStudioEnvelope(), changed);
});

test('不能同时提交整页与其区块或伪造区块ID，原候选和数据不变', () => {
  const first = source(), original = getStudioEnvelope(), number = count();
  assert.throws(() => select(first, ['page:home', section(first, 'home-copy')]), denied(422));
  assert.throws(() => select(first, ['section:made-up-id']), denied(422));
  assert.equal(count(), number); assert.deepEqual(getStudioEnvelope(), original); assert.equal(row(first.designId).applied_revision, null);
});

test('顶层重排提供关联结构组，旧整页单位仍可生成真实候选', () => {
  const original = getStudioEnvelope(), first = createExternalSiteDesignCandidate({ expectedRevision: original.revision, instruction: '调整首页完整区块顺序。', targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false }, preserveText: true }, { summary: '先展示产品再展示文字。', warnings: [], operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'reorder', id: '$page', children: ['home-products', 'home-title', 'home-copy'] }] }] }, admin, () => {});
  assert.ok(first.sectionUnits?.length); assert.equal(first.selectionUnits[0].sectionSelectionUnavailableReason, undefined);
  assert.ok(first.sectionUnits.some(unit => unit.nodeIds.includes('home-products')));
  const chosen = select(first, ['page:home']); assert.equal((preview(chosen, 'after').snapshot.editorData.home as Data).content[0].props.id, 'home-products'); assert.deepEqual(getStudioEnvelope(), original);
});

/** 候选必须经原编译器真实处理插入/删除/重排，不能直写私有载荷冒充结构支持。 */
function structuralSource(operations: AiPageEditOperation[]) {
  return createExternalSiteDesignCandidate({ expectedRevision: getDraftRecord().revision, instruction: '分别调整首页独立区块和结构，让用户选择满意部分。', targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false }, preserveText: false }, { summary: '页面结构与独立文案调整。', warnings: [], operations: [{ kind: 'page', pageId: 'home', operations }] }, admin, () => {});
}

test('不同位置的新增和删除可分别选择，同页未选人工编辑与文案方案保持', () => {
  const first = structuralSource([
    { kind: 'insert', parentId: '$page', index: 0, node: { tempId: 'new-intro', type: 'Text', text: 'AI_STRUCT_ADDED' } },
    { kind: 'remove', id: 'home-copy' }, { kind: 'text', id: 'home-title', text: 'AI_STRUCT_HEADING' },
  ]), original = getStudioEnvelope(), next = preview(first, 'after').snapshot.editorData.home as Data;
  const addedId = next.content.find(node => node.props.text === 'AI_STRUCT_ADDED')!.props.id;
  const addUnit = first.sectionUnits!.find(unit => unit.nodeIds.includes(addedId))!, removeUnit = first.sectionUnits!.find(unit => unit.nodeIds.includes('home-copy'))!;
  assert.notEqual(addUnit.id, removeUnit.id); assert.match(addUnit.id, /^section:g1:/);
  const home = structuredClone(original.state.editorData.home) as Data; home.content[2].props.title = 'MANUAL_PRODUCTS_KEPT';
  const manual = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, admin);
  const chosen = select(first, [addUnit.id]), frozen = preview(chosen, 'after').snapshot.editorData.home as Data;
  assert.equal(frozen.content[0].props.id, addedId); assert.match(JSON.stringify(frozen), /ORIGINAL_SELECTION_home|MANUAL_PRODUCTS_KEPT/); assert.doesNotMatch(JSON.stringify(frozen), /AI_STRUCT_HEADING/);
  assert.ok(frozen.content.some(node => node.props.id === 'home-copy')); assert.equal(frozen.content.find(node => node.props.id === 'home-products')!.props.title, 'MANUAL_PRODUCTS_KEPT');
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: manual.revision }, admin), undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, admin);
  assert.deepEqual(undone.state.editorData, manual.state.editorData); assert.equal(undone.activeReleaseId, original.activeReleaseId);
  const removed = select(first, [removeUnit.id]), removal = preview(removed, 'after').snapshot.editorData.home as Data;
  assert.ok(!removal.content.some(node => node.props.id === 'home-copy' || node.props.id === addedId)); assert.equal(removal.content[0].props.text, 'Original home');
});

test('同位置替换合为完整依赖组，不能拿旧单根ID扩大或拆开选择', () => {
  const first = structuralSource([{ kind: 'remove', id: 'home-copy' }, { kind: 'insert', parentId: '$page', index: 1, node: { tempId: 'new-replacement', type: 'Text', text: 'AI_REPLACEMENT' } }]);
  const after = preview(first, 'after').snapshot.editorData.home as Data, addedId = after.content.find(node => node.props.text === 'AI_REPLACEMENT')!.props.id;
  const unit = first.sectionUnits!.find(item => item.nodeIds.includes('home-copy'))!; assert.ok(unit.nodeIds.includes(addedId)); assert.equal(first.sectionUnits!.filter(item => item.nodeIds.includes(addedId)).length, 1);
  const chosen = select(first, [unit.id]); assert.deepEqual(preview(chosen, 'after').snapshot.editorData.home, after);
  const number = count(); assert.throws(() => select(first, ['section:home-copy']), denied(422)); assert.equal(count(), number);
});

test('选择重排同时带入动态卡片，未选文字变化不夹带且采用撤销一致', () => {
  const original = getStudioEnvelope(), first = structuralSource([
    { kind: 'reorder', id: '$page', children: ['home-products', 'home-title', 'home-copy'] },
    { kind: 'productCard', id: 'home-products', operations: [{ kind: 'design', id: 'card-home-products-title', design: { desktop: { fontSize: 29 } } }] },
    { kind: 'text', id: 'home-copy', text: 'AI_COPY_UNSELECTED' },
  ]), chosen = select(first, [section(first, 'home-products')]), frozen = preview(chosen, 'after').snapshot;
  assert.equal((frozen.editorData.home as Data).content[0].props.id, 'home-products'); assert.equal(frozen.sharedBlocks?.length, 1); assert.doesNotMatch(JSON.stringify(frozen.editorData.home), /AI_COPY_UNSELECTED/);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, admin); assert.deepEqual(applied.state.editorData, frozen.editorData);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, admin); assert.deepEqual(undone.state.editorData, original.state.editorData); assert.equal(undone.state.sharedBlocks?.length || 0, 0);
});

test('同长骨架的多组增删重排采用后无修改保存仍可精确撤销，所选后改继续拒绝', () => {
  const initial = getStudioEnvelope(), ids = ['hero', 'old-inquiry', 'factory', 'products', 'process', 'cases', 'service', 'contact'];
  const home: Data<Record<string, ComponentData['props']>, { title: string; brand: string; showChrome: 'yes' | 'no' }> = { root: { props: { title: 'Structural round trip', brand: '', showChrome: 'no' } }, zones: {}, content: ids.map(id => ({ type: 'Text', props: { id, text: `SUPPLIED_${id}` } })) };
  const baseline = patchStudio({ expectedRevision: initial.revision, patch: { editorData: { ...initial.state.editorData, home } } }, admin);
  const first = structuralSource([
    { kind: 'text', id: 'hero', text: 'AI_UNSELECTED_TITLE' }, { kind: 'remove', id: 'old-inquiry' },
    { kind: 'move', id: 'cases', parentId: '$page', index: 2 }, { kind: 'move', id: 'service', parentId: '$page', index: 3 },
    { kind: 'insert', parentId: '$page', index: 7, node: { tempId: 'new-documents', type: 'Text', text: 'SUPPLIED_DOCUMENTS' } },
  ]);
  const selectedIds = first.sectionUnits!.filter(unit => !unit.nodeIds.includes('hero')).map(unit => unit.id), chosen = select(first, selectedIds);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: baseline.revision }, admin);
  // 原生编辑器不改布局的保存仍会递增revision；数据等价不能被误判为所选结构发生手改。
  const saved = patchStudio({ expectedRevision: applied.revision, patch: { editorData: structuredClone(applied.state.editorData) } }, admin);
  assert.deepEqual(saved.state.editorData, applied.state.editorData);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: saved.revision }, admin);
  assert.deepEqual(undone.state.editorData, baseline.state.editorData); assert.equal(undone.activeReleaseId, baseline.activeReleaseId);

  const protectedCandidate = select(first, selectedIds), second = applyAiSiteDesign({ designId: protectedCandidate.designId, expectedRevision: undone.revision }, admin);
  const manual = structuredClone(second.state.editorData) as Record<string, Data>;
  manual.home.content.find(node => node.props.id === 'products')!.props.text = 'REAL_MANUAL_SELECTED_EDIT';
  const changed = patchStudio({ expectedRevision: second.revision, patch: { editorData: manual } }, admin);
  assert.throws(() => undoAiSiteDesign({ designId: protectedCandidate.designId, expectedRevision: changed.revision }, admin), denied(409));
  assert.deepEqual(getStudioEnvelope(), changed);
});

test('结构组内后改或人工重排时拒绝覆盖，未生成半条派生方案', () => {
  const first = structuralSource([{ kind: 'remove', id: 'home-copy' }]), original = getStudioEnvelope(), home = structuredClone(original.state.editorData.home) as Data;
  home.content[1].props.text = 'MANUAL_DELETED_TARGET'; const changed = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, admin), number = count();
  assert.throws(() => select(first, [section(first, 'home-copy')]), denied(409)); assert.deepEqual(getStudioEnvelope(), changed); assert.equal(count(), number);
});

test('跨根移动内容的两端合组，真实采用后只出现一次且未选标题保留', () => {
  const initial = getStudioEnvelope(), home: Data = { root: { props: {} }, zones: {}, content: [
    { type: 'Container', props: { id: 'origin', content: [{ type: 'Text', props: { id: 'phone', text: 'SUPPLIED_UNIQUE_CONTACT' } }] } },
    { type: 'Heading', props: { id: 'independent-title', text: 'Original independent title', level: 'h1' } },
    { type: 'Container', props: { id: 'destination', content: [] } },
  ] };
  const baseline = patchStudio({ expectedRevision: initial.revision, patch: { editorData: { ...initial.state.editorData, home } } }, admin);
  const first = structuralSource([{ kind: 'move', id: 'phone', parentId: 'destination', index: 0 }, { kind: 'text', id: 'independent-title', text: 'AI_OTHER_TITLE' }]);
  const unit = first.sectionUnits!.find(item => item.nodeIds.includes('origin'))!; assert.ok(unit.nodeIds.includes('destination')); assert.equal(first.sectionUnits!.filter(item => item.nodeIds.includes('destination')).length, 1);
  const chosen = select(first, [unit.id]), after = preview(chosen, 'after').snapshot.editorData.home as Data;
  assert.equal(after.content[0].props.content.length, 0); assert.equal(after.content[2].props.content[0].props.id, 'phone'); assert.equal(after.content[1].props.text, 'Original independent title'); assert.equal(JSON.stringify(after).split('SUPPLIED_UNIQUE_CONTACT').length - 1, 1);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: baseline.revision }, admin), undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, admin); assert.deepEqual(undone.state.editorData, baseline.state.editorData);
});

test('旧候选无区块投影时重建原生单位，精确撤销保留未选根的后续编辑', () => {
  const first = source(), legacy = JSON.parse(row(first.designId).payload_json); delete legacy.view.sectionUnits;
  getDatabase().prepare('UPDATE cms_ai_site_design SET payload_json=? WHERE id=?').run(JSON.stringify(legacy), first.designId);
  const loaded = readAiSiteDesign(first.designId, admin), chosen = select(loaded, [section(loaded, 'home-copy')]);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: chosen.baseRevision }, admin), home = structuredClone(applied.state.editorData.home) as Data;
  home.content[0].props.text = 'MANUAL_AFTER_APPLY'; const changed = patchStudio({ expectedRevision: applied.revision, patch: { editorData: { ...applied.state.editorData, home } } }, admin);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: changed.revision }, admin);
  assert.equal((undone.state.editorData.home as Data).content[0].props.text, 'MANUAL_AFTER_APPLY'); assert.equal((undone.state.editorData.home as Data).content[1].props.text, 'ORIGINAL_SELECTION_home');
});

test('页面同组件文字与手机样式可分选，真实预览/采用/撤销均保留未选后改', () => {
  const first = createExternalSiteDesignCandidate({ expectedRevision: getDraftRecord().revision, instruction: '改写首页标题，并分别调整电脑颜色和手机字号。', targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false }, preserveText: false }, { summary: '标题及三端样式候选', warnings: [], operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'text', id: 'home-title', text: 'NEW_PROPERTY_TITLE' }, { kind: 'design', id: 'home-title', design: { desktop: { color: '#3355ff' }, mobile: { fontSize: 28 } } }] }] }, admin, () => {});
  const mobile = first.propertyUnits!.find(unit => unit.nodeIds[0] === 'home-title' && unit.viewport === 'mobile')!; assert.ok(mobile);
  const initial = getStudioEnvelope(), chosen = select(first, [mobile.id]); assert.deepEqual(getStudioEnvelope(), initial);
  const rendered = preview(chosen, 'after').resolved.data as Data; assert.equal(rendered.content[0].props.text, 'Original home'); assert.deepEqual(rendered.content[0].props.design, { mobile: { fontSize: 28 } });
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: chosen.baseRevision }, admin), home = structuredClone(applied.state.editorData.home) as Data;
  home.content[0].props.text = 'LATER_MANUAL_TITLE'; home.content[0].props.design.desktop = { color: '#ff8800' };
  const edited = patchStudio({ expectedRevision: applied.revision, patch: { editorData: { ...applied.state.editorData, home } } }, admin), undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: edited.revision }, admin);
  assert.equal((undone.state.editorData.home as Data).content[0].props.text, 'LATER_MANUAL_TITLE'); assert.deepEqual((undone.state.editorData.home as Data).content[0].props.design, { desktop: { color: '#ff8800' } });
});

test('头尾原生属性部分采用与逆合并保留语言映射和同块后来手改，旧共享资产保持', () => {
  const current = getStudioEnvelope(), data: Data<Record<string, ComponentData['props']>, { title: string; showChrome: 'yes' | 'no' }> = { root: { props: { title: 'Header', showChrome: 'no' } }, zones: {}, content: [{ type: 'Container', props: { id: 'header-frame', content: [{ type: 'Heading', props: { id: 'header-title', text: 'Original company', level: 'h2' } }, { type: 'Text', props: { id: 'header-copy', text: 'Original support' } }] } }] };
  const localized = structuredClone(data); localized.content[0].props.content[0].props.text = 'Société originale';
  const setup = patchStudio({ expectedRevision: current.revision, patch: { settings: { ...current.state.settings, language: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }] }, sharedBlocks: [{ id: 'base-header', name: 'Original header', data, updated: '' }, { id: 'localized-header', name: 'French header', data: localized, updated: '' }], siteLayout: { header: { mode: 'block', blockId: 'base-header', localeBlockIds: { fr: 'localized-header' } }, footer: { mode: 'default', blockId: '' }, menus: [] } } }, admin);
  const source = createExternalSiteDesignCandidate({ expectedRevision: setup.revision, instruction: '优化页眉标题、手机字号和说明文字。', targets: { pageIds: ['home', 'contact', 'spare'], header: true, footer: false, navigation: false, style: false }, preserveText: false }, { summary: '自定义页眉内部方案', operations: [{ kind: 'chrome', slot: 'header', operations: [{ kind: 'text', id: 'header-title', text: 'Candidate company' }, { kind: 'design', id: 'header-title', design: { mobile: { fontSize: 28 } } }, { kind: 'text', id: 'header-copy', text: 'Candidate support' }] }], warnings: [] }, admin, () => {});
  const unit = source.assetUnits!.find(unit => unit.kind === 'property' && unit.group === 'text' && unit.nodeIds[0] === 'header-title')!; assert.ok(unit);
  const chosen = select(source, [unit.id]), frozen = preview(chosen, 'after').snapshot; assert.deepEqual(frozen.siteLayout!.header.localeBlockIds, { fr: 'localized-header' }); assert.equal(frozen.sharedBlocks!.find(block => block.id === 'base-header')!.data.content[0].props.content[0].props.text, 'Original company');
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: chosen.baseRevision }, admin), blockId = applied.state.siteLayout!.header.blockId, blocks = structuredClone(applied.state.sharedBlocks!); const block = blocks.find(item => item.id === blockId)!;
  block.name = 'Later manual name'; block.data.content[0].props.content[0].props.design = { desktop: { color: '#ff8800' } }; block.data.content[0].props.content[1].props.text = 'Later manual support';
  const edited = patchStudio({ expectedRevision: applied.revision, patch: { sharedBlocks: blocks } }, admin), undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: edited.revision }, admin), restored = undone.state.sharedBlocks!.find(item => item.id === blockId)!;
  assert.equal(restored.data.content[0].props.content[0].props.text, 'Original company'); assert.deepEqual(restored.data.content[0].props.content[0].props.design, { desktop: { color: '#ff8800' } }); assert.equal(restored.data.content[0].props.content[1].props.text, 'Later manual support'); assert.equal(restored.name, 'Later manual name');
  assert.deepEqual(undone.state.siteLayout!.header.localeBlockIds, { fr: 'localized-header' }); assert.deepEqual(undone.state.sharedBlocks!.find(item => item.id === 'localized-header')!.data, localized);
});
