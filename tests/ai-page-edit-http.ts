import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Data } from '@puckeditor/core';
import type { StudioState } from '../src/lib/types';
import type { AiPageEditPreview } from '../src/lib/ai-page-edit-types';
import type { AiProviderSummary } from '../src/server/ai-provider';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
const pageId = 'http-ai-edit-page', sectionId = 'http-ai-edit-section', copyId = 'http-ai-edit-copy';
const instruction = 'HTTP-PRIVATE-EDIT-INSTRUCTION: Simplify only this copy for professional buyers.';
function data(): Data { return { root: { props: { title: 'AI edit HTTP', brand: '', showChrome: 'no' } }, content: [{ type: 'Container', props: { content: [{ type: 'Heading', props: { id: 'http-edit-heading', text: 'Synthetic HTTP factory', level: 'h1' } }, { type: 'Text', props: { id: copyId, text: 'Original HTTP company information for a local test.' } }, { type: 'Text', props: { id: 'http-edit-locked', text: 'HTTP_LOCKED_FACT_DO_NOT_SEND', locked: true } }, { type: 'Image', props: { id: 'http-edit-image', src: '/images/chair.jpg', alt: 'Existing synthetic sample' } }], id: sectionId, layout: 'column', columns: 1, mobileColumns: 1, gap: 24 } }, { type: 'Text', props: { id: 'http-edit-outside', text: 'HTTP_OUTSIDE_EDIT_SCOPE_DO_NOT_SEND' } }], zones: {} } as Data; }

