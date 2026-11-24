import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Actor } from '../src/server/permissions';
import type { AiWritingGenerateInput, AiWritingProposal, AiWritingReceiptInput } from '../src/lib/ai-writing-types';
import { textToRichText, richTextPlainText } from '../src/lib/presentation-content';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { getAiProviderSummary, saveAiProvider } from '../src/server/ai-provider';
import { readAiWritingProfile, saveAiWritingProfile, generateAiWritingProposal, readAiWritingProposal, listAiWritingProposals, saveAiWritingDraft, readAiWritingSaveAttempt, listAiWritingReceipts, undoAiWritingReceipt, writingGroundingWarnings } from '../src/server/ai-writing';
import { readWritingReuse } from '../src/server/ai-writing-reuse';
import { ApiError } from '../src/server/http';

const admin: Actor = { id: 'writing-admin', name: '写作管理员', email: 'writing@example.invalid', role: 'admin' };
const other: Actor = { id: 'writing-other', name: '另一管理员', email: 'other@example.invalid', role: 'admin' };
let directory: string, previous: NodeJS.ProcessEnv, server: Server, calls: number, response: (prompt: Record<string, any>) => unknown, seenPrompt: string;
beforeEach(async () => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-ai-writing-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'synthetic-writing-secret-'.repeat(4); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3299';
  const current = getDraftRecord(); getDatabase().exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other]) getDatabase().prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
  patchStudio({ expectedRevision: current.revision, patch: {
    products: [{ id: 'writing-product', name: 'Original product', sku: 'SKU-0001', category: 'Parts', status: 'draft', image: '/images/studio.jpg', description: 'Original stored description', material: 'Steel' }],
    contentModels: [{ id: 'writing-model', name: '新闻', description: '', target: 'content', updated: '', fields: [{ id: 'body', key: 'body', label: '正文', type: 'textarea', required: false }, { id: 'excerpt', key: 'excerpt', label: '摘要', type: 'textarea', required: false }, { id: 'private-number', key: 'private_number', label: '内部数字', type: 'number', required: false }] }],
    contentEntries: [{ id: 'writing-entry', modelId: 'writing-model', title: 'Original article', status: 'draft', updated: '', customFields: { body: 'Original body', excerpt: 'Original excerpt' } }],
  } }, admin);
  calls = 0; seenPrompt = '';
  response = prompt => ({ fields: prompt.fields.map((field: any) => ({ key: field.key, after: field.kind === 'richtext' ? textToRichText('Generated body') : 'Generated description' })), warnings: [], missingFacts: [], evidenceIds: [] });
  server = createServer(async (request, reply) => {
    calls++; const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.match(input.messages[0].content, /AI_CONTENT_WRITING/); seenPrompt = input.messages[1].content;
    const result = response(JSON.parse(seenPrompt)); reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  saveAiProvider({ expectedRevision: getAiProviderSummary().revision, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-writing', apiKey: '', allowLocal: true }, admin);
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-ai-writing-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
function input(overrides: Partial<AiWritingGenerateInput> = {}): AiWritingGenerateInput { return { target: { kind: 'product', id: 'writing-product' }, fields: [{ key: 'description', label: '产品介绍', kind: 'text', maxLength: 1500, before: 'Human unsaved description' }], outputKeys: ['description'], task: 'product', sourceText: 'Steel parts. SKU-0001.', instruction: '', language: 'en', audience: '', tone: '', factIds: [], profileRevision: readAiWritingProfile(admin).revision, ...overrides }; }
function receipt(proposal: AiWritingProposal, before = 'Human unsaved description', after = 'Generated description'): AiWritingReceiptInput { return { proposalId: proposal.id, selectedKeys: ['description'], before: { description: before }, after: { description: after } }; }
function saveProduct(proposal: AiWritingProposal, next: Record<string, unknown> = {}, proof = receipt(proposal)) {
  const envelope = getStudioEnvelope(), product = { ...envelope.state.products[0], description: 'Generated description', ...next };
  return saveAiWritingDraft({ expectedRevision: envelope.revision, patch: { products: [product] }, receipts: [proof] }, admin);
}

test('写作资料私有保存、版本冲突及人工确认/适用范围可控，不进入Studio', () => {
  const original = getStudioEnvelope(), defaults = readAiWritingProfile(admin);
  assert.equal(defaults.revision, 0); assert.deepEqual(defaults.facts, []);
  const { revision: _rev, updatedAt: _date, ...fields } = defaults;
  const saved = saveAiWritingProfile({ ...fields, expectedRevision: 0, facts: [] }, admin);
  assert.equal(saved.revision, 1); assert.deepEqual(getStudioEnvelope(), original);
});

test('profile只接受明确白名单，版本变化保留旧数据', () => {
  const { revision: rev, updatedAt: _date, ...fields } = readAiWritingProfile(admin);
  const saved = saveAiWritingProfile({ ...fields, expectedRevision: rev, brandName: 'Factory', facts: [{ id: 'f1', label: '材质', text: 'Steel', source: '人工确认', confirmed: true, scope: 'company' }] }, admin);
  assert.throws(() => saveAiWritingProfile({ ...fields, expectedRevision: rev }, admin), status(409));
  assert.throws(() => saveAiWritingProfile({ ...fields, expectedRevision: saved.revision, apiKey: 'bad' }, admin), status(422));
  assert.equal(readAiWritingProfile(admin).brandName, 'Factory');
  assert.ok(saved.facts[0].confirmedAt && Number.isFinite(Date.parse(saved.facts[0].confirmedAt)));
});

test('未保存表单可生成、只发送选定字段，读取原建议不重发模型不改草稿', async () => {
  const before = getStudioEnvelope(); const proposal = await generateAiWritingProposal(input({ fields: [...input().fields, { key: 'seoTitle', label: '搜索标题', kind: 'text', maxLength: 200, before: 'Do not send hidden SEO' }] }), admin);
  assert.equal(calls, 1); assert.ok(!seenPrompt.includes('Do not send hidden SEO')); assert.equal(proposal.fields[0].before, 'Human unsaved description');
  assert.equal(readAiWritingProposal(proposal.id, admin).id, proposal.id); assert.equal(listAiWritingProposals(admin).items.length, 1); assert.equal(calls, 1); assert.deepEqual(getStudioEnvelope(), before);
});

test('本人提案和回执隔离，角色与停用状态每次重新检查', async () => {
  const proposal = await generateAiWritingProposal(input(), admin);
  assert.throws(() => readAiWritingProposal(proposal.id, other), status(404)); assert.equal(listAiWritingProposals(other).items.length, 0);
  const request = input(); getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('editor', admin.id);
  assert.throws(() => readAiWritingProfile(admin), status(403)); await assert.rejects(generateAiWritingProposal(request, admin), status(403));
  getDatabase().prepare('UPDATE auth_user SET role=?,banned=1 WHERE id=?').run('admin', admin.id); assert.throws(() => readAiWritingProfile(admin), status(401));
});

test('纯文本产品输出拒绝HTML、未知字段、重复字段与超长介绍且不自动重试', async () => {
  for (const output of [
    { fields: [{ key: 'description', after: '<script>alert(1)</script>' }], warnings: [], missingFacts: [] },
    { fields: [{ key: 'sku', after: 'Hacked' }], warnings: [], missingFacts: [] },
    { fields: [{ key: 'description', after: 'x'.repeat(1501) }], warnings: [], missingFacts: [] },
    { fields: [], warnings: [], missingFacts: [] },
  ]) { response = () => output; const count = calls; await assert.rejects(generateAiWritingProposal(input(), admin), status(422)); assert.equal(calls, count + 1); }
  assert.equal(listAiWritingProposals(admin).items.length, 0);
});

test('原字段和自定义数字不可作为写作目标，字段声明不能抬高输出限制', async () => {
  await assert.rejects(generateAiWritingProposal(input({ fields: [{ key: 'sku', label: 'SKU', kind: 'text', maxLength: 9000, before: '' }], outputKeys: ['sku'] }), admin), status(422));
  await assert.rejects(generateAiWritingProposal(input({ target: { kind: 'entry', id: 'writing-entry', modelId: 'writing-model' }, fields: [{ key: 'customFields:private-number', label: '数字', kind: 'text', maxLength: 1000, before: '' }], outputKeys: ['customFields:private-number'] }), admin), status(422)); assert.equal(calls, 0);
});

test('来源确认和产品适用范围未满足时不发请求', async () => {
  const { revision: rev, updatedAt: _date, ...fields } = readAiWritingProfile(admin);
  const profile = saveAiWritingProfile({ ...fields, expectedRevision: rev, facts: [{ id: 'unconfirmed', label: '认证', text: 'ISO 9001', source: '待核对', confirmed: false, scope: 'company' }, { id: 'other-product', label: '另一产品', text: '10 mm', source: '产品表', confirmed: true, scope: 'product', productId: 'another-product' }] }, admin);
  for (const factIds of [['unconfirmed'], ['other-product'], ['missing']]) await assert.rejects(generateAiWritingProposal(input({ profileRevision: profile.revision, factIds }), admin), status(422)); assert.equal(calls, 0);
});

test('profile或服务器原产品参数变化标旧建议过时并禁止按旧依据落库', async () => {
  const proposal = await generateAiWritingProposal(input(), admin); const current = getStudioEnvelope();
  patchStudio({ expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], material: 'Aluminium' }] } }, admin);
  assert.equal(readAiWritingProposal(proposal.id, admin).stale, true); assert.throws(() => saveProduct(proposal), status(409));
  const fresh = await generateAiWritingProposal(input(), admin); const { revision: rev, updatedAt: _d, ...fields } = readAiWritingProfile(admin); saveAiWritingProfile({ ...fields, expectedRevision: rev, tone: 'Concise' }, admin);
  assert.equal(readAiWritingProposal(fresh.id, admin).stale, true); assert.throws(() => saveProduct(fresh), status(409)); assert.equal(calls, 2);
});

