import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiSiteDesignPreview, AiSiteDesignRequest, AiSiteDesignSectionUnit } from '../../src/lib/ai-site-design-types';
import { withEditorRootDefaults } from '../../src/lib/editor-root-defaults';

const heroId = 'ui-section-hero', productsId = 'ui-section-products', contactId = 'ui-section-contact';
const originalHeading = 'Original section selection home', changedHeading = 'Changed section selection home';
const originalContact = 'ORIGINAL_SECTION_CONTACT', changedContact = 'CHANGED_SECTION_CONTACT';
const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'AI整站设计', exact: true });
const quote = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
type ContextNode = { id: string; type: string; productCardRef?: number };
type DesignContext = { request: AiSiteDesignRequest; context: { pages: { pageId: string; nodes: ContextNode[] }[]; productCards: { nodes: ContextNode[] }[] } };

/** 控制通道只操作包装器的合成实例；认证信息与SDK原始错误不写入测试报告。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  const origin = new URL(runtime.origin); expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Only isolated API paths are allowed');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated API ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}
async function sdk<T>(label: string, work: () => Promise<T>): Promise<T> { try { return await work(); } catch { throw new Error(`Isolated MCP ${label} failed`); } }
async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await sdk(name, () => client.callTool({ name, arguments: args })); expect(result.isError, `${name} should succeed`).not.toBe(true);
  return (result.structuredContent || JSON.parse((result.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text)) as T;
}
function homeData(): Data {
  return withEditorRootDefaults({ root: { props: { title: 'UI 区块选择首页', brand: '', showChrome: 'no' } }, zones: {}, content: [
    { type: 'Container', props: { id: heroId, nodeLabel: '首页首屏', layout: 'column', columns: 1, mobileColumns: 1, gap: 24, padding: 32, inset: 24, background: '#ffffff', image: '', minHeight: 0, align: 'start', content: [
      { type: 'Heading', props: { id: 'ui-section-heading', text: originalHeading, level: 'h1', size: 40, mobileSize: 28, align: 'left', style: 'sans', spacing: 0 } },
      { type: 'Text', props: { id: 'ui-section-copy', text: 'Synthetic supplied company information for section selection.', size: 16, align: 'left', maxWidth: 680 } },
    ] } },
    { type: 'ProductList', props: { id: productsId, nodeLabel: '产品展示区', eyebrow: 'SYNTHETIC PRODUCTS', title: 'Current supplied products', description: '', category: '', columns: 3, mobileColumns: 1, count: 3, padding: 32, background: 'transparent' } },
    { type: 'Container', props: { id: contactId, nodeLabel: '联系区块', layout: 'column', columns: 1, mobileColumns: 1, gap: 24, padding: 32, inset: 24, background: '#ffffff', image: '', minHeight: 0, align: 'start', content: [
      { type: 'Text', props: { id: 'ui-section-contact-copy', text: originalContact, size: 16, align: 'left', maxWidth: 680 } },
    ] } },
  ] } as Data);
}

test('首页只采用产品区块：真实预览、选择恢复、手机排版、拖拽编辑和撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(150000); page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  const client = new Client({ name: 'section-selection-ui', version: '1' });
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<{ enabled: boolean; hasApiKey: boolean }>(control, '/api/ai/provider');
  const home = original.state.pages.find(item => item.slug === '/')!; expect(home).toBeTruthy(); expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
  let seeded = false, tokenId = '', bodyFailure: unknown; const candidates: string[] = [];
  for (const [method, path] of [['POST', '/api/ai/site-designs/select'], ['POST', '/api/ai/site-designs/apply'], ['POST', '/api/ai/site-designs/undo'], ['PATCH', '/api/studio']] as const) ui.allowWrite(method, path);
  try {
    const baseline = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, [home.id]: homeData() } } }); seeded = true;
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI section selection designer', scopes: ['read', 'propose'], pageIds: null }); tokenId = credential.credential.id;
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const input: AiSiteDesignRequest = { expectedRevision: baseline.revision, instruction: '分别优化首页首屏、产品动态卡片和联系区块，让用户只采用满意的产品区块。', targets: { pageIds: [home.id], header: false, footer: false, navigation: false, style: false }, preserveText: false };
    const prepared = await tool<DesignContext>(client, 'site_design_context', input as unknown as Record<string, unknown>);
    const product = prepared.context.pages.find(item => item.pageId === home.id)!.nodes.find(item => item.id === productsId)!; expect(typeof product.productCardRef).toBe('number');
    const cardTitle = prepared.context.productCards[product.productCardRef!].nodes.find(item => item.type === 'Heading')!; expect(cardTitle).toBeTruthy();
    const source = await tool<AiSiteDesignPreview>(client, 'site_design_propose', { requestId: 'ui-section-source', request: prepared.request, proposal: { summary: '分别重设计首页三个独立区块，供用户挑选满意的部分。', warnings: [], operations: [{ kind: 'page', pageId: home.id, operations: [
      { kind: 'text', id: 'ui-section-heading', text: changedHeading },
      { kind: 'productCard', id: productsId, operations: [{ kind: 'design', id: cardTitle.id, design: { desktop: { fontSize: 31 }, mobile: { fontSize: 24 } } }] },
      { kind: 'text', id: 'ui-section-contact-copy', text: changedContact },
    ] }] } }); candidates.push(source.designId);
    const parent = source.selectionUnits.find(item => item.id === `page:${home.id}`)!; expect(parent).toBeTruthy();
    const sections = source.sectionUnits || [];
    const unitFor = (id: string): AiSiteDesignSectionUnit => { const unit = sections.find(item => item.parentId === parent.id && item.nodeIds.includes(id)); expect(unit, `应能独立选择${id}`).toBeTruthy(); return unit!; };
    const heroUnit = unitFor(heroId), productUnit = unitFor(productsId), contactUnit = unitFor(contactId);
    expect(new Set([heroUnit.id, productUnit.id, contactUnit.id]).size).toBe(3); expect(sections.filter(item => item.parentId === parent.id)).toHaveLength(3);
    const review = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: source.designId, action: 'apply' });
    await page.goto(review.reviewUrl); let dialog = dialogOf(page); await expect(dialog).toBeVisible();
    let afterFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(afterFrame.getByRole('heading', { name: changedHeading, exact: true })).toBeVisible(); await expect(afterFrame.getByText(changedContact, { exact: true })).toBeVisible();
    await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText(/^挑选页面内区块/).click();
    const whole = () => dialog.locator('.ai-site-design-selection-range > .ant-checkbox-wrapper').filter({ hasText: parent.label }).getByRole('checkbox');
    const section = (unit: AiSiteDesignSectionUnit) => dialog.locator('.ai-site-design-section-choices').getByRole('checkbox', { name: new RegExp(`^${quote(unit.label)}`) });
    await expect(whole()).toBeChecked(); await expect(section(heroUnit)).toBeChecked(); await expect(section(productUnit)).toBeChecked(); await expect(section(contactUnit)).toBeChecked();
    // 区块选满仍保留精度；整页须明确勾选，避免扩大到没有AI变化却后来手改的其他区块。
    await section(heroUnit).uncheck(); await expect(whole()).not.toBeChecked(); await expect(whole()).toHaveJSProperty('indeterminate', true); await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled();
    await section(heroUnit).check(); await expect(whole()).not.toBeChecked(); await expect(whole()).toHaveJSProperty('indeterminate', true); await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled(); await expect(textButton(dialog, '预览选中修改')).toBeEnabled();
    await section(heroUnit).uncheck(); await section(contactUnit).uncheck(); await expect(section(productUnit)).toBeChecked(); await expect(whole()).toHaveJSProperty('indeterminate', true);
    await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled(); await expect(dialog.getByText('采用范围已改变，当前仍显示上一版预览', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog);
    await testInfo.attach('sections-mobile-choices', { body: await dialog.locator('.ai-site-design-selection').screenshot({ animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 });
    // 按真实关闭保护保留后刷新，验证服务器区块ID与选中语义可恢复，不能只测组件内存。
    await textButton(dialog, '返回后台').click(); const guard = page.getByRole('dialog', { name: '未保存 · AI整站设计要求', exact: true }); await textButton(guard, '保留输入并离开').click();
    await expect(dialog).not.toBeVisible(); await page.reload(); dialog = dialogOf(page); await expect(dialog).toBeVisible(); await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText(/^挑选页面内区块/).click();
    await expect(section(heroUnit)).not.toBeChecked(); await expect(section(productUnit)).toBeChecked(); await expect(section(contactUnit)).not.toBeChecked(); await expect(whole()).toHaveJSProperty('indeterminate', true);
    const selectedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/site-designs/select' && response.request().method() === 'POST');
    await textButton(dialog, '预览选中修改').click(); const selectedHttp = await selectedResponse; expect(selectedHttp.status()).toBe(201); expect(selectedHttp.request().postDataJSON().unitIds).toEqual([productUnit.id]);
    const selected = await selectedHttp.json() as AiSiteDesignPreview; candidates.push(selected.designId); expect(selected.designId).not.toBe(source.designId); expect(selected.selection).toEqual({ sourceDesignId: source.designId, unitIds: [productUnit.id] });
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(baseline.revision); await expect(dialog.getByText('当前预览只包含已选择的修改', { exact: true })).toBeVisible();
    afterFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    const beforeFrame = dialog.frameLocator('iframe[title="修改前"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(beforeFrame.getByRole('heading', { name: originalHeading, exact: true })).toBeVisible(); await expect(afterFrame.getByRole('heading', { name: originalHeading, exact: true })).toBeVisible();
    await expect(afterFrame.getByText(originalContact, { exact: true })).toBeVisible(); await expect(afterFrame.getByText(changedHeading, { exact: true })).toHaveCount(0); await expect(afterFrame.getByText(changedContact, { exact: true })).toHaveCount(0);
    await expect(afterFrame.getByText(runtime.fixture.longName, { exact: true }).first()).toBeVisible(); await expect(afterFrame.locator('[data-shared-block-id]').first()).toBeVisible();
    await testInfo.attach('sections-selected-real-preview', { body: await dialog.locator('iframe[title="AI建议"]').screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog); await testInfo.attach('sections-mobile-real-preview', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 });
    await textButton(dialog, '确认应用到网站草稿').click(); await expect(dialog).toContainText('已应用到网站草稿');
    const applied = await api<StudioEnvelope>(control, '/api/studio'), appliedData = applied.state.editorData[home.id] as Data, baselineData = baseline.state.editorData[home.id] as Data;
    expect(appliedData.content[0]).toEqual(baselineData.content[0]); expect(appliedData.content[2]).toEqual(baselineData.content[2]); expect(appliedData.content[1].type).toBe('ContentLoop');
    const cardId = appliedData.content[1].props.itemBlockId as string, card = applied.state.sharedBlocks!.find(item => item.id === cardId)!; expect(card).toBeTruthy(); expect(JSON.stringify(card.data)).toContain('31');
    expect(applied.state.products).toEqual(baseline.state.products); expect(applied.state.theme).toEqual(baseline.state.theme); expect(applied.state.siteLayout).toEqual(baseline.state.siteLayout); expect(applied.activeReleaseId).toBe(baseline.activeReleaseId);
    await textButton(dialog, '返回后台').click(); await expect(dialog).not.toBeVisible(); await page.goto('/admin#pages'); await expect(page.getByRole('heading', { name: /^网站页面/ })).toBeVisible();
    await page.getByRole('button', { name: `编辑${home.title}`, exact: true }).click(); await expect(page.locator('.editor-screen')).toBeVisible();
    await page.locator('.editor-left-panel').getByRole('tab', { name: /图层/ }).click(); await page.getByRole('treeitem').filter({ hasText: '产品展示区' }).click(); await page.getByRole('button', { name: '编辑卡片设计', exact: true }).click();
    await expect(page.locator('.editor-topbar')).toContainText('循环卡片'); await page.getByRole('button', { name: '返回来源页面', exact: true }).click(); await expect(page.locator('.editor-topbar')).not.toContainText('循环卡片');
    await page.getByRole('button', { name: '返回页面管理', exact: true }).click(); await expect(page.getByRole('heading', { name: /^网站页面/ })).toBeVisible();
    const afterEditor = await api<StudioEnvelope>(control, '/api/studio'); expect(afterEditor.state.editorData[home.id]).toEqual(appliedData); expect(afterEditor.state.sharedBlocks?.find(item => item.id === cardId)?.data).toEqual(card.data);
    const undoReview = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: selected.designId, action: 'undo' }); await page.goto(undoReview.reviewUrl); dialog = dialogOf(page); await expect(dialog).toBeVisible();
    await textButton(dialog, '撤销本次整站设计').click(); await expect(dialog).toContainText('已撤销本次整站设计');
    const undone = await api<StudioEnvelope>(control, '/api/studio'); expect(undone.state.editorData).toEqual(baseline.state.editorData); expect(undone.state.sharedBlocks || []).toEqual(baseline.state.sharedBlocks || []); expect(undone.activeReleaseId).toBe(baseline.activeReleaseId);
    expect((await tool<{ status: string }>(client, 'site_design_status', { designId: source.designId })).status).toBe('pending'); expect((await tool<{ status: string }>(client, 'site_design_status', { designId: selected.designId })).status).toBe('undone');
    expect(await api(control, '/api/ai/provider')).toEqual(provider); expect(ui.writes.filter(item => item.path === '/api/ai/site-designs')).toHaveLength(0); expect(ui.writes.filter(item => item.path === '/api/ai/site-designs/select')).toHaveLength(1);
  } catch (cause) {
    bodyFailure = cause; try { await testInfo.attach('sections-primary-failure-screen', { body: await page.screenshot({ animations: 'disabled', timeout: 3000 }), contentType: 'image/png' }); } catch { /* 截图失败仍保留原异常。 */ } throw cause;
  } finally {
    const errors: string[] = [];
    try { await ui.closeOwnedPage(); } catch { errors.push('close-owned-page'); }
    try { await sdk('close', () => client.close()); } catch { errors.push('close-client'); }
    for (const id of candidates.reverse()) try { await api(control, `/api/ai/site-designs/${id}`, 'DELETE'); } catch { errors.push('delete-candidate'); }
    if (tokenId) try { await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); } catch { errors.push('revoke-token'); }
    if (seeded) try { const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, sharedBlocks: original.state.sharedBlocks || [] } }); } catch { errors.push('restore-isolated-state'); }
    await testInfo.attach('sections-cleanup', { body: Buffer.from(JSON.stringify({ errors, usedIndependentApiContext: true, primaryFailurePreserved: !!bodyFailure })), contentType: 'application/json' }); await control.dispose();
    if (!bodyFailure && errors.length) throw new Error(`Isolated section cleanup failed: ${errors.join(',')}`);
  }
});

