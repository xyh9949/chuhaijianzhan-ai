import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { createExternalAiToken, requireExternalAiGrant, revokeExternalAiToken, type ExternalAiGrant } from '../src/server/external-ai-tokens';
import { readAiWritingProfile, saveAiWritingProfile } from '../src/server/ai-writing';
import { externalAiWritingOverview, externalAiWritingContext, submitExternalAiWriting, readExternalAiWriting, requestExternalAiWritingReview, reviewExternalAiWriting, applyExternalAiWriting, undoExternalAiWriting } from '../src/server/external-ai-writing';
import { richTextPlainText, textToRichText, type RichNode } from '../src/lib/presentation-content';
import type { Actor } from '../src/server/permissions';
import { ApiError } from '../src/server/http';
const owner: Actor = { id: 'external-writer', name: 'Writer', email: 'writer@example.invalid', role: 'admin' }, other: Actor = { id: 'other-writer', name: 'Other', email: 'other@example.invalid', role: 'admin' };
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-writing-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3291'; process.env.BETTER_AUTH_SECRET = 'synthetic-external-writing-'.repeat(3);
  const draft = getDraftRecord(), db = getDatabase(); db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [owner, other]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
  patchStudio({ expectedRevision: draft.revision, patch: {
    products: [{ id: 'p1', name: 'Steel component', sku: 'S1', category: 'Parts', material: 'Steel', status: 'draft', image: '/images/studio.jpg', description: 'Original introduction' }, { id: 'p2', name: 'Private product marker', sku: 'S2', category: 'Parts', material: 'Private material', status: 'draft', image: '', description: 'Private product description' }],
    contentModels: [{ id: 'news', name: 'News', description: '', target: 'content', updated: '', fields: [{ id: 'body', key: 'body', label: 'Body', type: 'textarea', required: false }, { id: 'number', key: 'number', label: 'Number', type: 'number', required: false }] }],
    contentEntries: [{ id: 'a1', modelId: 'news', title: 'Original article', status: 'draft', updated: '', customFields: { body: 'Original body' } }],
  } }, owner);
  const profile = readAiWritingProfile(owner), { revision, updatedAt: _updatedAt, ...fields } = profile;
  saveAiWritingProfile({ ...fields, expectedRevision: revision, audience: 'private-audience-marker', market: 'private-market-marker', terminology: 'private-terminology-marker', avoidedClaims: 'private-avoided-marker', facts: [
    { id: 'company', label: 'Company fact', text: 'We manufacture components.', source: 'Company confirmed', confirmed: true, scope: 'company' },
    { id: 'product1', label: 'Material', text: 'Steel', source: 'Confirmed P1', confirmed: true, scope: 'product', productId: 'p1' },
    { id: 'product2', label: 'Private fact marker', text: 'Private product fact', source: 'Confirmed P2', confirmed: true, scope: 'product', productId: 'p2' },
    { id: 'unconfirmed', label: 'Unconfirmed marker', text: 'Unconfirmed fact', source: 'Unconfirmed', confirmed: false, scope: 'company' },
  ] }, owner);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-writing-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
function connection(recordIds: { productIds: string[] | null; entryIds: string[] | null } = { productIds: null, entryIds: null }, scopes = ['read', 'content:read', 'content:propose']) {
  const issued = createExternalAiToken({ name: 'External writing', scopes, recordIds }, owner), grant = requireExternalAiGrant(new Request('http://127.0.0.1:3291/api/mcp', { headers: { authorization: `Bearer ${issued.token}` } }), scopes.includes('content:read') ? 'content:read' : 'read'); return { ...issued, grant };
}
function context(grant: ExternalAiGrant, overrides: Record<string, unknown> = {}) { return externalAiWritingContext(grant, { target: { kind: 'product', id: 'p1' }, instruction: 'Write a clear introduction', factIds: ['company', 'product1'], ...overrides }); }
function propose(grant: ExternalAiGrant, after = 'Clear steel component introduction', request = context(grant).request, requestId = 'write-1') {
  return submitExternalAiWriting(grant, { requestId, request, proposal: { fields: request.fieldKeys.map(key => ({ key, after })), warnings: [], missingFacts: [], evidenceIds: request.factIds } });
}

test('外部写作上下文只投影授权保存内容和已确认适用事实，不读取私有写作指引', () => {
  const { grant } = connection({ productIds: ['p1'], entryIds: [] }), result = context(grant), json = JSON.stringify(result);
  assert.equal(result.context.fields[0].before, 'Original introduction'); assert.equal(result.siteModelCalls, false); assert.equal(result.context.fields[0].current, 'Original introduction');
  for (const privateText of ['private-audience-marker', 'private-market-marker', 'private-terminology-marker', 'private-avoided-marker', 'Private product marker', 'Private fact marker', 'Unconfirmed marker', owner.email]) assert.equal(json.includes(privateText), false);
  assert.deepEqual(result.context.confirmedFacts.map(item => item.id), ['company', 'product1']); assert.equal(externalAiWritingOverview(grant).total, 1);
  assert.throws(() => context(grant, { target: { kind: 'product', id: 'p2' } }), status(403));
  assert.throws(() => context(grant, { factIds: ['product2'] }), status(422));
  assert.throws(() => context(grant, { target: { kind: 'entry', id: 'a1' }, referenceProductIds: ['p2'] }), status(403));
});