test('采用前编辑区值与原生保存同事务建立回执，撤销不回滚其他字段或公开指针', async () => {
  const proposal = await generateAiWritingProposal(input(), admin), active = getStudioEnvelope().activeReleaseId;
  const saved = saveProduct(proposal, { name: 'Manually improved name' }); assert.equal(saved.writingReceipts.length, 1);
  const current = getStudioEnvelope(); patchStudio({ expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], material: 'Other manually changed material' }] } }, admin);
  const id = saved.writingReceipts[0].id, undo = undoAiWritingReceipt(id, { expectedRevision: getStudioEnvelope().revision }, admin);
  assert.equal(undo.state.products[0].description, 'Human unsaved description'); assert.equal(undo.state.products[0].name, 'Manually improved name'); assert.equal(undo.state.products[0].material, 'Other manually changed material'); assert.equal(undo.activeReleaseId, active);
  const revisionNow = undo.revision; assert.equal(undoAiWritingReceipt(id, { expectedRevision: revisionNow }, admin).revision, revisionNow);
});

test('填入后又人工改该字段时不把人工结果登记成AI回执', async () => {
  const proposal = await generateAiWritingProposal(input(), admin); const result = saveProduct(proposal, { description: 'Manually rewritten after AI' });
  assert.equal(result.state.products[0].description, 'Manually rewritten after AI'); assert.deepEqual(result.writingReceipts, []); assert.equal(listAiWritingReceipts(admin).items.length, 0);
});

