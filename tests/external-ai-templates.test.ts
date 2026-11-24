import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { createSiteConfig } from '../src/lib/site-render-config';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { createExternalAiToken, requireExternalAiGrant, revokeExternalAiToken } from '../src/server/external-ai-tokens';
import { externalAiTemplateOverview, externalAiTemplateContext, submitExternalAiTemplate, readExternalAiTemplate, requestExternalAiTemplateReview, selectExternalAiTemplate } from '../src/server/external-ai-templates';
import { applyAiDetailDesign, undoAiDetailDesign, deleteAiDetailDesign, resolveAiDetailDesignPreview } from '../src/server/ai-detail-design';
import { handleExternalAiMcp } from '../src/server/external-ai-mcp';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';
const owner: Actor = { id: 'template-owner', name: 'Synthetic owner', email: 'owner@example.invalid', role: 'admin' };
let directory = '', previous: NodeJS.ProcessEnv;
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-template-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3295'; process.env.BETTER_AUTH_SECRET = 'synthetic-template-secret-'.repeat(3);
  getDraftRecord(); const draft = createEmptyDraft();
  draft.products = [{ id: 'private-product', name: 'PRIVATE_UNAUTHORIZED_RECORD', sku: 'PRIVATE-SKU', category: 'Private', material: '', description: 'PRIVATE_RECORD_TEXT', image: '', status: 'draft' }, { id: 'selected-product', name: 'Actual selected product', sku: 'P1', category: 'Products', material: 'Steel', description: 'Actual supplied facts', image: '/images/chair.jpg', status: 'draft' }];
  draft.pages.push({ id: 'detail', title: 'Products', slug: '/products/:slug', type: 'product-detail', status: 'draft', updated: '' }, { id: 'secret', title: 'PRIVATE_PAGE_TITLE', slug: '/private-page', type: '普通页面', status: 'draft', updated: '' });
  draft.editorData.detail = { root: { props: {} }, content: [] }; draft.editorData.secret = { root: { props: {} }, content: [{ type: 'Text', props: { id: 'private-text', text: 'PRIVATE_PAGE_BODY' } }] };
  const data = { root: { props: {} }, zones: {}, content: [{ type: 'Container', props: { id: 'hero', layout: 'column', content: [{ type: 'Heading', props: { id: 'title', text: '', level: 'h1', bindings: { text: { source: 'product', mode: 'current', field: 'builtin:name' } } } }] } }] };
  draft.pageTemplates = [{ id: 'selected-template', name: 'Selected product layout', kind: 'product', updated: '', description: '', detailRule: { enabled: true, priority: 20, recordIds: ['selected-product'] }, data }, { id: 'private-template', name: 'PRIVATE_TEMPLATE_NAME', kind: 'product', updated: '', description: '', data }];
  draft.media = [{ id: 'allowed-media', name: 'Selected sample photo', url: '/images/chair.jpg', kind: 'image', alt: '', size: '1KB', folder: '' }, { id: 'private-media', name: 'PRIVATE_MEDIA_NAME', url: '/images/interior.jpg', kind: 'image', alt: '', size: '1KB', folder: '' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft)); db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(owner.id, owner.name, owner.email, owner.role);
});
afterEach(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-template-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
function connection(extra = {}) { const issued = createExternalAiToken({ name: 'Template connection', scopes: ['read', 'propose'], pageIds: ['home'], templateIds: ['selected-template'], recordIds: { productIds: ['selected-product'], entryIds: [] }, ...extra }, owner); return { ...issued, grant: requireExternalAiGrant(new Request('http://127.0.0.1:3295/api/mcp', { headers: { Authorization: `Bearer ${issued.token}` } })) }; }
const request = (extra = {}) => ({ templateId: 'selected-template', expectedRevision: getDraftRecord().revision, instruction: '调整详情图文层级并改善手机排版', preserveText: true, ...extra });
const proposal = (padding = 52) => ({ summary: '改善真实详情间距', operations: [{ kind: 'design', id: 'hero', design: { desktop: { paddingTop: padding }, mobile: { paddingTop: 24 } } }], warnings: [] });
const submit = (grant: ReturnType<typeof connection>['grant'], id = 'first', req = request(), output: unknown = proposal()) => submitExternalAiTemplate(grant, { requestId: id, request: req, proposal: output });

test('模板授权独立且默认关闭；显式模板授权必须同时选择预览记录范围', () => {
  const old = connection({ templateIds: undefined, recordIds: undefined }); assert.deepEqual(old.grant.templateIds, []); assert.throws(() => externalAiTemplateContext(old.grant, { request: request() }), status(403));
  assert.throws(() => connection({ recordIds: undefined }), status(422)); assert.throws(() => connection({ templateIds: ['missing'] }), status(422));
  const allowed = connection(); assert.throws(() => externalAiTemplateContext(allowed.grant, { request: request({ recordId: 'private-product' }) }), status(403)); assert.throws(() => externalAiTemplateContext(allowed.grant, { request: request({ templateId: 'private-template' }) }), status(403));
  const forged = { ...old.grant, templateIds: null }; assert.throws(() => externalAiTemplateContext(forged, { request: request() }), status(403));
});

test('只投影授权模板与真实命中样本，未授权记录/页面/素材/规则ID和私有资料不外发', () => {
  const { grant } = connection(), overview = externalAiTemplateOverview(grant), result = externalAiTemplateContext(grant, { request: request() });
  assert.equal(overview.total, 1); assert.equal(result.sample?.id, 'selected-product'); assert.equal(result.sample?.matched, true); assert.equal(result.request.recordId, 'selected-product');
  assert.deepEqual(result.context.imageLibrary.map(item => item.id), ['allowed-media']); assert.equal(result.context.imageLibraryTotal, 1); assert.deepEqual(result.context.pageLinks.map(item => item.id), ['home']);
  assert.doesNotMatch(JSON.stringify({ overview, result }), /PRIVATE_|private-product|private-template|owner@example|synthetic-template-secret/);
  assert.equal(result.context.dynamicBindingContext?.source, 'product'); assert.match(overview.nativeOperations, /current-record/); assert.equal(overview.siteModelCalls, false);
});

test('没有授权命中样本不能默认选其他record；显式兼容样本准确标记布局预览', () => {
  const current = getDraftRecord(); current.content.pageTemplates![0].detailRule!.enabled = false; getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(current.content));
  const { grant } = connection(); assert.throws(() => externalAiTemplateContext(grant, { request: request() }), status(422));
  const ctx = externalAiTemplateContext(grant, { request: request({ recordId: 'selected-product' }) }); assert.equal(ctx.sample?.matched, false); assert.match(ctx.sample!.reason, /仅布局预览/);
  const view = submit(grant, 'forced', ctx.request); const applied = applyAiDetailDesign({ designId: view.designId, expectedRevision: 0 }, owner); assert.equal(applied.state.pageTemplates![0].detailRule!.enabled, false);
});

