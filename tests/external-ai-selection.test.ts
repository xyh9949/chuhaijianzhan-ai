import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { createExternalAiToken, requireExternalAiGrant, revokeExternalAiToken } from '../src/server/external-ai-tokens';
import { submitExternalAiDesign, readExternalAiDesign, selectExternalAiDesign, inheritExternalAiDesignSelection } from '../src/server/external-ai-design';
import { selectAiSiteDesign, applyAiSiteDesign, undoAiSiteDesign } from '../src/server/ai-site-design';
import { getAiProviderSummary } from '../src/server/ai-provider';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';

const admin: Actor = { id: 'selection-owner', name: 'Selection owner', email: 'selection@example.invalid', role: 'admin' };
let directory = '', previous: NodeJS.ProcessEnv;
const rejected = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-selection-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3297'; process.env.BETTER_AUTH_SECRET = 'selection-unit-private-secret-'.repeat(3);
  getDraftRecord(); const draft = createEmptyDraft(); draft.pages.push({ ...draft.pages[0], id: 'contact', title: 'Contact', slug: '/contact' });
  draft.editorData = Object.fromEntries(draft.pages.map(page => [page.id, { root: { props: { title: page.title, brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Text', props: { id: `${page.id}-copy`, text: `Original ${page.id} content`, size: 16, align: 'left', maxWidth: 900 } }] }]));
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(admin.id, admin.name, admin.email, admin.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-selection-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function connection(scopes = ['read', 'propose']) {
  const issued = createExternalAiToken({ name: 'Selection client', scopes }, admin);
  return { ...issued, grant: requireExternalAiGrant(new Request('http://127.0.0.1:3297/api/mcp', { headers: { Authorization: `Bearer ${issued.token}` } })) };
}
function source(client: ReturnType<typeof connection>) {
  return submitExternalAiDesign(client.grant, { requestId: 'initial-design', request: { expectedRevision: 0, instruction: 'Make both page descriptions clearer, keep the original site settings.', targets: { pageIds: ['home', 'contact'], header: false, footer: false, navigation: false, style: false }, preserveText: false }, proposal: { summary: 'Two page edits', operations: ['home', 'contact'].map(pageId => ({ kind: 'page', pageId, operations: [{ kind: 'text', id: `${pageId}-copy`, text: `Proposed ${pageId} content` }] })), warnings: [] } });
}

test('外部选择只创建新候选，幂等复查同token来源且旧方案仍待确认，实际只采用所选页面', () => {
  const client = connection(), original = getStudioEnvelope(), provider = getAiProviderSummary(), first = source(client);
  const unit = first.selectionUnits.find(item => item.area === 'page' && item.pageIds.includes('home')); assert.ok(unit);
  const input = { requestId: 'select-home', designId: first.designId, expectedRevision: original.revision, unitIds: [unit.id] };
  const chosen = selectExternalAiDesign(client.grant, input); assert.notEqual(chosen.designId, first.designId); assert.equal(chosen.status, 'pending');
  assert.equal(chosen.selection?.sourceDesignId, first.designId); assert.deepEqual(chosen.selection?.unitIds, [unit.id]); assert.deepEqual(getStudioEnvelope(), original); assert.deepEqual(getAiProviderSummary(), provider);
  assert.equal(selectExternalAiDesign(client.grant, input).designId, chosen.designId);
  assert.throws(() => selectExternalAiDesign(client.grant, { ...input, unitIds: first.selectionUnits.map(item => item.id) }), rejected(409));
  const sourceStatus = readExternalAiDesign(client.grant, first.designId); assert.equal(sourceStatus.status, 'pending'); assert.equal(sourceStatus.selectionPreviews.length, 1); assert.equal(sourceStatus.selectionPreviews[0].designId, chosen.designId);
  const applied = applyAiSiteDesign({ designId: chosen.designId, expectedRevision: original.revision }, admin);
  assert.match(JSON.stringify(applied.state.editorData.home), /Proposed home content/); assert.deepEqual(applied.state.editorData.contact, original.state.editorData.contact);
  assert.equal(readExternalAiDesign(client.grant, first.designId).selectionPreviews[0].status, 'applied');
  const undone = undoAiSiteDesign({ designId: chosen.designId, expectedRevision: applied.revision }, admin); assert.deepEqual(undone.state.editorData, original.state.editorData);
  assert.equal(readExternalAiDesign(client.grant, first.designId).selectionPreviews[0].status, 'undone');
});

test('浏览器挑选外部来源同事务继承连接归属，其他连接不可读取或再次派生', () => {
  const client = connection(), first = source(client), other = connection();
  const chosen = getDatabase().transaction(() => { const view = selectAiSiteDesign({ designId: first.designId, expectedRevision: 0, unitIds: [first.selectionUnits[0].id] }, admin); inheritExternalAiDesignSelection(view, admin); return view; }).immediate();
  assert.equal(readExternalAiDesign(client.grant, chosen.designId).designId, chosen.designId);
  assert.throws(() => readExternalAiDesign(other.grant, chosen.designId), rejected(404));
  assert.throws(() => selectExternalAiDesign(other.grant, { requestId: 'foreign-source', designId: chosen.designId, expectedRevision: 0, unitIds: [chosen.selectionUnits[0].id] }), rejected(404));
});

test('选择工具不放宽只读、页面收窄或吊销权限，非法确认及单位不会产生孤立候选', () => {
  const client = connection(), first = source(client), reader = connection(['read']), db = getDatabase();
  const input = { requestId: 'selection-permissions', designId: first.designId, expectedRevision: 0, unitIds: [first.selectionUnits[0].id] };
  const count = () => (db.prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n, baseline = count();
  assert.throws(() => selectExternalAiDesign(reader.grant, input), rejected(403));
  for (const extra of [{ unitIds: [] }, { unitIds: ['not-an-actual-unit'] }, { unitIds: [input.unitIds[0], input.unitIds[0]] }, { confirmation: true }, { expectedRevision: 99 }]) assert.throws(() => selectExternalAiDesign(client.grant, { ...input, ...extra }), (error: unknown) => error instanceof ApiError && [409,422].includes(error.status));
  assert.equal(count(), baseline);
  db.prepare('UPDATE cms_external_ai_token SET page_ids_json=? WHERE id=?').run('["home"]', client.credential.id);
  assert.throws(() => selectExternalAiDesign(client.grant, input), rejected(403));
  revokeExternalAiToken(client.credential.id, admin); assert.throws(() => selectExternalAiDesign(client.grant, input), rejected(401));
  assert.equal(count(), baseline);
});