test('相同保存失联重试幂等，不重复建记录；后续其他内容变化时不重放旧数组', async () => {
  const proposal = await generateAiWritingProposal(input(), admin), current = getStudioEnvelope(), originalInput = { expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], description: 'Generated description' }] }, receipts: [receipt(proposal)] };
  const first = saveAiWritingDraft(originalInput, admin), again = saveAiWritingDraft(originalInput, admin);
  assert.equal(again.revision, first.revision); assert.equal(again.writingReceipts[0].id, first.writingReceipts[0].id); assert.equal(listAiWritingReceipts(admin).items.length, 1);
  patchStudio({ expectedRevision: again.revision, patch: { products: [{ ...again.state.products[0], name: 'Later manual name' }] } }, admin);
  assert.throws(() => saveAiWritingDraft(originalInput, admin), status(409)); assert.equal(getStudioEnvelope().state.products[0].name, 'Later manual name');
});

test('已保存后改目标字段时拒绝旧撤销，保留人工改动', async () => {
  const proposal = await generateAiWritingProposal(input(), admin), result = saveProduct(proposal), current = getStudioEnvelope();
  patchStudio({ expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], description: 'Later manual content' }] } }, admin);
  assert.throws(() => undoAiWritingReceipt(result.writingReceipts[0].id, { expectedRevision: getStudioEnvelope().revision }, admin), status(409));
  assert.equal(getStudioEnvelope().state.products[0].description, 'Later manual content'); assert.throws(() => undoAiWritingReceipt(result.writingReceipts[0].id, { expectedRevision: getStudioEnvelope().revision }, other), status(404));
});

test('新建产品在原保存时绑定稳定ID，撤销字段而非删除新记录', async () => {
  const proposal = await generateAiWritingProposal(input({ target: { kind: 'product', id: 'new-writing-product' }, fields: [{ ...input().fields[0], before: '' }] }), admin), current = getStudioEnvelope();
  const newProduct = { ...current.state.products[0], id: 'new-writing-product', sku: 'NEW-SKU', description: 'Generated description' };
  const saved = saveAiWritingDraft({ expectedRevision: current.revision, patch: { products: [...current.state.products, newProduct] }, receipts: [receipt(proposal, '')] }, admin);
  const undo = undoAiWritingReceipt(saved.writingReceipts[0].id, { expectedRevision: saved.revision }, admin); assert.equal(undo.state.products.length, 2); assert.equal(undo.state.products[1].id, 'new-writing-product'); assert.equal(undo.state.products[1].description, '');
});