/** 实际生产路由仅使用合成页面和本机模型；确认、撤销和冲突都读取真实持久化工作区。 */
export async function runAiPageEditHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }, state: Envelope, options: { dataDirectory: string; password: string }): Promise<Envelope> {
  const { admin, editor, viewer, anonymous } = clients, original = structuredClone(state), missing = 'aie-00000000-0000-0000-0000-000000000000';
  for (const [client, expected] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) {
    await client.api('/api/ai/edits', 'GET', undefined, expected); await client.api('/api/ai/edits', 'POST', {}, expected);
    await client.api(`/api/ai/edits/${missing}`, 'GET', undefined, expected); await client.api(`/api/ai/edits/${missing}`, 'DELETE', undefined, expected);
    for (const suffix of ['apply', 'undo']) await client.api(`/api/ai/edits/${suffix}`, 'POST', {}, expected);
  }
  assert.equal((await admin.fetch('/api/ai/edits', { method: 'POST', headers: { Origin: 'https://wrong.example.invalid' } })).status, 403);
  const seeded = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: [...state.state.pages, { id: pageId, title: 'AI edit HTTP', slug: '/http-ai-edit-scope', status: 'draft', type: '普通页面', updated: '刚刚' }], editorData: { ...state.state.editorData, [pageId]: data() } } }); state = seeded;
  const input = (expectedRevision = state.revision) => ({ pageId, targetId: sectionId, expectedRevision, instruction, mode: 'mixed', preserveText: false, lockedIds: [] });
  const beforeGeneration = structuredClone(state), configBefore = await admin.api<AiProviderSummary>('/api/ai/provider'); assert.equal(configBefore.enabled, false); assert.equal(configBefore.hasApiKey, false);
  await admin.api('/api/ai/edits', 'POST', input(), 422); assert.deepEqual(await admin.api('/api/studio'), state);
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const mock = createServer((incoming, response) => { let raw = ''; incoming.on('data', chunk => raw += String(chunk)); incoming.on('end', () => { const body = JSON.parse(raw) as typeof requests[number]; requests.push(body); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Review the selected HTTP copy.', operations: [{ kind: 'text', id: copyId, text: `HTTP reviewed company copy ${requests.length}.` }], warnings: ['Synthetic facts need human review.'] }) }, finish_reason: 'stop' }] })); }); });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); const address = mock.address(); assert.ok(address && typeof address !== 'string');
  let providerChanged = false, promotedViewerId: string | undefined;
  try {
    await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: configBefore.revision, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-page-edit-http', allowLocal: true, apiKey: 'synthetic-page-edit-http-key' }); providerChanged = true;
    let preview = await admin.api<AiPageEditPreview>('/api/ai/edits', 'POST', input(), 201); assert.equal(requests.length, 1); assert.equal(preview.pageId, pageId); assert.equal(preview.appliedRevision, null); assert.deepEqual(await admin.api('/api/studio'), state, '生成与对比均不修改网站');
    const encoded = JSON.stringify(requests[0]); assert.match(encoded, /Original HTTP company information/); assert.doesNotMatch(encoded, /HTTP_OUTSIDE_EDIT_SCOPE|HTTP_LOCKED_FACT|HTTP-SOURCE-0001|synthetic-page-edit-http-key/);
    for (const [url, marker] of [[preview.beforeUrl, 'Original HTTP company information'], [preview.afterUrl, 'HTTP reviewed company copy 1.']]) { const response = await admin.fetch(url); assert.equal(response.status, 200); assert.match(await response.text(), new RegExp(marker)); assert.match(response.headers.get('x-robots-tag') || '', /noindex/); }
    assert.equal((await admin.fetch(`${preview.afterUrl}/other-page`)).status, 404, '候选对比不允许越过目标页面');
    const initial = preview;
    preview = await admin.api<AiPageEditPreview>('/api/ai/edits', 'POST', { ...input(), baseEditId: initial.editId, instruction: 'Keep the first direction and make the introduction clearer.' }, 201);
    assert.deepEqual(preview.refinement, { baseEditId: initial.editId, round: 1 }); assert.equal(requests.length, 2);
    assert.match(requests[1].messages[1].content, /HTTP reviewed company copy 1/);
    assert.match(await (await admin.fetch(preview.beforeUrl)).text(), /Original HTTP company information/);
    assert.match(await (await admin.fetch(preview.afterUrl)).text(), /HTTP reviewed company copy 2/);
    assert.deepEqual(await admin.api('/api/studio'), state, '继续调整不保存或应用候选');
    assert.ok((await admin.api<{ items: AiPageEditPreview[] }>(`/api/ai/edits?pageId=${pageId}`)).items.some(item => item.editId === preview.editId));
    const members = await admin.api<{ members: { id: string; email: string }[] }>('/api/members'); promotedViewerId = members.members.find(member => member.email === 'http-viewer@example.com')?.id; assert.ok(promotedViewerId);
    await admin.api(`/api/members/${promotedViewerId}`, 'PATCH', { role: 'admin' }); await viewer.api('/api/auth/sign-in/email', 'POST', { email: 'http-viewer@example.com', password: options.password });
    await viewer.api(`/api/ai/edits/${preview.editId}`, 'GET', undefined, 404); await viewer.api(`/api/ai/edits/${preview.editId}`, 'DELETE', undefined, 404); await viewer.api('/api/ai/edits/apply', 'POST', { editId: preview.editId, expectedRevision: state.revision }, 404); assert.equal((await viewer.fetch(preview.afterUrl)).status, 404);
    await admin.api(`/api/members/${promotedViewerId}`, 'PATCH', { role: 'viewer' }); promotedViewerId = undefined; await viewer.api('/api/auth/sign-in/email', 'POST', { email: 'http-viewer@example.com', password: options.password });
    state = await admin.api<Envelope>('/api/ai/edits/apply', 'POST', { editId: preview.editId, expectedRevision: state.revision }); const appliedRevision = state.revision;
    assert.equal(state.revision, seeded.revision + 1); assert.equal(state.activeReleaseId, original.activeReleaseId); assert.match(JSON.stringify(state.state.editorData[pageId]), /HTTP reviewed company copy 2/);
    for (const [id, value] of Object.entries(beforeGeneration.state.editorData)) if (id !== pageId) assert.deepEqual(state.state.editorData[id], value, '其他页面保持原样'); assert.deepEqual(state.state.products, original.state.products); assert.deepEqual(state.state.settings, original.state.settings); assert.deepEqual(state.state.customCode, original.state.customCode);
    const retried = await admin.api<Envelope>('/api/ai/edits/apply', 'POST', { editId: preview.editId, expectedRevision: seeded.revision }); assert.equal(retried.revision, state.revision);
    const changedTheme = { ...state.state.theme, primary: '#234567' }; state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { theme: changedTheme } });
    state = await admin.api<Envelope>('/api/ai/edits/undo', 'POST', { editId: preview.editId, expectedRevision: state.revision }); assert.deepEqual(state.state.editorData[pageId], seeded.state.editorData[pageId]); assert.equal(state.state.theme.primary, '#234567');
    const undoRetry = await admin.api<Envelope>('/api/ai/edits/undo', 'POST', { editId: preview.editId, expectedRevision: appliedRevision + 1 }); assert.equal(undoRetry.revision, state.revision);
    const detail = await admin.api<AiPageEditPreview>(`/api/ai/edits/${preview.editId}`); assert.equal(detail.undoneRevision, state.revision); assert.ok(Date.parse(detail.expiresAt) > Date.now() + 6 * 86400000);
    const second = await admin.api<AiPageEditPreview>('/api/ai/edits', 'POST', input(), 201); state = await admin.api<Envelope>('/api/ai/edits/apply', 'POST', { editId: second.editId, expectedRevision: state.revision });
    const edited = structuredClone(state.state.editorData[pageId]) as Data; edited.content.push({ type: 'Text', props: { id: 'http-edit-manual', text: 'Keep manual content after AI' } }); state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { editorData: { ...state.state.editorData, [pageId]: edited } } });
    await admin.api('/api/ai/edits/undo', 'POST', { editId: second.editId, expectedRevision: state.revision }, 409); assert.deepEqual(await admin.api('/api/studio'), state, '撤销冲突保留人工修改');
    const expired = await admin.api<AiPageEditPreview>('/api/ai/edits', 'POST', input(), 201), database = new Database(join(options.dataDirectory, 'studio.sqlite'));
    try { database.prepare('UPDATE cms_ai_edit SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', expired.editId); } finally { database.close(); }
    await admin.api(`/api/ai/edits/${expired.editId}`, 'GET', undefined, 410); await admin.api('/api/ai/edits/apply', 'POST', { editId: expired.editId, expectedRevision: state.revision }, 410);
    await admin.api('/api/ai/edits', 'POST', { ...input(), lockedIds: [copyId] }, 422); assert.equal(requests.length, 5, '锁定拒绝后不重复调用模型');
    const exported = await admin.api('/api/site-packages/export', 'POST', { name: 'AI edit private runtime isolation', description: 'Synthetic local validation', license: 'Synthetic local validation' });
    for (const value of [exported, await admin.api('/api/studio')]) for (const marker of [initial.editId, preview.editId, second.editId, expired.editId, instruction, 'synthetic-page-edit-http-key']) assert.equal(JSON.stringify(value).includes(marker), false, '私有操作记录与密钥不进入业务DTO或整站包');
    await admin.api(`/api/ai/edits/${second.editId}`, 'DELETE'); assert.deepEqual(await admin.api('/api/studio'), state); await admin.api(`/api/ai/edits/${second.editId}`, 'GET', undefined, 404); assert.equal((await anonymous.fetch('/http-ai-edit-scope')).status, 404);
    return state;
  } finally {
    if (promotedViewerId) await admin.api(`/api/members/${promotedViewerId}`, 'PATCH', { role: 'viewer' });
    if (providerChanged) { const latest = await admin.api<AiProviderSummary>('/api/ai/provider'); await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: latest.revision, enabled: false, baseUrl: configBefore.baseUrl, model: configBefore.model, allowLocal: configBefore.allowLocal, clearApiKey: true }); }
    mock.closeAllConnections(); if (mock.listening) await new Promise<void>((done, reject) => mock.close(error => error ? reject(error) : done()));
  }
}