test('整块选满保持区块精度：单个变化区块保留同页未变化区块手改', async ({ page, ui }, testInfo) => {
  test.setTimeout(120000); page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  const client = new Client({ name: 'section-precision-review-ui', version: '1' });
  const original = await api<StudioEnvelope>(control, '/api/studio'), home = original.state.pages.find(item => item.slug === '/')!;
  let seeded = false, tokenId = '', bodyFailure: unknown; const candidates: string[] = [], manualCopy = 'MANUAL_UNCHANGED_SECTION_KEEP';
  for (const [method, path] of [['POST', '/api/ai/site-designs/select'], ['POST', '/api/ai/site-designs/apply'], ['POST', '/api/ai/site-designs/undo']] as const) ui.allowWrite(method, path);
  try {
    const baseline = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, [home.id]: homeData() } } }); seeded = true;
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI precise whole section', scopes: ['read', 'propose'], pageIds: [home.id] }); tokenId = credential.credential.id;
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const request: AiSiteDesignRequest = { expectedRevision: baseline.revision, instruction: '只调整首页首屏整体留白，其他区块保持。', targets: { pageIds: [home.id], header: false, footer: false, navigation: false, style: false }, preserveText: true };
    const source = await tool<AiSiteDesignPreview>(client, 'site_design_propose', { requestId: 'ui-precise-whole-section-source', request, proposal: { summary: '只调整首屏共同留白。', warnings: [], operations: [{ kind: 'page', pageId: home.id, operations: [{ kind: 'design', id: heroId, design: { desktop: { paddingTop: 52 } } }] }] } }); candidates.push(source.designId);
    expect(source.sectionUnits).toHaveLength(1); expect(source.detailUnits || []).toHaveLength(0); const unit = source.sectionUnits![0]; expect(unit.nodeIds).toEqual([heroId]);
    const manual = structuredClone(baseline.state.editorData[home.id]) as Data; manual.content[2].props.content[0].props.text = manualCopy;
    const manualState = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: baseline.revision, patch: { editorData: { ...baseline.state.editorData, [home.id]: manual } } });
    const link = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: source.designId, action: 'apply' }); await page.goto(link.reviewUrl); let dialog = dialogOf(page); await expect(dialog).toBeVisible();
    const loaded = async () => { for (const title of ['修改前', 'AI建议']) { const outer = dialog.frameLocator(`iframe[title="${title}"]`); await expect(outer.frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: originalHeading, exact: true })).toBeVisible(); await expect.poll(() => outer.locator('html').evaluate(element => element.ownerDocument.readyState)).toBe('complete'); } };
    await loaded(); await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText(/^挑选页面内区块/).click();
    const whole = () => dialog.locator('.ai-site-design-selection-range > .ant-checkbox-wrapper').getByRole('checkbox');
    const block = () => dialog.locator('.ai-site-design-section-range > .ant-checkbox-wrapper').getByRole('checkbox');
    await expect(whole()).toBeChecked(); await expect(block()).toBeChecked(); await block().uncheck(); await block().check();
    await expect(whole()).not.toBeChecked(); await expect(whole()).toHaveJSProperty('indeterminate', true); await expect(block()).toBeChecked();
    await expect(textButton(dialog, '预览选中修改')).toBeEnabled(); await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled();
    await textButton(dialog, '返回后台').click(); const guard = page.getByRole('dialog', { name: '未保存 · AI整站设计要求', exact: true }); await textButton(guard, '保留输入并离开').click(); await expect(dialog).not.toBeVisible(); await page.reload(); dialog = dialogOf(page); await expect(dialog).toBeVisible(); await loaded();
    await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText(/^挑选页面内区块/).click(); await expect(whole()).not.toBeChecked(); await expect(whole()).toHaveJSProperty('indeterminate', true); await expect(block()).toBeChecked();
    // 真实POST必须保留section身份；若被提升成page，将因未变化联系区的人工编辑触发整页409。
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/site-designs/select' && response.request().method() === 'POST'); await textButton(dialog, '预览选中修改').click(); const response = await pending; expect(response.status()).toBe(201); expect(response.request().postDataJSON().unitIds).toEqual([unit.id]);
    const selected = await response.json() as AiSiteDesignPreview; candidates.push(selected.designId); expect(selected.selection).toEqual({ sourceDesignId: source.designId, unitIds: [unit.id] }); await loaded();
    const preview = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]'); await expect(preview.getByText(manualCopy, { exact: true })).toBeVisible();
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(manualState.revision);
    await textButton(dialog, '确认应用到网站草稿').click(); await expect(dialog).toContainText('已应用到网站草稿');
    const applied = await api<StudioEnvelope>(control, '/api/studio'), appliedData = applied.state.editorData[home.id] as Data; expect(appliedData.content[0].props.design.desktop.paddingTop).toBe(52); expect(appliedData.content[1]).toEqual(manual.content[1]); expect(appliedData.content[2]).toEqual(manual.content[2]); expect(applied.activeReleaseId).toBe(manualState.activeReleaseId);
    await textButton(dialog, '撤销本次整站设计').click(); await expect(dialog).toContainText('已撤销本次整站设计'); const undone = await api<StudioEnvelope>(control, '/api/studio'); expect(undone.state.editorData).toEqual(manualState.state.editorData); expect(undone.activeReleaseId).toBe(manualState.activeReleaseId);
    expect(ui.writes.filter(item => item.path === '/api/ai/site-designs/select')).toHaveLength(1); expect((await tool<{ status: string }>(client, 'site_design_status', { designId: source.designId })).status).toBe('pending');
  } catch (cause) { bodyFailure = cause; throw cause; }
  finally {
    const errors: string[] = [];
    try { await ui.closeOwnedPage(); } catch { errors.push('close-owned-page'); }
    try { await sdk('close', () => client.close()); } catch { errors.push('close-client'); }
    for (const id of candidates.reverse()) try { await api(control, `/api/ai/site-designs/${id}`, 'DELETE'); } catch { errors.push('delete-candidate'); }
    if (tokenId) try { await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); } catch { errors.push('revoke-token'); }
    if (seeded) try { const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, sharedBlocks: original.state.sharedBlocks || [] } }); } catch { errors.push('restore-isolated-state'); }
    await testInfo.attach('precise-whole-section-cleanup', { body: Buffer.from(JSON.stringify({ errors, primaryFailurePreserved: !!bodyFailure })), contentType: 'application/json' }); await control.dispose(); if (!bodyFailure && errors.length) throw new Error(`Isolated precision cleanup failed: ${errors.join(',')}`);
  }
});