test('新文章原空必填title不纳入撤销，其余正文可撤且不删除记录，失联重试仍幂等', async () => {
  const proposal = await generateAiWritingProposal(input({ target: { kind: 'entry', id: 'new-writing-entry', modelId: 'writing-model' }, fields: [{ key: 'title', label: '标题', kind: 'text', maxLength: 200, before: '' }, { key: 'customFields:body', label: '正文', kind: 'richtext', maxLength: 30000, before: '' }], outputKeys: ['title', 'customFields:body'], task: 'article' }), admin);
  const current = getStudioEnvelope(), title = proposal.fields.find(field => field.key === 'title')!.after as string, doc = proposal.fields.find(field => field.key === 'customFields:body')!.after;
  const entry = { id: 'new-writing-entry', modelId: 'writing-model', title, status: 'draft', updated: '', customFields: { body: richTextPlainText(doc as any) }, richTextFields: { body: doc } };
  const saveInput = { expectedRevision: current.revision, patch: { contentEntries: [...current.state.contentEntries!, entry] }, receipts: [{ proposalId: proposal.id, selectedKeys: ['title', 'customFields:body'], before: { title: '', 'customFields:body': '' }, after: { title, 'customFields:body': doc }, beforePresent: { title: true, 'customFields:body': false } }] };
  const saved = saveAiWritingDraft(saveInput, admin); assert.deepEqual(saved.writingReceipts[0].fields, ['customFields:body']); assert.equal(saved.writingWarnings.length, 1); assert.match(saved.writingWarnings[0], /标题/);
  assert.equal(saveAiWritingDraft(saveInput, admin).revision, saved.revision);
  const undo = undoAiWritingReceipt(saved.writingReceipts[0].id, { expectedRevision: saved.revision }, admin), restored = undo.state.contentEntries!.find(item => item.id === entry.id)!;
  assert.equal(undo.state.contentEntries!.length, 2); assert.equal(restored.title, title); assert.equal(Object.hasOwn(restored.customFields, 'body'), false); assert.deepEqual(restored.richTextFields, {});
});

test('仅有原空必填title时正常保存并明确无可撤回执，不放宽required', async () => {
  const proposal = await generateAiWritingProposal(input({ target: { kind: 'entry', id: 'title-only-entry', modelId: 'writing-model' }, fields: [{ key: 'title', label: '标题', kind: 'text', maxLength: 200, before: '' }], outputKeys: ['title'], task: 'article' }), admin), current = getStudioEnvelope(), title = proposal.fields[0].after as string;
  const saved = saveAiWritingDraft({ expectedRevision: current.revision, patch: { contentEntries: [...current.state.contentEntries!, { id: 'title-only-entry', modelId: 'writing-model', title, status: 'draft', updated: '', customFields: {} }] }, receipts: [{ proposalId: proposal.id, selectedKeys: ['title'], before: { title: '' }, after: { title } }] }, admin);
  assert.equal(saved.writingReceipts.length, 0); assert.equal(saved.writingWarnings.length, 1); assert.equal(saved.state.contentEntries!.find(item => item.id === 'title-only-entry')!.title, title);
});

test('文章RichNode/文字成对保存，选段或追加后的实际whole-body可登记撤销', async () => {
  const beforeDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Human original' }] }, { type: 'image', attrs: { src: '/images/studio.jpg', alt: 'Existing image', width: 50, align: 'left' } }] } as const;
  const inputValue = input({ target: { kind: 'entry', id: 'writing-entry', modelId: 'writing-model' }, fields: [{ key: 'customFields:body', label: '正文', kind: 'richtext', maxLength: 30000, before: textToRichText('Selected text') }], outputKeys: ['customFields:body'], task: 'rewrite' });
  const proposal = await generateAiWritingProposal(inputValue, admin), afterDoc = { type: 'doc', content: [...beforeDoc.content, ...textToRichText('Generated body').content!] }, current = getStudioEnvelope();
  const entry = { ...current.state.contentEntries![0], customFields: { ...current.state.contentEntries![0].customFields, body: richTextPlainText(afterDoc as any) }, richTextFields: { body: afterDoc } };
  const saved = saveAiWritingDraft({ expectedRevision: current.revision, patch: { contentEntries: [entry] }, receipts: [{ proposalId: proposal.id, selectedKeys: ['customFields:body'], before: { 'customFields:body': beforeDoc }, after: { 'customFields:body': afterDoc } }] }, admin);
  assert.equal(saved.state.contentEntries![0].richTextFields!.body.content!.filter(n => n.type === 'image').length, 1);
  const undo = undoAiWritingReceipt(saved.writingReceipts[0].id, { expectedRevision: saved.revision }, admin); assert.deepEqual(undo.state.contentEntries![0].richTextFields!.body, beforeDoc); assert.equal(undo.state.contentEntries![0].customFields.excerpt, 'Original excerpt');
});

