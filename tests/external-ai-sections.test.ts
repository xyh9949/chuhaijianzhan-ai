import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Data } from '@puckeditor/core';
import type { Actor } from '../src/server/permissions';
import type { AiSiteDesignPreview } from '../src/lib/ai-site-design-types';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { getAiProviderSummary } from '../src/server/ai-provider';
import { createExternalAiToken, requireExternalAiGrant, revokeExternalAiToken } from '../src/server/external-ai-tokens';
import { externalAiCapabilities, externalAiContext, readExternalAiDesign, selectExternalAiDesign, submitExternalAiDesign } from '../src/server/external-ai-design';
import { applyAiSiteDesign, deleteAiSiteDesign, resolveAiSiteDesignPreview, undoAiSiteDesign } from '../src/server/ai-site-design';
import { readAiDesignGuidance, saveAiDesignGuidance } from '../src/server/ai-design-guidance';
import { handleExternalAiMcp } from '../src/server/external-ai-mcp';
import { ApiError } from '../src/server/http';

const origin = 'http://127.0.0.1:3293';
const owner: Actor = { id: 'external-section-owner', name: 'Synthetic section owner', email: 'section-owner@example.invalid', role: 'admin' };
const denied = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
let directory = '', previous: NodeJS.ProcessEnv;

beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-sections-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-external-section-secret-'.repeat(3);
  getDraftRecord(); const draft = createEmptyDraft();
  draft.pages.push({ id: 'contact', title: 'UNAUTHORIZED_CONTACT_TITLE', slug: '/contact', status: 'draft', type: '普通页面', updated: '' });
  draft.editorData = {
    home: { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [
      { type: 'Container', props: { id: 'home-hero', layout: 'column', nodeLabel: 'Hero', content: [{ type: 'Heading', props: { id: 'hero-title', text: 'ORIGINAL_HERO', level: 'h1' } }] } },
      { type: 'Container', props: { id: 'home-features', layout: 'column', nodeLabel: 'Features', content: [{ type: 'Text', props: { id: 'features-copy', text: 'ORIGINAL_FEATURES' } }] } },
      { type: 'ProductList', props: { id: 'home-products', title: 'Products', description: '', category: '', columns: 3, count: 3, padding: 24, background: 'transparent' } },
    ] },
    contact: { root: { props: { title: 'Contact', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Container', props: { id: 'UNAUTHORIZED_CONTACT_ROOT', layout: 'column', nodeLabel: 'UNAUTHORIZED_SECTION_LABEL', content: [{ type: 'Text', props: { id: 'contact-copy', text: 'UNAUTHORIZED_CONTACT_BODY' } }] } }] },
  };
  draft.products = [{ id: 'supplied-chair', name: 'Supplied chair', sku: 'CHAIR-01', category: 'Seating', material: 'Wood', description: 'Supplied product facts.', image: '', status: 'draft' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(owner.id, owner.name, owner.email, owner.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-sections-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function connection(extra: Record<string, unknown> = {}) {
  const issued = createExternalAiToken({ name: 'Section client', scopes: ['read', 'propose'], ...extra }, owner);
  return { ...issued, grant: requireExternalAiGrant(new Request(`${origin}/api/mcp`, { headers: { Authorization: `Bearer ${issued.token}` } })) };
}
function request(pageIds = ['home', 'contact']) { return { expectedRevision: getDraftRecord().revision, instruction: 'Improve the hero, features and product cards while preserving separate editable sections.', targets: { pageIds, header: false, footer: false, navigation: false, style: false }, preserveText: false }; }
function source(client: ReturnType<typeof connection>, pageIds = ['home', 'contact'], requestExtra: Record<string, unknown> = {}) {
  return submitExternalAiDesign(client.grant, { requestId: 'initial-sections', request: { ...request(pageIds), ...requestExtra }, proposal: { summary: 'Prepare independently editable page sections.', warnings: [], operations: [
    { kind: 'page', pageId: 'home', operations: [{ kind: 'text', id: 'hero-title', text: 'PROPOSED_HERO' }, { kind: 'text', id: 'features-copy', text: 'PROPOSED_FEATURES' }, { kind: 'productCard', id: 'home-products', operations: [{ kind: 'design', id: 'card-home-products-title', design: { desktop: { fontSize: 31 } } }] }] },
    ...(pageIds.includes('contact') ? [{ kind: 'page', pageId: 'contact', operations: [{ kind: 'text', id: 'contact-copy', text: 'PROPOSED_CONTACT' }] }] : []),
  ] } });
}
function section(view: Pick<AiSiteDesignPreview, 'sectionUnits'>, rootId: string) { const unit = view.sectionUnits?.find(item => item.nodeIds.includes(rootId)); assert.ok(unit); return unit; }
function selectInput(view: Pick<AiSiteDesignPreview, 'designId'>, unitIds: string[], requestId = 'select-sections') { return { requestId, designId: view.designId, expectedRevision: getDraftRecord().revision, unitIds }; }
const count = () => (getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n;
const snapshot = (view: Pick<AiSiteDesignPreview, 'designId'>) => resolveAiSiteDesignPreview(view.designId, 'after', owner)!.snapshot;
async function rpc(token: string, method: string, params: unknown = {}) {
  const response = await handleExternalAiMcp(new Request(`${origin}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
  assert.equal(response.status, 200); return response.json();
}

test('外部根区块元数据不改变旧整页单位，选择首屏后真实采用撤销且其余区块保持可编辑', () => {
  const client = connection(), original = getStudioEnvelope(), provider = getAiProviderSummary(), first = source(client);
  assert.deepEqual(first.selectionUnits.map(unit => unit.id), ['page:home', 'page:contact']);
  assert.equal(first.sectionUnits?.length, 4); const hero = section(first, 'home-hero');
  assert.equal(hero.area, 'page'); assert.equal(hero.kind, 'section'); assert.equal(hero.parentId, 'page:home'); assert.deepEqual(hero.pageIds, ['home']); assert.deepEqual(hero.nodeIds, ['home-hero']); assert.match(hero.id, /^section:[a-f0-9]{32}$/);
  const chosen = selectExternalAiDesign(client.grant, selectInput(first, [hero.id]));
  assert.notEqual(chosen.designId, first.designId); assert.equal(chosen.status, 'pending'); assert.deepEqual(chosen.selection?.unitIds, [hero.id]); assert.deepEqual(getStudioEnvelope(), original); assert.deepEqual(getAiProviderSummary(), provider);
  const next = snapshot(chosen); assert.match(JSON.stringify((next.editorData.home as Data).content[0]), /PROPOSED_HERO/); assert.deepEqual((next.editorData.home as Data).content.slice(1), (original.state.editorData.home as Data).content.slice(1)); assert.deepEqual(next.editorData.contact, original.state.editorData.contact); assert.equal(next.sharedBlocks?.length || 0, 0);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, owner); assert.deepEqual(applied.state.editorData, next.editorData); assert.equal(readExternalAiDesign(client.grant, first.designId).status, 'pending');
  assert.equal(readExternalAiDesign(client.grant, first.designId).selectionPreviews[0].status, 'applied');
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, owner); assert.deepEqual(undone.state.editorData, original.state.editorData); assert.equal(undone.activeReleaseId, original.activeReleaseId);
});

test('外部选择产品根区块精确带入生成卡片，未选文案与产品事实不被夹带', () => {
  const client = connection(), original = getStudioEnvelope(), first = source(client), chosen = selectExternalAiDesign(client.grant, selectInput(first, [section(first, 'home-products').id]));
  const next = snapshot(chosen); assert.equal(next.sharedBlocks?.length, 1); assert.deepEqual((next.editorData.home as Data).content.slice(0, 2), (original.state.editorData.home as Data).content.slice(0, 2));
  // 私有预览为真实产品渲染临时映射published；实际采用仍须保留产品资料和草稿状态。
  assert.deepEqual(next.products.map(({ status: _status, ...facts }) => facts), original.state.products.map(({ status: _status, ...facts }) => facts));
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, owner); assert.deepEqual(applied.state.products, original.state.products);
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, owner);
  assert.deepEqual(undone.state.editorData, original.state.editorData); assert.equal(undone.state.sharedBlocks?.length || 0, 0);
});

test('新sectionID的幂等回执不依赖源方案存活，异体重试和跨连接仍拒绝', () => {
  const client = connection(), other = connection(), first = source(client), input = selectInput(first, [section(first, 'home-hero').id]), chosen = selectExternalAiDesign(client.grant, input), baseline = count();
  assert.equal(selectExternalAiDesign(client.grant, input).designId, chosen.designId);
  assert.throws(() => selectExternalAiDesign(client.grant, { ...input, unitIds: [section(first, 'home-features').id] }), denied(409));
  assert.throws(() => readExternalAiDesign(other.grant, chosen.designId), denied(404)); assert.throws(() => selectExternalAiDesign(other.grant, { ...input, requestId: 'foreign-section' }), denied(404)); assert.equal(count(), baseline);
  deleteAiSiteDesign(first.designId, owner); assert.equal(selectExternalAiDesign(client.grant, input).designId, chosen.designId); assert.equal(count(), baseline - 1);
});

test('只读、收窄与吊销复核及伪造/重复/父子混选均不产生候选或写草稿', () => {
  const client = connection(), reader = connection({ scopes: ['read'] }), first = source(client), hero = section(first, 'home-hero'), input = selectInput(first, [hero.id]), original = getStudioEnvelope(), baseline = count();
  assert.throws(() => selectExternalAiDesign(reader.grant, input), denied(403));
  for (const unitIds of [['section:forged'], [hero.id, hero.id], ['page:home', hero.id], ['hero-title']]) assert.throws(() => selectExternalAiDesign(client.grant, { ...input, unitIds }), denied(422));
  getDatabase().prepare('UPDATE cms_external_ai_token SET page_ids_json=? WHERE id=?').run('["home"]', client.credential.id); assert.throws(() => readExternalAiDesign(client.grant, first.designId), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, input), denied(403));
  revokeExternalAiToken(client.credential.id, owner); assert.throws(() => selectExternalAiDesign(client.grant, input), denied(401)); assert.equal(count(), baseline); assert.deepEqual(getStudioEnvelope(), original);
});

test('限定页面仅发现本页section，MCP沿用旧工具输入和确认边界', async () => {
  const client = connection({ pageIds: ['home'] }), first = source(client, ['home']), capabilities = externalAiCapabilities(client.grant);
  assert.doesNotMatch(JSON.stringify(first), /UNAUTHORIZED_/); assert.ok(first.sectionUnits?.every(unit => unit.parentId === 'page:home' && unit.pageIds.length === 1 && unit.pageIds[0] === 'home')); assert.equal(capabilities.selectiveAdoption.rootSections.selectedIdsLimit, 103);
  const initialized = await rpc(client.token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'section-test', version: '1' } }); assert.equal(initialized.result.serverInfo.version, '0.31.1');
  const tools = (await rpc(client.token, 'tools/list')).result.tools, tool = tools.find((item: { name: string }) => item.name === 'site_design_select'); assert.equal(tools.length, 7); assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['designId', 'expectedRevision', 'requestId', 'unitIds']); assert.equal(tool.inputSchema.properties.unitIds.maxItems, 103);
  const status = (await rpc(client.token, 'tools/call', { name: 'site_design_status', arguments: { designId: first.designId } })).result.structuredContent; assert.deepEqual(status.sectionUnits, first.sectionUnits);
  const original = getStudioEnvelope(), selected = (await rpc(client.token, 'tools/call', { name: 'site_design_select', arguments: selectInput(first, [section(first, 'home-hero').id]) })).result;
  assert.equal(selected.isError, undefined); assert.notEqual(selected.structuredContent.designId, first.designId); assert.equal(selected.structuredContent.requiresBrowserConfirmation, true); assert.deepEqual(getStudioEnvelope(), original);
  const readOnly = connection({ scopes: ['read'], pageIds: ['home'] }), readTools = (await rpc(readOnly.token, 'tools/list')).result.tools; assert.equal(readTools.some((item: { name: string }) => item.name === 'site_design_select'), false);
});

test('页面共同显隐变化仍明确回退整页，不能凭空拼sectionID', () => {
  const client = connection({ pageIds: ['home'] }), first = submitExternalAiDesign(client.grant, { requestId: 'page-visibility', request: request(['home']), proposal: { summary: 'Explicitly let this page inherit its site header.', warnings: [], operations: [{ kind: 'pageChrome', pageId: 'home', header: 'inherit' }] } });
  assert.deepEqual(first.sectionUnits, []); assert.ok(first.selectionUnits[0].sectionSelectionUnavailableReason); const baseline = count();
  assert.throws(() => selectExternalAiDesign(client.grant, selectInput(first, ['section:00000000000000000000000000000000'])), denied(422)); assert.equal(count(), baseline);
  const whole = selectExternalAiDesign(client.grant, selectInput(first, ['page:home'], 'whole-page-fallback')); assert.equal(whole.status, 'pending');
});

test('区块派生保留私有设计约定溯源，撤去scope后状态及幂等回执不能泄露', () => {
  const profile = readAiDesignGuidance(owner), { revision, updatedAt: _updatedAt, ...fields } = profile; saveAiDesignGuidance({ ...fields, preferredStyle: 'PRIVATE_SECTION_GUIDANCE', enabled: true, expectedRevision: revision }, owner);
  const client = connection({ scopes: ['read', 'propose', 'design-guidance:read'], pageIds: ['home'] }), context = externalAiContext(client.grant, request(['home'])), first = source(client, ['home'], { guidanceRevision: context.request.guidanceRevision });
  const input = selectInput(first, [section(first, 'home-hero').id]), chosen = selectExternalAiDesign(client.grant, input); assert.equal(chosen.designGuidance?.active, true); assert.doesNotMatch(JSON.stringify(chosen), /PRIVATE_SECTION_GUIDANCE/);
  getDatabase().prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run('["read","propose"]', client.credential.id);
  assert.throws(() => readExternalAiDesign(client.grant, chosen.designId), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, input), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, selectInput(first, [section(first, 'home-hero').id], 'guided-section-retry')), denied(403));
});