test('外部方案走原生候选/续调/本人确认/精确撤销，无站内模型也能完成，不自动写草稿', () => {
  const { grant } = connection(), before = getStudioEnvelope(), first = submit(grant), continued = submit(grant, 'second', request({ baseDesignId: first.designId }), proposal(64));
  assert.equal(continued.refinement?.round, 1); assert.equal(continued.status, 'pending'); assert.deepEqual(getStudioEnvelope(), before); assert.equal(continued.validation.visualInspection, 'not-performed');
  assert.match(continued.reviewUrl, /externalTemplate=aitd-[a-f0-9-]+#templates$/); assert.match(continued.afterUrl, /~detail-design/); assert.doesNotMatch(continued.reviewUrl, /fsai_|token/);
  requestExternalAiTemplateReview(grant, { designId: continued.designId, action: 'apply' }); assert.equal(getStudioEnvelope().revision, 0);
  const applied = applyAiDetailDesign({ designId: continued.designId, expectedRevision: 0 }, owner); assert.equal(readExternalAiTemplate(grant, continued.designId).status, 'applied'); assert.deepEqual(applied.state.products, before.state.products);
  undoAiDetailDesign({ designId: continued.designId, expectedRevision: applied.revision }, owner); assert.equal(readExternalAiTemplate(grant, continued.designId).status, 'undone'); assert.deepEqual(getStudioEnvelope().state.pageTemplates!.map(({updated,...item})=>item), before.state.pageTemplates!.map(({updated,...item})=>item));
});

test('外部详情候选的原生调序、图库和自由折叠面板能真实渲染，确认后仍可精确撤销', () => {
  const current=getDraftRecord(), template=current.content.pageTemplates![0];
  current.content.settings.email='orders@example.invalid';
  current.content.products[1].images=['/images/chair.jpg','/images/studio.jpg'];
  template.data={root:{props:{showChrome:'no'}},content:[
    {type:'ProductDetail',props:{id:'detail',productId:'',layout:'split',imageHeight:480,padding:24,cta:'Request a quote'}},
    {type:'Accordion',props:{id:'shipping',firstOpen:true,items:[{id:'schedule',title:'Shipping',body:'Discuss delivery dates with our team.'}]}},
  ]} as typeof template.data;
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(current.content));
  const {grant}=connection(), before=getStudioEnvelope();
  const context=externalAiTemplateContext(grant,{request:request()});
  assert.deepEqual(context.context.galleryFields?.map(field=>field.field),['builtin:images']);
  assert.doesNotMatch(JSON.stringify(context.context.galleryFields),/studio\.jpg|selected-product/);
  const view=submit(grant,'native-presentation',context.request,{summary:'保留询盘，调整详情并扩展图文',warnings:[],operations:[
    {kind:'productDetailOrder',id:'detail',order:'specifications-first'},
    {kind:'accordionFree',id:'shipping'},
    {kind:'insert',parentId:'shipping',slot:'items[0].content',index:1,node:{type:'Gallery',tempId:'new-detail-gallery',bindings:{images:'builtin:images'}}},
  ]});
  assert.deepEqual(getStudioEnvelope(),before);
  const preview=resolveAiDetailDesignPreview(view.designId,'after',owner)!;
  const html=renderToStaticMarkup(createElement(Render,{config:createSiteConfig({...preview.snapshot,pageId:preview.resolved.page.id,previewProductId:'selected-product',previewPrefix:preview.previewPrefix}),data:preview.resolved.data}));
  assert.match(html,/editor-site-detail-specifications-first/);
  assert.match(html,/href="mailto:orders@example.invalid/);
  assert.match(html,/Discuss delivery dates with our team\./);
  const galleryHtml=html.slice(html.indexOf('Discuss delivery dates with our team.'));
  assert.match(galleryHtml,/\/images\/studio\.jpg/);
  assert.ok(galleryHtml.indexOf('/images/chair.jpg')>0&&galleryHtml.indexOf('/images/chair.jpg')<galleryHtml.indexOf('/images/studio.jpg'));
  const applied=applyAiDetailDesign({designId:view.designId,expectedRevision:before.revision},owner);
  assert.deepEqual(applied.state.products,before.state.products);
  assert.deepEqual(applied.state.pageTemplates![0].data,preview.resolved.data);
  const undone=undoAiDetailDesign({designId:view.designId,expectedRevision:applied.revision},owner);
  assert.deepEqual(undone.state.pageTemplates![0].data,before.state.pageTemplates![0].data);
  assert.equal(readExternalAiTemplate(grant,view.designId).status,'undone');
});

test('同连接语义幂等、跨连接父方案隔离、撤权与只读保护；重试采用后的原请求不重复创建', () => {
  const issued = connection(), other = connection(), req = request(), out = proposal(), first = submit(issued.grant, 'stable', req, out);
  assert.equal(submit(issued.grant, 'stable', req, JSON.parse(JSON.stringify(out))).designId, first.designId); assert.throws(() => submit(issued.grant, 'stable', req, proposal(99)), status(409));
  assert.throws(() => readExternalAiTemplate(other.grant, first.designId), status(404)); assert.throws(() => submit(other.grant, 'foreign', request({ baseDesignId: first.designId })), status(404)); assert.throws(() => submit(connection({ scopes: ['read'] }).grant), status(403));
  applyAiDetailDesign({ designId: first.designId, expectedRevision: 0 }, owner); assert.equal(submit(issued.grant, 'stable', req, out).status, 'applied');
  revokeExternalAiToken(issued.credential.id, owner); assert.throws(() => readExternalAiTemplate(issued.grant, first.designId), status(401));
});

test('模板设计不能借原生命令引用未授权素材或页面；失败事务没有候选残留', () => {
  const { grant } = connection();
  for (const operation of [{ kind: 'insert', parentId: '$page', index: 1, node: { tempId: 'photo', type: 'Image', mediaId: 'private-media' } }, { kind: 'insert', parentId: '$page', index: 1, node: { tempId: 'link', type: 'ActionButton', text: 'Click', linkTarget: { kind: 'page', id: 'secret' } } }]) assert.throws(() => submit(grant, 'forbidden', request(), { summary: 'Forbidden', operations: [operation] }), status(403));
  assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_template_design').get() as { n: number }).n, 0);
});

test('续调成功后的同体断线重试读取子候选，不再依赖已删除的父候选或模板现状', () => {
  const { grant } = connection(), parent = submit(grant), req = request({ baseDesignId: parent.designId }), out = proposal(64), child = submit(grant, 'child-idempotent', req, out);
  deleteAiDetailDesign(parent.designId, owner);
  assert.equal(submit(grant, 'child-idempotent', req, out).designId, child.designId);
  const current = getDraftRecord(); current.content.pageTemplates = current.content.pageTemplates!.filter(item => item.id !== 'selected-template'); getDatabase().prepare('UPDATE cms_draft SET revision=revision+1,content_json=? WHERE id=1').run(JSON.stringify(current.content));
  assert.equal(submit(grant, 'child-idempotent', req, out).designId, child.designId);
  assert.throws(() => submit(grant, 'new-child', req, out), status(422));
});

test('MCP真实传输按模板显式授权增6工具，只读增4，旧连接保持7工具且不能伪造调用', async () => {
  async function rpc(token: string, method: string, params: unknown = {}) { const response = await handleExternalAiMcp(new Request('http://127.0.0.1:3295/api/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })); assert.equal(response.status, 200); return response.json(); }
  const old = connection({ templateIds: [] }), full = connection(), read = connection({ scopes: ['read'] });
  assert.equal((await rpc(old.token, 'tools/list')).result.tools.length, 7); assert.equal((await rpc(full.token, 'tools/list')).result.tools.length, 13); assert.equal((await rpc(read.token, 'tools/list')).result.tools.length, 9);
  const ctx = await rpc(full.token, 'tools/call', { name: 'site_template_context', arguments: { request: request() } }); assert.equal(ctx.result.structuredContent.sample.id, 'selected-product');
  const created = await rpc(full.token, 'tools/call', { name: 'site_template_propose', arguments: { requestId: 'wire', request: ctx.result.structuredContent.request, proposal: proposal() } }); assert.equal(created.result.structuredContent.status, 'pending');
  const first = created.result.structuredContent, mobile = first.selectionUnits.find((unit: { kind: string; viewport?: string }) => unit.kind === 'property' && unit.viewport === 'mobile');
  const selected = await rpc(full.token, 'tools/call', { name: 'site_template_select', arguments: { requestId: 'wire-select', designId: first.designId, expectedRevision: 0, unitIds: [mobile.id] } });
  assert.equal(selected.result.structuredContent?.status, 'pending'); assert.notEqual(selected.result.structuredContent?.designId, first.designId); assert.deepEqual(selected.result.structuredContent?.selection.unitIds, [mobile.id]); assert.equal(getDraftRecord().revision, 0);
  // 详情是平坦原生命令（上限80），不能误套整站32组命令的传输上限。
  const detailed = await rpc(full.token, 'tools/call', { name: 'site_template_propose', arguments: { requestId: 'wire-many-native', request: ctx.result.structuredContent.request, proposal: { summary: 'Detailed native layout', operations: Array.from({ length: 40 }, (_, index) => ({ kind: 'design', id: 'hero', design: { mobile: { paddingTop: index + 10 } } })), warnings: [] } } }); assert.equal(detailed.result.structuredContent?.status, 'pending');
  const { warnings: _warnings, ...withoutWarnings } = proposal(); const defaults = await rpc(full.token, 'tools/call', { name: 'site_template_propose', arguments: { requestId: 'wire-default-warnings', request: ctx.result.structuredContent.request, proposal: withoutWarnings } }); assert.equal(defaults.result.structuredContent?.status, 'pending');
  assert.equal((await rpc(old.token, 'tools/call', { name: 'site_template_context', arguments: { request: request() } })).result.isError, true);
});

test('详情MCP范围派生幂等且同连接隔离，未调用站内模型或应用草稿', () => {
  const issued = connection(), other = connection(), source = submit(issued.grant), mobile = source.selectionUnits!.find(unit => unit.kind === 'property' && unit.viewport === 'mobile')!, body = { requestId: 'select-stable', designId: source.designId, expectedRevision: 0, unitIds: [mobile.id] }, baseline = getStudioEnvelope();
  const selected = selectExternalAiTemplate(issued.grant, body); assert.notEqual(selected.designId, source.designId); assert.deepEqual(getStudioEnvelope(), baseline); assert.equal(selectExternalAiTemplate(issued.grant, body).designId, selected.designId);
  assert.throws(() => selectExternalAiTemplate(issued.grant, { ...body, unitIds: ['invented'] }), status(409)); assert.throws(() => selectExternalAiTemplate(other.grant, { ...body, requestId: 'foreign' }), status(404)); assert.throws(() => selectExternalAiTemplate(connection({ scopes: ['read'] }).grant, body), status(403));
  assert.equal(readExternalAiTemplate(issued.grant, selected.designId).status, 'pending'); assert.equal(readExternalAiTemplate(issued.grant, source.designId).status, 'pending');
});