test('模型不能新增图片、危险链接或伪造未发送的事实引用', async () => {
  const article = input({ target: { kind: 'entry', id: 'writing-entry', modelId: 'writing-model' }, fields: [{ key: 'customFields:body', label: '正文', kind: 'richtext', maxLength: 30000, before: '' }], outputKeys: ['customFields:body'], task: 'article' });
  response = () => ({ fields: [{ key: 'customFields:body', after: { type: 'doc', content: [{ type: 'image', attrs: { src: '/images/studio.jpg' } }] } }], warnings: [], missingFacts: [] }); await assert.rejects(generateAiWritingProposal(article, admin), status(422));
  response = () => ({ fields: [{ key: 'description', after: 'Content' }], warnings: [], missingFacts: [], evidenceIds: ['not-sent'] }); await assert.rejects(generateAiWritingProposal(input(), admin), status(422)); assert.equal(calls, 2);
});

test('付费等待期间降权会保留草稿且清本次占位，不能采用模型结果', async () => {
  const before = getStudioEnvelope(); response = prompt => { getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('editor', admin.id); return { fields: [{ key: 'description', after: 'Model result' }], warnings: [], missingFacts: [] }; };
  await assert.rejects(generateAiWritingProposal(input(), admin), status(403)); assert.deepEqual(getStudioEnvelope(), before); assert.equal((getDatabase().prepare('SELECT count(*) count FROM cms_ai_writing_proposal').get() as any).count, 0); assert.equal(calls, 1);
});

test('未选字段、错误revision与重复采用字段不能在原保存旁路写入', async () => {
  const proposal = await generateAiWritingProposal(input(), admin), current = getStudioEnvelope(), patch = { products: [{ ...current.state.products[0], description: 'Generated description' }] };
  assert.throws(() => saveAiWritingDraft({ expectedRevision: current.revision - 1, patch, receipts: [receipt(proposal)] }, admin), status(409));
  assert.throws(() => saveAiWritingDraft({ expectedRevision: current.revision, patch, receipts: [{ ...receipt(proposal), selectedKeys: ['sku'], before: { sku: 'A' }, after: { sku: 'B' } }] }, admin), status(422));
  assert.throws(() => saveAiWritingDraft({ expectedRevision: current.revision, patch, receipts: [receipt(proposal), receipt(proposal)] }, admin), status(422)); assert.deepEqual(getStudioEnvelope(), current);
});

test('长久占位和本人容量会在发模型前拒绝，不通过GET偷偷清理', async () => {
  const target = input().target, now = new Date().toISOString(), expiry = new Date(Date.now() + 60000).toISOString();
  for (let i = 0; i < 30; i++) getDatabase().prepare('INSERT INTO cms_ai_writing_proposal VALUES(?,?,?,?,?,?,?,?)').run(`awp-${crypto.randomUUID()}`, admin.id, target.kind, target.id, 0, JSON.stringify({ pending: true }), now, expiry);
  await assert.rejects(generateAiWritingProposal(input(), admin), status(429)); assert.equal(calls, 0); assert.equal(listAiWritingProposals(admin).items.length, 0); assert.equal((getDatabase().prepare('SELECT count(*) count FROM cms_ai_writing_proposal').get() as any).count, 30);
});

test('保存内容校验失败时回执与草稿一起回滚，不允许借接口修改设置', async () => {
  const proposal = await generateAiWritingProposal(input(), admin), before = getStudioEnvelope();
  assert.throws(() => saveProduct(proposal, { image: '/not-owned.jpg' }), status(422)); assert.deepEqual(getStudioEnvelope(), before); assert.equal(listAiWritingReceipts(admin).items.length, 0);
  assert.throws(() => saveAiWritingDraft({ expectedRevision: before.revision, patch: { settings: { name: 'Changed' } }, receipts: [receipt(proposal)] }, admin), status(422));
});