test('外部候选无需站内模型，提交/审核链接不改草稿；负责人确认采用后可原生编辑及撤销', () => {
  const { grant } = connection(), before = getStudioEnvelope(), candidate = propose(grant);
  assert.deepEqual(getStudioEnvelope(), before); assert.equal(candidate.status, 'pending'); assert.match(candidate.reviewUrl, /externalContent=eaw-/); assert.equal(candidate.siteModelCalls, false);
  const review = requestExternalAiWritingReview(grant, { candidateId: candidate.id, action: 'apply' }); assert.equal(review.requiresBrowserConfirmation, true); assert.deepEqual(getStudioEnvelope(), before);
  assert.throws(() => reviewExternalAiWriting(candidate.id, other), status(404));
  const applied = applyExternalAiWriting(candidate.id, { expectedRevision: before.revision, selectedKeys: ['description'] }, owner);
  assert.equal(applied.state.products[0].description, 'Clear steel component introduction'); assert.equal(applied.externalContent.status, 'applied'); assert.equal(applied.state.products[1].name, 'Private product marker');
  assert.equal(readExternalAiWriting(grant, candidate.id).status, 'applied');
  const undone = undoExternalAiWriting(candidate.id, { expectedRevision: applied.revision }, owner); assert.equal(undone.state.products[0].description, 'Original introduction'); assert.equal(undone.externalContent.status, 'undone');
  assert.equal(undoExternalAiWriting(candidate.id, { expectedRevision: applied.revision }, owner).revision, undone.revision);
});

test('同请求幂等、不同凭据隔离及旧设计scope不能读取文章产品', () => {
  const first = connection(), second = connection(), request = context(first.grant).request, candidate = propose(first.grant, 'Text', request);
  assert.equal(propose(first.grant, 'Text', request).id, candidate.id); assert.throws(() => propose(first.grant, 'Different', request), status(409));
  assert.throws(() => readExternalAiWriting(second.grant, candidate.id), status(404));
  assert.throws(() => context(second.grant, { ...request, baseCandidateId: candidate.id }), status(404));
  const old = connection({ productIds: [], entryIds: [] }, ['read', 'propose']); assert.throws(() => externalAiWritingOverview(old.grant), status(403));
});

test('继续调整提供上次候选但保持真实before，来源变化使旧候选失效', () => {
  const { grant } = connection(), first = propose(grant, 'First introduction'), continued = context(grant, { ...first.request, baseCandidateId: first.id });
  assert.equal(continued.context.fields[0].before, 'Original introduction'); assert.equal(continued.context.fields[0].current, 'First introduction');
  const second = propose(grant, 'Second introduction', continued.request, 'write-2'); assert.equal(second.fields[0].before, 'Original introduction');
  const current = getStudioEnvelope(); patchStudio({ expectedRevision: current.revision, patch: { products: current.state.products.map(item => item.id === 'p1' ? { ...item, material: 'Aluminium' } : item) } }, owner);
  assert.equal(readExternalAiWriting(grant, second.id).stale, true); assert.throws(() => applyExternalAiWriting(second.id, { expectedRevision: getDraftRecord().revision, selectedKeys: ['description'] }, owner), status(409));
});

test('原生字段/富文本规则不能被外部绕过，必须完整保留已有图片和链接', () => {
  const { grant } = connection(), before = getStudioEnvelope(), doc: RichNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original linked text', marks: [{ type: 'link', attrs: { href: 'https://example.invalid/original' } }] }] }, { type: 'image', attrs: { src: '/images/studio.jpg', alt: 'Original' } }] };
  patchStudio({ expectedRevision: before.revision, patch: { contentEntries: [{ ...before.state.contentEntries![0], customFields: { body: richTextPlainText(doc) }, richTextFields: { body: doc } }] } }, owner);
  assert.throws(() => context(grant, { fieldKeys: ['name'] }), status(422));
  assert.throws(() => context(grant, { target: { kind: 'entry', id: 'a1' }, fieldKeys: ['customFields:number'], factIds: [] }), status(422));
  const request = context(grant, { target: { kind: 'entry', id: 'a1' }, fieldKeys: ['customFields:body'], factIds: [] }).request;
  assert.throws(() => propose(grant, 'Replacement losing protected media', request), status(422));
  const modified = structuredClone(doc); modified.content![0].content![0].text = 'Improved linked text';
  const candidate = submitExternalAiWriting(grant, { requestId: 'preserve-1', request, proposal: { fields: [{ key: 'customFields:body', after: modified }], warnings: [], missingFacts: [] } });
  const applied = applyExternalAiWriting(candidate.id, { expectedRevision: getDraftRecord().revision, selectedKeys: ['customFields:body'] }, owner);
  assert.deepEqual(applied.state.contentEntries![0].richTextFields!.body, modified); assert.equal(applied.state.contentEntries![0].customFields.body, richTextPlainText(modified));
  const restored = undoExternalAiWriting(candidate.id, { expectedRevision: applied.revision }, owner); assert.deepEqual(restored.state.contentEntries![0].richTextFields!.body, doc);
});

