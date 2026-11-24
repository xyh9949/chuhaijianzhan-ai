import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Data } from '@puckeditor/core';
import type { Actor } from '../src/server/permissions';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { createExternalAiToken, requireExternalAiGrant, revokeExternalAiToken } from '../src/server/external-ai-tokens';
import { externalAiContext, readExternalAiDesign, selectExternalAiDesign, submitExternalAiDesign } from '../src/server/external-ai-design';
import { deleteAiSiteDesign } from '../src/server/ai-site-design';
import { readAiDesignGuidance, saveAiDesignGuidance } from '../src/server/ai-design-guidance';
import { handleExternalAiMcp } from '../src/server/external-ai-mcp';
import { ApiError } from '../src/server/http';

const origin = 'http://127.0.0.1:3287';
const owner: Actor = { id: 'review-regression-owner', name: 'Synthetic regression owner', email: 'review-regression@example.invalid', role: 'admin' };
const denied = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-review-regression-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-review-regression-secret-'.repeat(3);
  getDraftRecord(); const draft = createEmptyDraft();
  draft.pages.push({ id: 'other', title: 'UNAUTHORIZED_PAGE_TITLE', slug: '/other', type: '普通页面', status: 'draft', updated: '' });
  draft.editorData.home = { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Image', props: { id: 'home-image', src: '/images/chair.jpg', alt: 'Supplied photo', height: 300, fit: 'cover', radius: 0 } }] };
  draft.editorData.other = { root: { props: { title: 'Other', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Text', props: { id: 'private-copy', text: 'UNAUTHORIZED_PAGE_BODY' } }] };
  draft.media = [{ id: 'allowed-image', name: 'Supplied photo', url: '/images/chair.jpg', kind: 'image', alt: '', folder: '', size: '1KB' }, { id: 'private-image', name: 'UNAUTHORIZED_MEDIA_NAME', url: '/images/interior.jpg', kind: 'image', alt: '', folder: '', size: '1KB' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft)); db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(owner.id, owner.name, owner.email, owner.role);
});
afterEach(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-review-regression-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
function connection(extra: Record<string, unknown> = {}) { const issued = createExternalAiToken({ name: 'Review regression client', scopes: ['read', 'propose'], pageIds: ['home'], ...extra }, owner); return { ...issued, grant: requireExternalAiGrant(new Request(`${origin}/api/mcp`, { headers: { Authorization: `Bearer ${issued.token}` } })) }; }
function request(extra: Record<string, unknown> = {}) { return { expectedRevision: getDraftRecord().revision, instruction: 'Improve the supplied image alternative text.', targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false }, preserveText: false, ...extra }; }
function submission(requestId = 'saved-image', extra: Record<string, unknown> = {}, alt = 'Updated supplied photo') { return { requestId, request: request(extra), proposal: { summary: 'Use supplied photo alternative text.', operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'image', id: 'home-image', mediaId: 'allowed-image', alt }] }], warnings: [] } }; }
function changeReference() { const current = getDraftRecord(), home = structuredClone(current.content.editorData.home) as Data; home.content[0].props.src = '/images/interior.jpg'; return patchStudio({ expectedRevision: current.revision, patch: { editorData: { ...current.content.editorData, home } } }, owner); }
const count = () => (getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n;
async function tool(token: string, name: string, args: unknown) { const response = await handleExternalAiMcp(new Request(`${origin}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.result.isError, undefined); return body.result.structuredContent; }

test('真实MCP的限定页图片明细与总数同授权集合，全站连接仍可见全库计数', async () => {
  const limited = connection(), whole = connection({ pageIds: null }), original = getStudioEnvelope();
  const limitedView = await tool(limited.token, 'site_design_context', { ...request(), detailPageId: 'home' }), fullView = await tool(whole.token, 'site_design_context', { ...request(), detailPageId: 'home' });
  assert.deepEqual(limitedView.pageDetail.context.imageLibrary.map((item: { id: string }) => item.id), ['allowed-image']); assert.equal(limitedView.pageDetail.context.imageLibraryTotal, 1); assert.doesNotMatch(JSON.stringify(limitedView), /UNAUTHORIZED_|private-image|interior.jpg/);
  assert.equal(fullView.pageDetail.context.imageLibrary.length, 2); assert.equal(fullView.pageDetail.context.imageLibraryTotal, 2); assert.deepEqual(getStudioEnvelope(), original);
});

test('24项明细上限不截断授权图片总数，也不夹带未授权图片总量', async () => {
  const content = getDraftRecord().content, visible = Array.from({ length: 25 }, (_, n) => ({ id: `permitted-${n}`, name: `Supplied image ${n}`, url: `/api/media/permitted-${n}`, kind: 'image' as const, alt: '', folder: '', size: '1KB' }));
  content.media = [...visible, content.media[1]]; content.editorData.home = { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: visible.map((image, n) => ({ type: 'Image', props: { id: `image-${n}`, src: image.url, alt: '', height: 300, fit: 'cover', radius: 0 } })) };
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content)); const client = connection(), view = await tool(client.token, 'site_design_context', { ...request(), detailPageId: 'home' });
  assert.equal(view.pageDetail.context.imageLibrary.length, 24); assert.equal(view.pageDetail.context.imageLibraryTotal, 25); assert.doesNotMatch(JSON.stringify(view), /UNAUTHORIZED_|private-image/);
});

test('成功图片提案在页面引用变动后恢复原回执，异体409优先而新越界提案仍403', () => {
  const client = connection(), input = submission(), first = submitExternalAiDesign(client.grant, input), changed = changeReference(), baseline = count();
  const retry = submitExternalAiDesign(client.grant, input); assert.equal(retry.designId, first.designId); assert.equal(retry.stale, true); assert.equal(readExternalAiDesign(client.grant, first.designId).designId, first.designId); assert.deepEqual(getStudioEnvelope(), changed);
  assert.throws(() => submitExternalAiDesign(client.grant, { ...input, proposal: { ...input.proposal, summary: 'Different proposal' } }), denied(409));
  assert.throws(() => submitExternalAiDesign(client.grant, { ...input, requestId: 'new-outside-image', request: request() }), denied(403)); assert.equal(count(), baseline); assert.deepEqual(getStudioEnvelope(), changed);
});

test('成功图片续调的幂等不重新依赖已删父候选或当前素材引用', () => {
  const client = connection(), parent = submitExternalAiDesign(client.grant, submission('parent-image')), childInput = submission('child-image', { baseDesignId: parent.designId }, 'Second supplied photo alternative text'), child = submitExternalAiDesign(client.grant, childInput);
  deleteAiSiteDesign(parent.designId, owner); const changed = changeReference(); assert.equal(submitExternalAiDesign(client.grant, childInput).designId, child.designId); assert.equal(count(), 1); assert.deepEqual(getStudioEnvelope(), changed);
});

test('跳过旧素材校验仍逐次复核成功候选的guidance、动作、来源页和吊销授权', () => {
  const { revision, updatedAt: _updatedAt, ...profile } = readAiDesignGuidance(owner); saveAiDesignGuidance({ ...profile, preferredStyle: 'PRIVATE_REVIEW_GUIDANCE', enabled: true, expectedRevision: revision }, owner);
  const client = connection({ scopes: ['read', 'propose', 'design-guidance:read'] }), context = externalAiContext(client.grant, request()), input = submission('guided-image', { guidanceRevision: context.request.guidanceRevision }), first = submitExternalAiDesign(client.grant, input); changeReference(); assert.equal(submitExternalAiDesign(client.grant, input).designId, first.designId);
  const db = getDatabase(); db.prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run('["read","propose"]', client.credential.id); assert.throws(() => submitExternalAiDesign(client.grant, input), denied(403)); assert.throws(() => readExternalAiDesign(client.grant, first.designId), denied(403));
  db.prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run('["read","design-guidance:read"]', client.credential.id); assert.throws(() => submitExternalAiDesign(client.grant, input), denied(403));
  db.prepare('UPDATE cms_external_ai_token SET scopes_json=?,page_ids_json=? WHERE id=?').run('["read","propose","design-guidance:read"]', '["other"]', client.credential.id); assert.throws(() => submitExternalAiDesign(client.grant, input), denied(403));
  revokeExternalAiToken(client.credential.id, owner); assert.throws(() => submitExternalAiDesign(client.grant, input), denied(401)); assert.equal(count(), 1);
});

test('派生历史按同token去重，仅返回有界ID状态且过期条目消失，撤去guidance先挡整份回执', () => {
  const client = connection(), other = connection(), first = submitExternalAiDesign(client.grant, submission()), second = submitExternalAiDesign(other.grant, submission()), unit = first.selectionUnits[0].id;
  const child = selectExternalAiDesign(client.grant, { requestId: 'selected-own', designId: first.designId, expectedRevision: 0, unitIds: [unit] }); selectExternalAiDesign(other.grant, { requestId: 'selected-other', designId: second.designId, expectedRevision: 0, unitIds: [second.selectionUnits[0].id] });
  const history = readExternalAiDesign(client.grant, first.designId).selectionPreviews; assert.equal(history.length, 1); assert.equal(history[0].designId, child.designId); assert.deepEqual(Object.keys(history[0]).sort(), ['designId', 'reviewUrl', 'status', 'unitIds']); assert.throws(() => readExternalAiDesign(other.grant, first.designId), denied(404));
  getDatabase().prepare('UPDATE cms_ai_site_design SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', child.designId); assert.deepEqual(readExternalAiDesign(client.grant, first.designId).selectionPreviews, []);
  const { revision, updatedAt: _updatedAt, ...profile } = readAiDesignGuidance(owner); saveAiDesignGuidance({ ...profile, preferredStyle: 'PRIVATE_HISTORY_GUIDANCE', enabled: true, expectedRevision: revision }, owner); const guided = connection({ scopes: ['read', 'propose', 'design-guidance:read'] }), ctx = externalAiContext(guided.grant, request()), parent = submitExternalAiDesign(guided.grant, submission('private-parent', { guidanceRevision: ctx.request.guidanceRevision })); selectExternalAiDesign(guided.grant, { requestId: 'private-child', designId: parent.designId, expectedRevision: 0, unitIds: [parent.selectionUnits[0].id] });
  getDatabase().prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run('["read","propose"]', guided.credential.id); assert.throws(() => readExternalAiDesign(guided.grant, parent.designId), denied(403));
});
