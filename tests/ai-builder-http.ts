import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AiSiteBrief, AiSitePlan } from '../src/lib/ai-builder-types';
import type { StudioState } from '../src/lib/types';
import type { AiProviderSummary } from '../src/server/ai-provider';
import { loopParam } from '../src/lib/content-query';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
type PlanResponse = { planId: string; baseRevision: number; plan: AiSitePlan; expiresInMinutes: number };
type PreviewResponse = { previewId: string; baseRevision: number; pages: { id: string; title: string; slug: string }[]; warnings: string[]; seoIssues: unknown[] };
const secret = 'ai-http-synthetic-private-token';
const marker = 'Synthetic AI HTTP factory';

/** 仅为生产HTTP验收生成合成方案，不查询外部模型，不将业务效果或企业事实伪装成实证。 */
export function aiBuilderHttpPlan(): AiSitePlan {
  const hero = (heading: string) => ({ kind: 'hero' as const, heading, body: 'Synthetic factory website for testing editable pages. All content requires review.' });
  return {
    summary: 'Synthetic company site: product discovery and business contact. Review all business details.',
    pages: [
      { key: 'home', title: 'Home', path: '/', purpose: 'Company overview for professional buyers', seoTitle: 'Synthetic AI HTTP factory overview', seoDescription: 'Explore the supplied synthetic company information and product collection.', sections: [hero(marker), { kind: 'features', heading: 'What we make', body: 'Only synthetic source information is used.', items: [{ title: 'Product information', body: 'Review supplied material descriptions.' }, { title: 'Business enquiries', body: 'Discuss requirements with the team.' }] }] },
      { key: 'products', title: 'Products', path: '/products', purpose: 'Browse actual products and supplied specifications', seoTitle: 'Synthetic AI HTTP product collection', seoDescription: 'Browse the existing products supplied by the company, with their own descriptions.', sections: [hero('Our product collection'), { kind: 'products', heading: 'Available product information', body: 'Browse actual records; no products are invented.' }] },
      { key: 'detail', title: 'Product information', path: '/products/:slug', purpose: 'Read the selected actual product record', seoTitle: 'Synthetic AI HTTP product specifications', seoDescription: 'Review the selected product information and contact the team for confirmation.', sections: [hero('Product details')] },
      { key: 'contact', title: 'Contact', path: '/contact', purpose: 'Send a business enquiry to the company', seoTitle: 'Contact Synthetic AI HTTP factory', seoDescription: 'Share your business requirements with the company and confirm the details.', sections: [hero('Discuss your requirements'), { kind: 'contact', heading: 'Contact our team', body: 'Send your requirements for manual review.' }] },
    ],
    directions: [
      { id: 'editorial', name: 'Editorial', rationale: 'Company story with calm typography and clear hierarchy.', primary: '#173443', background: '#f8f6f1', text: '#172033', headingFont: 'serif', layout: 'editorial' },
      { id: 'catalog', name: 'Catalog', rationale: 'Product-first information with compact catalog structure.', primary: '#233b5d', background: '#ffffff', text: '#182238', headingFont: 'sans', layout: 'catalog' },
      { id: 'showcase', name: 'Showcase', rationale: 'Large centered presentation and spacious content rhythm.', primary: '#4c3447', background: '#f8f4f7', text: '#29212b', headingFont: 'mono', layout: 'showcase' },
    ],
  };
}
function nodeTypes(value: unknown, found = new Set<string>()): Set<string> {
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>; if (typeof object.type === 'string') found.add(object.type);
    for (const item of Object.values(object)) nodeTypes(item, found);
  }
  return found;
}

