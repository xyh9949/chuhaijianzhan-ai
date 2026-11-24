import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Data } from '@puckeditor/core';
import type { AiPageEditOperation } from '../src/lib/ai-page-edit-types';
import type { AiSiteDesignPreview } from '../src/lib/ai-site-design-types';
import type { Actor } from '../src/server/permissions';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { getAiProviderSummary } from '../src/server/ai-provider';
import { createExternalAiToken, requireExternalAiGrant, revokeExternalAiToken } from '../src/server/external-ai-tokens';
import { externalAiCapabilities, externalAiContext, readExternalAiDesign, requestExternalAiReview, selectExternalAiDesign, submitExternalAiDesign } from '../src/server/external-ai-design';
import { applyAiSiteDesign, deleteAiSiteDesign, resolveAiSiteDesignPreview, undoAiSiteDesign } from '../src/server/ai-site-design';
import { readAiDesignGuidance, saveAiDesignGuidance } from '../src/server/ai-design-guidance';
import { handleExternalAiMcp } from '../src/server/external-ai-mcp';
import { ApiError } from '../src/server/http';

const origin = 'http://127.0.0.1:3289';
const owner: Actor = { id: 'external-detail-owner', name: 'Synthetic detail owner', email: 'detail-owner@example.invalid', role: 'admin' };
const denied = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
let directory = '', previous: NodeJS.ProcessEnv, sequence = 0;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-details-')); sequence = 0;
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-external-detail-secret-'.repeat(3);
  getDraftRecord(); const draft = createEmptyDraft();
  draft.pages.push({ id: 'contact', title: 'UNAUTHORIZED_CONTACT_TITLE', slug: '/contact', status: 'draft', type: '普通页面', updated: '' });
  draft.editorData = {
    home: { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [
      { type: 'Container', props: { id: 'hero', layout: 'column', nodeLabel: 'Hero', content: [
        { type: 'Heading', props: { id: 'hero-title', text: 'ORIGINAL_TITLE', level: 'h1' } },
        { type: 'Text', props: { id: 'hero-description', text: 'ORIGINAL_DESCRIPTION' } },
        { type: 'Container', props: { id: 'hero-body', layout: 'column', nodeLabel: 'Nested content', content: [{ type: 'Text', props: { id: 'body-copy', text: 'ORIGINAL_BODY' } }, { type: 'Text', props: { id: 'body-other', text: 'ORIGINAL_BODY_OTHER' } }] } },
        { type: 'ProductList', props: { id: 'product-list', title: 'Products', description: '', category: '', columns: 3, count: 3, padding: 24, background: 'transparent' } },
        { type: 'Text', props: { id: 'untouched-copy', text: 'ORIGINAL_UNTOUCHED' } },
      ] } },
      { type: 'Container', props: { id: 'features', layout: 'column', content: [{ type: 'Text', props: { id: 'features-copy', text: 'ORIGINAL_FEATURES' } }] } },
    ] },
    contact: { root: { props: { title: 'Contact', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Container', props: { id: 'private-root', layout: 'column', content: [{ type: 'Heading', props: { id: 'private-title', text: 'UNAUTHORIZED_CONTACT_BODY', level: 'h1' } }] } }] },
  };
  draft.products = [{ id: 'supplied-chair', name: 'Supplied chair', sku: 'CHAIR-01', category: 'Seating', material: 'Wood', description: 'Supplied product facts.', image: '', status: 'draft' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(owner.id, owner.name, owner.email, owner.role);
});
afterEach(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-details-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
function connection(extra: Record<string, unknown> = {}) { const issued = createExternalAiToken({ name: 'Detail client', scopes: ['read', 'propose'], ...extra }, owner); return { ...issued, grant: requireExternalAiGrant(new Request(`${origin}/api/mcp`, { headers: { Authorization: `Bearer ${issued.token}` } })) }; }
function request(pageIds = ['home']) { return { expectedRevision: getDraftRecord().revision, instruction: 'Improve the title, description, nested copy and dynamic card while keeping editable stable section structure.', targets: { pageIds, header: false, footer: false, navigation: false, style: false }, preserveText: false }; }
const edits = (): AiPageEditOperation[] => [{ kind: 'text', id: 'hero-title', text: 'PROPOSED_TITLE' }, { kind: 'text', id: 'hero-description', text: 'PROPOSED_DESCRIPTION' }, { kind: 'text', id: 'body-copy', text: 'PROPOSED_BODY' }, { kind: 'productCard', id: 'product-list', operations: [{ kind: 'design', id: 'card-product-list-title', design: { desktop: { fontSize: 31 } } }] }];
/** 细项来自真实冻结候选的标题、嵌套树和动态卡片，不手造单位或私有候选快照。 */
function source(client: ReturnType<typeof connection>, operations = edits(), pageIds = ['home'], extra: Record<string, unknown> = {}) { return submitExternalAiDesign(client.grant, { requestId: `detail-source-${++sequence}`, request: { ...request(pageIds), ...extra }, proposal: { summary: 'Prepare editable title, description and nested section choices.', warnings: [], operations: [{ kind: 'page', pageId: 'home', operations }, ...(pageIds.includes('contact') ? [{ kind: 'page', pageId: 'contact', operations: [{ kind: 'text', id: 'private-title', text: 'UNAUTHORIZED_PROPOSED_COPY' }] }] : [])] } }); }
const selection = (view: Pick<AiSiteDesignPreview, 'designId'>, unitIds: string[], requestId = 'select-details') => ({ requestId, designId: view.designId, expectedRevision: getDraftRecord().revision, unitIds });
const snapshot = (view: Pick<AiSiteDesignPreview, 'designId'>) => resolveAiSiteDesignPreview(view.designId, 'after', owner)!.snapshot;
function detail(view: Pick<AiSiteDesignPreview, 'detailUnits'>, id: string) { const unit = view.detailUnits?.find(item => item.nodeIds.includes(id)); assert.ok(unit); return unit; }
function hero(data: unknown) { return (data as Data).content[0].props.content as Data['content']; }
const count = () => (getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n;
async function rpc(token: string, method: string, params: unknown = {}) { const response = await handleExternalAiMcp(new Request(`${origin}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })); assert.equal(response.status, 200); return response.json(); }

test('外部细项保留旧整页区块单位，只选标题真实采用撤销且不夹带说明或卡片', () => {
  const client = connection({ pageIds: ['home'] }), original = getStudioEnvelope(), provider = getAiProviderSummary(), first = source(client), title = detail(first, 'hero-title'), parent = first.sectionUnits!.find(unit => unit.nodeIds.includes('hero'))!;
  assert.deepEqual(first.selectionUnits.map(unit => unit.id), ['page:home']); assert.match(parent.id, /^section:[a-f0-9]{32}$/); assert.equal(first.detailUnits?.length, 4); assert.match(title.id, /^detail:d1:[a-f0-9]{32}$/); assert.equal(title.kind, 'detail'); assert.equal(title.parentId, parent.id); assert.equal(title.rootId, 'hero'); assert.deepEqual(title.pageIds, ['home']); assert.deepEqual(title.nodeIds, ['hero-title']);
  const chosen = selectExternalAiDesign(client.grant, selection(first, [title.id])), next = snapshot(chosen); assert.deepEqual(chosen.selection?.unitIds, [title.id]); assert.equal(hero(next.editorData.home)[0].props.text, 'PROPOSED_TITLE'); assert.deepEqual(hero(next.editorData.home).slice(1), hero(original.state.editorData.home).slice(1)); assert.equal(next.sharedBlocks?.length || 0, 0);
  assert.equal(requestExternalAiReview(client.grant, { designId: chosen.designId, action: 'apply' }).requiresBrowserConfirmation, true); assert.deepEqual(getStudioEnvelope(), original); assert.deepEqual(getAiProviderSummary(), provider);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, owner), undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, owner); assert.deepEqual(undone.state.editorData, original.state.editorData); assert.equal(undone.activeReleaseId, original.activeReleaseId); assert.equal(readExternalAiDesign(client.grant, chosen.designId).status, 'undone'); assert.equal(readExternalAiDesign(client.grant, first.designId).status, 'pending');
});

test('细项全选不提升整根，未列出兄弟的后来手改和新锁在采用撤销中保留', () => {
  const client = connection({ pageIds: ['home'] }), first = source(client), original = getStudioEnvelope(), home = structuredClone(original.state.editorData.home) as Data; hero(home)[4].props.text = 'MANUAL_UNSELECTED_SIBLING'; hero(home)[4].props.locked = true;
  const manual = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, owner), fineIds = first.detailUnits!.map(unit => unit.id), chosen = selectExternalAiDesign(client.grant, selection(first, fineIds));
  assert.deepEqual(new Set(chosen.selection?.unitIds), new Set(fineIds)); assert.ok(chosen.selection?.unitIds.every(id => id.startsWith('detail:d1:'))); assert.deepEqual(hero(snapshot(chosen).editorData.home)[4], hero(home)[4]); assert.deepEqual(getStudioEnvelope(), manual);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: manual.revision }, owner); assert.deepEqual(hero(applied.state.editorData.home)[4], hero(home)[4]); const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, owner); assert.deepEqual(undone.state.editorData, manual.state.editorData);
});

test('嵌套结构和父属性变化停在完整父树前沿，g1结构组不提供细项', () => {
  const client = connection({ pageIds: ['home'] }), original = getStudioEnvelope(), first = source(client, [{ kind: 'text', id: 'hero-title', text: 'UNSELECTED_TITLE' }, { kind: 'insert', parentId: 'hero-body', index: 1, node: { tempId: 'new-body-copy', type: 'Text', text: 'NESTED_INSERTED_COPY' } }]), body = detail(first, 'hero-body');
  assert.equal(first.detailUnits?.some(unit => unit.nodeIds.includes('body-copy')), false); const chosen = selectExternalAiDesign(client.grant, selection(first, [body.id])), next = snapshot(chosen); assert.equal(hero(next.editorData.home)[0].props.text, 'ORIGINAL_TITLE'); assert.match(JSON.stringify(hero(next.editorData.home)[2]), /NESTED_INSERTED_COPY/); assert.deepEqual(getStudioEnvelope(), original);
  const ownStyle = source(client, [{ kind: 'design', id: 'hero-body', design: { desktop: { paddingTop: 40 } } }, { kind: 'text', id: 'body-copy', text: 'NESTED_STYLE_COPY' }]); assert.deepEqual(detail(ownStyle, 'hero-body').nodeIds, ['hero-body']); assert.equal(ownStyle.detailUnits?.some(unit => unit.nodeIds.includes('body-copy')), false);
  const rootStyle = source(client, [{ kind: 'design', id: 'hero', design: { desktop: { paddingTop: 60 } } }, { kind: 'text', id: 'hero-title', text: 'ROOT_STYLE_COPY' }]); assert.deepEqual(rootStyle.detailUnits, []); assert.ok(rootStyle.sectionUnits![0].detailSelectionUnavailableReason);
  const moved = source(client, [{ kind: 'move', id: 'hero-title', parentId: 'features', index: 1 }]); assert.match(moved.sectionUnits![0].id, /^section:g1:/); assert.deepEqual(moved.detailUnits, []);
});

test('只选择动态产品列表细项自动带入可编辑卡片，其他细项和产品事实保持', () => {
  const client = connection({ pageIds: ['home'] }), original = getStudioEnvelope(), first = source(client), chosen = selectExternalAiDesign(client.grant, selection(first, [detail(first, 'product-list').id])), next = snapshot(chosen);
  assert.equal(next.sharedBlocks?.length, 1); assert.deepEqual(hero(next.editorData.home).slice(0, 3), hero(original.state.editorData.home).slice(0, 3)); assert.deepEqual(hero(next.editorData.home)[4], hero(original.state.editorData.home)[4]);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, owner); assert.deepEqual(applied.state.products, original.state.products); const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, owner); assert.equal(undone.state.sharedBlocks?.length || 0, 0); assert.deepEqual(undone.state.editorData, original.state.editorData);
});

test('父子混选、伪造和重复细项拒绝；选中项或共同父配置后来改变时不覆盖', () => {
  const client = connection({ pageIds: ['home'] }), first = source(client), title = detail(first, 'hero-title'), original = getStudioEnvelope(), baseline = count();
  for (const ids of [['page:home', title.id], [title.parentId, title.id], [title.id, title.id], ['hero-title'], ['detail:d1:00000000000000000000000000000000']]) assert.throws(() => selectExternalAiDesign(client.grant, selection(first, ids)), denied(422)); assert.equal(count(), baseline); assert.deepEqual(getStudioEnvelope(), original);
  const home = structuredClone(original.state.editorData.home) as Data; hero(home)[0].props.text = 'MANUAL_SELECTED_TITLE'; const manual = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, owner); assert.throws(() => selectExternalAiDesign(client.grant, selection(first, [title.id], 'selected-conflict')), denied(409)); assert.deepEqual(getStudioEnvelope(), manual);
  hero(home)[0].props.text = 'ORIGINAL_TITLE'; home.content[0].props.design = { desktop: { paddingTop: 30 } }; const changed = patchStudio({ expectedRevision: manual.revision, patch: { editorData: { ...manual.state.editorData, home } } }, owner); assert.throws(() => selectExternalAiDesign(client.grant, selection(first, [title.id], 'ancestor-conflict')), denied(409)); assert.equal(count(), baseline); assert.deepEqual(getStudioEnvelope(), changed);
});

test('细项幂等保存原来源ID，源删除后的读取和应用撤销不重新选择', () => {
  const client = connection({ pageIds: ['home'] }), first = source(client), ids = [detail(first, 'hero-title').id, detail(first, 'hero-description').id], input = selection(first, ids), chosen = selectExternalAiDesign(client.grant, input), original = getStudioEnvelope(), baseline = count();
  assert.equal(selectExternalAiDesign(client.grant, { ...input, unitIds: [...ids].reverse() }).designId, chosen.designId); assert.throws(() => selectExternalAiDesign(client.grant, { ...input, unitIds: [ids[0]] }), denied(409)); assert.equal(count(), baseline);
  deleteAiSiteDesign(first.designId, owner); assert.equal(selectExternalAiDesign(client.grant, input).designId, chosen.designId); assert.deepEqual(new Set(readExternalAiDesign(client.grant, chosen.designId).selection?.unitIds), new Set(ids));
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, owner); assert.equal(selectExternalAiDesign(client.grant, input).status, 'applied'); const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, owner); assert.equal(selectExternalAiDesign(client.grant, input).status, 'undone'); assert.deepEqual(undone.state.editorData, original.state.editorData);
});

test('细项保持同连接和原来源全部页面授权，收窄/只读/吊销拒绝且不新增候选', () => {
  const client = connection(), other = connection(), reader = connection({ scopes: ['read'] }), first = source(client, edits(), ['home', 'contact']), input = selection(first, [detail(first, 'hero-title').id]), original = getStudioEnvelope(), baseline = count();
  assert.throws(() => readExternalAiDesign(other.grant, first.designId), denied(404)); assert.throws(() => selectExternalAiDesign(other.grant, input), denied(404)); assert.throws(() => selectExternalAiDesign(reader.grant, input), denied(403));
  getDatabase().prepare('UPDATE cms_external_ai_token SET page_ids_json=? WHERE id=?').run('["home"]', client.credential.id); assert.throws(() => readExternalAiDesign(client.grant, first.designId), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, input), denied(403)); revokeExternalAiToken(client.credential.id, owner); assert.throws(() => selectExternalAiDesign(client.grant, input), denied(401)); assert.equal(count(), baseline); assert.deepEqual(getStudioEnvelope(), original);
});

test('MCP同一工具schema返回授权细项与新预览，确认仍需用户后台操作', async () => {
  const client = connection({ pageIds: ['home'] }), first = source(client), original = getStudioEnvelope(), capability = externalAiCapabilities(client.grant); assert.equal(capability.selectiveAdoption.detailSubtrees.field, 'detailUnits'); assert.equal(capability.selectiveAdoption.detailSubtrees.maximumUnits, 200);
  const initialized = await rpc(client.token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fine-subtree-test', version: '1' } }); assert.equal(initialized.result.serverInfo.version, '0.31.1'); const tools = (await rpc(client.token, 'tools/list')).result.tools, select = tools.find((tool: { name: string }) => tool.name === 'site_design_select'); assert.equal(tools.length, 7); assert.deepEqual(Object.keys(select.inputSchema.properties).sort(), ['designId', 'expectedRevision', 'requestId', 'unitIds']); assert.equal(select.inputSchema.properties.unitIds.maxItems, 103);
  const status = (await rpc(client.token, 'tools/call', { name: 'site_design_status', arguments: { designId: first.designId } })).result.structuredContent; assert.deepEqual(status.detailUnits, first.detailUnits); assert.doesNotMatch(JSON.stringify(status), /UNAUTHORIZED_|private-title|private-root/); assert.ok(status.detailUnits.every((unit: { parentId: string; rootId: string; pageIds: string[] }) => unit.parentId === first.sectionUnits![0].id && unit.rootId === 'hero' && unit.pageIds.length === 1 && unit.pageIds[0] === 'home'));
  const selected = (await rpc(client.token, 'tools/call', { name: 'site_design_select', arguments: selection(first, [detail(first, 'hero-title').id]) })).result; assert.equal(selected.isError, undefined); assert.notEqual(selected.structuredContent.designId, first.designId); assert.equal(selected.structuredContent.requiresBrowserConfirmation, true); assert.deepEqual(getStudioEnvelope(), original);
});

test('细项派生继承设计约定隐私，撤权后状态和成功请求回执均不能绕过', () => {
  const { revision, updatedAt: _updatedAt, ...profile } = readAiDesignGuidance(owner); saveAiDesignGuidance({ ...profile, preferredStyle: 'PRIVATE_FINE_GUIDANCE', enabled: true, expectedRevision: revision }, owner);
  const client = connection({ scopes: ['read', 'propose', 'design-guidance:read'], pageIds: ['home'] }), context = externalAiContext(client.grant, request()), first = source(client, edits(), ['home'], { guidanceRevision: context.request.guidanceRevision }), input = selection(first, [detail(first, 'hero-title').id]), chosen = selectExternalAiDesign(client.grant, input); assert.equal(chosen.designGuidance?.active, true); assert.doesNotMatch(JSON.stringify(chosen), /PRIVATE_FINE_GUIDANCE/);
  getDatabase().prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run('["read","propose"]', client.credential.id); assert.throws(() => readExternalAiDesign(client.grant, chosen.designId), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, input), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, selection(first, [detail(first, 'hero-title').id], 'revoked-fine')), denied(403));
});
