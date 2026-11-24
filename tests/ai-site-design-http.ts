import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Data } from '@puckeditor/core';
import type { StudioState } from '../src/lib/types';
import type { AiSiteDesignPreview } from '../src/lib/ai-site-design-types';
import type { AiProviderSummary } from '../src/server/ai-provider';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
const pageIds = ['http-site-design-home', 'http-site-design-contact'];
const data = (id: string): Data => ({ root: { props: { title: id, brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Heading', props: { id: `${id}-title`, text: 'Synthetic website page', level: 'h1' } }, { type: 'Text', props: { id: `${id}-copy`, text: 'Original synthetic website information.' } }] } as Data);

/** 实际生产路由验证跨页候选/续调/采用撤销；全站资产语义另由定向服务端及浏览器验证。 */
export async function runAiSiteDesignHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }, state: Envelope): Promise<Envelope> {
  const { admin, editor, viewer, anonymous } = clients, original = structuredClone(state), missing = 'aisd-00000000-0000-0000-0000-000000000000';
  for (const [client, expected] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) {
    await client.api('/api/ai/site-designs', 'GET', undefined, expected); await client.api('/api/ai/site-designs', 'POST', {}, expected);
    await client.api(`/api/ai/site-designs/${missing}`, 'GET', undefined, expected); await client.api(`/api/ai/site-designs/${missing}`, 'DELETE', undefined, expected);
    for (const suffix of ['apply', 'undo']) await client.api(`/api/ai/site-designs/${suffix}`, 'POST', {}, expected);
  }
  assert.equal((await admin.fetch('/api/ai/site-designs', { method: 'POST', headers: { Origin: 'https://wrong.example.invalid' } })).status, 403);
  const pages = pageIds.map((id, index) => ({ id, title: `Synthetic site design ${index + 1}`, slug: `/http-site-design-${index + 1}`, status: 'draft', type: '普通页面', locale: state.state.settings.language, updated: new Date().toISOString() }));
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: [...state.state.pages, ...pages], editorData: { ...state.state.editorData, ...Object.fromEntries(pageIds.map(id => [id, data(id)])) } } });
  const request = (extra: Record<string, unknown> = {}) => ({ expectedRevision: state.revision, instruction: 'HTTP_SYNTHETIC_SITE_DESIGN 优化所选两个页面的采购说明，保留其他页面和全站设置。', targets: { pageIds, header: false, footer: false, navigation: false, style: false }, preserveText: false, ...extra });
  const config = await admin.api<AiProviderSummary>('/api/ai/provider'); assert.equal(config.enabled, false); assert.equal(config.hasApiKey, false);
  await admin.api('/api/ai/site-designs', 'POST', request(), 422);
  const requests: unknown[] = [];
  const mock = createServer((incoming, response) => { let raw = ''; incoming.on('data', chunk => raw += chunk); incoming.on('end', () => { requests.push(JSON.parse(raw)); const count = requests.length; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '调整两页采购说明并保留其他内容。', intent: { goal: '使跨页说明更清楚', decisions: ['优化两页原生正文'], preserve: ['全站头尾与现有资料'], assumptions: [] }, operations: pageIds.map(pageId => ({ kind: 'page', pageId, operations: [{ kind: 'text', id: `${pageId}-copy`, text: `SITE_DESIGN_HTTP_COPY_${count} for ${pageId}` }] })), warnings: [] }) }, finish_reason: 'stop' }] })); }); });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); const address = mock.address(); assert.ok(address && typeof address !== 'string');
  let configured = false;
  try {
    await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: config.revision, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-site-design-http', apiKey: 'synthetic-site-design-http-key', allowLocal: true }); configured = true;
    const before = structuredClone(state), first = await admin.api<AiSiteDesignPreview>('/api/ai/site-designs', 'POST', request(), 201);
    assert.equal(requests.length, 1); assert.deepEqual(await admin.api('/api/studio'), state); assert.equal(first.affectedPages.length, 2); const selectedPreviews = first.previewPages.filter(page => pageIds.includes(page.pageId)); assert.equal(selectedPreviews.length, 2); assert.ok(selectedPreviews.every(page => page.available));
    assert.equal((await anonymous.fetch(first.afterUrl)).status, 404); assert.equal((await viewer.fetch(first.afterUrl)).status, 404);
    for (const page of selectedPreviews) { const response = await admin.fetch(page.afterUrl!); assert.equal(response.status, 200); assert.match(await response.text(), /SITE_DESIGN_HTTP_COPY_1/); assert.match(response.headers.get('x-robots-tag') || '', /noindex/); }
    const second = await admin.api<AiSiteDesignPreview>('/api/ai/site-designs', 'POST', request({ baseDesignId: first.designId, instruction: '继续保留这两个页面范围，把采购说明再精简一点。' }), 201);
    assert.equal(requests.length, 2); assert.equal(second.refinement?.round, 1); assert.equal(second.refinement?.baseDesignId, first.designId); assert.deepEqual(await admin.api('/api/studio'), state);
    const old = await admin.fetch(second.beforeUrl); assert.match(await old.text(), /Original synthetic website information/);
    state = await admin.api<Envelope>('/api/ai/site-designs/apply', 'POST', { designId: second.designId, expectedRevision: state.revision });
    assert.equal(state.activeReleaseId, before.activeReleaseId); for (const id of pageIds) assert.match(JSON.stringify(state.state.editorData[id]), /SITE_DESIGN_HTTP_COPY_2/);
    assert.deepEqual(state.state.theme, before.state.theme); assert.deepEqual(state.state.siteLayout, before.state.siteLayout); assert.deepEqual(state.state.products, before.state.products);
    const repeat = await admin.api<Envelope>('/api/ai/site-designs/apply', 'POST', { designId: second.designId, expectedRevision: before.revision }); assert.equal(repeat.revision, state.revision);
    state = await admin.api<Envelope>('/api/ai/site-designs/undo', 'POST', { designId: second.designId, expectedRevision: state.revision });
    for (const id of pageIds) assert.deepEqual(state.state.editorData[id], before.state.editorData[id]); assert.equal(state.activeReleaseId, before.activeReleaseId);
    const undone = await admin.api<AiSiteDesignPreview>(`/api/ai/site-designs/${second.designId}`); assert.equal(undone.undoneRevision, state.revision);
    await admin.api(`/api/ai/site-designs/${first.designId}`, 'DELETE'); assert.ok((await admin.api<{ items: AiSiteDesignPreview[] }>('/api/ai/site-designs')).items.some(item => item.designId === second.designId));
  } finally {
    if (configured) { const current = await admin.api<AiProviderSummary>('/api/ai/provider'); await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: current.revision, enabled: config.enabled, baseUrl: config.baseUrl, model: config.model, allowLocal: config.allowLocal, clearApiKey: true }); }
    state = await admin.api<Envelope>('/api/studio'); state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: original.state.pages, editorData: original.state.editorData } });
    mock.closeAllConnections(); await new Promise<void>(done => mock.close(() => done()));
  }
  return state;
}