test('普通新文章与产品都是私有候选，确认创建草稿后可安全整条撤销', () => {
  const { grant } = connection(), original = getStudioEnvelope();
  const entryRequest = context(grant, { target: { kind: 'entry', modelId: 'news' }, factIds: ['company'] }).request;
  const article = submitExternalAiWriting(grant, { requestId: 'new-article', request: entryRequest, proposal: { fields: [{ key: 'title', after: 'A clear article' }, { key: 'customFields:body', after: textToRichText('An editable body') }], warnings: [], missingFacts: [] } });
  assert.equal(article.isNew, true); assert.deepEqual(getStudioEnvelope(), original);
  const saved = applyExternalAiWriting(article.id, { expectedRevision: original.revision, selectedKeys: entryRequest.fieldKeys }, owner), entry = saved.state.contentEntries!.find(item => item.id === article.target.id)!;
  assert.equal(entry.status, 'draft'); assert.equal(entry.customFields.body, 'An editable body'); assert.ok(entry.richTextFields?.body);
  const undone = undoExternalAiWriting(article.id, { expectedRevision: saved.revision }, owner); assert.equal(undone.state.contentEntries!.some(item => item.id === article.target.id), false);
  const productRequest = context(grant, { target: { kind: 'product' }, create: { name: 'New component', sku: 'NEW-1', category: 'Parts', material: 'Steel' }, factIds: ['company'] }).request;
  const product = propose(grant, 'New description', productRequest, 'new-product'); assert.equal(product.creation?.sku, 'NEW-1');
  const productSaved = applyExternalAiWriting(product.id, { expectedRevision: undone.revision, selectedKeys: ['description'] }, owner); assert.equal(productSaved.state.products.length, original.state.products.length + 1);
  const productUndone = undoExternalAiWriting(product.id, { expectedRevision: productSaved.revision }, owner); assert.equal(productUndone.state.products.length, original.state.products.length);
});

test('创建需要整类显式授权，缺必填非文字资料不造值，失败不遗留候选', () => {
  const limited = connection({ productIds: ['p1'], entryIds: ['a1'] }); assert.throws(() => context(limited.grant, { target: { kind: 'entry', modelId: 'news' }, factIds: [] }), status(403));
  const { grant } = connection(), current = getStudioEnvelope(); patchStudio({ expectedRevision: current.revision, patch: { contentModels: current.state.contentModels!.map(model => ({ ...model, fields: model.fields.map(field => field.id === 'number' ? { ...field, required: true } : field) })), contentEntries: current.state.contentEntries!.map(entry => ({ ...entry, customFields: { ...entry.customFields, number: 10 } })) } }, owner);
  const request = context(grant, { target: { kind: 'entry', modelId: 'news' }, factIds: [] }).request, before = getStudioEnvelope(), rows = getDatabase().prepare('SELECT count(*) n FROM cms_ai_writing_proposal').get() as { n: number };
  assert.throws(() => propose(grant, 'New content', request, 'required-non-text'), status(422)); assert.deepEqual(getStudioEnvelope(), before); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_writing_proposal').get() as { n: number }).n, rows.n);
});