test('过期GET不延长期限，过期回执不能撤销；读取过程不清理或外发', async () => {
  const proposal = await generateAiWritingProposal(input(), admin), saved = saveProduct(proposal);
  getDatabase().prepare('UPDATE cms_ai_writing_proposal SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), proposal.id);
  assert.throws(() => readAiWritingProposal(proposal.id, admin), status(410)); assert.equal((getDatabase().prepare('SELECT count(*) count FROM cms_ai_writing_proposal').get() as any).count, 1);
  getDatabase().prepare('UPDATE cms_ai_writing_receipt SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), saved.writingReceipts[0].id); assert.throws(() => undoAiWritingReceipt(saved.writingReceipts[0].id, { expectedRevision: saved.revision }, admin), status(410)); assert.equal(calls, 1);
});

test('数字和认证匹配提示区分已知/缺失/0/单位，明确不等于完整事实核查', () => {
  assert.deepEqual(writingGroundingWarnings('0 defects. 10 mm. ISO 9001:2015', ['0 defects. 10 mm. ISO 9001:2015']), []);
  const warnings = writingGroundingWarnings('10 mm', ['ISO 14001, 0 defects, 10 cm']); assert.equal(warnings.length, 1); assert.match(warnings[0], /ISO 14001/); assert.match(warnings[0], /0/); assert.match(warnings[0], /10 cm/); assert.match(warnings[0], /不代表已证明其错误/);
});

test('零撤销字段仍有同事务保存完成标记，GET核对不重写也不调用模型', async () => {
  const proposal = await generateAiWritingProposal(input({ target: { kind: 'entry', id: 'zero-receipt-entry', modelId: 'writing-model' }, fields: [{ key: 'title', label: '标题', kind: 'text', maxLength: 200, before: '' }], outputKeys: ['title'], task: 'article' }), admin);
  const current = getStudioEnvelope(), title = proposal.fields[0].after as string, saveAttemptId = `aws-${crypto.randomUUID()}`;
  const payload = { saveAttemptId, expectedRevision: current.revision, patch: { contentEntries: [...current.state.contentEntries!, { id: 'zero-receipt-entry', modelId: 'writing-model', title, status: 'draft', updated: '', customFields: {} }] }, receipts: [{ proposalId: proposal.id, selectedKeys: ['title'], before: { title: '' }, after: { title } }] };
  const saved = saveAiWritingDraft(payload, admin), count = calls, beforeRead = getStudioEnvelope();
  assert.deepEqual(saved.writingReceipts, []); assert.equal(saved.writingWarnings.length, 1);
  const marker = readAiWritingSaveAttempt(saveAttemptId, admin);
  assert.equal(marker.status, 'saved'); assert.equal(marker.savedRevision, saved.revision); assert.equal(marker.expectedRevision, current.revision); assert.deepEqual(marker.receiptIds, []); assert.deepEqual(marker.warnings, saved.writingWarnings); assert.deepEqual(marker.targets, [proposal.target]); assert.deepEqual(marker.proposalIds, [proposal.id]); assert.equal(readAiWritingProposal(proposal.id, admin).savedRevision, saved.revision);
  assert.equal(saveAiWritingDraft(payload, admin).revision, saved.revision); assert.deepEqual(getStudioEnvelope(), beforeRead); assert.equal(calls, count);
});

test('稳定保存标识规范化对象键顺序，拒绝不同请求，重复核对不覆盖后来修改', async () => {
  const proposal = await generateAiWritingProposal(input(), admin), current = getStudioEnvelope(), saveAttemptId = `aws-${crypto.randomUUID()}`;
  const payload = { saveAttemptId, expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], description: 'Generated description' }] }, receipts: [receipt(proposal)] };
  const saved = saveAiWritingDraft(payload, admin), marker = saved.writingSaveAttempt!;
  const reordered = { receipts: payload.receipts, patch: { products: payload.patch.products.map(product => Object.fromEntries(Object.entries(product).reverse())) }, expectedRevision: payload.expectedRevision, saveAttemptId };
  assert.equal(saveAiWritingDraft(reordered, admin).writingSaveAttempt!.id, marker.id);
  assert.throws(() => saveAiWritingDraft({ ...payload, expectedRevision: saved.revision }, admin), status(409));
  assert.throws(() => saveAiWritingDraft({ ...payload, patch: { products: [{ ...payload.patch.products[0], name: 'Different request' }] } }, admin), status(409));
  patchStudio({ expectedRevision: saved.revision, patch: { products: [{ ...saved.state.products[0], description: 'Later manual text' }] } }, admin);
  const newer = getStudioEnvelope(), replay = saveAiWritingDraft(payload, admin);
  assert.equal(replay.writingSaveAttempt!.savedRevision, saved.revision); assert.equal(replay.revision, newer.revision); assert.equal(replay.state.products[0].description, 'Later manual text'); assert.deepEqual(getStudioEnvelope(), newer); assert.equal(calls, 1);
});

test('保存标记只属于本人并重新检查角色，过期/缺失不能冒称保存失败或成功', async () => {
  const proposal = await generateAiWritingProposal(input(), admin), current = getStudioEnvelope(), saveAttemptId = `aws-${crypto.randomUUID()}`;
  saveAiWritingDraft({ saveAttemptId, expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], description: 'Generated description' }] }, receipts: [receipt(proposal)] }, admin);
  assert.throws(() => readAiWritingSaveAttempt(saveAttemptId, other), status(404)); assert.throws(() => readAiWritingSaveAttempt(`aws-${crypto.randomUUID()}`, admin), status(404)); assert.throws(() => readAiWritingSaveAttempt('../writing', admin), status(422));
  getDatabase().prepare('UPDATE cms_ai_writing_save SET expires_at=? WHERE actor_id=? AND id=?').run(new Date(Date.now() - 1).toISOString(), admin.id, saveAttemptId);
  assert.throws(() => readAiWritingSaveAttempt(saveAttemptId, admin), status(410)); assert.equal((getDatabase().prepare('SELECT count(*) count FROM cms_ai_writing_save').get() as any).count, 1);
  getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('editor', admin.id); assert.throws(() => readAiWritingSaveAttempt(saveAttemptId, admin), status(403));
  getDatabase().prepare('UPDATE auth_user SET role=?,banned=1 WHERE id=?').run('admin', admin.id); assert.throws(() => readAiWritingSaveAttempt(saveAttemptId, admin), status(401)); assert.equal(calls, 1);
});

