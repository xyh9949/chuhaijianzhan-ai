import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { readAiDesignGuidance, saveAiDesignGuidance } from '../src/server/ai-design-guidance';
import { createExternalAiToken, requireExternalAiGrant, revokeExternalAiToken } from '../src/server/external-ai-tokens';
import { externalAiDesignGuidance } from '../src/server/external-ai-guidance';
import { externalAiContext, submitExternalAiDesign, readExternalAiDesign, selectExternalAiDesign } from '../src/server/external-ai-design';
import { externalAiTemplateContext, submitExternalAiTemplate, readExternalAiTemplate } from '../src/server/external-ai-templates';
import { applyAiSiteDesign, undoAiSiteDesign, deleteAiSiteDesign } from '../src/server/ai-site-design';
import { applyAiDetailDesign, undoAiDetailDesign } from '../src/server/ai-detail-design';
import { handleExternalAiMcp } from '../src/server/external-ai-mcp';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';

const origin = 'http://127.0.0.1:3294';
const actor: Actor = { id: 'guidance-owner', name: 'Synthetic owner', email: 'guidance-owner@example.invalid', role: 'admin' };
const status = (n: number) => (error: unknown) => error instanceof ApiError && error.status === n;
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-guidance-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-design-guidance-secret-'.repeat(3);
  getDraftRecord(); const draft = createEmptyDraft();
  draft.settings.name = 'Synthetic factory';
  draft.pages.push({ id: 'secret', title: 'UNAUTHORIZED_PAGE_TITLE', slug: '/private', type: '普通页面', status: 'draft', updated: '' }, { id: 'detail', title: 'Products', slug: '/products/:slug', type: '产品详情', status: 'draft', updated: '' });
  draft.editorData = { home: { root: { props: { title: 'Home', showChrome: 'no', brand: '' } }, zones: {}, content: [{ type: 'Heading', props: { id: 'home-title', text: 'Supplied company headline', level: 'h1' } }] }, secret: { root: { props: {} }, content: [{ type: 'Text', props: { id: 'secret-text', text: 'UNAUTHORIZED_PAGE_BODY' } }] }, detail: { root: { props: {} }, content: [] } };
  draft.products = [{ id: 'p1', name: 'Supplied chair', sku: 'SUPPLIED-C01', category: 'Seating', material: 'Wood', description: 'Supplied product facts', image: '', status: 'draft' }, { id: 'p2', name: 'UNAUTHORIZED_PRODUCT', sku: 'SECRET', category: 'Private', material: '', description: 'UNAUTHORIZED_PRODUCT_TEXT', image: '', status: 'draft' }];
  draft.pageTemplates = [{ id: 'product-template', kind: 'product', name: 'Supplied product layout', description: '', updated: '', detailRule: { enabled: true, priority: 20, recordIds: ['p1'] }, data: { root: { props: {} }, zones: {}, content: [{ type: 'Container', props: { id: 'detail-box', layout: 'column', content: [{ type: 'Heading', props: { id: 'detail-title', text: '', level: 'h1', bindings: { text: { source: 'product', mode: 'current', field: 'builtin:name' } } } }] } }] } }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-guidance-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
function connection(guidance = false, extra: Record<string, unknown> = {}) { const issued = createExternalAiToken({ name: 'Guidance test', scopes: ['read', 'propose', ...(guidance ? ['design-guidance:read'] : [])], pageIds: ['home'], templateIds: ['product-template'], recordIds: { productIds: ['p1'], entryIds: [] }, ...extra }, actor); return { ...issued, grant: requireExternalAiGrant(new Request(`${origin}/api/mcp`, { headers: { Authorization: `Bearer ${issued.token}` } })) }; }
function save(extra = {}) { const { revision, updatedAt: _updatedAt, ...profile } = readAiDesignGuidance(actor); return saveAiDesignGuidance({ ...profile, preferredStyle: 'PRIVATE_GUIDANCE: use quiet editorial hierarchy', preserveNotes: 'PRIVATE_PRESERVE: retain supplied logo placement', avoidStyles: 'PRIVATE_AVOID: avoid crowded panels', feedback: [{ id: 'feedback-one', text: 'PRIVATE_FEEDBACK: use generous mobile spacing' }], ...extra, expectedRevision: revision }, actor); }
function request(extra: Record<string, unknown> = {}) { return { expectedRevision: getDraftRecord().revision, instruction: '改善首页层级与手机阅读', preserveText: true, targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false }, ...extra }; }
function templateRequest(extra: Record<string, unknown> = {}) { return { expectedRevision: getDraftRecord().revision, templateId: 'product-template', recordId: 'p1', instruction: '改善详情版式与手机间距', preserveText: true, ...extra }; }
const proposal = (size = 38) => ({ summary: 'Use native heading hierarchy', operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'design', id: 'home-title', design: { desktop: { fontSize: size } } }] }], warnings: [] });
const templateProposal = (padding = 48) => ({ summary: 'Use native detail spacing', operations: [{ kind: 'design', id: 'detail-box', design: { desktop: { paddingTop: padding } } }], warnings: [] });
async function rpc(token: string, method: string, params: unknown = {}) { const response = await handleExternalAiMcp(new Request(`${origin}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })); assert.equal(response.status, 200); return response.json(); }

test('旧连接无新工具且整站、模板与候选都不夹带私有约定或版本', async () => {
  save(); const old = connection(), before = getStudioEnvelope();
  assert.throws(() => externalAiDesignGuidance(old.grant), status(403));
  const tools = (await rpc(old.token, 'tools/list')).result.tools.map((item: { name: string }) => item.name); assert.equal(tools.includes('site_design_guidance'), false);
  const context = externalAiContext(old.grant, request()), detail = externalAiTemplateContext(old.grant, { request: templateRequest() });
  assert.doesNotMatch(JSON.stringify({ context, detail }), /PRIVATE_GUIDANCE|PRIVATE_PRESERVE|PRIVATE_AVOID|PRIVATE_FEEDBACK|guidanceRevision|designGuidance|UNAUTHORIZED_/);
  const view = submitExternalAiDesign(old.grant, { requestId: 'old-design', request: context.request, proposal: proposal() });
  const template = submitExternalAiTemplate(old.grant, { requestId: 'old-template', request: detail.request, proposal: templateProposal() });
  assert.equal('designGuidance' in view, false); assert.equal('designGuidance' in template, false); assert.deepEqual(getStudioEnvelope(), before);
  assert.equal((await rpc(old.token, 'tools/call', { name: 'site_design_guidance', arguments: {} })).result.isError, true);
});

test('独立约定权限按需发现，可读取全站参考但不扩指定页面、模板或记录', async () => {
  const saved = save(), allowed = connection(true), before = getStudioEnvelope();
  const tools = (await rpc(allowed.token, 'tools/list')).result.tools.map((item: { name: string }) => item.name); assert.ok(tools.includes('site_design_guidance'));
  const read = await rpc(allowed.token, 'tools/call', { name: 'site_design_guidance', arguments: {} }); assert.equal(read.result.structuredContent.revision, saved.revision); assert.equal(read.result.structuredContent.feedback[0], saved.feedback[0].text); assert.equal(read.result.structuredContent.advisory, true);
  const context = externalAiContext(allowed.grant, request()), detail = externalAiTemplateContext(allowed.grant, { request: templateRequest() });
  assert.equal(context.request.guidanceRevision, saved.revision); assert.equal(context.context.designGuidance?.preferredStyle, saved.preferredStyle); assert.equal(detail.request.guidanceRevision, saved.revision); assert.equal(detail.context.designGuidance?.avoidStyles, saved.avoidStyles);
  assert.doesNotMatch(JSON.stringify({ context, detail }), /UNAUTHORIZED_|guidance-owner@example|synthetic-design-guidance-secret/);
  assert.throws(() => externalAiContext(allowed.grant, request({ targets: { ...request().targets, pageIds: ['secret'] } })), status(403));
  assert.throws(() => externalAiContext(allowed.grant, request({ targets: { ...request().targets, style: true } })), status(403));
  assert.throws(() => externalAiTemplateContext(allowed.grant, { request: templateRequest({ recordId: 'p2' }) }), status(403));
  assert.deepEqual(getStudioEnvelope(), before);
});

test('新提案强制原样带回当前约定版本，旧权限不能猜版本；失败不建候选', () => {
  save(); const allowed = connection(true), old = connection(), context = externalAiContext(allowed.grant, request());
  assert.throws(() => submitExternalAiDesign(allowed.grant, { requestId: 'missing-version', request: request(), proposal: proposal() }), status(422));
  assert.throws(() => submitExternalAiDesign(allowed.grant, { requestId: 'invalid-version', request: request({ guidanceRevision: -1 }), proposal: proposal() }), status(422));
  assert.throws(() => externalAiContext(old.grant, request({ guidanceRevision: 0 })), status(422));
  assert.throws(() => submitExternalAiDesign(old.grant, { requestId: 'forged-version', request: context.request, proposal: proposal() }), status(422));
  save({ preferredStyle: 'PRIVATE_GUIDANCE_CHANGED' });
  assert.throws(() => submitExternalAiDesign(allowed.grant, { requestId: 'stale-version', request: context.request, proposal: proposal() }), status(409));
  assert.throws(() => externalAiContext(allowed.grant, context.request), status(409));
  assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n, 0);
});

test('偏好改变保留成功请求幂等和旧真实预览，派生及原生采用撤销仍可用', () => {
  const profile = save(), allowed = connection(true), before = getStudioEnvelope(), context = externalAiContext(allowed.grant, request());
  const submission = { requestId: 'stable-guidance', request: context.request, proposal: proposal() }, first = submitExternalAiDesign(allowed.grant, submission);
  assert.equal(first.designGuidance?.revision, profile.revision); assert.equal(first.designGuidance?.active, true); assert.doesNotMatch(JSON.stringify(first), /PRIVATE_GUIDANCE|PRIVATE_PRESERVE|PRIVATE_AVOID|PRIVATE_FEEDBACK/);
  save({ preferredStyle: 'A later explicit design direction' });
  const retry = submitExternalAiDesign(allowed.grant, submission); assert.equal(retry.designId, first.designId); assert.equal(retry.designGuidance?.stale, true);
  const selected = selectExternalAiDesign(allowed.grant, { requestId: 'select-old-guidance', designId: first.designId, expectedRevision: before.revision, unitIds: [first.selectionUnits[0].id] }); assert.equal(selected.designGuidance?.revision, profile.revision); assert.equal(selected.designGuidance?.stale, true);
  const applied = applyAiSiteDesign({ designId: first.designId, expectedRevision: before.revision }, actor); assert.equal(readExternalAiDesign(allowed.grant, first.designId).status, 'applied');
  const undone = undoAiSiteDesign({ designId: first.designId, expectedRevision: applied.revision }, actor); assert.deepEqual(undone.state.editorData, before.state.editorData); assert.equal(undone.activeReleaseId, before.activeReleaseId);
});

test('详情提案同样绑定版本，偏好改变后幂等及真实采用撤销不被软参考阻断', () => {
  const profile = save(), allowed = connection(true), before = getStudioEnvelope(), context = externalAiTemplateContext(allowed.grant, { request: templateRequest() });
  assert.throws(() => submitExternalAiTemplate(allowed.grant, { requestId: 'detail-missing', request: templateRequest(), proposal: templateProposal() }), status(422));
  const submission = { requestId: 'detail-stable', request: context.request, proposal: templateProposal() }, first = submitExternalAiTemplate(allowed.grant, submission); assert.equal(first.designGuidance?.revision, profile.revision);
  save({ avoidStyles: 'A later preference' }); assert.equal(submitExternalAiTemplate(allowed.grant, submission).designId, first.designId); assert.equal(readExternalAiTemplate(allowed.grant, first.designId).designGuidance?.stale, true);
  assert.throws(() => submitExternalAiTemplate(allowed.grant, { requestId: 'detail-stale', request: context.request, proposal: templateProposal(60) }), status(409));
  const applied = applyAiDetailDesign({ designId: first.designId, expectedRevision: before.revision }, actor), undone = undoAiDetailDesign({ designId: first.designId, expectedRevision: applied.revision }, actor);
  assert.deepEqual(undone.state.pageTemplates!.map(({ updated, ...item }) => item), before.state.pageTemplates!.map(({ updated, ...item }) => item));
});

test('关闭约定不把保存正文送进设计上下文，仍保留版本核对和显式只读', async () => {
  const profile = save({ enabled: false }), allowed = connection(true, { scopes: ['read', 'design-guidance:read'] });
  const context = externalAiContext(allowed.grant, request()); assert.equal(context.request.guidanceRevision, profile.revision); assert.equal('designGuidance' in context.context, false); assert.doesNotMatch(JSON.stringify(context), /PRIVATE_GUIDANCE|PRIVATE_FEEDBACK/);
  const explicit = externalAiDesignGuidance(allowed.grant); assert.equal(explicit.enabled, false); assert.equal(explicit.preferredStyle, profile.preferredStyle);
  const invalidWrite = await rpc(allowed.token, 'tools/call', { name: 'site_design_guidance', arguments: { preferredStyle: 'Machine cannot save this' } }); assert.equal(invalidWrite.result.isError, true); assert.deepEqual(readAiDesignGuidance(actor), profile);
  assert.throws(() => submitExternalAiDesign(allowed.grant, { requestId: 'read-only', request: context.request, proposal: proposal() }), status(403));
});

test('每次复核负责人和独立权限，移除scope后元数据不外发，跨连接候选仍隔离', () => {
  save(); const allowed = connection(true), other = connection(true), context = externalAiContext(allowed.grant, request()), first = submitExternalAiDesign(allowed.grant, { requestId: 'permission-test', request: context.request, proposal: proposal() });
  assert.throws(() => readExternalAiDesign(other.grant, first.designId), status(404));
  getDatabase().prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run(JSON.stringify(['read', 'propose']), allowed.credential.id);
  assert.throws(() => externalAiDesignGuidance(allowed.grant), status(403)); assert.throws(() => readExternalAiDesign(allowed.grant, first.designId), status(403)); assert.throws(() => externalAiContext(allowed.grant, request({ baseDesignId: first.designId })), status(403)); assert.doesNotMatch(JSON.stringify(externalAiContext(allowed.grant, request())), /PRIVATE_GUIDANCE|guidanceRevision|designGuidance/);
  getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('editor', actor.id); assert.throws(() => externalAiDesignGuidance(other.grant), status(403));
  getDatabase().prepare('UPDATE auth_user SET role=?,banned=1 WHERE id=?').run('admin', actor.id); assert.throws(() => externalAiDesignGuidance(other.grant), status(401));
  getDatabase().prepare('UPDATE auth_user SET banned=0 WHERE id=?').run(actor.id); revokeExternalAiToken(other.credential.id, actor); assert.throws(() => externalAiDesignGuidance(other.grant), status(401));
});


test('停用约定后的续调仍继承私有输入溯源，撤去scope不能借inactive候选读回摘要', () => {
  save(); const allowed = connection(true), context = externalAiContext(allowed.grant, request());
  const first = submitExternalAiDesign(allowed.grant, { requestId: 'private-parent', request: context.request, proposal: { ...proposal(), summary: 'PRIVATE_GUIDANCE: editorial design based on saved private preferences' } });
  const detailParentContext = externalAiTemplateContext(allowed.grant, { request: templateRequest() }), detailParent = submitExternalAiTemplate(allowed.grant, { requestId: 'private-detail-parent', request: detailParentContext.request, proposal: { ...templateProposal(), summary: 'PRIVATE_GUIDANCE used for this detail layout' } });
  save({ enabled: false });
  const next = externalAiContext(allowed.grant, request({ baseDesignId: first.designId })), submission = { requestId: 'private-inactive-child', request: next.request, proposal: { ...proposal(42), summary: 'Keep the PRIVATE_GUIDANCE from the parent preview' } };
  const child = submitExternalAiDesign(allowed.grant, submission); assert.equal(child.designGuidance?.active, false); assert.equal(child.designGuidance?.privateInputUsed, true);
  const detailContext = externalAiTemplateContext(allowed.grant, { request: templateRequest() }), detailFirst = submitExternalAiTemplate(allowed.grant, { requestId: 'inactive-detail-first', request: detailContext.request, proposal: templateProposal() });
  assert.equal(detailFirst.designGuidance?.privateInputUsed, undefined, '无私有祖先且本轮未启用的模板不凭空标记私有输入');
  const detailNext = externalAiTemplateContext(allowed.grant, { request: templateRequest({ baseDesignId: detailParent.designId }) }), detailSubmission = { requestId: 'private-inactive-detail-child', request: detailNext.request, proposal: { ...templateProposal(64), summary: 'Keep PRIVATE_GUIDANCE from the detail parent' } };
  const detailChild = submitExternalAiTemplate(allowed.grant, detailSubmission); assert.equal(detailChild.designGuidance?.active, false); assert.equal(detailChild.designGuidance?.privateInputUsed, true);
  getDatabase().prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run(JSON.stringify(['read', 'propose']), allowed.credential.id);
  assert.throws(() => readExternalAiDesign(allowed.grant, child.designId), status(403));
  assert.throws(() => readExternalAiTemplate(allowed.grant, detailChild.designId), status(403));
  assert.throws(() => submitExternalAiTemplate(allowed.grant, detailSubmission), status(403));
  assert.throws(() => externalAiTemplateContext(allowed.grant, { request: templateRequest({ baseDesignId: detailChild.designId }) }), status(403));
  assert.throws(() => submitExternalAiDesign(allowed.grant, submission), status(403));
  assert.throws(() => externalAiContext(allowed.grant, request({ baseDesignId: child.designId })), status(403));
  assert.throws(() => selectExternalAiDesign(allowed.grant, { requestId: 'private-child-selection', designId: child.designId, expectedRevision: 0, unitIds: [child.selectionUnits[0].id] }), status(403));
});


test('guided子提案的同体重试不依赖已删除或过期父候选，撤权仍以子方案溯源拒绝', () => {
  save(); const allowed = connection(true); let lastSubmission: Parameters<typeof submitExternalAiDesign>[1];
  for (const mode of ['deleted', 'expired']) {
    const parentContext = externalAiContext(allowed.grant, request()), parent = submitExternalAiDesign(allowed.grant, { requestId: `parent-${mode}`, request: parentContext.request, proposal: proposal() });
    const childContext = externalAiContext(allowed.grant, request({ baseDesignId: parent.designId })), submission = { requestId: `child-${mode}`, request: childContext.request, proposal: proposal(44) }, child = submitExternalAiDesign(allowed.grant, submission);
    if (mode === 'deleted') deleteAiSiteDesign(parent.designId, actor); else getDatabase().prepare('UPDATE cms_ai_site_design SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', parent.designId);
    assert.equal(submitExternalAiDesign(allowed.grant, submission).designId, child.designId); lastSubmission = submission;
  }
  getDatabase().prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run(JSON.stringify(['read', 'propose']), allowed.credential.id);
  assert.throws(() => submitExternalAiDesign(allowed.grant, lastSubmission!), status(403));
});
