import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const origin = 'http://127.0.0.1:3292';
const owner: Actor = { id: 'structural-section-owner', name: 'Synthetic structural owner', email: 'structural-owner@example.invalid', role: 'admin' };
const denied = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
type ViewIdentity = Pick<AiSiteDesignPreview, 'designId' | 'sectionUnits'>;
let directory = '', previous: NodeJS.ProcessEnv;

beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-structural-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-structural-section-secret-'.repeat(3);
  getDraftRecord(); const draft = createEmptyDraft();
  draft.pages.push({ id: 'contact', title: 'UNAUTHORIZED_CONTACT_TITLE', slug: '/contact', status: 'draft', type: '普通页面', updated: '' });
  draft.editorData = {
    home: { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [
      { type: 'Container', props: { id: 'hero', layout: 'column', nodeLabel: 'Hero', content: [{ type: 'Heading', props: { id: 'hero-title', text: 'ORIGINAL_HERO', level: 'h1' } }] } },
      { type: 'Container', props: { id: 'offer', layout: 'column', nodeLabel: 'Old offer', content: [{ type: 'Text', props: { id: 'offer-copy', text: 'SUPPLIED_OFFER_TEXT' } }] } },
      { type: 'Container', props: { id: 'product-section', layout: 'column', nodeLabel: 'Products', content: [{ type: 'ProductList', props: { id: 'product-list', title: 'Products', description: '', category: '', columns: 3, count: 3, padding: 24, background: 'transparent' } }] } },
      { type: 'Container', props: { id: 'features', layout: 'column', nodeLabel: 'Features', content: [{ type: 'Text', props: { id: 'features-copy', text: 'ORIGINAL_FEATURES' } }] } },
    ] },
    contact: { root: { props: { title: 'Contact', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Text', props: { id: 'contact-copy', text: 'UNAUTHORIZED_CONTACT_BODY' } }] },
  };
  draft.products = [{ id: 'supplied-product', name: 'Supplied chair', sku: 'CHAIR-01', category: 'Seating', material: 'Wood', description: 'Supplied product facts.', image: '', status: 'draft' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(owner.id, owner.name, owner.email, owner.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-structural-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function connection(extra: Record<string, unknown> = {}) { const issued = createExternalAiToken({ name: 'Structural section client', scopes: ['read', 'propose'], ...extra }, owner); return { ...issued, grant: requireExternalAiGrant(new Request(`${origin}/api/mcp`, { headers: { Authorization: `Bearer ${issued.token}` } })) }; }
function request(pageIds = ['home']) { return { expectedRevision: getDraftRecord().revision, instruction: 'Restructure the offer and product presentation while keeping the hero and features separately editable.', targets: { pageIds, header: false, footer: false, navigation: false, style: false }, preserveText: false }; }
/** 通过实际原生操作移动真实内容、替换旧根并生成动态卡片；不直写候选JSON模拟分组。 */
function structure(): AiPageEditOperation[] { return [
  { kind: 'move', id: 'offer-copy', parentId: 'product-section', index: 0 },
  { kind: 'remove', id: 'offer' },
  { kind: 'insert', parentId: '$page', index: 1, node: { tempId: 'new-offer-heading', type: 'Heading', text: 'New offer presentation', level: 'h2' } },
  { kind: 'productCard', id: 'product-list', operations: [{ kind: 'design', id: 'card-product-list-title', design: { desktop: { fontSize: 31 } } }] },
  { kind: 'text', id: 'hero-title', text: 'PROPOSED_HERO' }, { kind: 'text', id: 'features-copy', text: 'PROPOSED_FEATURES' },
]; }
function source(client: ReturnType<typeof connection>, operations = structure(), pageIds = ['home'], extra: Record<string, unknown> = {}) {
  return submitExternalAiDesign(client.grant, { requestId: 'structural-source', request: { ...request(pageIds), ...extra }, proposal: { summary: 'Restructure the offer with native editable sections and a dynamic card.', warnings: [], operations: [{ kind: 'page', pageId: 'home', operations }, ...(pageIds.includes('contact') ? [{ kind: 'page', pageId: 'contact', operations: [{ kind: 'text', id: 'contact-copy', text: 'PROPOSED_CONTACT' }] }] : [])] } });
}
const input = (view: Pick<AiSiteDesignPreview, 'designId'>, unitIds: string[], requestId = 'select-structure') => ({ requestId, designId: view.designId, expectedRevision: getDraftRecord().revision, unitIds });
const snapshot = (view: Pick<AiSiteDesignPreview, 'designId'>) => resolveAiSiteDesignPreview(view.designId, 'after', owner)!.snapshot;
const roots = (data: unknown) => (data as Data).content.map(node => node.props.id);
const count = () => (getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n;
function group(view: ViewIdentity, rootId: string) { const found = view.sectionUnits?.find(unit => unit.nodeIds.includes(rootId)); assert.ok(found); return found; }
async function rpc(token: string, method: string, params: unknown = {}) { const response = await handleExternalAiMcp(new Request(`${origin}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })); assert.equal(response.status, 200); return response.json(); }

test('结构组联动删除替换与跨根迁移并精确带入卡片，真实读取采用撤销仍保持未选根', () => {
  const client = connection({ pageIds: ['home'] }), original = getStudioEnvelope(), provider = getAiProviderSummary(), first = source(client), structural = group(first, 'offer');
  assert.deepEqual(first.selectionUnits.map(unit => unit.id), ['page:home']); assert.match(structural.id, /^section:g1:[a-f0-9]{32}$/); assert.equal(structural.kind, 'section'); assert.equal(structural.parentId, 'page:home'); assert.deepEqual(structural.pageIds, ['home']); assert.equal(structural.nodeIds.length, 3); assert.ok(structural.nodeIds.includes('product-section'));
  const proposed = snapshot(first), added = roots(proposed.editorData.home).find(id => !roots(original.state.editorData.home).includes(id)); assert.ok(added); assert.ok(structural.nodeIds.includes(added)); assert.equal(roots(proposed.editorData.home).includes('offer'), false);
  assert.match(group(first, 'hero').id, /^section:[a-f0-9]{32}$/); assert.match(group(first, 'features').id, /^section:[a-f0-9]{32}$/);
  const chosen = selectExternalAiDesign(client.grant, input(first, [structural.id])), next = snapshot(chosen); assert.notEqual(chosen.designId, first.designId); assert.equal(readExternalAiDesign(client.grant, chosen.designId).status, 'pending'); assert.deepEqual(chosen.selection?.unitIds, [structural.id]);
  assert.deepEqual(roots(next.editorData.home), ['hero', added, 'product-section', 'features']); assert.deepEqual((next.editorData.home as Data).content[0], (original.state.editorData.home as Data).content[0]); assert.deepEqual((next.editorData.home as Data).content[3], (original.state.editorData.home as Data).content[3]); assert.equal(next.sharedBlocks?.length, 1); assert.equal(JSON.stringify(next.editorData.home).match(/SUPPLIED_OFFER_TEXT/g)?.length, 1); assert.doesNotMatch(JSON.stringify(next.editorData.home), /PROPOSED_HERO|PROPOSED_FEATURES/);
  assert.equal(requestExternalAiReview(client.grant, { designId: chosen.designId, action: 'apply' }).requiresBrowserConfirmation, true); assert.deepEqual(getStudioEnvelope(), original); assert.deepEqual(getAiProviderSummary(), provider);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, owner); assert.deepEqual(applied.state.editorData, next.editorData); assert.deepEqual(applied.state.products, original.state.products); assert.equal(applied.activeReleaseId, original.activeReleaseId); assert.equal(readExternalAiDesign(client.grant, first.designId).selectionPreviews[0].status, 'applied');
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, owner); assert.deepEqual(undone.state.editorData, original.state.editorData); assert.equal(undone.state.sharedBlocks?.length || 0, 0); assert.equal(readExternalAiDesign(client.grant, chosen.designId).status, 'undone'); assert.equal(readExternalAiDesign(client.grant, first.designId).status, 'pending');
});

test('只有删除根的依赖组允许空after树，仍可生成真实预览并完整撤销', () => {
  const client = connection({ pageIds: ['home'] }), original = getStudioEnvelope(), first = source(client, [{ kind: 'remove', id: 'offer' }, { kind: 'text', id: 'hero-title', text: 'UNSELECTED_HERO_CHANGE' }]), removed = group(first, 'offer');
  assert.match(removed.id, /^section:g1:[a-f0-9]{32}$/); assert.deepEqual(removed.nodeIds, ['offer']);
  const chosen = selectExternalAiDesign(client.grant, input(first, [removed.id])), next = snapshot(chosen); assert.deepEqual(roots(next.editorData.home), ['hero', 'product-section', 'features']); assert.deepEqual((next.editorData.home as Data).content[0], (original.state.editorData.home as Data).content[0]);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, owner), undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, owner); assert.deepEqual(undone.state.editorData, original.state.editorData);
});

test('仅重排根也使用结构ID，按真实位置挑选时不夹带独立首屏文案', () => {
  const client = connection({ pageIds: ['home'] }), original = getStudioEnvelope(), first = source(client, [{ kind: 'reorder', id: '$page', children: ['product-section', 'hero', 'offer', 'features'] }, { kind: 'text', id: 'hero-title', text: 'UNSELECTED_HERO_CHANGE' }]), moved = group(first, 'product-section');
  assert.match(moved.id, /^section:g1:[a-f0-9]{32}$/); const chosen = selectExternalAiDesign(client.grant, input(first, [moved.id])), next = snapshot(chosen); assert.deepEqual(roots(next.editorData.home), ['product-section', 'hero', 'offer', 'features']); assert.deepEqual((next.editorData.home as Data).content[1], (original.state.editorData.home as Data).content[0]); assert.deepEqual(getStudioEnvelope(), original);
});

test('跨根后代迁移必须整组，不能用旧单根ID或节点ID扩大/拆开选择', () => {
  const client = connection({ pageIds: ['home'] }), original = getStudioEnvelope(), first = source(client, [{ kind: 'move', id: 'hero-title', parentId: 'offer', index: 1 }]), migrated = group(first, 'hero');
  assert.match(migrated.id, /^section:g1:[a-f0-9]{32}$/); assert.deepEqual(new Set(migrated.nodeIds), new Set(['hero', 'offer'])); assert.equal(group(first, 'offer').id, migrated.id);
  const obsolete = `section:${createHash('sha256').update(JSON.stringify(['home', ['hero']])).digest('hex').slice(0, 32)}`, baseline = count();
  for (const unitIds of [[obsolete], ['hero'], ['hero-title'], ['page:home', migrated.id], [migrated.id, migrated.id]]) assert.throws(() => selectExternalAiDesign(client.grant, input(first, unitIds)), denied(422)); assert.equal(count(), baseline); assert.deepEqual(getStudioEnvelope(), original);
  const chosen = selectExternalAiDesign(client.grant, input(first, [migrated.id])), next = snapshot(chosen); assert.equal(JSON.stringify(next.editorData.home).match(/hero-title/g)?.length, 1); assert.equal(((next.editorData.home as Data).content[0].props.content as unknown[]).length, 0); assert.match(JSON.stringify((next.editorData.home as Data).content[1]), /hero-title/);
});

test('结构组幂等回执按已成功新方案读取，源删除后仍返回同ID且不重新执行', () => {
  const client = connection({ pageIds: ['home'] }), first = source(client), selection = input(first, [group(first, 'offer').id]), chosen = selectExternalAiDesign(client.grant, selection), baseline = count();
  assert.equal(selectExternalAiDesign(client.grant, selection).designId, chosen.designId); assert.throws(() => selectExternalAiDesign(client.grant, { ...selection, unitIds: [group(first, 'hero').id] }), denied(409)); assert.equal(count(), baseline);
  deleteAiSiteDesign(first.designId, owner); const retry = selectExternalAiDesign(client.grant, selection); assert.equal(retry.designId, chosen.designId); assert.deepEqual(retry.selection?.unitIds, selection.unitIds); assert.equal(count(), baseline - 1);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: chosen.baseRevision }, owner); assert.equal(selectExternalAiDesign(client.grant, selection).status, 'applied'); const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, owner); assert.equal(selectExternalAiDesign(client.grant, selection).status, 'undone'); assert.equal(undone.activeReleaseId, null);
});

test('结构分组不会放宽同连接、原来源页范围、只读或实时吊销，拒绝不留下候选', () => {
  const client = connection(), other = connection(), reader = connection({ scopes: ['read'] }), first = source(client, structure(), ['home', 'contact']), selection = input(first, [group(first, 'offer').id]), original = getStudioEnvelope(), baseline = count();
  assert.throws(() => readExternalAiDesign(other.grant, first.designId), denied(404)); assert.throws(() => selectExternalAiDesign(other.grant, selection), denied(404)); assert.throws(() => selectExternalAiDesign(reader.grant, selection), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, { ...selection, unitIds: Array.from({ length: 104 }, (_, n) => `section:g1:${n}`) }), denied(422));
  getDatabase().prepare('UPDATE cms_external_ai_token SET page_ids_json=? WHERE id=?').run('["home"]', client.credential.id); assert.throws(() => readExternalAiDesign(client.grant, first.designId), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, selection), denied(403));
  revokeExternalAiToken(client.credential.id, owner); assert.throws(() => selectExternalAiDesign(client.grant, selection), denied(401)); assert.equal(count(), baseline); assert.deepEqual(getStudioEnvelope(), original);
});

test('原子结构组保留同页未选手改和新锁，选中根被改则原子拒绝', () => {
  const client = connection({ pageIds: ['home'] }), first = source(client), original = getStudioEnvelope(), home = structuredClone(original.state.editorData.home) as Data; home.content[0].props.locked = true; home.content[0].props.nodeLabel = 'Manual unselected hero';
  const manual = patchStudio({ expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, home } } }, owner), chosen = selectExternalAiDesign(client.grant, input(first, [group(first, 'offer').id])); assert.deepEqual((snapshot(chosen).editorData.home as Data).content[0], home.content[0]); assert.deepEqual(getStudioEnvelope(), manual);
  home.content[1].props.nodeLabel = 'Manual selected offer'; const changed = patchStudio({ expectedRevision: manual.revision, patch: { editorData: { ...manual.state.editorData, home } } }, owner), baseline = count(); assert.throws(() => selectExternalAiDesign(client.grant, input(first, [group(first, 'offer').id], 'conflicting-structure')), denied(409)); assert.equal(count(), baseline); assert.deepEqual(getStudioEnvelope(), changed);
});

test('MCP按旧输入发现结构组，限定页及审核确认边界保持', async () => {
  const client = connection({ pageIds: ['home'] }), first = source(client), original = getStudioEnvelope(), capabilities = externalAiCapabilities(client.grant); assert.equal(capabilities.selectiveAdoption.rootSections.dependencyGrouping, true); assert.equal(capabilities.selectiveAdoption.rootSections.selectedIdsLimit, 103); assert.equal(capabilities.selectiveAdoption.rootSections.maximumUnits, 200);
  const initialized = await rpc(client.token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'structural-sections-test', version: '1' } }); assert.equal(initialized.result.serverInfo.version, '0.31.1');
  const tools = (await rpc(client.token, 'tools/list')).result.tools, select = tools.find((tool: { name: string }) => tool.name === 'site_design_select'); assert.equal(tools.length, 7); assert.deepEqual(Object.keys(select.inputSchema.properties).sort(), ['designId', 'expectedRevision', 'requestId', 'unitIds']); assert.equal(select.inputSchema.properties.unitIds.maxItems, 103);
  const status = (await rpc(client.token, 'tools/call', { name: 'site_design_status', arguments: { designId: first.designId } })).result.structuredContent; assert.deepEqual(status.sectionUnits, first.sectionUnits); assert.doesNotMatch(JSON.stringify(status), /UNAUTHORIZED_/); assert.ok(status.sectionUnits.every((unit: { pageIds: string[]; parentId: string }) => unit.parentId === 'page:home' && unit.pageIds.length === 1 && unit.pageIds[0] === 'home'));
  const selected = (await rpc(client.token, 'tools/call', { name: 'site_design_select', arguments: input(first, [group(first, 'offer').id]) })).result; assert.equal(selected.isError, undefined); assert.notEqual(selected.structuredContent.designId, first.designId); assert.equal(selected.structuredContent.requiresBrowserConfirmation, true); assert.deepEqual(getStudioEnvelope(), original);
});

test('结构组派生保留设计约定隐私溯源，撤权不能从新候选或幂等回执读回', () => {
  const { revision, updatedAt: _updatedAt, ...profile } = readAiDesignGuidance(owner); saveAiDesignGuidance({ ...profile, preferredStyle: 'PRIVATE_STRUCTURAL_GUIDANCE', enabled: true, expectedRevision: revision }, owner);
  const client = connection({ scopes: ['read', 'propose', 'design-guidance:read'], pageIds: ['home'] }), context = externalAiContext(client.grant, request()), first = source(client, structure(), ['home'], { guidanceRevision: context.request.guidanceRevision }), selection = input(first, [group(first, 'offer').id]), chosen = selectExternalAiDesign(client.grant, selection);
  assert.equal(chosen.designGuidance?.active, true); assert.doesNotMatch(JSON.stringify(chosen), /PRIVATE_STRUCTURAL_GUIDANCE/); getDatabase().prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run('["read","propose"]', client.credential.id);
  assert.throws(() => readExternalAiDesign(client.grant, chosen.designId), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, selection), denied(403)); assert.throws(() => selectExternalAiDesign(client.grant, input(first, [group(first, 'offer').id], 'revoked-structural-select')), denied(403));
});