test('保存验证失败不留完成标记，确认记录容量满时不提前修改草稿', async () => {
  const proposal = await generateAiWritingProposal(input(), admin), current = getStudioEnvelope(), saveAttemptId = `aws-${crypto.randomUUID()}`;
  const payload = { saveAttemptId, expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], description: 'Generated description', image: '/not-owned.jpg' }] }, receipts: [receipt(proposal)] };
  assert.throws(() => saveAiWritingDraft(payload, admin), status(422)); assert.deepEqual(getStudioEnvelope(), current); assert.throws(() => readAiWritingSaveAttempt(saveAttemptId, admin), status(404));
  const now = new Date().toISOString(), expires = new Date(Date.now() + 60_000).toISOString();
  for (let index = 0; index < 100; index++) getDatabase().prepare('INSERT INTO cms_ai_writing_save VALUES(?,?,?,?,?,?)').run(`aws-${crypto.randomUUID()}`, admin.id, 'x'.repeat(64), '{}', now, expires);
  assert.throws(() => saveAiWritingDraft({ ...payload, patch: { products: [{ ...current.state.products[0], description: 'Generated description' }] } }, admin), status(429)); assert.deepEqual(getStudioEnvelope(), current); assert.equal(listAiWritingReceipts(admin).items.length, 0);
});

test('关联文章只有明确选中的产品事实可用，产品变化使旧建议过时且禁止保存', async () => {
  const { revision: rev, updatedAt: _updated, ...profile } = readAiWritingProfile(admin);
  const savedProfile = saveAiWritingProfile({ ...profile, expectedRevision: rev, facts: [{ id: 'product-fact', label: '产品材质', text: 'Steel', source: '已核对产品表', confirmed: true, scope: 'product', productId: 'writing-product' }] }, admin);
  const article = input({ target: { kind: 'entry', id: 'writing-entry', modelId: 'writing-model' }, fields: [{ key: 'customFields:body', label: '正文', kind: 'richtext', maxLength: 30000, before: 'Original body' }], outputKeys: ['customFields:body'], task: 'article', profileRevision: savedProfile.revision, factIds: ['product-fact'] });
  await assert.rejects(generateAiWritingProposal(article, admin), status(422)); await assert.rejects(generateAiWritingProposal({ ...article, referenceProductIds: ['missing-product'] }, admin), status(422)); await assert.rejects(generateAiWritingProposal(input({ referenceProductIds: ['writing-product'] }), admin), status(422)); assert.equal(calls, 0);
  const proposal = await generateAiWritingProposal({ ...article, referenceProductIds: ['writing-product'] }, admin);
  assert.deepEqual(proposal.referenceProductIds, ['writing-product']); assert.equal(proposal.evidence[0].productId, 'writing-product'); assert.equal(readAiWritingProposal(proposal.id, admin).stale, false);
  const current = getStudioEnvelope(); patchStudio({ expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], material: 'Changed material' }] } }, admin);
  assert.equal(readAiWritingProposal(proposal.id, admin).stale, true); const newer = getStudioEnvelope(), doc = proposal.fields[0].after;
  assert.throws(() => saveAiWritingDraft({ expectedRevision: newer.revision, patch: { contentEntries: [{ ...newer.state.contentEntries![0], customFields: { ...newer.state.contentEntries![0].customFields, body: richTextPlainText(doc as any) }, richTextFields: { body: doc } }] }, receipts: [{ proposalId: proposal.id, selectedKeys: ['customFields:body'], before: { 'customFields:body': 'Original body' }, after: { 'customFields:body': doc } }] }, admin), status(409)); assert.equal(calls, 1);
});

