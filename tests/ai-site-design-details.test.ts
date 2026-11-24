import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Data } from '@puckeditor/core';
import type { AiSiteDesignPreview } from '../src/lib/ai-site-design-types';
import type { AiPageEditOperation } from '../src/lib/ai-page-edit-types';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { ApiError } from '../src/server/http';
import { applyAiSiteDesign, createExternalSiteDesignCandidate, readAiSiteDesign, resolveAiSiteDesignPreview, selectAiSiteDesign, undoAiSiteDesign } from '../src/server/ai-site-design';
import type { Actor } from '../src/server/permissions';

const actor: Actor = { id: 'fine-owner', name: '内部挑选管理员', email: 'fine@example.invalid', role: 'admin' };
let directory = '', previous: NodeJS.ProcessEnv;
const denied = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
const page = (): Data => ({ root: { props: {} }, zones: {}, content: [
  { type: 'Container', props: { id: 'hero', nodeLabel: '首页首屏', content: [
    { type: 'Heading', props: { id: 'headline', text: 'Original title', level: 'h1' } },
    { type: 'Text', props: { id: 'copy', text: 'Original supplied description.' } },
    { type: 'ProductList', props: { id: 'home-products', title: 'Supplied products', category: '', columns: 3, count: 3, padding: 24, background: 'transparent' } },
  ] } },
  { type: 'Text', props: { id: 'outside', text: 'Original outside copy.' } },
] } as Data);

beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-design-details-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3294'; process.env.BETTER_AUTH_SECRET = 'synthetic-details-secret-'.repeat(4);
  getDraftRecord(); const draft = createEmptyDraft(); draft.pages = [{ id: 'home', title: '首页', slug: '/', type: '普通页面', status: 'draft', updated: '' }]; draft.editorData = { home: page() };
  draft.products = [{ id: 'p1', name: 'Supplied chair', sku: 'P1', category: 'Chairs', material: 'Wood', description: 'Confirmed facts.', image: '', status: 'draft' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-design-details-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 真正经原AI编译器生成多项修改，再选择内部子树；不直写候选数据绕开校验。 */
function source(operations: AiPageEditOperation[] = [
  { kind: 'text', id: 'headline', text: 'AI_TITLE' }, { kind: 'text', id: 'copy', text: 'AI_COPY' },
  { kind: 'productCard', id: 'home-products', operations: [{ kind: 'design', id: 'card-home-products-title', design: { desktop: { fontSize: 29 } } }] },
  { kind: 'text', id: 'outside', text: 'AI_OUTSIDE' },
]) { return createExternalSiteDesignCandidate({ expectedRevision: getDraftRecord().revision, instruction: '分别调整首页首屏标题、说明和动态产品卡片，允许只采用满意的内部内容。', targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false }, preserveText: false }, { summary: '首屏内部多项调整及独立正文。', warnings: [], operations: [{ kind: 'page', pageId: 'home', operations }] }, actor, () => {}); }
const preview = (view: AiSiteDesignPreview, side: 'before' | 'after' = 'after') => resolveAiSiteDesignPreview(view.designId, side, actor)!.snapshot;
const detail = (view: AiSiteDesignPreview, nodeId: string) => { const unit = view.detailUnits?.find(item => item.nodeIds.includes(nodeId)); assert.ok(unit); return unit; };
const select = (view: AiSiteDesignPreview, unitIds: string[]) => selectAiSiteDesign({ designId: view.designId, expectedRevision: getDraftRecord().revision, unitIds }, actor);
const count = () => (getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n;

test('只选标题内部项不夹带说明/卡片/外部文案，保持原草稿及模型配置', () => {
  const original = getStudioEnvelope(), first = source(), provider = getDatabase().prepare('SELECT * FROM cms_ai_provider').get();
  const chosen = select(first, [detail(first, 'headline').id]), frozen = preview(chosen);
  const hero = (frozen.editorData.home as Data).content[0]; assert.equal(hero.props.content[0].props.text, 'AI_TITLE'); assert.equal(hero.props.content[1].props.text, 'Original supplied description.'); assert.equal(hero.props.content[2].type, 'ProductList');
  assert.equal(frozen.sharedBlocks?.length || 0, 0); assert.equal((frozen.editorData.home as Data).content[1].props.text, 'Original outside copy.');
  assert.deepEqual(getStudioEnvelope(), original); assert.deepEqual(getDatabase().prepare('SELECT * FROM cms_ai_provider').get(), provider);
});

test('内部产品列表自动带入精准卡片依赖，真实采用与撤销保持其他子树', () => {
  const original = getStudioEnvelope(), first = source(), chosen = select(first, [detail(first, 'home-products').id]), frozen = preview(chosen);
  assert.equal(frozen.sharedBlocks?.length, 1); assert.equal((frozen.editorData.home as Data).content[0].props.content[0].props.text, 'Original title');
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, actor); assert.deepEqual(applied.state.editorData, frozen.editorData); assert.equal(applied.activeReleaseId, original.activeReleaseId);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, actor); assert.deepEqual(undone.state.editorData, original.state.editorData); assert.equal(undone.state.sharedBlocks?.length || 0, 0);
});

test('单个细项也保持精度，同根未选兄弟后改可重建预览并安全撤销', () => {
  const first = source([{ kind: 'text', id: 'headline', text: 'AI_SINGLE_TITLE' }]), original = getStudioEnvelope(), home = structuredClone(original.state.editorData.home) as Data;
  home.content[0].props.content[1].props.text = 'MANUAL_SIBLING_KEPT'; const current = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, actor);
  assert.equal(first.detailUnits?.length, 1); const chosen = select(first, [detail(first, 'headline').id]), frozen = preview(chosen);
  assert.equal((frozen.editorData.home as Data).content[0].props.content[1].props.text, 'MANUAL_SIBLING_KEPT'); assert.deepEqual(getStudioEnvelope(), current);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: current.revision }, actor), undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, actor); assert.deepEqual(undone.state.editorData, current.state.editorData);
});

