import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Data } from '@puckeditor/core';
import type { StudioState } from '../src/lib/types';
import type { AiDetailDesignPreview } from '../src/lib/ai-detail-design-types';
import type { AiProviderSummary } from '../src/server/ai-provider';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
const templateId = 'http-detail-layout', productId = 'http-detail-product';
const layout: Data = { root: { props: { title: 'Synthetic detail', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Container', props: { id: 'http-detail-hero', layout: 'column', content: [{ type: 'Heading', props: { id: 'http-detail-title', text: '', level: 'h1', bindings: { text: { source: 'product', mode: 'current', field: 'builtin:name' } } } }, { type: 'Text', props: { id: 'http-detail-copy', text: 'HTTP_DETAIL_ORIGINAL_COPY' } }] } }] } as Data;

/** 真实HTTP路由验证本人候选、动态样本、续调、确认与精确撤销，所有数据仅在总测试临时实例。 */
export async function runAiDetailDesignHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }, state: Envelope): Promise<Envelope> {
  const { admin, editor, viewer, anonymous } = clients, original = structuredClone(state), missing = 'aitd-00000000-0000-0000-0000-000000000000';
  for (const [client, expected] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) {
    await client.api('/api/ai/detail-designs', 'GET', undefined, expected); await client.api('/api/ai/detail-designs', 'POST', {}, expected);
    await client.api(`/api/ai/detail-designs/${missing}`, 'GET', undefined, expected); await client.api(`/api/ai/detail-designs/${missing}`, 'DELETE', undefined, expected);
    for (const suffix of ['apply', 'undo']) await client.api(`/api/ai/detail-designs/${suffix}`, 'POST', {}, expected);
  }
  assert.equal((await admin.fetch('/api/ai/detail-designs', { method: 'POST', headers: { Origin: 'https://wrong.example.invalid' } })).status, 403);
  const defaultPage = state.state.pages.find(page => page.slug === '/products/:slug'), pageId = defaultPage?.id || 'http-detail-default';
  const pages = defaultPage ? state.state.pages : [...state.state.pages, { id: pageId, title: 'Synthetic product detail', slug: '/products/:slug', type: 'product-detail', status: 'draft', updated: '' }];
  // 临时禁用已有产品规则使本测试能证明目标确实命中；收尾完整恢复原规则和所有业务资料。
  const oldTemplates = (state.state.pageTemplates || []).map(template => template.kind === 'product' && template.detailRule?.enabled ? { ...template, detailRule: { ...template.detailRule, enabled: false } } : template);
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages, editorData: { ...state.state.editorData, ...(!defaultPage ? { [pageId]: { root: { props: {} }, content: [] } } : {}) }, products: [...state.state.products, { id: productId, name: 'HTTP_REAL_DETAIL_PRODUCT', sku: 'HTTP-D1', category: 'Synthetic', description: 'Confirmed synthetic detail facts.', material: 'Steel', image: '', status: 'draft' }], pageTemplates: [...oldTemplates, { id: templateId, name: 'HTTP detail layout', description: '', kind: 'product', detailRule: { enabled: true, priority: 1000, recordIds: [productId] }, updated: '', data: layout }] } });
  const request = (extra: Record<string, unknown> = {}) => ({ expectedRevision: state.revision, templateId, recordId: productId, instruction: 'HTTP_SYNTHETIC_DETAIL_DESIGN 调整产品详情图文与手机间距，保留动态产品标题。', preserveText: true, ...extra });
  const config = await admin.api<AiProviderSummary>('/api/ai/provider'); assert.equal(config.enabled, false); assert.equal(config.hasApiKey, false); await admin.api('/api/ai/detail-designs', 'POST', request(), 422);
  const requests: unknown[] = [], mock = createServer((incoming, response) => { let raw = ''; incoming.on('data', chunk => raw += chunk); incoming.on('end', () => { requests.push(JSON.parse(raw)); const count = requests.length; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '优化详情页原生图文间距，保留动态标题。', intent: { goal: '让采购阅读清楚', decisions: ['改善手机与桌面图文间距'], preserve: ['动态产品标题'], assumptions: [] }, operations: [{ kind: 'design', id: 'http-detail-hero', design: { desktop: { paddingTop: 60 + count }, mobile: { paddingTop: 20 + count } } }], warnings: [] }) }, finish_reason: 'stop' }] })); }); });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); const address = mock.address(); assert.ok(address && typeof address !== 'string'); let configured = false;
  try {
    await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: config.revision, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-detail-design-http', apiKey: 'synthetic-detail-design-http-key', allowLocal: true }); configured = true;
    const before = structuredClone(state), first = await admin.api<AiDetailDesignPreview>('/api/ai/detail-designs', 'POST', request(), 201);
    assert.equal(requests.length, 1); assert.deepEqual(await admin.api('/api/studio'), state); assert.equal(first.sample?.id, productId); assert.equal(first.sample?.matched, true);
    for (const client of [anonymous, viewer, editor]) assert.equal((await client.fetch(first.afterUrl)).status, 404);
    assert.equal((await anonymous.fetch(first.afterUrl, { headers: { Authorization: 'Bearer not-a-browser-session' } })).status, 404);
    const preview = await admin.fetch(first.afterUrl); assert.equal(preview.status, 200); const html = await preview.text(); assert.match(html, /HTTP_REAL_DETAIL_PRODUCT/); assert.match(html, /HTTP_DETAIL_ORIGINAL_COPY/); assert.match(preview.headers.get('x-robots-tag') || '', /noindex/); assert.equal((await admin.fetch(`${first.afterUrl}/products/${productId}`)).status, 404);
    const second = await admin.api<AiDetailDesignPreview>('/api/ai/detail-designs', 'POST', request({ baseDesignId: first.designId, instruction: '保留当前详情结构，把手机间距再调整一点。' }), 201); assert.equal(second.refinement?.round, 1); assert.equal(second.refinement?.baseDesignId, first.designId); assert.equal(requests.length, 2); assert.deepEqual(await admin.api('/api/studio'), before);
    state = await admin.api<Envelope>('/api/ai/detail-designs/apply', 'POST', { designId: second.designId, expectedRevision: state.revision }); assert.equal(state.activeReleaseId, before.activeReleaseId); assert.deepEqual(state.state.products, before.state.products); assert.deepEqual(state.state.editorData, before.state.editorData); assert.deepEqual(state.state.pageTemplates!.find(template => template.id === templateId)!.detailRule, before.state.pageTemplates!.find(template => template.id === templateId)!.detailRule); assert.match(JSON.stringify(state.state.pageTemplates!.find(template => template.id === templateId)!.data), /paddingTop/);
    assert.equal((await admin.api<Envelope>('/api/ai/detail-designs/apply', 'POST', { designId: second.designId, expectedRevision: before.revision })).revision, state.revision);
    const changed = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { theme: { ...state.state.theme, text: '#344455' } } }); state = await admin.api<Envelope>('/api/ai/detail-designs/undo', 'POST', { designId: second.designId, expectedRevision: changed.revision }); assert.deepEqual(state.state.pageTemplates!.find(template => template.id === templateId)!.data, before.state.pageTemplates!.find(template => template.id === templateId)!.data); assert.equal(state.state.theme.text, '#344455'); assert.equal(state.activeReleaseId, before.activeReleaseId);
    const undone = await admin.api<AiDetailDesignPreview>(`/api/ai/detail-designs/${second.designId}`); assert.equal(undone.undoneRevision, state.revision); await admin.api(`/api/ai/detail-designs/${first.designId}`, 'DELETE'); assert.ok((await admin.api<{ items: AiDetailDesignPreview[] }>('/api/ai/detail-designs')).items.some(item => item.designId === second.designId));
  } finally {
    if (configured) { const current = await admin.api<AiProviderSummary>('/api/ai/provider'); await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: current.revision, enabled: config.enabled, baseUrl: config.baseUrl, model: config.model, allowLocal: config.allowLocal, clearApiKey: true }); }
    state = await admin.api<Envelope>('/api/studio'); state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, products: original.state.products, pageTemplates: original.state.pageTemplates || [], sharedBlocks: original.state.sharedBlocks || [], theme: original.state.theme } });
    mock.closeAllConnections(); await new Promise<void>(done => mock.close(() => done()));
  }
  return state;
}