/** 在现有隔离生产实例末尾执行；仅临时接本机mock，应用后仍不发布，原网站资料逐项保持。 */
export async function runAiBuilderHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }, state: Envelope, options: { dataDirectory: string; password: string }): Promise<Envelope> {
  const { admin, editor, viewer, anonymous } = clients;
  const initialConfig = await admin.api<AiProviderSummary>('/api/ai/provider');
  assert.equal(initialConfig.enabled, false); assert.equal(initialConfig.hasApiKey, false);
  for (const [client, expected] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) {
    await client.api('/api/ai/provider', 'GET', undefined, expected);
    await client.api('/api/ai/provider', 'PATCH', {}, expected);
    for (const path of ['/api/ai/provider/test', '/api/ai/build/plan', '/api/ai/build/preview', '/api/ai/build/apply']) await client.api(path, 'POST', {}, expected);
  }
  const badOrigin = await admin.fetch('/api/ai/provider', { method: 'PATCH', headers: { Origin: 'https://wrong.example.invalid', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(badOrigin.status, 403);
  const original = structuredClone(state), requests: { authorization?: string; body: Record<string, unknown> }[] = [];
  const mock = createServer((request, response) => {
    let raw = ''; request.on('data', chunk => raw += String(chunk)); request.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>; requests.push({ authorization: request.headers.authorization, body });
      assert.equal(request.url, '/v1/chat/completions');
      const messages = body.messages as { role: string; content: string }[];
      const value = messages[0].content.includes('Return exactly this JSON object') ? { ok: true } : aiBuilderHttpPlan();
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }));
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); const address = mock.address(); assert.ok(address && typeof address !== 'string', '本机AI模拟服务需要独立端口');
  let promotedViewerId: string | undefined;
  try {
    const config = await admin.api<AiProviderSummary>('/api/ai/provider', 'PATCH', { expectedRevision: initialConfig.revision, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-http-model', allowLocal: true, apiKey: secret });
    assert.equal(config.hasApiKey, true); assert.equal(Object.hasOwn(config, 'apiKey'), false); assert.equal(JSON.stringify(config).includes(secret), false);
    await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: initialConfig.revision, enabled: false, baseUrl: '', model: '', allowLocal: false }, 409);
    assert.deepEqual(await admin.api('/api/ai/provider/test', 'POST', {}), { ok: true, model: 'synthetic-http-model' });
    assert.equal(requests.length, 1); assert.equal(requests[0].authorization, `Bearer ${secret}`); assert.equal(requests[0].body.max_tokens, 32);
    const brief: AiSiteBrief = { companyName: marker, description: 'We provide synthetic furniture product records for this isolated HTTP test. Do not invent business facts.', industry: 'Furniture', audience: 'Professional buyers', market: 'Global', language: state.state.settings.language, styleNotes: 'Clear and commercial. Three distinct page compositions.' };
    const planInput = { expectedRevision: state.revision, brief };
    await admin.api('/api/ai/build/plan', 'POST', { ...planInput, expectedRevision: -1 }, 422);
    const staleInput = state.revision > 0 ? state.revision - 1 : 1;
    await admin.api('/api/ai/build/plan', 'POST', { ...planInput, expectedRevision: staleInput }, 409); assert.equal(requests.length, 1);
    const planned = await admin.api<PlanResponse>('/api/ai/build/plan', 'POST', planInput);
    assert.equal(planned.baseRevision, state.revision); assert.equal(planned.expiresInMinutes, 40); assert.equal(planned.plan.directions.length, 3); assert.equal(planned.plan.pages.length, 4); assert.equal(requests.length, 2);
    const sent = JSON.parse((requests[1].body.messages as { content: string }[])[1].content) as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent).sort(), ['brief', 'images', 'products']); assert.equal(JSON.stringify(sent).includes(secret), false); assert.ok(!Object.hasOwn(sent, 'inquiries'), '询盘和内部记录不得进入模型上下文');
    assert.deepEqual(await admin.api<Envelope>('/api/studio'), original, '生成规划不改变网站草稿、发布指针或运行询盘');

    const previews: PreviewResponse[] = [];
    for (const direction of planned.plan.directions) {
      const preview = await admin.api<PreviewResponse>('/api/ai/build/preview', 'POST', { planId: planned.planId, directionId: direction.id, prefix: '/ai-http' }); previews.push(preview);
      assert.equal(preview.baseRevision, state.revision); assert.ok(preview.pages.length >= 3, '预览应包含生成的普通页面'); assert.ok(Array.isArray(preview.seoIssues));
      const path = `/preview/~ai/${preview.previewId}/ai-http`, response = await admin.fetch(path), html = await response.text();
      assert.equal(response.status, 200); assert.match(html, /noindex/); assert.ok(html.includes(marker), '私有预览渲染AI规划内容'); assert.ok(html.includes(`/preview/~ai/${preview.previewId}/ai-http/contact`), '候选站内链留在当前预览命名空间');
      assert.notEqual((await anonymous.fetch(path)).status, 200); assert.notEqual((await editor.fetch(path)).status, 200); assert.notEqual((await viewer.fetch(path)).status, 200);
    }
    assert.equal(requests.length, 2, '三种设计预览复用已生成规划，不重复调用模型');
    assert.deepEqual(await admin.api<Envelope>('/api/studio'), original, '三方向预览均不得修改草稿');
    await admin.api('/api/ai/build/preview', 'POST', { planId: planned.planId, directionId: 'not-in-plan', prefix: '/ai-http' }, 422);
    await admin.api('/api/ai/build/preview', 'POST', { planId: planned.planId, directionId: 'editorial', prefix: '/admin/private' }, 422);

    // 两个同角色账号也不能读取、应用彼此的短期规划；借用只读测试成员后恢复原角色。
    const members = await admin.api<{ members: { id: string; email: string }[] }>('/api/members'); promotedViewerId = members.members.find(member => member.email === 'http-viewer@example.com')?.id; assert.ok(promotedViewerId);
    await admin.api(`/api/members/${promotedViewerId}`, 'PATCH', { role: 'admin' }); await viewer.api('/api/auth/sign-in/email', 'POST', { email: 'http-viewer@example.com', password: options.password });
    await viewer.api('/api/ai/build/preview', 'POST', { planId: planned.planId, directionId: 'editorial', prefix: '/ai-other' }, 404);
    await viewer.api('/api/ai/build/apply', 'POST', { previewId: previews[0].previewId, expectedRevision: state.revision }, 404);
    assert.equal((await viewer.fetch(`/preview/~ai/${previews[0].previewId}/ai-http`)).status, 404);
    await admin.api(`/api/members/${promotedViewerId}`, 'PATCH', { role: 'viewer' }); promotedViewerId = undefined; await viewer.api('/api/auth/sign-in/email', 'POST', { email: 'http-viewer@example.com', password: options.password });

    const selected = previews[0];
    // 完整目录通过生产预览加载，复用此前HTTP导入的真实合成产品和原生查询控件。
    const cataloguePath = `/preview/~ai/${selected.previewId}/ai-http/products`;
    const catalogueResponse = await admin.fetch(cataloguePath), catalogueHtml = await catalogueResponse.text();
    assert.equal(catalogueResponse.status, 200);
    const loopId = /data-content-loop="([^"]+)"/.exec(catalogueHtml)?.[1]; assert.ok(loopId);
    const renderedProducts = (html: string) => [...html.matchAll(/data-loop-record="([^"]+)"/g)].map(match => match[1]);
    const firstProducts = renderedProducts(catalogueHtml);
    assert.equal(firstProducts.length, 12);
    const nextCatalogue = await admin.fetch(`${cataloguePath}?${new URLSearchParams([[loopParam(loopId, 'page'), '2']])}`);
    assert.equal(nextCatalogue.status, 200);
    const nextProducts = renderedProducts(await nextCatalogue.text());
    assert.ok(nextProducts.length && nextProducts.every(id => !firstProducts.includes(id)));
    const searchedCatalogue = await admin.fetch(`${cataloguePath}?${new URLSearchParams([[loopParam(loopId, 'search'), 'HTTP-Q-30']])}`);
    assert.equal(searchedCatalogue.status, 200);
    assert.deepEqual(renderedProducts(await searchedCatalogue.text()), ['http-query-product-30']);

    const layoutSelection = { baseReleaseId: state.activeReleaseId, productIds: [], includeTheme: false, includeSettings: false, includeLayout: true };
    const originalLayoutPreview = await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', { ...layoutSelection, pageIds: [], expectedRevision: state.revision });
    state = await admin.api<Envelope>('/api/ai/build/apply', 'POST', { previewId: selected.previewId, expectedRevision: selected.baseRevision });
    assert.equal(state.revision, original.revision + 1); assert.equal(state.activeReleaseId, original.activeReleaseId); assert.equal(state.state.releases.length, original.state.releases.length);
    for (const field of ['products', 'media', 'settings', 'theme', 'forms', 'customCode', 'contentModels', 'contentEntries', 'taxonomies', 'redirects', 'inquiries'] as const) assert.deepEqual(state.state[field], original.state[field], `${field}不应被AI建站覆盖`);
    const { menus: previousMenus = [], ...previousLayout } = original.state.siteLayout!;
    const { menus: appliedMenus = [], ...appliedLayout } = state.state.siteLayout!;
    assert.deepEqual(appliedLayout, previousLayout, '前缀站保留原全站页眉、页脚和布局设置');
    assert.deepEqual(appliedMenus.slice(0, previousMenus.length), previousMenus, '旧菜单逐项保留');
    assert.equal(appliedMenus.length, previousMenus.length + 1);
    const generatedMenu = appliedMenus.at(-1)!;
    assert.deepEqual(generatedMenu.items.map(item => item.target), selected.pages.filter(page => !page.slug.includes(':')).map(page => ({ kind: 'page', id: page.id })));
    const previousBlocks = original.state.sharedBlocks || [], appliedBlocks = state.state.sharedBlocks || [];
    assert.deepEqual(appliedBlocks.slice(0, previousBlocks.length), previousBlocks, '旧共享区块逐项保留');
    const generatedBlocks = appliedBlocks.slice(previousBlocks.length);
    assert.equal(generatedBlocks.length, 3, '新增共享页眉、页脚和目录卡片各一份');
    assert.equal(generatedBlocks.filter(block => nodeTypes(block.data).has('Navigation')).length, 1);
    for (const page of original.state.pages) { assert.deepEqual(state.state.pages.find(item => item.id === page.id), page, '旧页面资料保持'); assert.deepEqual(state.state.editorData[page.id], original.state.editorData[page.id], '旧页面设计保持'); }
    const firstPage = selected.pages.find(page => page.slug === '/ai-http')!; assert.ok(firstPage, '新增首页有独立路径');
    const types = nodeTypes(state.state.editorData[firstPage.id]); assert.ok(types.has('Container') && types.has('Heading') && types.has('Text') && types.has('ActionButton') && types.has('SharedBlock'), '生成结果必须是现有可拖拽节点');
    assert.ok([...types].every(type => ['Container', 'Heading', 'Text', 'ActionButton', 'Image', 'SharedBlock', 'ContentList', 'ProductDetail', 'Form'].includes(type)), '生成页面不包含未知组件或执行代码');
    const retried = await admin.api<Envelope>('/api/ai/build/apply', 'POST', { previewId: selected.previewId, expectedRevision: selected.baseRevision }); assert.equal(retried.revision, state.revision); assert.deepEqual(retried.state.pages, state.state.pages); assert.equal(requests.length, 2);
    await admin.api('/api/ai/build/apply', 'POST', { previewId: previews[1].previewId, expectedRevision: previews[1].baseRevision }, 409);
    assert.equal((await anonymous.fetch('/ai-http')).status, 404, '应用草稿仍不会公开');
    assert.equal((await admin.fetch('/preview/ai-http')).status, 200, '应用后可在普通草稿预览及编辑器继续操作');
    const releaseSelection = { expectedRevision: state.revision, baseReleaseId: state.activeReleaseId, pageIds: selected.pages.map(page => page.id), productIds: [], includeTheme: false, includeSettings: false };
    const publication = await admin.api<{ errors: string[]; expectedRevision: number }>('/api/releases/preview', 'POST', releaseSelection);
    assert.ok(generatedBlocks.every(block => publication.errors.some(error => error.includes(block.id))), '发布预检应查出未选择的共享区块');
    assert.equal(publication.expectedRevision, state.revision);
    const withDependencies = await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', { ...releaseSelection, ...layoutSelection, sharedBlockIds: generatedBlocks.map(block => block.id) });
    // 比对采用前布局预检；先前回滚留下的旧菜单问题必须原样保留，新增依赖都须通过。
    const oldMenuErrors = new Set(previousMenus.flatMap(menu => menu.items.map(item => `菜单“${menu.name}”项目“${item.label}”引用目标不可用`)));
    assert.deepEqual(originalLayoutPreview.errors.filter(error => !oldMenuErrors.has(error)), []);
    assert.deepEqual([...withDependencies.errors].sort(), [...originalLayoutPreview.errors].sort());
    assert.equal((await admin.api<Envelope>('/api/studio')).activeReleaseId, original.activeReleaseId);

    const database = new Database(join(options.dataDirectory, 'studio.sqlite'));
    try {
      const stored = database.prepare('SELECT * FROM cms_ai_provider').get(); assert.equal(JSON.stringify(stored).includes(secret), false, 'SQLite只保存密钥密文');
      database.prepare('UPDATE cms_ai_build SET expires_at=? WHERE id IN (?,?)').run('2000-01-01T00:00:00.000Z', planned.planId, previews[2].previewId);
    } finally { database.close(); }
    await admin.api('/api/ai/build/preview', 'POST', { planId: planned.planId, directionId: 'editorial', prefix: '/ai-expired' }, 410);
    await admin.api('/api/ai/build/apply', 'POST', { previewId: previews[2].previewId, expectedRevision: previews[2].baseRevision }, 410);
    assert.equal((await admin.fetch(`/preview/~ai/${previews[2].previewId}/ai-http`)).status, 404);
    const exported = await admin.api('/api/site-packages/export', 'POST', { name: 'AI builder runtime isolation', description: 'Synthetic local QA', license: 'Synthetic local QA' });
    for (const value of [exported, await admin.api('/api/studio')]) { const raw = JSON.stringify(value); assert.equal(raw.includes(secret), false); assert.equal(raw.includes('synthetic-http-model'), false); assert.equal(raw.includes(planned.planId), false); }
    // 操作响应可附本次建站撤销回执；后续套件只传标准工作区，不能把私有操作回执误当持久字段。
    return {state:state.state,revision:state.revision,activeReleaseId:state.activeReleaseId};
  } finally {
    if (promotedViewerId) await admin.api(`/api/members/${promotedViewerId}`, 'PATCH', { role: 'viewer' });
    const latest = await admin.api<AiProviderSummary>('/api/ai/provider');
    await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: latest.revision, enabled: false, baseUrl: initialConfig.baseUrl, model: initialConfig.model, allowLocal: initialConfig.allowLocal, clearApiKey: true });
    mock.closeAllConnections(); if (mock.listening) await new Promise<void>((resolveClose, reject) => mock.close(error => error ? reject(error) : resolveClose()));
  }
}
