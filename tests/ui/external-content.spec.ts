import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { ExternalAiWritingRequest, ExternalAiWritingView } from '../../src/lib/external-ai-writing-types';
import type { SeoProposalPreview } from '../../src/lib/seo-types';
import { textToRichText } from '../../src/lib/presentation-content';

/** 只操作包装器的合成实例；SDK/HTTP失败不回显携带临时凭据的底层错误。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  const origin = new URL(runtime.origin); expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Only isolated API paths are allowed');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated API ${method} ${path} failed`); });
  expect(response.ok(), `Isolated API ${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}
async function sdk<T>(name: string, work: () => Promise<T>): Promise<T> { try { return await work(); } catch { throw new Error(`Isolated MCP ${name} failed`); } }
async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const value = await sdk(name, () => client.callTool({ name, arguments: args })); expect(value.isError, `${name} should succeed`).not.toBe(true);
  return (value.structuredContent || JSON.parse((value.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text)) as T;
}

test('无站内模型的外部文案逐项审核、富文本新建、原生继续编辑和撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(150000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 15000 });
  const client = new Client({ name: 'external-content-ui', version: '1.0.0' }); let tokenId = '', createdEntryId = '';
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const product = original.state.products[1], model = original.state.contentModels!.find(item => item.id === 'ui-story-model')!;
  expect(model).toBeTruthy();
  try {
    const provider = await api<{ enabled: boolean; hasApiKey: boolean }>(control, '/api/ai/provider'); expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI native external content', scopes: ['read', 'content:read', 'content:propose'], pageIds: null, recordIds: { productIds: null, entryIds: null } }); tokenId = credential.credential.id;
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const prepared = await tool<{ request: ExternalAiWritingRequest }>(client, 'site_content_context', { target: { kind: 'product', id: product.id }, fieldKeys: ['description', 'seoTitle'], instruction: '仅使用测试资料准备产品介绍与搜索标题，不增加事实。', sourceText: '', task: 'product' });
    const candidate = await tool<ExternalAiWritingView>(client, 'site_content_propose', { requestId: 'ui-product-native-writing', request: prepared.request, proposal: { fields: [{ key: 'description', after: 'A concise synthetic introduction prepared by the external client.' }, { key: 'seoTitle', after: 'Unselected synthetic title' }], evidenceIds: [], warnings: [], missingFacts: [] } });
    const review = await tool<{ reviewUrl: string }>(client, 'site_content_review', { candidateId: candidate.id, action: 'apply' });
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(original.revision);
    ui.allowWrite('POST', `/api/external-ai/content/${candidate.id}/apply`); ui.allowWrite('POST', `/api/external-ai/content/${candidate.id}/undo`);
    await page.goto(review.reviewUrl); await expect(page.getByRole('heading', { name: '核对内容，再保存', exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: '搜索标题', exact: true }).uncheck();
    const save = page.getByRole('button', { name: '确认保存选中内容到草稿', exact: true }); await save.click(); await expect(textButton(page, '继续自由编辑')).toBeVisible();
    await expect(page.getByText('本次已采用', { exact: true })).toHaveCount(1); await expect(page.getByText('本次未采用', { exact: true })).toHaveCount(1);
    let saved = await api<StudioEnvelope>(control, '/api/studio'); const savedProduct = saved.state.products.find(item => item.id === product.id)!;
    expect(savedProduct.description).toBe(candidate.fields.find(field => field.key === 'description')!.after); expect(savedProduct.seoTitle).toBe(product.seoTitle);
    await textButton(page, '继续自由编辑').click(); await expect(textButton(page, '保存产品')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '产品介绍 （可选）', exact: true })).toHaveValue(savedProduct.description);
    await page.goto(review.reviewUrl); await textButton(page, '撤销本次内容修改').click(); await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
    expect((await api<StudioEnvelope>(control, '/api/studio')).state.products.find(item => item.id === product.id)!.description).toBe(product.description);
    const newArticle = await tool<{ request: ExternalAiWritingRequest }>(client, 'site_content_context', { target: { kind: 'entry', modelId: model.id }, create: {}, task: 'article', fieldKeys: ['title', 'customFields:ui-body'], instruction: '写一篇测试采购文章，不增加认证、交期或价格。', sourceText: 'Synthetic article for isolated UI verification.' });
    const article = await tool<ExternalAiWritingView>(client, 'site_content_propose', { requestId: 'ui-new-rich-article', request: newArticle.request, proposal: { fields: [{ key: 'title', after: 'Synthetic procurement guide' }, { key: 'customFields:ui-body', after: textToRichText('Read the supplied specification first.\n\nConfirm the intended application before selecting a product.') }], evidenceIds: [], warnings: [], missingFacts: [] } });
    createdEntryId = article.target.id;
    ui.allowWrite('POST', `/api/external-ai/content/${article.id}/apply`); ui.allowWrite('POST', `/api/external-ai/content/${article.id}/undo`);
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(article.reviewUrl);
    await expect(page.getByText('Read the supplied specification first.', { exact: true })).toBeVisible(); await noOverflow(page);
    await testInfo.attach('external-rich-content-mobile', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    await page.getByRole('button', { name: '确认保存选中内容到草稿', exact: true }).click(); await expect(textButton(page, '继续自由编辑')).toBeVisible();
    saved = await api<StudioEnvelope>(control, '/api/studio'); const entry = saved.state.contentEntries?.find(item => item.id === article.target.id); expect(entry?.richTextFields?.['ui-body']).toEqual(article.fields.find(field => field.key === 'customFields:ui-body')!.after);
    await textButton(page, '继续自由编辑').click(); await expect(textButton(page, '保存草稿')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '内容标题', exact: true })).toHaveValue('Synthetic procurement guide');
    await expect(page.locator('[contenteditable="true"]').filter({ hasText: 'Read the supplied specification first.' })).toBeVisible();
    await page.goto(article.reviewUrl); await textButton(page, '撤销本次内容修改').click(); await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
    expect((await api<StudioEnvelope>(control, '/api/studio')).state.contentEntries?.some(item => item.id === article.target.id)).toBe(false);
    expect(ui.writes.some(item => item.path.startsWith('/api/ai/writing/proposals'))).toBe(false);
  } finally {
    await sdk('close', () => client.close());
    const latest = await api<StudioEnvelope>(control, '/api/studio');
    // 失败也只复原本用例触及的产品与新增文章，不回滚其它站点设置或发布数据。
    await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { products: latest.state.products.map(item => item.id === product.id ? product : item), contentEntries: latest.state.contentEntries?.filter(item => item.id !== createdEntryId) } });
    if (tokenId) await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); await control.dispose();
  }
});

test('外部SEO直接进入原生真实预览并确认撤销，不调用站内AI或搜索接口', async ({ page, ui }, testInfo) => {
  test.setTimeout(90000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 15000 });
  const client = new Client({ name: 'external-seo-ui', version: '1.0.0' }); let tokenId = '';
  const original = await api<StudioEnvelope>(control, '/api/studio'), home = original.state.pages.find(item => item.slug === '/')!;
  try {
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI external SEO', scopes: ['read', 'seo:read', 'seo:propose'], pageIds: [home.id], recordIds: { productIds: [], entryIds: [] } }); tokenId = credential.credential.id;
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const context = await tool<{ request: Record<string, unknown> }>(client, 'site_seo_context', { target: { kind: 'page', id: home.id }, expectedRevision: original.revision, instruction: '依据站内事实准备更清楚的首页搜索展示，不编搜索统计。', reportIds: [] });
    const proposal = await tool<SeoProposalPreview>(client, 'site_seo_propose', { requestId: 'ui-external-seo-preview', request: context.request, proposal: { seoTitle: 'Synthetic manufacturing website', seoDescription: 'Explore the supplied product and company information in this isolated demonstration.', summary: 'Clarify the homepage search presentation using supplied information.', evidence: [], warnings: [] } });
    const review = await tool<{ reviewUrl: string }>(client, 'site_seo_review', { proposalId: proposal.proposalId, action: 'apply' });
    ui.allowWrite('POST', '/api/seo/proposals/apply'); ui.allowWrite('POST', '/api/seo/proposals/undo');
    await page.goto(review.reviewUrl); const dialog = page.getByRole('dialog', { name: `优化搜索展示 · ${home.title}`, exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: '预览与确认', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(original.revision);
    await textButton(dialog, '查看实际页面前后版本').click();
    // 当前Next动态metadata可流式追加到body，核对真实文档标签时不把位置写死在head。
    await expect.poll(() => page.frameLocator('iframe[title="SEO修改后实际页面"]').locator('title').textContent()).toMatch(/Synthetic manufacturing website/);
    await expect(page.frameLocator('iframe[title="SEO修改前实际页面"]').frameLocator('iframe[title="网站草稿隔离预览"]').locator('main')).toBeVisible();
    await expect(page.frameLocator('iframe[title="SEO修改后实际页面"]').frameLocator('iframe[title="网站草稿隔离预览"]').locator('main')).toBeVisible();
    await testInfo.attach('external-seo-real-page-comparison', { body: await dialog.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await dialog.getByRole('button', { name: '确认应用到草稿', exact: true }).click(); await expect(textButton(dialog, '撤销这次修改')).toBeVisible();
    expect((await api<StudioEnvelope>(control, '/api/studio')).state.pages.find(item => item.id === home.id)!.seoTitle).toBe('Synthetic manufacturing website');
    await textButton(dialog, '撤销这次修改').click(); await expect(textButton(dialog, '撤销这次修改')).toBeDisabled();
    expect((await api<StudioEnvelope>(control, '/api/studio')).state.pages.find(item => item.id === home.id)!.seoTitle).toBe(home.seoTitle);
    expect(ui.writes.map(item => item.path)).toEqual(['/api/seo/proposals/apply', '/api/seo/proposals/undo']);
  } finally {
    await sdk('close', () => client.close());
    const latest = await api<StudioEnvelope>(control, '/api/studio');
    await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: latest.state.pages.map(item => item.id === home.id ? { ...item, seoTitle: home.seoTitle, seoDescription: home.seoDescription } : item) } });
    if (tokenId) await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); await control.dispose();
  }
});

test('产品原生历史撤销AI文案后，保留编辑页并可继续手工保存', async ({ page, ui }) => {
  test.setTimeout(90000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 15000 });
  const client = new Client({ name: 'product-native-undo-ui', version: '1' }); let tokenId = '';
  const original = await api<StudioEnvelope>(control, '/api/studio'), product = original.state.products.find(item => item.id === 'p2')!;
  try {
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI native product undo', scopes: ['read', 'content:read', 'content:propose'], pageIds: null, recordIds: { productIds: [product.id], entryIds: [] } }); tokenId = credential.credential.id;
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const prepared = await tool<{ request: ExternalAiWritingRequest }>(client, 'site_content_context', { target: { kind: 'product', id: product.id }, fieldKeys: ['description'], instruction: '仅按当前合成资料改写介绍，用于原生撤销后的继续编辑验证。', sourceText: '', task: 'product' });
    const candidate = await tool<ExternalAiWritingView>(client, 'site_content_propose', { requestId: 'ui-product-native-undo-source', request: prepared.request, proposal: { fields: [{ key: 'description', after: 'Synthetic introduction for native undo continuation.' }], evidenceIds: [], warnings: [], missingFacts: [] } });
    // 使用现有确认接口产生真实原生回执；后续撤销和继续保存必须由产品编辑器完成。
    await api(control, `/api/external-ai/content/${candidate.id}/apply`, 'POST', { expectedRevision: original.revision, selectedKeys: ['description'] });
    const receipts = await api<{ items: { id: string; target: { id: string }; undoneRevision: number | null }[] }>(control, `/api/ai/writing/receipts?kind=product&id=${product.id}`);
    const receipt = receipts.items.find(item => item.target.id === product.id && item.undoneRevision === null)!; expect(receipt).toBeTruthy();
    ui.allowWrite('POST', `/api/ai/writing/receipts/${receipt.id}/undo`); ui.allowWrite('PATCH', '/api/studio');
    await page.goto('/admin#products'); await page.locator(`tr[data-row-key="${product.id}"]`).getByRole('button', { name: `编辑${product.name}`, exact: true }).click();
    await textButton(page, 'AI写介绍').click(); const writer = page.getByRole('dialog', { name: 'AI写产品介绍', exact: true });
    await writer.getByRole('tab', { name: '查看建议与修改', exact: true }).click(); await textButton(writer, '撤销这次修改').click(); await expect(textButton(writer, '已撤销').last()).toBeVisible();
    await textButton(writer, '返回编辑').click(); await expect(writer).toBeHidden();
    await expect(page.getByRole('textbox', { name: '产品介绍 （可选）', exact: true })).toHaveValue(product.description);
    const name = page.getByRole('textbox', { name: '产品名称', exact: true }), changedName = 'Native undo followed by manual edit'; await name.fill(changedName); await textButton(page, '保存产品').click(); await expect(name).toBeHidden();
    const saved = await api<StudioEnvelope>(control, '/api/studio'), current = saved.state.products.find(item => item.id === product.id)!; expect(current.name).toBe(changedName); expect(current.description).toBe(product.description); expect(saved.activeReleaseId).toBe(original.activeReleaseId);
    expect(ui.writes).toEqual([{ method: 'POST', path: `/api/ai/writing/receipts/${receipt.id}/undo` }, { method: 'PATCH', path: '/api/studio' }]);
  } finally {
    await ui.closeOwnedPage(); await sdk('close', () => client.close());
    const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { products: latest.state.products.map(item => item.id === product.id ? product : item) } });
    if (tokenId) await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); await control.dispose();
  }
});
