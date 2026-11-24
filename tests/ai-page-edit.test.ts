import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Data } from '@puckeditor/core';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio, createInquiry } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { ApiError } from '../src/server/http';
import { saveAiProvider } from '../src/server/ai-provider';
import { generateAiPageEdit, listAiPageEdits, readAiPageEdit, deleteAiPageEdit, applyAiPageEdit, undoAiPageEdit, resolveAiPageEditPreview } from '../src/server/ai-page-edit';
import type { Actor } from '../src/server/permissions';

const admin: Actor = { id: 'edit-admin', name: '页面管理员', email: 'admin@example.invalid', role: 'admin' };
const other: Actor = { id: 'edit-other', name: '其他管理员', email: 'other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'edit-editor', name: '编辑员', email: 'editor@example.invalid', role: 'editor' };
const request = (extra: Record<string, unknown> = {}) => ({ pageId: 'home', targetId: 'section', expectedRevision: 0, instruction: 'Simplify the copy for professional buyers.', mode: 'mixed', preserveText: false, lockedIds: [], ...extra });
const modelResult = () => ({ summary: '精简当前区块说明，其他内容保持。', operations: [{ kind: 'text', id: 'copy', text: 'Reviewed company information for professional buyers.' }], warnings: [] });
function pageData(): Data {
  return { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, content: [{ type: 'Container', props: { content: [{ type: 'Heading', props: { id: 'title', text: 'Original factory', level: 'h1' } }, { type: 'Text', props: { id: 'copy', text: 'Original company information supplied for review.' } }, { type: 'Image', props: { id: 'image', src: '/images/chair.jpg', alt: 'Existing photograph' } }], id: 'section', layout: 'column', columns: 1, mobileColumns: 1, gap: 24 } }, { type: 'Text', props: { id: 'outside', text: 'OUTSIDE_SCOPE_DO_NOT_SEND' } }], zones: {} } as Data;
}
let directory = '', previous: NodeJS.ProcessEnv, server: Server | undefined;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-ai-page-edit-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'page-edit-test-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3294';
  getDraftRecord(); const content = createEmptyDraft(); content.editorData.home = pageData();
  content.pages.push({ ...content.pages[0], id: 'other-page', title: 'Other page', slug: '/other' }); content.editorData['other-page'] = { root: { props: { title: 'Other page' } }, content: [{ type: 'Text', props: { id: 'other-copy', text: 'OTHER_PAGE_DO_NOT_SEND' } }] };
  content.products = [{ id: 'existing-product', sku: 'PRIVATE-PRODUCT-SKU', name: 'PRIVATE_PRODUCT_DO_NOT_SEND', category: 'Private', material: '', description: 'Private product information', image: '', status: 'draft' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(content));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(async () => {
  if (server) { const active = server; server = undefined; active.closeAllConnections(); await new Promise<void>(done => active.close(() => done())); }
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-ai-page-edit-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
async function mock(handler: (body: Record<string, unknown>) => unknown = () => modelResult()) {
  const requests: Record<string, unknown>[] = [];
  server = createServer((incoming, response) => { let raw = ''; incoming.on('data', chunk => raw += chunk); incoming.on('end', () => { const body = JSON.parse(raw); requests.push(body); const value = handler(body); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })); }); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  saveAiProvider({ expectedRevision: 0, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-page-edit-model', apiKey: 'synthetic-page-edit-key-do-not-export', allowLocal: true }, admin); return requests;
}

test('未配置、错误范围/权限/revision在外发前拒绝，生成不写网站', async () => {
  const before = getStudioEnvelope(); await assert.rejects(generateAiPageEdit(request(), admin), status(422));
  await assert.rejects(generateAiPageEdit(request(), editor), status(403)); await assert.rejects(generateAiPageEdit(request({ expectedRevision: 1 }), admin), status(409));
  await assert.rejects(generateAiPageEdit(request({ targetId: 'missing' }), admin), status(422)); await assert.rejects(generateAiPageEdit(request({ instruction: '' }), admin), status(422));
  assert.deepEqual(getStudioEnvelope(), before); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_edit').get() as { n: number }).n, 0);
});
test('只发送所选区块白名单，前后预览冻结且建议只在创建者私表', async () => {
  const requests = await mock(), before = getStudioEnvelope(); createInquiry({ name: 'Private buyer', email: 'private-buyer@example.invalid', message: 'PRIVATE_INQUIRY_DO_NOT_SEND' }); const current = getStudioEnvelope();
  const preview = await generateAiPageEdit(request(), admin); assert.equal(requests.length, 1); const encoded = JSON.stringify(requests); assert.match(encoded, /Original company information/); assert.doesNotMatch(encoded, /OUTSIDE_SCOPE|OTHER_PAGE|PRIVATE_PRODUCT|PRIVATE_INQUIRY|synthetic-page-edit-key/);
  assert.deepEqual(getStudioEnvelope(), current); assert.equal(preview.baseRevision, before.revision); assert.equal(preview.appliedRevision, null); assert.equal(listAiPageEdits(admin, 'home').items[0].editId, preview.editId); assert.equal(listAiPageEdits(other).items.length, 0);
  assert.throws(() => readAiPageEdit(preview.editId, other), status(404)); assert.throws(() => resolveAiPageEditPreview(preview.editId, 'after', other), status(404));
  const original = resolveAiPageEditPreview(preview.editId, 'before', admin)!, edited = resolveAiPageEditPreview(preview.editId, 'after', admin)!;
  assert.match(JSON.stringify(original.resolved.data), /Original company/); assert.match(JSON.stringify(edited.resolved.data), /Reviewed company/); assert.equal(edited.snapshot.customCode?.global.jsEnabled, false);
  assert.equal(JSON.stringify(current).includes(preview.editId), false); assert.equal(preview.request.instruction, request().instruction);
});
test('应用/撤销原子幂等，只有目标页面草稿改变，其他资料和公开指针保持', async () => {
  await mock(); const before = getStudioEnvelope(), preview = await generateAiPageEdit(request(), admin);
  const applied = applyAiPageEdit({ editId: preview.editId, expectedRevision: 0 }, admin), repeated = applyAiPageEdit({ editId: preview.editId, expectedRevision: 0 }, admin);
  assert.equal(applied.revision, 1); assert.equal(repeated.revision, 1); assert.equal(applied.activeReleaseId, before.activeReleaseId); assert.deepEqual(applied.state.products, before.state.products); assert.deepEqual(applied.state.editorData['other-page'], before.state.editorData['other-page']); assert.deepEqual(applied.state.settings, before.state.settings);
  assert.ok(Date.parse(readAiPageEdit(preview.editId, admin).expiresAt) > Date.now() + 6 * 24 * 60 * 60 * 1000);
  const theme = { ...getDraftRecord().content.theme, primary: '#123456' }; patchStudio({ expectedRevision: 1, patch: { theme } }, admin);
  const restored = undoAiPageEdit({ editId: preview.editId, expectedRevision: 2 }, admin), restoredAgain = undoAiPageEdit({ editId: preview.editId, expectedRevision: 2 }, admin);
  assert.equal(restored.revision, 3); assert.equal(restoredAgain.revision, 3); assert.deepEqual(restored.state.editorData.home, before.state.editorData.home); assert.equal(restored.state.theme.primary, '#123456'); assert.equal(restored.activeReleaseId, before.activeReleaseId);
  assert.equal(readAiPageEdit(preview.editId, admin).undoneRevision, 3); assert.equal(applyAiPageEdit({ editId: preview.editId, expectedRevision: 0 }, admin).revision, 3);
});
test('预览后409和应用后人工编辑的撤销冲突均保留后续修改', async () => {
  await mock(); const preview = await generateAiPageEdit(request(), admin);
  patchStudio({ expectedRevision: 0, patch: { theme: { ...getDraftRecord().content.theme, primary: '#345678' } } }, admin);
  assert.throws(() => applyAiPageEdit({ editId: preview.editId, expectedRevision: 0 }, admin), status(409));
  const fresh = await generateAiPageEdit(request({ expectedRevision: 1 }), admin); applyAiPageEdit({ editId: fresh.editId, expectedRevision: 1 }, admin);
  const data = structuredClone(getDraftRecord().content.editorData.home) as Data; data.content.push({ type: 'Text', props: { id: 'manual-addition', text: 'Keep later manual edit' } }); patchStudio({ expectedRevision: 2, patch: { editorData: { ...getDraftRecord().content.editorData, home: data } } }, admin);
  const current = getStudioEnvelope(); assert.throws(() => undoAiPageEdit({ editId: fresh.editId, expectedRevision: 3 }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), current);
});
test('生成期间并发或降权会释放本次记录，不把建议覆盖到新版本', async () => {
  await mock(() => { getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); return modelResult(); });
  await assert.rejects(generateAiPageEdit(request(), admin), status(403)); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_edit').get() as { n: number }).n, 0); assert.equal(getDraftRecord().revision, 0);
});
test('损坏模型/满额/超大预览均无付费重试且不留下占位', async () => {
  const requests = await mock(() => ({ ...modelResult(), operations: [{ kind: 'text', id: 'outside', text: 'Tampered outside scope' }] })); await assert.rejects(generateAiPageEdit(request(), admin), status(422)); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_edit').get() as { n: number }).n, 0);
  const db = getDatabase(), stamp = new Date().toISOString(), expiry = new Date(Date.now() + 60000).toISOString();
  for (let index = 0; index < 30; index++) db.prepare('INSERT INTO cms_ai_edit(id,actor_id,page_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(`aie-${randomUUID()}`, admin.id, 'home', 0, '{"pending":true}', stamp, expiry);
  await assert.rejects(generateAiPageEdit(request(), admin), status(429)); assert.equal(requests.length, 1); db.prepare('DELETE FROM cms_ai_edit').run();
  const content = getDraftRecord().content; (content.editorData['other-page'] as Data).content[0].props.text = 'L'.repeat(11 * 1024 * 1024); db.prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  await assert.rejects(generateAiPageEdit(request(), admin), status(413)); assert.equal(requests.length, 1);
});
test('到期/删除/当前角色与停用检查保持，删除历史不改已应用页面', async () => {
  await mock(); const preview = await generateAiPageEdit(request(), admin); assert.throws(() => undoAiPageEdit({ editId: preview.editId, expectedRevision: 0 }, admin), status(422));
  getDatabase().prepare('UPDATE cms_ai_edit SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', preview.editId); assert.throws(() => readAiPageEdit(preview.editId, admin), status(410)); assert.throws(() => applyAiPageEdit({ editId: preview.editId, expectedRevision: 0 }, admin), status(410));
  getDatabase().prepare('UPDATE cms_ai_edit SET expires_at=? WHERE id=?').run(new Date(Date.now() + 60000).toISOString(), preview.editId); applyAiPageEdit({ editId: preview.editId, expectedRevision: 0 }, admin);
  getDatabase().prepare('UPDATE auth_user SET banned=1 WHERE id=?').run(admin.id); assert.throws(() => readAiPageEdit(preview.editId, admin), status(401)); getDatabase().prepare('UPDATE auth_user SET banned=0 WHERE id=?').run(admin.id);
  const current = getStudioEnvelope(); deleteAiPageEdit(preview.editId, admin); assert.throws(() => readAiPageEdit(preview.editId, admin), status(404)); assert.deepEqual(getStudioEnvelope(), current);
});

test('未应用方案可以继续调整，模型看到候选内容但对比及撤销始终保留最初页面', async () => {
  let round = 0;
  const requests = await mock(() => ({ summary: `第${++round}轮设计`, intent: { goal: '让采购者快速理解公司', decisions: ['精简当前区块'], preserve: ['保留真实产品信息'], assumptions: [] }, operations: [{ kind: 'text', id: 'copy', text: `Candidate copy round ${round}` }], warnings: [] }));
  const before = getStudioEnvelope(), first = await generateAiPageEdit(request(), admin);
  const second = await generateAiPageEdit(request({ baseEditId: first.editId, instruction: 'Keep the direction and make the introduction clearer.' }), admin);
  assert.deepEqual(second.refinement, { baseEditId: first.editId, round: 1 });
  const body = JSON.parse((requests[1].messages as { content: string }[])[1].content);
  assert.match(JSON.stringify(body.nodes), /Candidate copy round 1/);
  assert.equal(body.refinement.originalGoal, request().instruction);
  assert.match(JSON.stringify(resolveAiPageEditPreview(second.editId, 'before', admin)?.resolved.data), /Original company information/);
  assert.match(JSON.stringify(resolveAiPageEditPreview(second.editId, 'after', admin)?.resolved.data), /Candidate copy round 2/);
  assert.deepEqual(getStudioEnvelope(), before);
  // 新方案拥有独立冻结载荷，删除旧候选不会使新方案的预览、采用或撤销失效。
  deleteAiPageEdit(first.editId, admin);
  const applied = applyAiPageEdit({ editId: second.editId, expectedRevision: before.revision }, admin);
  const restored = undoAiPageEdit({ editId: second.editId, expectedRevision: applied.revision }, admin);
  assert.deepEqual(restored.state.editorData.home, before.state.editorData.home);
  assert.equal(second.intent?.goal, '让采购者快速理解公司');
});

test('继续调整不能更换范围、解除锁定、访问他人或沿用已应用方案', async () => {
  const requests = await mock(), first = await generateAiPageEdit(request({ lockedIds: ['title'] }), admin);
  await assert.rejects(generateAiPageEdit(request({ baseEditId: first.editId, lockedIds: [] }), admin), status(422));
  await assert.rejects(generateAiPageEdit(request({ baseEditId: first.editId, lockedIds: ['title'], targetId: undefined }), admin), status(422));
  await assert.rejects(generateAiPageEdit(request({ baseEditId: first.editId, lockedIds: ['title'] }), other), status(404));
  assert.equal(requests.length, 1);
  applyAiPageEdit({ editId: first.editId, expectedRevision: 0 }, admin);
  await assert.rejects(generateAiPageEdit(request({ baseEditId: first.editId, lockedIds: ['title'], expectedRevision: 1 }), admin), status(409));
  assert.equal(requests.length, 1);
});

test('继续调整允许只细化手机，调用次数有界且每轮主动调用一次', async () => {
  let round = 0;
  const requests = await mock(() => ({ summary: '调整手机文字层级', operations: [{ kind: 'design', id: 'copy', design: { mobile: { fontSize: 16 + ++round } } }], warnings: [] }));
  let candidate = await generateAiPageEdit(request({ mode: 'design', preserveText: true }), admin);
  for (let index = 0; index < 6; index++) candidate = await generateAiPageEdit(request({ baseEditId: candidate.editId, mode: 'design', preserveText: true, viewport: 'mobile', instruction: 'Only improve mobile readability.' }), admin);
  assert.equal(candidate.refinement?.round, 6); assert.equal(requests.length, 7);
  await assert.rejects(generateAiPageEdit(request({ baseEditId: candidate.editId, mode: 'design', preserveText: true, viewport: 'mobile' }), admin), status(422));
  assert.equal(requests.length, 7); assert.equal(getDraftRecord().revision, 0);
});

test('模型生成期间父方案被应用会拒绝新候选，不遗留可覆盖草稿的分叉', async () => {
  let parentId = '', calls = 0;
  await mock(() => { if (++calls === 2) applyAiPageEdit({ editId: parentId, expectedRevision: 0 }, admin); return { summary: '继续精简说明', operations: [{ kind: 'text', id: 'copy', text: `Concurrent design ${calls}` }], warnings: [] }; });
  parentId = (await generateAiPageEdit(request(), admin)).editId;
  await assert.rejects(generateAiPageEdit(request({ baseEditId: parentId }), admin), status(409));
  assert.equal(listAiPageEdits(admin).items.length, 1); assert.equal(getDraftRecord().revision, 1);
  assert.match(JSON.stringify(getDraftRecord().content.editorData.home), /Concurrent design 1/);
});

function addProductCard() {
  const content = getDraftRecord().content;
  (content.editorData.home as Data).content[0].props.content.push({ type: 'ContentLoop', props: { id: 'loop', source: 'product', itemBlockId: 'existing-card', count: 3, columns: 3, mobileColumns: 1, gap: 20, title: '', emptyText: 'No products yet' } });
  content.sharedBlocks = [{ id: 'existing-card', name: '原产品卡片', updated: '原始', data: { root: { props: {} }, content: [{ type: 'Container', props: { id: 'card-frame', content: [{ type: 'Heading', props: { id: 'card-title', text: '', level: 'h3', bindings: { text: { source: 'product', mode: 'current', field: 'builtin:name' } }, design: { desktop: { fontSize: 20 } } } }], layout: 'column', gap: 12 } }], zones: {} } }];
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
}

test('动态卡片在候选预览私有生成，续调只保留最终资产，确认与撤销原子处理页面及卡片', async () => {
  addProductCard(); let round = 0;
  const requests = await mock(() => ({ summary: '突出动态产品名称和层级', operations: [{ kind: 'productCard', id: 'loop', operations: [{ kind: 'design', id: 'card-title', design: { desktop: { fontSize: 30 + ++round }, mobile: { fontSize: 24 } } }] }], warnings: [] }));
  const before = getStudioEnvelope(), first = await generateAiPageEdit(request({ mode: 'design', preserveText: true }), admin);
  assert.match((requests[0].messages as { content: string }[])[1].content, /PRIVATE_PRODUCT_DO_NOT_SEND/);
  assert.deepEqual(getStudioEnvelope(), before);
  const final = await generateAiPageEdit(request({ baseEditId: first.editId, mode: 'design', preserveText: true, instruction: 'Keep the card and make the product title a little larger.' }), admin);
  const original = resolveAiPageEditPreview(final.editId, 'before', admin)!, candidate = resolveAiPageEditPreview(final.editId, 'after', admin)!;
  assert.equal(original.snapshot.sharedBlocks?.length, 1); assert.equal(candidate.snapshot.sharedBlocks?.length, 2);
  assert.deepEqual(candidate.snapshot.sharedBlocks?.[0], before.state.sharedBlocks?.[0]);
  assert.equal(final.difference?.typographyChanged, true);
  const added = candidate.snapshot.sharedBlocks!.find(block => block.id !== 'existing-card')!;
  assert.equal((added.data.content[0].props.content as Data['content'])[0].props.design.desktop.fontSize, 32);
  const applied = applyAiPageEdit({ editId: final.editId, expectedRevision: 0 }, admin);
  assert.equal(applied.state.sharedBlocks?.length, 2); assert.deepEqual(applied.state.sharedBlocks?.[0], before.state.sharedBlocks?.[0]);
  const restored = undoAiPageEdit({ editId: final.editId, expectedRevision: applied.revision }, admin);
  assert.deepEqual(restored.state.sharedBlocks, before.state.sharedBlocks); assert.deepEqual(restored.state.editorData.home, before.state.editorData.home);
});

test('生成卡片被其他页面采用后撤销拒绝覆盖；解除外部引用后可以完整恢复', async () => {
  addProductCard();
  await mock(() => ({ summary: '调整产品卡片', operations: [{ kind: 'productCard', id: 'loop', operations: [{ kind: 'design', id: 'card-title', design: { desktop: { fontSize: 36 } } }] }], warnings: [] }));
  const preview = await generateAiPageEdit(request({ mode: 'design', preserveText: true }), admin), applied = applyAiPageEdit({ editId: preview.editId, expectedRevision: 0 }, admin);
  const generated = applied.state.sharedBlocks!.find(block => block.id !== 'existing-card')!;
  const related = patchStudio({ expectedRevision: applied.revision, patch: { editorData: { ...applied.state.editorData, 'other-page': { root: { props: {} }, content: [{ type: 'SharedBlock', props: { id: 'adopted-card', blockId: generated.id } }] } } } }, admin);
  assert.throws(() => undoAiPageEdit({ editId: preview.editId, expectedRevision: related.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), related);
  const detached = patchStudio({ expectedRevision: related.revision, patch: { editorData: { ...related.state.editorData, 'other-page': { root: { props: {} }, content: [] } } } }, admin);
  const restored = undoAiPageEdit({ editId: preview.editId, expectedRevision: detached.revision }, admin);
  assert.equal(restored.state.sharedBlocks?.length, 1); assert.equal(restored.state.sharedBlocks?.[0].id, 'existing-card');
});

test('同一父方案的两个分支只能采用一个，旧分支不能覆盖已经采用的设计', async () => {
  let round = 0;
  await mock(() => ({ summary: '候选设计', operations: [{ kind: 'text', id: 'copy', text: `Branch ${++round}` }], warnings: [] }));
  const parent = await generateAiPageEdit(request(), admin), left = await generateAiPageEdit(request({ baseEditId: parent.editId }), admin), right = await generateAiPageEdit(request({ baseEditId: parent.editId }), admin);
  const applied = applyAiPageEdit({ editId: left.editId, expectedRevision: 0 }, admin);
  assert.throws(() => applyAiPageEdit({ editId: right.editId, expectedRevision: 0 }, admin), status(409));
  assert.throws(() => applyAiPageEdit({ editId: right.editId, expectedRevision: applied.revision }, admin), status(409));
  const current = getStudioEnvelope(); assert.deepEqual(current.state, applied.state); assert.equal(current.revision, applied.revision); assert.match(JSON.stringify(applied.state.editorData.home), /Branch 2/);
});

test('采用后手工调整生成卡片会阻止撤销覆盖，正常服务端更新时间不影响撤销判定', async () => {
  addProductCard();
  await mock(() => ({ summary: '调整产品卡片', operations: [{ kind: 'productCard', id: 'loop', operations: [{ kind: 'design', id: 'card-title', design: { desktop: { fontSize: 36 } } }] }], warnings: [] }));
  const preview = await generateAiPageEdit(request({ mode: 'design', preserveText: true }), admin), applied = applyAiPageEdit({ editId: preview.editId, expectedRevision: 0 }, admin);
  const blocks = structuredClone(applied.state.sharedBlocks!); blocks.find(block => block.id !== 'existing-card')!.name = '用户确认的新卡片名称';
  const manual = patchStudio({ expectedRevision: applied.revision, patch: { sharedBlocks: blocks } }, admin);
  assert.throws(() => undoAiPageEdit({ editId: preview.editId, expectedRevision: manual.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), manual);
});

test('设计上下文复用真实列表查询筛选，锁定产品列表不发送其产品样本', async () => {
  addProductCard();
  const content = getDraftRecord().content, loop = (content.editorData.home as Data).content[0].props.content.find((node: Data['content'][number]) => node.props.id === 'loop');
  content.products.push({ ...content.products[0], id: 'excluded-product', sku: 'EXCLUDED-PRODUCT-SKU', name: 'OUTSIDE_FILTER_PRODUCT_DO_NOT_SEND' });
  loop.props.query = { filters: [{ field: 'builtin:id', op: 'eq', value: 'existing-product' }] };
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const requests = await mock(); await generateAiPageEdit(request(), admin);
  assert.match((requests[0].messages as { content: string }[])[1].content, /PRIVATE_PRODUCT_DO_NOT_SEND/);
  assert.doesNotMatch((requests[0].messages as { content: string }[])[1].content, /OUTSIDE_FILTER_PRODUCT_DO_NOT_SEND/);
  loop.props.locked = true; getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  await generateAiPageEdit(request(), admin);
  assert.doesNotMatch((requests[1].messages as { content: string }[])[1].content, /PRIVATE_PRODUCT_DO_NOT_SEND|OUTSIDE_FILTER_PRODUCT_DO_NOT_SEND/);
});
