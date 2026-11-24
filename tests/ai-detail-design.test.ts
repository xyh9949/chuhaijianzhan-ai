import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Data } from '@puckeditor/core';
import type { Actor } from '../src/server/permissions';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio, createInquiry } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { saveAiProvider } from '../src/server/ai-provider';
import { ApiError } from '../src/server/http';
import { generateAiDetailDesign, readAiDetailDesign, listAiDetailDesigns, deleteAiDetailDesign, prepareExternalDetailDesignContext, createExternalDetailDesignCandidate, applyAiDetailDesign, undoAiDetailDesign, resolveAiDetailDesignPreview, selectAiDetailDesign } from '../src/server/ai-detail-design';

const admin: Actor = { id: 'detail-admin', name: '详情管理员', email: 'detail@example.invalid', role: 'admin' };
const other: Actor = { id: 'other-admin', name: '其他管理员', email: 'other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'detail-editor', name: '编辑员', email: 'editor@example.invalid', role: 'editor' };
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
const request = (extra: Record<string, unknown> = {}) => ({ expectedRevision: getDraftRecord().revision, templateId: 'product-layout', instruction: '让详情页图文结构更清楚，手机阅读舒适，保留动态资料。', preserveText: true, ...extra });
const output = (operations: unknown[] = [{ kind: 'design', id: 'hero', design: { desktop: { paddingTop: 58 }, mobile: { paddingTop: 24 } } }]) => ({ summary: '重新安排原生详情的图文层级，保留真实动态资料。', intent: { goal: '让采购客户容易阅读详情', decisions: ['优化图文间距与手机阅读'], preserve: ['动态产品及案例资料'], assumptions: [] }, operations, warnings: [] });
const candidate = (extra: Record<string, unknown> = {}, result: unknown = output()) => createExternalDetailDesignCandidate(request(extra), result, admin, () => {});
let directory = '', previous: NodeJS.ProcessEnv, server: Server | undefined;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-ai-detail-design-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'detail-design-unit-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3295';
  getDraftRecord(); const content = createEmptyDraft();
  content.settings.name = 'Synthetic manufacturer'; content.settings.description = 'User supplied company information.';
  content.contentModels = [{ id: 'cases', name: 'Cases', target: 'content', description: '', updated: '', fields: [{ id: 'body', key: 'body', label: 'Case story', type: 'textarea', required: false }] }];
  content.products = [{ id: 'unmatched-product', name: 'PRIVATE_UNSELECTED_PRODUCT', sku: 'PRIVATE-SKU', category: 'Private', description: 'Private description', material: '', image: '', status: 'draft' }, { id: 'actual-product', name: 'Selected real product', sku: 'P1', category: 'Project', description: 'Confirmed steel product.', material: 'Steel', image: '', status: 'draft', slug: 'actual-product' }];
  content.contentEntries = [{ id: 'actual-case', title: 'Selected real case', modelId: 'cases', status: 'draft', updated: '', customFields: { body: 'Confirmed real case story.' } }];
  content.pages.push({ id: 'product-detail', title: 'Product detail', slug: '/products/:slug', type: 'product-detail', status: 'draft', updated: '' }, { id: 'case-detail', title: 'Case detail', slug: '/cases/:slug', type: '普通页面', contentModelId: 'cases', status: 'draft', updated: '' });
  content.editorData['product-detail'] = { root: { props: {} }, content: [{ type: 'Text', props: { id: 'fallback-product', text: 'DEFAULT_PRODUCT_LAYOUT' } }] };
  content.editorData['case-detail'] = { root: { props: {} }, content: [{ type: 'Text', props: { id: 'fallback-case', text: 'DEFAULT_CASE_LAYOUT' } }] };
  const data = (kind: 'product' | 'entry'): Data => ({ root: { props: { title: 'Original layout', showChrome: 'yes' } }, content: [{ type: 'Container', props: { id: 'hero', layout: 'column', content: [{ type: 'Heading', props: { id: 'title', text: '', level: 'h1', bindings: { text: { source: kind, mode: 'current', ...(kind === 'entry' ? { modelId: 'cases' } : {}), field: kind === 'product' ? 'builtin:name' : 'builtin:title' } } } }, { type: 'Text', props: { id: 'body', text: '', bindings: { text: { source: kind, mode: 'current', ...(kind === 'entry' ? { modelId: 'cases' } : {}), field: kind === 'product' ? 'builtin:description' : 'field:body' } } } }] } }, { type: 'Text', props: { id: 'support', text: 'Confirmed support information.' } }, { type: 'ProductList', props: { id: 'related-products', title: 'Related products', count: 3, columns: 3, mobileColumns: 1, category: 'Project' } }], zones: {} } as Data);
  content.pageTemplates = [{ id: 'product-layout', name: 'Product layout', description: '', kind: 'product', updated: '', detailRule: { enabled: true, priority: 20, recordIds: ['actual-product'] }, data: data('product') }, { id: 'case-layout', name: 'Case layout', description: '', kind: 'entry', modelId: 'cases', updated: '', detailRule: { enabled: true, priority: 20 }, data: data('entry') }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(content));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(async () => {
  if (server) { const active = server; server = undefined; active.closeAllConnections(); await new Promise<void>(done => active.close(() => done())); }
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-ai-detail-design-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function mock(handler: (body: Record<string, unknown>, count: number) => unknown = () => output()) {
  const requests: Record<string, unknown>[] = [];
  server = createServer((incoming, response) => { let raw = ''; incoming.on('data', chunk => raw += chunk); incoming.on('end', () => { const body = JSON.parse(raw); requests.push(body); const value = handler(body, requests.length); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })); }); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  saveAiProvider({ expectedRevision: 0, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-detail-design', allowLocal: true, apiKey: 'synthetic-detail-design-key' }, admin);
  return requests;
}

test('SQL14私表独立；角色、范围、版本及模型配置错误在外发前拒绝', async () => {
  assert.equal((getDatabase().prepare('SELECT max(version) n FROM cms_schema_migration').get() as { n: number }).n, 19);
  const before = getStudioEnvelope();
  await assert.rejects(generateAiDetailDesign(request(), editor), status(403)); await assert.rejects(generateAiDetailDesign(request({ expectedRevision: 99 }), admin), status(409)); await assert.rejects(generateAiDetailDesign(request({ templateId: 'missing' }), admin), status(422)); await assert.rejects(generateAiDetailDesign(request(), admin), status(422));
  assert.deepEqual(getStudioEnvelope(), before); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_template_design').get() as { n: number }).n, 0);
});

test('选择实际命中的真实产品而非首条；上下文仅提供选中事实；候选冻结且本人私有', async () => {
  const sent = await mock(); createInquiry({ name: 'Buyer', email: 'buyer@example.invalid', message: 'PRIVATE_INQUIRY_NOT_SENT' }); const before = getStudioEnvelope();
  const view = await generateAiDetailDesign(request(), admin);
  assert.equal(sent.length, 1); assert.equal(view.sample?.id, 'actual-product'); assert.equal(view.sample.matched, true); assert.match(view.sample.url, /actual-product/);
  assert.deepEqual(getStudioEnvelope(), before); assert.match(JSON.stringify(sent), /Selected real product/); assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_UNSELECTED_PRODUCT|PRIVATE_INQUIRY_NOT_SENT|synthetic-detail-design-key/);
  assert.equal(listAiDetailDesigns(other).items.length, 0); assert.throws(() => readAiDetailDesign(view.designId, other), status(404)); assert.throws(() => resolveAiDetailDesignPreview(view.designId, 'after', other), status(404));
  const old = resolveAiDetailDesignPreview(view.designId, 'before', admin)!, next = resolveAiDetailDesignPreview(view.designId, 'after', admin)!;
  assert.equal(old.resolved.product?.id, 'actual-product'); assert.equal(next.resolved.detailTemplateId, 'product-layout'); assert.doesNotMatch(JSON.stringify(old.resolved.data), /DEFAULT_PRODUCT_LAYOUT/); assert.match(JSON.stringify(next.resolved.data), /paddingTop/); assert.equal(next.snapshot.customCode?.global.jsEnabled, false);
  const changed = patchStudio({ expectedRevision: before.revision, patch: { products: before.state.products.map(item => ({ ...item, name: 'Live changed name' })) } }, admin);
  assert.equal(resolveAiDetailDesignPreview(view.designId, 'after', admin)!.resolved.product!.name, 'Selected real product'); assert.throws(() => applyAiDetailDesign({ designId: view.designId, expectedRevision: changed.revision }, admin), status(409));
});

test('案例真实详情使用相同记录的动态entry字段，采用撤销不改文章内容或匹配规则', () => {
  const before = getStudioEnvelope(), view = candidate({ templateId: 'case-layout' }); assert.equal(view.sample?.kind, 'entry'); assert.equal(view.sample?.id, 'actual-case'); assert.equal(view.sample?.matched, true);
  const rendered = resolveAiDetailDesignPreview(view.designId, 'after', admin)!; assert.equal(rendered.resolved.entry?.title, 'Selected real case'); assert.equal(rendered.resolved.detailTemplateId, 'case-layout'); assert.match(JSON.stringify(rendered.resolved.data), /field:body/);
  const after = applyAiDetailDesign({ designId: view.designId, expectedRevision: before.revision }, admin); assert.deepEqual(after.state.contentEntries, before.state.contentEntries); assert.deepEqual(after.state.pages, before.state.pages); assert.deepEqual(after.state.pageTemplates![1].detailRule, before.state.pageTemplates![1].detailRule);
  const undone = undoAiDetailDesign({ designId: view.designId, expectedRevision: after.revision }, admin); assert.deepEqual(undone.state.pageTemplates![1].data, before.state.pageTemplates![1].data); assert.equal(undone.activeReleaseId, before.activeReleaseId);
});

test('限定模板的历史、读取、选择、应用和撤销均拒绝其他模板的方案', () => {
  const product = candidate(), listing = candidate({ templateId: 'case-layout' });
  const before = getStudioEnvelope();
  const input = { designId: listing.designId, expectedRevision: before.revision, templateId: 'product-layout' };
  assert.deepEqual(new Set(listAiDetailDesigns(admin).items.map(item => item.designId)), new Set([product.designId, listing.designId]));
  assert.deepEqual(listAiDetailDesigns(admin, 'product-layout').items.map(item => item.designId), [product.designId]);
  assert.throws(() => readAiDetailDesign(listing.designId, admin, 'product-layout'), status(404));
  assert.throws(() => deleteAiDetailDesign(listing.designId, admin, 'product-layout'), status(404));
  assert.throws(() => selectAiDetailDesign({ ...input, unitIds: [listing.selectionUnits![0].id] }, admin), status(404));
  assert.throws(() => applyAiDetailDesign(input, admin), status(404));
  assert.deepEqual(getStudioEnvelope(), before);

  const applied = applyAiDetailDesign({ ...input, templateId: 'case-layout' }, admin);
  assert.throws(() => undoAiDetailDesign({ ...input, expectedRevision: applied.revision }, admin), status(404));
  assert.deepEqual(getStudioEnvelope(), { revision: applied.revision, state: applied.state, activeReleaseId: applied.activeReleaseId });
  const undone = undoAiDetailDesign({ ...input, templateId: 'case-layout', expectedRevision: applied.revision }, admin);
  assert.deepEqual(undone.state.pageTemplates!.map(item => item.data), before.state.pageTemplates!.map(item => item.data));
});

test('没有命中默认拒绝；显式兼容样本可强制布局预览，清楚标记且采用不启用规则', async () => {
  const initial = getDraftRecord(); initial.content.pageTemplates![0].detailRule!.enabled = false; getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(initial.content));
  const sent = await mock(); await assert.rejects(generateAiDetailDesign(request(), admin), status(422)); assert.equal(sent.length, 0);
  const view = await generateAiDetailDesign(request({ recordId: 'actual-product' }), admin); assert.equal(view.sample?.matched, false); assert.match(view.warnings.join(), /仅模板布局预览/);
  const rendered = resolveAiDetailDesignPreview(view.designId, 'before', admin)!; assert.doesNotMatch(JSON.stringify(rendered.resolved.data), /DEFAULT_PRODUCT_LAYOUT/);
  const applied = applyAiDetailDesign({ designId: view.designId, expectedRevision: 0 }, admin); assert.equal(applied.state.pageTemplates![0].detailRule!.enabled, false);
});

test('缺少真实样本、错误模型或默认详情页时不调用AI，也不保存假预览', async () => {
  const sent = await mock(); await assert.rejects(generateAiDetailDesign(request({ recordId: 'missing' }), admin), status(422)); await assert.rejects(generateAiDetailDesign(request({ templateId: 'case-layout', recordId: 'actual-product' }), admin), status(422));
  const current = getDraftRecord(); current.content.pages = current.content.pages.filter(page => page.id !== 'product-detail'); delete current.content.editorData['product-detail']; getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(current.content));
  await assert.rejects(generateAiDetailDesign(request({ recordId: 'actual-product' }), admin), status(422)); assert.equal(sent.length, 0); assert.equal(listAiDetailDesigns(admin).items.length, 0);
});

test('确认采用幂等，严格版本保护；仅替换目标data，不改其他模板、SEO、产品或公开指针', () => {
  const before = getStudioEnvelope(), view = candidate(), result = applyAiDetailDesign({ designId: view.designId, expectedRevision: before.revision }, admin);
  assert.equal(result.revision, before.revision + 1); assert.equal(applyAiDetailDesign({ designId: view.designId, expectedRevision: before.revision }, admin).revision, result.revision); assert.equal(result.activeReleaseId, before.activeReleaseId);
  for (const key of ['products', 'contentEntries', 'settings', 'editorData', 'theme', 'pages', 'customCode'] as const) assert.deepEqual(result.state[key], before.state[key]); assert.deepEqual(result.state.pageTemplates![1], before.state.pageTemplates![1]); assert.equal(readAiDetailDesign(view.designId, admin).canUndo, true);
});

test('撤销精确恢复data，保留后加页面、产品资料与模板名称；重复撤销幂等', () => {
  const before = getStudioEnvelope(), view = candidate(), applied = applyAiDetailDesign({ designId: view.designId, expectedRevision: 0 }, admin);
  const changed = patchStudio({ expectedRevision: applied.revision, patch: { products: applied.state.products.map(item => ({ ...item, material: 'Confirmed updated material' })), pageTemplates: applied.state.pageTemplates!.map(item => item.id === 'product-layout' ? { ...item, name: 'Manually named layout' } : item) } }, admin);
  const undone = undoAiDetailDesign({ designId: view.designId, expectedRevision: changed.revision }, admin); assert.deepEqual(undone.state.pageTemplates![0].data, before.state.pageTemplates![0].data); assert.equal(undone.state.pageTemplates![0].name, 'Manually named layout'); assert.equal(undone.state.products[0].material, 'Confirmed updated material'); assert.equal(undoAiDetailDesign({ designId: view.designId, expectedRevision: changed.revision }, admin).revision, undone.revision);
});

test('目标手改和新锁阻止撤销，read明确给出不可撤销原因', () => {
  const view = candidate(), applied = applyAiDetailDesign({ designId: view.designId, expectedRevision: 0 }, admin), templates = structuredClone(applied.state.pageTemplates!); templates[0].data.content[0].props.locked = true;
  const current = patchStudio({ expectedRevision: applied.revision, patch: { pageTemplates: templates } }, admin); const latest = readAiDetailDesign(view.designId, admin); assert.equal(latest.canUndo, false); assert.match(latest.undoReason!, /后续编辑|锁定/); assert.throws(() => undoAiDetailDesign({ designId: view.designId, expectedRevision: current.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), current);
});

test('相关产品卡片创建独立块，后续跨页面引用或手改会阻止删除，解除引用可撤销', () => {
  const view = candidate({}, output([{ kind: 'productCard', id: 'related-products', operations: [{ kind: 'design', id: 'card-related-products-title', design: { mobile: { fontSize: 20 } } }] }])), before = getStudioEnvelope(), applied = applyAiDetailDesign({ designId: view.designId, expectedRevision: 0 }, admin);
  assert.equal(applied.state.sharedBlocks?.length, 1); const blockId = applied.state.sharedBlocks![0].id;
  const home = structuredClone(applied.state.editorData.home) as Data; home.content.push({ type: 'SharedBlock', props: { id: 'external-ref', blockId } }); const changed = patchStudio({ expectedRevision: applied.revision, patch: { editorData: { ...applied.state.editorData, home } } }, admin);
  assert.throws(() => undoAiDetailDesign({ designId: view.designId, expectedRevision: changed.revision }, admin), status(409));
  const released = patchStudio({ expectedRevision: changed.revision, patch: { editorData: { ...changed.state.editorData, home: applied.state.editorData.home } } }, admin), undone = undoAiDetailDesign({ designId: view.designId, expectedRevision: released.revision }, admin); assert.equal(undone.state.sharedBlocks?.length, 0); assert.deepEqual(undone.state.pageTemplates![0].data, before.state.pageTemplates![0].data);
});

test('继续调整沿用原before和同样本，累计预览与采用一致；删除父不破坏子', () => {
  const before = getStudioEnvelope(), first = candidate(), second = candidate({ baseDesignId: first.designId, instruction: '保留刚才结构，把标题手机字号也缩小一点。' }, output([{ kind: 'design', id: 'title', design: { mobile: { fontSize: 28 } } }]));
  assert.equal(second.refinement?.round, 1); assert.equal(second.sample?.id, first.sample?.id); deleteAiDetailDesign(first.designId, admin); const frozen = resolveAiDetailDesignPreview(second.designId, 'after', admin)!; assert.match(JSON.stringify(frozen.resolved.data), /paddingTop/); assert.match(JSON.stringify(frozen.resolved.data), /fontSize/); assert.deepEqual(getStudioEnvelope(), before);
  const applied = applyAiDetailDesign({ designId: second.designId, expectedRevision: 0 }, admin); assert.deepEqual(applied.state.pageTemplates![0].data, frozen.resolved.data); assert.deepEqual(undoAiDetailDesign({ designId: second.designId, expectedRevision: applied.revision }, admin).state.pageTemplates![0].data, before.state.pageTemplates![0].data);
});

test('继续不能换模板、样本、放宽保留条件或超过6轮，已采用不能继续', () => {
  let view = candidate(); for (const extra of [{ templateId: 'case-layout' }, { recordId: 'unmatched-product' }, { preserveText: false }]) assert.throws(() => candidate({ baseDesignId: view.designId, ...extra }), status(422));
  for (let i = 1; i <= 6; i++) view = candidate({ baseDesignId: view.designId }, output([{ kind: 'design', id: 'title', design: { mobile: { fontSize: 26 + i } } }])); assert.equal(view.refinement?.round, 6); assert.throws(() => candidate({ baseDesignId: view.designId }), status(422));
  applyAiDetailDesign({ designId: view.designId, expectedRevision: 0 }, admin); assert.throws(() => candidate({ baseDesignId: view.designId }), status(409));
});

test('错误模型操作、任意patch、解除动态绑定和修改锁定内容被拒绝，草稿与候选不变', () => {
  const before = getStudioEnvelope(); for (const result of [{ summary: 'bad', patch: { products: [] }, operations: [], warnings: [] }, output([{ kind: 'text', id: 'title', text: 'Hardcoded sample' }]), output([{ kind: 'design', id: 'missing', design: { mobile: { fontSize: 28 } } }])]) assert.throws(() => candidate({}, result), status(422)); assert.deepEqual(getStudioEnvelope(), before); assert.equal(listAiDetailDesigns(admin).items.length, 0);
});

test('外部AI不调用站内模型，撤销授权在事务内复查；过期/删账号/降权不泄漏候选', () => {
  const before = getStudioEnvelope(); let calls = 0; assert.throws(() => createExternalDetailDesignCandidate(request(), output(), admin, () => { if (++calls === 2) throw new ApiError(403, 'revoked'); }), status(403)); assert.equal(listAiDetailDesigns(admin).items.length, 0); assert.deepEqual(getStudioEnvelope(), before);
  const view = candidate(); getDatabase().prepare('UPDATE cms_ai_template_design SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), view.designId); assert.throws(() => readAiDetailDesign(view.designId, admin), status(410));
  const next = candidate(); getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('viewer', admin.id); assert.throws(() => readAiDetailDesign(next.designId, admin), status(403)); getDatabase().prepare('DELETE FROM auth_user WHERE id=?').run(admin.id); assert.throws(() => resolveAiDetailDesignPreview(next.designId, 'after', admin), status(401));
});

test('生成期间草稿变化时丢弃候选，不覆盖用户工作', async () => {
  const sent = await mock(() => { const current = getStudioEnvelope(); patchStudio({ expectedRevision: current.revision, patch: { theme: { ...current.state.theme, primary: '#223344' } } }, admin); return output(); });
  await assert.rejects(generateAiDetailDesign(request(), admin), status(409)); assert.equal(sent.length, 1); assert.equal(getStudioEnvelope().state.theme.primary, '#223344'); assert.equal(listAiDetailDesigns(admin).items.length, 0);
});

test('配额保留生成槽位，过期记录清理；已生成预览独立于全站/局部私表', () => {
  const db = getDatabase(), stamp = new Date().toISOString(); for (let i = 0; i < 30; i++) db.prepare('INSERT INTO cms_ai_template_design(id,actor_id,template_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(`aitd-${randomUUID()}`, admin.id, 'product-layout', 0, '{"pending":true}', stamp, new Date(Date.now() + 60000).toISOString()); assert.throws(() => candidate(), status(429));
  db.prepare('UPDATE cms_ai_template_design SET expires_at=?').run(new Date(Date.now() - 1).toISOString()); const view = candidate(); assert.equal(listAiDetailDesigns(admin, 'product-layout').items[0].designId, view.designId); assert.equal(listAiDetailDesigns(admin, 'case-layout').items.length, 0); assert.equal((db.prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n, 0);
});

test('事实投影不外发关系ID、媒体URL或未在模板开放的字段', () => {
  const content = getDraftRecord().content, model = content.contentModels![0];
  model.fields.push({ id: 'cover', key: 'cover', label: 'Cover', type: 'image', required: false }, { id: 'reference', key: 'reference', label: 'Reference', type: 'url', required: false }, { id: 'related', key: 'related', label: 'Related', type: 'relation', required: false, relation: { source: 'product', multiple: true, onDelete: 'restrict' } });
  content.contentEntries![0].customFields = { body: 'Confirmed selected text', cover: '/api/media/PRIVATE_COVER', reference: 'https://example.invalid/?token=PRIVATE_QUERY', related: ['PRIVATE_UNAUTHORIZED_RELATED_RECORD'] };
  content.products[1].customFields = { unlisted: 'PRIVATE_UNDECLARED_PRODUCT_FIELD' };
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const entry = prepareExternalDetailDesignContext(request({ templateId: 'case-layout' }), admin), product = prepareExternalDetailDesignContext(request(), admin);
  assert.match(JSON.stringify(entry.context.sampleValues), /Confirmed selected text/); assert.doesNotMatch(JSON.stringify(entry.context.sampleValues), /PRIVATE_/); assert.doesNotMatch(JSON.stringify(product.context.sampleValues), /PRIVATE_/);
});

test('撤销保护后改的匹配规则和原同步块，避免恢复到含义已变的布局', () => {
  const content = getDraftRecord().content; content.sharedBlocks = [{ id: 'original-block', name: 'Original support', updated: '', data: { root: { props: {} }, content: [{ type: 'Text', props: { id: 'original-copy', text: 'Confirmed original support' } }] } }]; content.pageTemplates![0].data.content.push({ type: 'SharedBlock', props: { id: 'original-ref', blockId: 'original-block' } });
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const view = candidate(), applied = applyAiDetailDesign({ designId: view.designId, expectedRevision: 0 }, admin), blocks = structuredClone(applied.state.sharedBlocks!); blocks[0].data.content[0].props.text = 'Later support';
  const changed = patchStudio({ expectedRevision: applied.revision, patch: { sharedBlocks: blocks } }, admin); assert.throws(() => undoAiDetailDesign({ designId: view.designId, expectedRevision: changed.revision }, admin), status(409));
  const released = patchStudio({ expectedRevision: changed.revision, patch: { sharedBlocks: applied.state.sharedBlocks, pageTemplates: applied.state.pageTemplates!.map(item => item.id === 'product-layout' ? { ...item, detailRule: { ...item.detailRule!, enabled: false } } : item) } }, admin); assert.throws(() => undoAiDetailDesign({ designId: view.designId, expectedRevision: released.revision }, admin), status(409)); assert.equal(readAiDetailDesign(view.designId, admin).canUndo, false);
});

test('换图后用户删除旧素材，撤销明确拒绝恢复失效地址', () => {
  const content = getDraftRecord().content; content.media = ['old-photo', 'new-photo'].map(id => ({ id, name: id, url: `/api/media/${id}`, kind: 'image' as const, folder: '', size: '1 KB', alt: id })); content.pageTemplates![0].data.content.push({ type: 'Image', props: { id: 'static-photo', src: '/api/media/old-photo', alt: 'Existing photo' } });
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const view = candidate({}, output([{ kind: 'image', id: 'static-photo', mediaId: 'new-photo' }])), applied = applyAiDetailDesign({ designId: view.designId, expectedRevision: 0 }, admin), current = patchStudio({ expectedRevision: applied.revision, patch: { media: applied.state.media.filter(item => item.id !== 'old-photo') } }, admin);
  assert.throws(() => undoAiDetailDesign({ designId: view.designId, expectedRevision: current.revision }, admin), status(409)); assert.match(readAiDetailDesign(view.designId, admin).undoReason!, /素材/); assert.deepEqual(getStudioEnvelope(), current);
});

test('模型响应回来前管理员被降权，异步完成时拒绝写候选', async () => {
  const sent = await mock(() => { getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('viewer', admin.id); return output(); }); await assert.rejects(generateAiDetailDesign(request(), admin), status(403)); assert.equal(sent.length, 1); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_template_design').get() as { n: number }).n, 0); assert.equal(getDraftRecord().revision, 0);
});

test('预览越界分页拒绝；鉴权失败不回退到当前草稿或其他模板', () => {
  const source = getDraftRecord().content; source.sharedBlocks = [{ id: 'query-card', name: 'Query card', updated: '', data: { root: { props: {} }, content: [{ type: 'Text', props: { id: 'card-copy', text: 'Card' } }] } }];
  source.pageTemplates![0].data.content[2] = { type: 'ContentLoop', props: { id: 'related-products', source: 'product', itemBlockId: 'query-card', count: 6, columns: 3, query: { paginate: true, pageSize: 1 } } };
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(source));
  const view = candidate(); assert.throws(() => resolveAiDetailDesignPreview(`aitd-${randomUUID()}`, 'after', admin), status(404)); assert.throws(() => resolveAiDetailDesignPreview(view.designId, 'after', editor), status(403)); assert.equal(resolveAiDetailDesignPreview(view.designId, 'after', admin, { 'page_related-products': '999' }), null);
});

test('详情模板原生样式按范围真实派生，确认采用及精确撤销保留未选文字和同组件样式', () => {
  const source = candidate(), mobile = source.selectionUnits!.find(unit => unit.kind === 'property' && unit.viewport === 'mobile')!; assert.ok(mobile);
  const baseline = getStudioEnvelope(), selected = selectAiDetailDesign({ designId: source.designId, expectedRevision: baseline.revision, unitIds: [mobile.id] }, admin); assert.deepEqual(getStudioEnvelope(), baseline);
  assert.deepEqual(selected.selection, { sourceDesignId: source.designId, unitIds: [mobile.id] });
  const real = resolveAiDetailDesignPreview(selected.designId, 'after', admin)!; assert.equal(real.resolved.product!.id, 'actual-product'); assert.deepEqual(real.resolved.data.content[0].props.design, { mobile: { paddingTop: 24 } }); assert.equal(real.resolved.data.content[0].props.content[0].props.bindings.text.source, 'product');
  const applied = applyAiDetailDesign({ designId: selected.designId, expectedRevision: selected.baseRevision }, admin), templates = structuredClone(applied.state.pageTemplates!), target = templates.find(item => item.id === 'product-layout')!;
  target.data.content[0].props.design.desktop = { color: '#ff8800' }; target.data.content[1].props.text = 'Later unselected support';
  const changed = patchStudio({ expectedRevision: applied.revision, patch: { pageTemplates: templates } }, admin); assert.equal(readAiDetailDesign(selected.designId, admin).canUndo, true);
  const undone = undoAiDetailDesign({ designId: selected.designId, expectedRevision: changed.revision }, admin), restored = undone.state.pageTemplates!.find(item => item.id === 'product-layout')!;
  assert.deepEqual(restored.data.content[0].props.design, { desktop: { color: '#ff8800' } }); assert.equal(restored.data.content[1].props.text, 'Later unselected support'); assert.deepEqual(undone.state.products, baseline.state.products); assert.deepEqual(restored.detailRule, baseline.state.pageTemplates![0].detailRule);
});

test('详情范围仅接受服务器ID，整体/属性重叠、后改目标和后来内部锁定均拒绝', () => {
  const source = candidate(), units = source.selectionUnits!, property = units.find(unit => unit.kind === 'property' && unit.viewport === 'mobile')!, parent = units.find(unit => unit.id === property.parentId)!;
  const choose = (unitIds: string[], actor = admin) => selectAiDetailDesign({ designId: source.designId, expectedRevision: getDraftRecord().revision, unitIds }, actor);
  assert.throws(() => choose(['property:invented']), status(422)); assert.throws(() => choose([parent.id, property.id]), status(422)); assert.throws(() => choose([property.id], editor), status(403)); assert.throws(() => choose([property.id], other), status(404));
  const current = getStudioEnvelope(), templates = structuredClone(current.state.pageTemplates!); templates[0].data.content[0].props.content[0].props.locked = true;
  const changed = patchStudio({ expectedRevision: current.revision, patch: { pageTemplates: templates } }, admin);
  assert.throws(() => choose([property.id]), status(409)); assert.deepEqual(getStudioEnvelope(), changed);
});