test('写作来源引用由服务器核对，文字手改不能继续冒称原摘录，内部标识不进入提示', async () => {
  const candidate = readWritingReuse(admin, undefined, 'writing-product').candidates.find(item => item.sourceRef.locator === 'material')!;
  const { revision: rev, updatedAt: _updated, ...profile } = readAiWritingProfile(admin), fact = { ...candidate, id: 'material-snapshot', confirmed: true };
  const { sourceRef, label, text, source, scope, productId } = fact;
  const saved = saveAiWritingProfile({ ...profile, expectedRevision: rev, facts: [{ id: fact.id, label, text, source, scope, productId, sourceRef, confirmed: true }] }, admin);
  const proposal = await generateAiWritingProposal(input({ profileRevision: saved.revision, factIds: [fact.id] }), admin);
  assert.equal(proposal.evidence[0].sourceRef!.fingerprint, sourceRef.fingerprint); assert.ok(!seenPrompt.includes(sourceRef.fingerprint)); assert.ok(!seenPrompt.includes('sourceRef'));
  const { revision: nextRevision, updatedAt: _nextUpdated, ...nextProfile } = saved;
  assert.throws(() => saveAiWritingProfile({ ...nextProfile, expectedRevision: nextRevision, facts: [{ ...saved.facts[0], text: 'Different manual value' }] }, admin), status(409));
  const current = getStudioEnvelope(); patchStudio({ expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], material: 'Aluminium' }] } }, admin);
  assert.equal(readAiWritingProposal(proposal.id, admin).stale, true); await assert.rejects(generateAiWritingProposal(input({ profileRevision: saved.revision, factIds: [fact.id] }), admin), status(409)); assert.equal(calls, 1);
});

test('一次保存多份提案与确认标记原子绑定，任一回执无效时全体回滚', async () => {
  const productProposal = await generateAiWritingProposal(input(), admin), articleProposal = await generateAiWritingProposal(input({ target: { kind: 'entry', id: 'writing-entry', modelId: 'writing-model' }, fields: [{ key: 'title', label: '标题', kind: 'text', maxLength: 200, before: 'Original article' }], outputKeys: ['title'], task: 'article' }), admin);
  const current = getStudioEnvelope(), saveAttemptId = `aws-${crypto.randomUUID()}`, title = articleProposal.fields[0].after as string;
  const payload = { saveAttemptId, expectedRevision: current.revision, patch: { products: [{ ...current.state.products[0], description: 'Generated description' }], contentEntries: [{ ...current.state.contentEntries![0], title }] }, receipts: [receipt(productProposal), { proposalId: articleProposal.id, selectedKeys: ['title'], before: { title: 'Original article' }, after: { title } }] };
  assert.throws(() => saveAiWritingDraft({ ...payload, receipts: [payload.receipts[0], { ...payload.receipts[1], selectedKeys: ['sku'] }] }, admin), status(422));
  assert.deepEqual(getStudioEnvelope(), current); assert.equal(listAiWritingReceipts(admin).items.length, 0); assert.throws(() => readAiWritingSaveAttempt(saveAttemptId, admin), status(404));
  const saved = saveAiWritingDraft(payload, admin), marker = readAiWritingSaveAttempt(saveAttemptId, admin);
  assert.equal(marker.receiptIds.length, 2); assert.deepEqual(marker.proposalIds, [productProposal.id, articleProposal.id]); assert.deepEqual(marker.targets, [productProposal.target, articleProposal.target]); assert.equal(saved.revision, marker.savedRevision); assert.equal(calls, 2);
});

test('原来源已删除的历史确认摘录可原样保留，生成明确只用摘录且不冒称回查原件', async () => {
  // 模拟已保存确认资料在之后删除原件的历史状态；不将此夹具当成本轮新引用验证。
  const prior = readAiWritingProfile(admin), fact = { id: 'historic-pdf', label: '已核对旧公司摘录', text: 'Steel components for trade.', source: '旧资料第2页', scope: 'company' as const, confirmed: true, confirmedAt: new Date().toISOString(), sourceRef: { kind: 'pdf' as const, recordId: `aib-${crypto.randomUUID()}`, sourceId: `ais-${crypto.randomUUID()}`, fingerprint: 'a'.repeat(64), locator: 'description · 第2页', snapshot: 'Steel components for trade.', capturedAt: new Date().toISOString() } };
  getDatabase().prepare('UPDATE cms_ai_writing_profile SET config_json=? WHERE id=1').run(JSON.stringify({ ...prior, facts: [fact] }));
  const { revision: expectedRevision, updatedAt: _updated, ...profile } = readAiWritingProfile(admin);
  const retained = saveAiWritingProfile({ ...profile, expectedRevision, brandName: 'Changed brand only' }, admin);
  assert.deepEqual(retained.facts[0].sourceRef, fact.sourceRef);
  const proposal = await generateAiWritingProposal(input({ profileRevision: retained.revision, factIds: [fact.id] }), admin);
  assert.ok(proposal.warnings.some(message => message.includes('原来源当前不可回查'))); assert.equal(proposal.stale, false); assert.equal(calls, 1); assert.ok(!seenPrompt.includes(fact.sourceRef.sourceId));
});
