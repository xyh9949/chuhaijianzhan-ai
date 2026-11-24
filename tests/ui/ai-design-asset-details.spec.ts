import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Locator } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { PageTemplate } from '../../src/lib/types';
import type { AiSiteDesignPreview } from '../../src/lib/ai-site-design-types';
import type { AiDetailDesignPreview } from '../../src/lib/ai-detail-design-types';
import { withEditorRootDefaults } from '../../src/lib/editor-root-defaults';

/** 仅使用包装器的隔离实例，认证/SDK异常不输出凭据或完整请求。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  const origin = new URL(runtime.origin); expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Only isolated API paths are allowed');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated asset ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}
async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  let result; try { result = await client.callTool({ name, arguments: args }); } catch { throw new Error(`Isolated asset MCP ${name} failed`); }
  expect(result.isError, `${name} should succeed`).not.toBe(true);
  return (result.structuredContent || JSON.parse((result.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text)) as T;
}
function headerData(): Data { return withEditorRootDefaults({ root: { props: {} }, content: [{ type: 'Container', props: { id: 'asset-header', padding: 16, minHeight: 0, content: [{ type: 'Heading', props: { id: 'asset-brand', text: 'Supplied asset brand', level: 'h2' } }, { type: 'Text', props: { id: 'asset-header-note', text: 'Supplied header support' } }] } }] }); }
function detailData(): Data { return withEditorRootDefaults({ root: { props: {} }, content: [{ type: 'Container', props: { id: 'asset-detail', padding: 24, minHeight: 0, content: [{ type: 'Heading', props: { id: 'asset-product-title', text: '', level: 'h1', bindings: { text: { source: 'product', mode: 'current', field: 'builtin:name' } } } }, { type: 'Text', props: { id: 'asset-support', text: 'Supplied product support' } }] } }] }); }
async function loaded(dialog: Locator, beforeText: string, afterText: string) {
  for (const [side, text] of [['修改前', beforeText], ['AI建议', afterText]]) {
    const frame = dialog.frameLocator(`iframe[title="${side}"]`);
    await expect(frame.frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: text, exact: true })).toBeVisible();
    await expect.poll(() => frame.locator('html').evaluate(element => element.ownerDocument.readyState)).toBe('complete');
  }
}
async function toggleFine(dialog: Locator, label: string) {
  const node = dialog.locator('.ant-tree-treenode').filter({ hasText: label }); await expect(node).toHaveCount(1);
  await node.locator('.ant-tree-checkbox').click(); await expect(node.locator('.ant-tree-checkbox')).toHaveClass(/ant-tree-checkbox-checked/);
}

test('头尾和详情模板属性：原生选择、真实手机预览、确认保存及保留未选后改的撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(180000); page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 12000 }), client = new Client({ name: 'asset-ranges-ui', version: '1' });
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api(control, '/api/ai/provider'), home = original.state.pages.find(item => item.slug === '/')!, product = original.state.products[1];
  let seeded = false, tokenId = '', failure: unknown; const siteIds: string[] = [], detailIds: string[] = [];
  for (const path of ['/api/ai/site-designs/select', '/api/ai/site-designs/apply', '/api/ai/site-designs/undo', '/api/ai/detail-designs/select', '/api/ai/detail-designs/apply', '/api/ai/detail-designs/undo']) ui.allowWrite('POST', path);
  ui.allowWrite('PATCH', '/api/studio');
  try {
    const template: PageTemplate = { id: 'ui-asset-template', name: 'Asset property product template', kind: 'product', description: '', updated: '', detailRule: { enabled: true, priority: 999, recordIds: [product.id], ...(product.modelId ? { modelId: product.modelId } : {}) }, data: detailData() };
    const seededState = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, [home.id]: withEditorRootDefaults({ root: { props: {} }, content: [{ type: 'Heading', props: { id: 'asset-home', text: 'Supplied homepage', level: 'h1' } }] }) }, sharedBlocks: [...(original.state.sharedBlocks || []), { id: 'ui-asset-header', name: 'UI asset header', updated: '', data: headerData() }], siteLayout: { ...(original.state.siteLayout || { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: [] }), header: { ...(original.state.siteLayout?.header || {}), mode: 'block', blockId: 'ui-asset-header' } }, pageTemplates: [...(original.state.pageTemplates || []), template] } }); seeded = true;
    const issued = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI asset reviewer', scopes: ['read', 'propose'], pageIds: null, templateIds: [template.id], recordIds: { productIds: [product.id], entryIds: [] } }); tokenId = issued.credential.id;
    try { await client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${issued.token}`, Connection: 'close' } } })); } catch { throw new Error('Isolated asset MCP connection failed'); }
    const source = await tool<AiSiteDesignPreview & { reviewUrl: string }>(client, 'site_design_propose', { requestId: 'ui-asset-header-source', request: { expectedRevision: seededState.revision, instruction: '调整页眉品牌标题和手机字号，保留真实资料。', preserveText: false, targets: { pageIds: seededState.state.pages.map(item => item.id), header: true, footer: false, navigation: false, style: false } }, proposal: { summary: 'UI header text and mobile styles', warnings: [], operations: [{ kind: 'chrome', slot: 'header', operations: [{ kind: 'text', id: 'asset-brand', text: 'Designed asset brand' }, { kind: 'design', id: 'asset-brand', design: { mobile: { fontSize: 26 } } }] }] } }); siteIds.push(source.designId);
    const text = source.assetUnits!.find(unit => unit.kind === 'property' && unit.group === 'text')!; expect(text).toBeTruthy();
    await page.goto(source.reviewUrl); let dialog = page.getByRole('dialog', { name: 'AI整站设计', exact: true }); await loaded(dialog, 'Supplied asset brand', 'Designed asset brand');
    await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText('细选文字、三端样式与头尾内部', { exact: true }).click(); await toggleFine(dialog, text.label);
    await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled();
    const selectedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/site-designs/select' && response.request().method() === 'POST'); await textButton(dialog, '预览选中修改').click(); const selected = await (await selectedResponse).json() as AiSiteDesignPreview; siteIds.push(selected.designId);
    await loaded(dialog, 'Supplied asset brand', 'Designed asset brand'); await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog); await dialog.locator('.ai-design-preview .ant-segmented-item').filter({ hasText: '手机' }).click();
    const afterFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]'); await expect.poll(() => afterFrame.locator('main').evaluate(() => innerWidth)).toBe(390);
    const frozen = await api<StudioEnvelope>(control, '/api/studio'); expect(frozen.revision).toBe(seededState.revision); await page.setViewportSize({ width: 1600, height: 1000 }); await textButton(dialog, '确认应用到网站草稿').click(); await expect(dialog).toContainText('已保存');
    // 采用与撤销都会重挂真实对比 iframe。等新文档完成加载再离开，保留严格网络检查。
    await loaded(dialog, 'Supplied asset brand', 'Designed asset brand');
    let current = await api<StudioEnvelope>(control, '/api/studio'), blocks = structuredClone(current.state.sharedBlocks!); const blockId = current.state.siteLayout!.header.blockId, block = blocks.find(item => item.id === blockId)!;
    expect(block.data.content[0].props.content[0].props.text).toBe('Designed asset brand'); expect(block.data.content[0].props.content[0].props.design).toBeUndefined();
    block.data.content[0].props.content[0].props.design = { desktop: { color: '#335577' } }; block.data.content[0].props.content[1].props.text = 'Later manual header note';
    await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { sharedBlocks: blocks } });
    const undoReview = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: selected.designId, action: 'undo' }); await page.goto(undoReview.reviewUrl); dialog = page.getByRole('dialog', { name: 'AI整站设计', exact: true }); await loaded(dialog, 'Supplied asset brand', 'Designed asset brand');
    await textButton(dialog, '撤销本次整站设计').click(); await expect(dialog).toContainText('已撤销本次整站设计');
    await loaded(dialog, 'Supplied asset brand', 'Designed asset brand');
    current = await api<StudioEnvelope>(control, '/api/studio'); const restoredHeader = current.state.sharedBlocks!.find(item => item.id === blockId)!;
    expect(restoredHeader.data.content[0].props.content[0].props.text).toBe('Supplied asset brand'); expect(restoredHeader.data.content[0].props.content[0].props.design).toEqual({ desktop: { color: '#335577' } }); expect(restoredHeader.data.content[0].props.content[1].props.text).toBe('Later manual header note');
    const detail = await tool<AiDetailDesignPreview & { reviewUrl: string }>(client, 'site_template_propose', { requestId: 'ui-asset-detail-source', request: { expectedRevision: current.revision, templateId: template.id, recordId: product.id, instruction: '改善产品详情电脑和手机的间距，保留所有动态内容。', preserveText: true }, proposal: { summary: 'UI detail desktop and mobile spacing', warnings: [], operations: [{ kind: 'design', id: 'asset-detail', design: { desktop: { paddingTop: 62 }, mobile: { paddingTop: 18 } } }] } }); detailIds.push(detail.designId);
    const mobile = detail.selectionUnits!.find(unit => unit.kind === 'property' && unit.viewport === 'mobile')!; expect(mobile).toBeTruthy();
    await page.goto(detail.reviewUrl); dialog = page.getByRole('dialog', { name: 'AI详情布局设计', exact: true }); await loaded(dialog, product.name, product.name); await dialog.getByText(/^只采用部分详情修改/).click(); await toggleFine(dialog, mobile.label);
    const detailResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/detail-designs/select' && response.request().method() === 'POST'); await textButton(dialog, '预览选中详情修改').click(); const selectedDetail = await (await detailResponse).json() as AiDetailDesignPreview; detailIds.push(selectedDetail.designId);
    await loaded(dialog, product.name, product.name); await dialog.locator('.ai-design-preview .ant-segmented-item').filter({ hasText: '手机' }).click();
    const mobileFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]'); await expect.poll(() => mobileFrame.locator('main').evaluate(() => innerWidth)).toBe(390); await expect(mobileFrame.locator('[data-site-node-id="asset-detail"]')).toHaveCSS('padding-top', '18px');
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog); await testInfo.attach('asset-details-mobile-preview', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 });
    await textButton(dialog, '确认保存为模板草稿').click(); await expect(dialog).toContainText('已保存为详情模板草稿'); current = await api<StudioEnvelope>(control, '/api/studio'); const templates = structuredClone(current.state.pageTemplates!), active = templates.find(item => item.id === template.id)!;
    expect(active.data.content[0].props.design).toEqual({ mobile: { paddingTop: 18 } }); active.data.content[0].props.design.desktop = { color: '#335577' }; active.data.content[0].props.content[1].props.text = 'Later manual product support';
    await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { pageTemplates: templates } }); await textButton(dialog, '读取最新状态').click(); await expect(textButton(dialog, '撤销本次修改')).toBeEnabled(); await textButton(dialog, '撤销本次修改').click(); await expect(dialog).toContainText('已撤销本次详情布局修改');
    const undone = await api<StudioEnvelope>(control, '/api/studio'), restored = undone.state.pageTemplates!.find(item => item.id === template.id)!;
    expect(restored.data.content[0].props.design).toEqual({ desktop: { color: '#335577' } }); expect(restored.data.content[0].props.content[1].props.text).toBe('Later manual product support'); expect(restored.data.content[0].props.content[0].props.bindings.text.source).toBe('product'); expect(undone.state.products).toEqual(original.state.products); expect(undone.activeReleaseId).toBe(original.activeReleaseId); expect(await api(control, '/api/ai/provider')).toEqual(provider);
  } catch (cause) { failure = cause; throw cause; }
  finally {
    const errors: string[] = []; try { await ui.closeOwnedPage(); } catch { errors.push('close-page'); } try { await client.close(); } catch { errors.push('close-client'); }
    for (const id of siteIds.reverse()) try { await api(control, `/api/ai/site-designs/${id}`, 'DELETE'); } catch { errors.push('delete-site-candidate'); }
    for (const id of detailIds.reverse()) try { await api(control, `/api/ai/detail-designs/${id}`, 'DELETE'); } catch { errors.push('delete-detail-candidate'); }
    if (tokenId) try { await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); } catch { errors.push('revoke-token'); }
    if (seeded) try { const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { editorData: original.state.editorData, sharedBlocks: original.state.sharedBlocks || [], siteLayout: original.state.siteLayout || { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: [] }, pageTemplates: original.state.pageTemplates || [] } }); } catch { errors.push('restore-state'); }
    await testInfo.attach('asset-details-cleanup', { body: Buffer.from(JSON.stringify({ errors, actualPreview: true, noRealModel: true, primaryFailurePreserved: !!failure })), contentType: 'application/json' }); await control.dispose(); if (!failure && errors.length) throw new Error(`Isolated asset cleanup failed: ${errors.join(',')}`);
  }
});