test('整页/整块和内部项混选或伪造ID原子拒绝，原来源和草稿保持', () => {
  const first = source(), item = detail(first, 'headline'), original = getStudioEnvelope(), number = count();
  for (const ids of [['page:home', item.id], [item.parentId, item.id], ['detail:d1:made-up']]) assert.throws(() => select(first, ids), denied(422));
  assert.equal(count(), number); assert.deepEqual(getStudioEnvelope(), original);
});

test('共同祖先后改时拒绝覆盖，未生成半条候选', () => {
  const first = source(), original = getStudioEnvelope(), home = structuredClone(original.state.editorData.home) as Data;
  home.content[0].props.design = { desktop: { gap: 36 } }; const current = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, actor), number = count();
  assert.throws(() => select(first, [detail(first, 'headline').id]), denied(409)); assert.deepEqual(getStudioEnvelope(), current); assert.equal(count(), number);
});

test('内部项后来加锁会拒绝，未选兄弟加锁仍可精准采用标题', () => {
  const first = source(), original = getStudioEnvelope(), home = structuredClone(original.state.editorData.home) as Data;
  home.content[0].props.content[1].props.locked = true; const siblingLocked = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, actor);
  const chosen = select(first, [detail(first, 'headline').id]); assert.equal((preview(chosen).editorData.home as Data).content[0].props.content[1].props.locked, true); assert.deepEqual(getStudioEnvelope(), siblingLocked);
  home.content[0].props.content[0].props.locked = true; const selectedLocked = patchStudio({ expectedRevision: siblingLocked.revision, patch: { editorData: { ...siblingLocked.state.editorData, home } } }, actor), number = count();
  assert.throws(() => select(first, [detail(first, 'headline').id]), denied(409)); assert.deepEqual(getStudioEnvelope(), selectedLocked); assert.equal(count(), number);
});

test('内部全选保留细项语义，不扩大到后来人工修改的未变兄弟', () => {
  const first = source([{ kind: 'text', id: 'headline', text: 'AI_ALL_FINE_TITLE' }, { kind: 'text', id: 'copy', text: 'AI_ALL_FINE_COPY' }]), original = getStudioEnvelope(), home = structuredClone(original.state.editorData.home) as Data;
  home.content[0].props.content[2].props.title = 'MANUAL_UNCHANGED_PRODUCT'; patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, actor);
  const chosen = select(first, first.detailUnits!.map(unit => unit.id)), frozen = preview(chosen).editorData.home as Data;
  assert.equal(frozen.content[0].props.content[0].props.text, 'AI_ALL_FINE_TITLE'); assert.equal(frozen.content[0].props.content[1].props.text, 'AI_ALL_FINE_COPY'); assert.equal(frozen.content[0].props.content[2].props.title, 'MANUAL_UNCHANGED_PRODUCT');
  assert.ok(chosen.selection?.unitIds.every(id => id.startsWith('detail:d1:')));
});

test('内部重排在最近父树整体采用，另一个兄弟的文案不夹带', () => {
  const initial = getStudioEnvelope(), home = page(); home.content[0].props.content.push({ type: 'Container', props: { id: 'nested', content: [{ type: 'Text', props: { id: 'first', text: 'First' } }, { type: 'Text', props: { id: 'second', text: 'Second' } }] } });
  patchStudio({ expectedRevision: initial.revision, patch: { editorData: { ...initial.state.editorData, home } } }, actor);
  const first = source([{ kind: 'reorder', id: 'nested', children: ['second', 'first'] }, { kind: 'text', id: 'copy', text: 'AI_OTHER_COPY' }]);
  assert.ok(!first.detailUnits!.some(unit => unit.nodeIds.includes('first') || unit.nodeIds.includes('second')));
  const chosen = select(first, [detail(first, 'nested').id]), frozen = preview(chosen).editorData.home as Data;
  assert.deepEqual(frozen.content[0].props.content[3].props.content.map((node: { props: { id: string } }) => node.props.id), ['second', 'first']); assert.equal(frozen.content[0].props.content[1].props.text, 'Original supplied description.');
});

test('旧候选无detail字段读取时重算，内部项与另一根结构组可混合选择', () => {
  const first = source([{ kind: 'text', id: 'headline', text: 'AI_MIXED_TITLE' }, { kind: 'text', id: 'copy', text: 'AI_COPY_NOT_SELECTED' }, { kind: 'insert', parentId: '$page', index: 2, node: { tempId: 'new-mixed-root', type: 'Text', text: 'AI_NEW_ROOT' } }]);
  const row = getDatabase().prepare('SELECT payload_json FROM cms_ai_site_design WHERE id=?').get(first.designId) as { payload_json: string }, raw = JSON.parse(row.payload_json); delete raw.view.detailUnits;
  getDatabase().prepare('UPDATE cms_ai_site_design SET payload_json=? WHERE id=?').run(JSON.stringify(raw), first.designId); const loaded = readAiSiteDesign(first.designId, actor);
  const root = loaded.sectionUnits!.find(unit => unit.id.startsWith('section:g1:'))!; assert.ok(root);
  const chosen = select(loaded, [detail(loaded, 'headline').id, root.id]), frozen = preview(chosen);
  assert.match(JSON.stringify(frozen.editorData.home), /AI_MIXED_TITLE/); assert.match(JSON.stringify(frozen.editorData.home), /AI_NEW_ROOT/); assert.doesNotMatch(JSON.stringify(frozen.editorData.home), /AI_COPY_NOT_SELECTED/);
});