test('后续人工内容、被引用的新建内容以及撤销连接后的采用都安全拒绝', () => {
  const issued = connection(), candidate = propose(issued.grant), original = getStudioEnvelope(); revokeExternalAiToken(issued.credential.id, owner);
  assert.throws(() => applyExternalAiWriting(candidate.id, { expectedRevision: original.revision, selectedKeys: ['description'] }, owner), status(401)); assert.deepEqual(getStudioEnvelope(), original);
  const { grant } = connection(), fresh = propose(grant), applied = applyExternalAiWriting(fresh.id, { expectedRevision: original.revision, selectedKeys: ['description'] }, owner);
  const changed = patchStudio({ expectedRevision: applied.revision, patch: { products: applied.state.products.map(item => item.id === 'p1' ? { ...item, description: 'Later manual text' } : item) } }, owner);
  assert.throws(() => undoExternalAiWriting(fresh.id, { expectedRevision: changed.revision }, owner), status(409)); assert.equal(getStudioEnvelope().state.products[0].description, 'Later manual text');
  const request = context(grant, { target: { kind: 'entry', modelId: 'news' }, factIds: [] }).request, created = propose(grant, 'Created content', request, 'create-edited'), saved = applyExternalAiWriting(created.id, { expectedRevision: changed.revision, selectedKeys: request.fieldKeys }, owner);
  const edited = patchStudio({ expectedRevision: saved.revision, patch: { contentEntries: saved.state.contentEntries!.map(entry => entry.id === created.target.id ? { ...entry, title: 'Later user title' } : entry) } }, owner);
  assert.throws(() => undoExternalAiWriting(created.id, { expectedRevision: edited.revision }, owner), status(409)); assert.ok(getStudioEnvelope().state.contentEntries!.find(entry => entry.id === created.target.id));
});


test('读取上下文后即使只改其他记录，旧外部生成也必须重新获取基线', () => {
  const { grant } = connection(), request = context(grant).request, current = getStudioEnvelope();
  patchStudio({ expectedRevision: current.revision, patch: { products: current.state.products.map(item => item.id === 'p2' ? { ...item, description: 'Another edit' } : item) } }, owner);
  assert.throws(() => propose(grant, 'Output based on old context', request), status(409));
  const { expectedRevision: _version, ...missingVersion } = context(grant).request;
  assert.throws(() => submitExternalAiWriting(grant, { requestId: 'missing-version', request: missingVersion, proposal: { fields: [{ key: 'description', after: 'Unversioned output' }], warnings: [], missingFacts: [] } }), status(422));
});

test('新建内容被其他记录引用时撤销返回冲突并保留内容，清理引用后可重试', () => {
  const { grant } = connection(), request = context(grant, { target: { kind: 'entry', modelId: 'news' }, factIds: [] }).request, candidate = propose(grant, 'New article', request, 'referenced-new');
  const applied = applyExternalAiWriting(candidate.id, { expectedRevision: getDraftRecord().revision, selectedKeys: request.fieldKeys }, owner);
  const related = { id: 'related', key: 'related', label: 'Related article', type: 'relation' as const, required: false, relation: { source: 'entry' as const, modelId: 'news', multiple: false, onDelete: 'restrict' as const } };
  const linked = patchStudio({ expectedRevision: applied.revision, patch: { contentModels: applied.state.contentModels!.map(model => ({ ...model, fields: [...model.fields, related] })), contentEntries: applied.state.contentEntries!.map(entry => entry.id === 'a1' ? { ...entry, customFields: { ...entry.customFields, related: candidate.target.id } } : entry) } }, owner);
  assert.equal(reviewExternalAiWriting(candidate.id, owner).canUndo, false);
  assert.throws(() => undoExternalAiWriting(candidate.id, { expectedRevision: linked.revision }, owner), status(409)); assert.ok(getDraftRecord().content.contentEntries!.find(entry => entry.id === candidate.target.id));
  const unlinked = patchStudio({ expectedRevision: linked.revision, patch: { contentEntries: linked.state.contentEntries!.map(entry => entry.id === 'a1' ? { ...entry, customFields: { ...entry.customFields, related: null } } : entry) } }, owner);
  assert.equal(undoExternalAiWriting(candidate.id, { expectedRevision: unlinked.revision }, owner).externalContent.status, 'undone');
});


test('已确认事实独立版本变化后拒绝旧上下文生成，采用范围真实持久化', () => {
  const { grant } = connection(), oldRequest = context(grant).request, before = getStudioEnvelope(), profile = readAiWritingProfile(owner), { revision, updatedAt: _updatedAt, ...fields } = profile;
  saveAiWritingProfile({ ...fields, expectedRevision: revision, facts: fields.facts.map(fact => fact.id === 'product1' ? { ...fact, text: 'Aluminium' } : fact) }, owner);
  assert.equal(getDraftRecord().revision, before.revision); assert.throws(() => propose(grant, 'Output based on old Steel evidence', oldRequest), status(409));
  const request = context(grant, { fieldKeys: ['description', 'seoTitle'] }).request, candidate = propose(grant, 'Selected writing', request, 'partial-writing');
  const applied = applyExternalAiWriting(candidate.id, { expectedRevision: before.revision, selectedKeys: ['description'] }, owner);
  assert.deepEqual(applied.externalContent.appliedKeys, ['description']); assert.deepEqual(reviewExternalAiWriting(candidate.id, owner).appliedKeys, ['description']); assert.equal(applied.state.products[0].seoTitle, undefined);
  const undone = undoExternalAiWriting(candidate.id, { expectedRevision: applied.revision }, owner); assert.deepEqual(undone.externalContent.appliedKeys, ['description']);
});