test('首页结构组挑选：独立新增删除、关联重排、恢复预览、原生往返和撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(150000); page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  const client = new Client({ name: 'structural-selection-ui', version: '1' });
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<{ enabled: boolean; hasApiKey: boolean }>(control, '/api/ai/provider');
  const home = original.state.pages.find(item => item.slug === '/')!; expect(home).toBeTruthy(); expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
  const ids = { hero: 'ui-structure-hero', old: 'ui-structure-old-inquiry', factory: 'ui-structure-factory', products: 'ui-structure-products', process: 'ui-structure-process', cases: 'ui-structure-cases', service: 'ui-structure-service', contact: 'ui-structure-contact' };
  const beforeTitle = 'Supplied structural selection homepage', afterTitle = 'Unselected AI homepage wording', addedTitle = 'Supplied company documents';
  const beforeHeadings = ['Previous inquiry introduction', 'Factory capabilities', 'Product collections', 'Manufacturing process', 'Application cases', 'Project service', 'Contact our team'];
  const afterHeadings = ['Factory capabilities', 'Application cases', 'Project service', 'Product collections', 'Manufacturing process', 'Contact our team', addedTitle];
  // 新增和删除分处稳定锚点两侧；成对重排另外形成依赖组，独立首屏文案保留为未选修改。
  const section = (id: string, title: string, level = 'h2') => ({ type: 'Container', props: { id, nodeLabel: title, layout: 'column', columns: 1, mobileColumns: 1, gap: 16, padding: 24, inset: 24, background: '#ffffff', image: '', minHeight: 0, align: 'start', content: [
    { type: 'Heading', props: { id: `${id}-heading`, text: title, level, size: level === 'h1' ? 40 : 28, mobileSize: level === 'h1' ? 28 : 22, align: 'left', style: 'sans', spacing: 0 } },
    { type: 'Text', props: { id: `${id}-copy`, text: `Synthetic supplied content: ${title}.`, size: 16, align: 'left', maxWidth: 680 } },
  ] } });
  const sample = withEditorRootDefaults({ root: { props: { title: 'UI 结构挑选首页', brand: '', showChrome: 'no' } }, zones: {}, content: [section(ids.hero, beforeTitle, 'h1'), section(ids.old, beforeHeadings[0]), section(ids.factory, beforeHeadings[1]), section(ids.products, beforeHeadings[2]), section(ids.process, beforeHeadings[3]), section(ids.cases, beforeHeadings[4]), section(ids.service, beforeHeadings[5]), section(ids.contact, beforeHeadings[6])] } as Data);
  // 真正完成预览文档再离开，防止测试自己的导航取消仍在加载的Next脚本；网络审计保持严格。
  async function loadedComparison(dialog: Locator, afterHeading: string) {
    for (const [side, heading] of [['修改前', beforeTitle], ['AI建议', afterHeading]]) {
      const frame = dialog.frameLocator(`iframe[title="${side}"]`);
      await expect(frame.frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await expect.poll(() => frame.locator('html').evaluate(element => element.ownerDocument.readyState)).toBe('complete');
    }
  }
  let seeded = false, tokenId = '', bodyFailure: unknown; const candidates: string[] = [];
  for (const [method, path] of [['POST', '/api/ai/site-designs/select'], ['POST', '/api/ai/site-designs/apply'], ['POST', '/api/ai/site-designs/undo'], ['PATCH', '/api/studio']] as const) ui.allowWrite(method, path);
  try {
    const baseline = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, [home.id]: sample } } }); seeded = true;
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI structural section designer', scopes: ['read', 'propose'], pageIds: [home.id] }); tokenId = credential.credential.id;
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const request: AiSiteDesignRequest = { expectedRevision: baseline.revision, instruction: '新增公司资料入口，移除旧询价介绍，把应用案例与工程服务放到产品系列前；另外提供一版首屏文案，让用户分别挑选。', targets: { pageIds: [home.id], header: false, footer: false, navigation: false, style: false }, preserveText: false };
    const prepared = await tool<DesignContext>(client, 'site_design_context', request as unknown as Record<string, unknown>);
    const source = await tool<AiSiteDesignPreview>(client, 'site_design_propose', { requestId: 'ui-structural-section-source', request: prepared.request, proposal: { summary: '分别提供新增、删除和关联重排，首屏文字可独立保留原稿。', warnings: [], operations: [{ kind: 'page', pageId: home.id, operations: [
      { kind: 'text', id: `${ids.hero}-heading`, text: afterTitle },
      { kind: 'remove', id: ids.old },
      { kind: 'move', id: ids.cases, parentId: '$page', index: 2 },
      { kind: 'move', id: ids.service, parentId: '$page', index: 3 },
      { kind: 'insert', parentId: '$page', index: 7, node: { tempId: 'new-company-documents', type: 'Heading', level: 'h2', text: addedTitle, design: { desktop: { fontSize: 28, paddingTop: 24, paddingBottom: 24 }, mobile: { fontSize: 22 } } } },
    ] }] } }); candidates.push(source.designId);
    const parent = source.selectionUnits.find(item => item.id === `page:${home.id}`)!; expect(parent).toBeTruthy(); expect(parent.sectionSelectionUnavailableReason).toBeUndefined();
    const units = (source.sectionUnits || []).filter(item => item.parentId === parent.id), originalIds = new Set(Object.values(ids));
    const removed = units.find(item => item.nodeIds.includes(ids.old))!, added = units.find(item => item.nodeIds.every(id => !originalIds.has(id)))!, copy = units.find(item => item.nodeIds.includes(ids.hero))!;
    const moved = units.find(item => item.nodeIds.length > 1 && item.nodeIds.every(id => [ids.products, ids.process, ids.cases, ids.service].includes(id)))!;
    expect(units).toHaveLength(4); expect(removed).toBeTruthy(); expect(added).toBeTruthy(); expect(copy).toBeTruthy(); expect(moved).toBeTruthy(); expect(moved.nodeIds).toHaveLength(2);
    expect(removed.nodeIds).toEqual([ids.old]); expect(added.nodeIds).toHaveLength(1); expect(copy.nodeIds).toEqual([ids.hero]);
    for (const unit of [removed, added, moved]) expect(unit.id).toMatch(/^section:g1:[a-f0-9]{32}$/);
    expect(`${removed.label} ${removed.description}`).toMatch(/删除|移除/); expect(`${added.label} ${added.description}`).toMatch(/新增/); expect(`${moved.label} ${moved.description}`).toMatch(/移动|重排|顺序|关联/);
    const chosenIds = [removed.id, added.id, moved.id], addedId = added.nodeIds[0];
    const review = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: source.designId, action: 'apply' }); await page.goto(review.reviewUrl); let dialog = dialogOf(page); await expect(dialog).toBeVisible(); await loadedComparison(dialog, afterTitle);
    let afterFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(afterFrame.locator('h2')).toHaveText(afterHeadings); await expect(afterFrame.getByRole('heading', { name: beforeHeadings[0], exact: true })).toHaveCount(0);
    await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText(/^挑选页面内区块/).click();
    const unitCheckbox = (unit: AiSiteDesignSectionUnit) => dialog.locator('.ai-site-design-section-choices').getByRole('checkbox', { name: new RegExp(`^${quote(unit.label)}`) });
    await unitCheckbox(copy).uncheck(); await expect(unitCheckbox(removed)).toBeChecked(); await expect(unitCheckbox(added)).toBeChecked(); await expect(unitCheckbox(moved)).toBeChecked();
    await expect(dialog.locator('.ai-site-design-section-choices').getByRole('checkbox')).toHaveCount(4); await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog); await testInfo.attach('structural-groups-mobile-choices', { body: await dialog.locator('.ai-site-design-selection').screenshot({ animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 }); await loadedComparison(dialog, afterTitle);
    await textButton(dialog, '返回后台').click(); const guard = page.getByRole('dialog', { name: '未保存 · AI整站设计要求', exact: true }); await textButton(guard, '保留输入并离开').click(); await expect(dialog).not.toBeVisible(); await page.reload(); dialog = dialogOf(page); await expect(dialog).toBeVisible();
    await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText(/^挑选页面内区块/).click(); await expect(unitCheckbox(copy)).not.toBeChecked(); for (const unit of [removed, added, moved]) await expect(unitCheckbox(unit)).toBeChecked();
    const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/ai/site-designs/select' && item.request().method() === 'POST'); await textButton(dialog, '预览选中修改').click(); const selectedHttp = await response; expect(selectedHttp.status()).toBe(201); expect([...selectedHttp.request().postDataJSON().unitIds].sort()).toEqual([...chosenIds].sort());
    const selected = await selectedHttp.json() as AiSiteDesignPreview; candidates.push(selected.designId); expect(selected.selection?.sourceDesignId).toBe(source.designId); expect([...(selected.selection?.unitIds || [])].sort()).toEqual([...chosenIds].sort()); expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(baseline.revision);
    await loadedComparison(dialog, beforeTitle); afterFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(afterFrame.locator('h2')).toHaveText(afterHeadings); await expect(afterFrame.getByRole('heading', { name: afterTitle, exact: true })).toHaveCount(0); await expect(afterFrame.getByRole('heading', { name: beforeHeadings[0], exact: true })).toHaveCount(0); await expect(afterFrame.getByRole('heading', { name: addedTitle, exact: true })).toHaveCount(1);
    const beforeFrame = dialog.frameLocator('iframe[title="修改前"]').frameLocator('iframe[title="网站草稿隔离预览"]'); await expect(beforeFrame.locator('h2')).toHaveText(beforeHeadings);
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog); await expect(afterFrame.getByRole('heading', { name: addedTitle, exact: true })).toBeVisible(); await testInfo.attach('structural-groups-mobile-real-preview', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 }); await loadedComparison(dialog, beforeTitle);
    await textButton(dialog, '确认应用到网站草稿').click(); await expect(dialog).toContainText('已应用到网站草稿');
    const applied = await api<StudioEnvelope>(control, '/api/studio'), data = applied.state.editorData[home.id] as Data;
    expect(data.content.map(item => item.props.id)).toEqual([ids.hero, ids.factory, ids.cases, ids.service, ids.products, ids.process, ids.contact, addedId]); expect(data.content[0]).toEqual(sample.content[0]);
    expect(applied.state.products).toEqual(baseline.state.products); expect(applied.state.sharedBlocks || []).toEqual(baseline.state.sharedBlocks || []); expect(applied.state.siteLayout).toEqual(baseline.state.siteLayout); expect(applied.state.theme).toEqual(baseline.state.theme); expect(applied.activeReleaseId).toBe(baseline.activeReleaseId);
    await textButton(dialog, '返回后台').click(); await expect(dialog).not.toBeVisible(); await page.goto('/admin#pages'); await expect(page.getByRole('heading', { name: /^网站页面/ })).toBeVisible(); await page.getByRole('button', { name: `编辑${home.title}`, exact: true }).click(); await expect(page.locator('.editor-screen')).toBeVisible();
    const canvas = page.frameLocator('.editor-canvas iframe'); await expect(canvas.locator('h1').filter({ hasText: beforeTitle })).toBeVisible(); await expect(canvas.locator('h2')).toHaveText(afterHeadings);
    await page.locator('.editor-left-panel').getByRole('tab', { name: /图层/ }).click(); await page.getByRole('treeitem').filter({ hasText: 'Application cases' }).first().click(); await expect(page.locator('.editor-right-panel')).toBeVisible();
    await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await page.getByRole('button', { name: '返回页面管理', exact: true }).click(); await expect(page.getByRole('heading', { name: /^网站页面/ })).toBeVisible(); expect((await api<StudioEnvelope>(control, '/api/studio')).state.editorData[home.id]).toEqual(data);
    const undoReview = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: selected.designId, action: 'undo' }); await page.goto(undoReview.reviewUrl); dialog = dialogOf(page); await expect(dialog).toBeVisible(); await loadedComparison(dialog, beforeTitle);
    await textButton(dialog, '撤销本次整站设计').click(); await expect(dialog).toContainText('已撤销本次整站设计'); const undone = await api<StudioEnvelope>(control, '/api/studio'); expect(undone.state.editorData).toEqual(baseline.state.editorData); expect(undone.state.sharedBlocks || []).toEqual(baseline.state.sharedBlocks || []); expect(undone.activeReleaseId).toBe(baseline.activeReleaseId);
    expect((await tool<{ status: string }>(client, 'site_design_status', { designId: source.designId })).status).toBe('pending'); expect((await tool<{ status: string }>(client, 'site_design_status', { designId: selected.designId })).status).toBe('undone'); expect(await api(control, '/api/ai/provider')).toEqual(provider); expect(ui.writes.filter(item => item.path === '/api/ai/site-designs')).toHaveLength(0); expect(ui.writes.filter(item => item.path === '/api/ai/site-designs/select')).toHaveLength(1);
  } catch (cause) {
    bodyFailure = cause; try { await testInfo.attach('structural-groups-primary-failure-screen', { body: await page.screenshot({ animations: 'disabled', timeout: 3000 }), contentType: 'image/png' }); } catch { /* 截图失败仍保留原异常。 */ } throw cause;
  } finally {
    const errors: string[] = [];
    try { await ui.closeOwnedPage(); } catch { errors.push('close-owned-page'); }
    try { await sdk('close', () => client.close()); } catch { errors.push('close-client'); }
    for (const id of candidates.reverse()) try { await api(control, `/api/ai/site-designs/${id}`, 'DELETE'); } catch { errors.push('delete-candidate'); }
    if (tokenId) try { await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); } catch { errors.push('revoke-token'); }
    if (seeded) try { const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, sharedBlocks: original.state.sharedBlocks || [] } }); } catch { errors.push('restore-isolated-state'); }
    await testInfo.attach('structural-groups-cleanup', { body: Buffer.from(JSON.stringify({ errors, usedIndependentApiContext: true, primaryFailurePreserved: !!bodyFailure })), contentType: 'application/json' }); await control.dispose(); if (!bodyFailure && errors.length) throw new Error(`Isolated structural selection cleanup failed: ${errors.join(',')}`);
  }
});
