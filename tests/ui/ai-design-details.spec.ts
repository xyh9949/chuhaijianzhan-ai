import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiSiteDesignDetailUnit, AiSiteDesignPreview, AiSiteDesignRequest } from '../../src/lib/ai-site-design-types';
import { withEditorRootDefaults } from '../../src/lib/editor-root-defaults';

const rootId = 'ui-detail-selection-hero', headingId = 'ui-detail-selection-title', copyId = 'ui-detail-selection-copy', noteId = 'ui-detail-selection-note';
const originalTitle = 'Supplied fine selection homepage', changedTitle = 'AI proposed fine selection homepage';
const originalCopy = 'Original supplied introduction.', changedCopy = 'AI proposed introduction that should remain unselected.';
const originalNote = 'Original supplied contact note.', manualNote = 'Manual sibling edit after the AI proposal.', latestNote = 'Later manual sibling edit after the selected preview.';
const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'AI整站设计', exact: true });
const quote = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 只操作包装器的合成实例；请求和SDK失败只记录有界动作，不输出认证头。 */
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
function sample(): Data {
  return withEditorRootDefaults({ root: { props: { title: 'UI 内部调整首页', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Container', props: { id: rootId, nodeLabel: '公司介绍区', layout: 'column', columns: 1, mobileColumns: 1, gap: 24, padding: 32, inset: 24, background: '#ffffff', image: '', minHeight: 0, align: 'start', content: [
    { type: 'Heading', props: { id: headingId, text: originalTitle, level: 'h1', size: 40, mobileSize: 28, align: 'left', style: 'sans', spacing: 0 } },
    { type: 'Text', props: { id: copyId, text: originalCopy, size: 16, align: 'left', maxWidth: 680 } },
    { type: 'Text', props: { id: noteId, text: originalNote, size: 16, align: 'left', maxWidth: 680 } },
  ] } }] } as Data);
}
/** 摘要先于预览加载；离开前核对两侧真实内容及文档完成，不能取消正在加载的Next脚本。 */
async function loadedComparison(dialog: Locator, designId: string) {
  for (const [side, title, path] of [['修改前', originalTitle, 'before'], ['AI建议', changedTitle, 'after']]) {
    await expect(dialog.locator(`iframe[title="${side}"]`)).toHaveAttribute('src', new RegExp(`^/preview/~site-design/${quote(designId)}/${path}(?:/|$)`));
    const frame = dialog.frameLocator(`iframe[title="${side}"]`);
    await expect(frame.frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect.poll(() => frame.locator('html').evaluate(element => element.ownerDocument.readyState)).toBe('complete');
  }
}

test('区块内部精细选择：全选保精度、单项保留兄弟手改、恢复预览与原生撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(150000); page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  const client = new Client({ name: 'detail-selection-ui', version: '1' });
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<{ enabled: boolean; hasApiKey: boolean }>(control, '/api/ai/provider');
  const home = original.state.pages.find(item => item.slug === '/')!; expect(home).toBeTruthy(); expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
  let seeded = false, tokenId = '', bodyFailure: unknown; const candidates: string[] = [];
  for (const [method, path] of [['POST', '/api/ai/site-designs/select'], ['POST', '/api/ai/site-designs/apply'], ['POST', '/api/ai/site-designs/undo'], ['PATCH', '/api/studio']] as const) ui.allowWrite(method, path);
  try {
    const baseline = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, [home.id]: sample() } } }); seeded = true;
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI fine selection designer', scopes: ['read', 'propose'], pageIds: [home.id] }); tokenId = credential.credential.id;
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const request: AiSiteDesignRequest = { expectedRevision: baseline.revision, instruction: '给公司介绍区提供新的主标题和说明，允许用户只采用满意的内部内容，保留其他真实资料。', targets: { pageIds: [home.id], header: false, footer: false, navigation: false, style: false }, preserveText: false };
    const prepared = await tool<{ request: AiSiteDesignRequest }>(client, 'site_design_context', request as unknown as Record<string, unknown>);
    const source = await tool<AiSiteDesignPreview>(client, 'site_design_propose', { requestId: 'ui-fine-selection-source', request: prepared.request, proposal: { summary: '独立调整公司介绍区的标题和说明，其余内容保持。', warnings: [], operations: [{ kind: 'page', pageId: home.id, operations: [{ kind: 'text', id: headingId, text: changedTitle }, { kind: 'text', id: copyId, text: changedCopy }] }] } }); candidates.push(source.designId);
    const section = source.sectionUnits!.find(item => item.nodeIds.includes(rootId))!; expect(section).toBeTruthy(); expect(section.detailSelectionUnavailableReason).toBeUndefined();
    const details = (source.detailUnits || []).filter(item => item.parentId === section.id); expect(details).toHaveLength(2);
    const titleUnit = details.find(item => item.nodeIds.includes(headingId))!, copyUnit = details.find(item => item.nodeIds.includes(copyId))!; expect(titleUnit).toBeTruthy(); expect(copyUnit).toBeTruthy();
    for (const unit of details) { expect(unit.rootId).toBe(rootId); expect(unit.kind).toBe('detail'); expect(unit.nodeIds).toHaveLength(1); }
    // 在同块未变化兄弟上真实提交人工修改；随后精准选择必须保留它，不能退化成整个根替换。
    const firstManualData = structuredClone(baseline.state.editorData[home.id]) as Data; firstManualData.content[0].props.content[2].props.text = manualNote;
    const firstManual = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: baseline.revision, patch: { editorData: { ...baseline.state.editorData, [home.id]: firstManualData } } });
    const review = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: source.designId, action: 'apply' }); await page.goto(review.reviewUrl); let dialog = dialogOf(page); await expect(dialog).toBeVisible(); await loadedComparison(dialog, source.designId);
    await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText(/^挑选页面内区块/).click(); await dialog.getByText(/^挑选区块内部/).click();
    const whole = () => dialog.locator('.ai-site-design-selection-range > .ant-checkbox-wrapper').getByRole('checkbox');
    const block = () => dialog.locator('.ai-site-design-section-range > .ant-checkbox-wrapper').getByRole('checkbox');
    const fine = (unit: AiSiteDesignDetailUnit) => dialog.locator('.ai-site-design-detail-choices').getByRole('checkbox', { name: new RegExp(`^${quote(unit.label)}`) });
    await expect(whole()).toBeChecked(); await expect(block()).toBeChecked(); await expect(fine(titleUnit)).toBeChecked(); await expect(fine(copyUnit)).toBeChecked();
    await fine(titleUnit).uncheck(); await fine(titleUnit).check();
    await expect(whole()).not.toBeChecked(); await expect(whole()).toHaveJSProperty('indeterminate', true); await expect(block()).not.toBeChecked(); await expect(block()).toHaveJSProperty('indeterminate', true);
    await expect(fine(titleUnit)).toBeChecked(); await expect(fine(copyUnit)).toBeChecked(); await expect(textButton(dialog, '预览选中修改')).toBeEnabled(); await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled();
    // 只有明确点击整块才能扩大范围；再次挑内部项后继续保持fine身份。
    await block().check(); await expect(block()).toBeChecked(); await expect(whole()).not.toBeChecked(); await expect(whole()).toHaveJSProperty('indeterminate', true); await expect(textButton(dialog, '预览选中修改')).toBeEnabled(); await fine(copyUnit).uncheck();
    await expect(fine(titleUnit)).toBeChecked(); await expect(block()).toHaveJSProperty('indeterminate', true); await expect(whole()).toHaveJSProperty('indeterminate', true);
    await expect(dialog.getByText(/^只采用部分修改/)).toContainText('已选 1/1 个范围'); await expect(dialog.getByText(/^只采用部分修改/)).toContainText('内部调整');
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog); await testInfo.attach('fine-selection-mobile-choices', { body: await dialog.locator('.ai-site-design-selection').screenshot({ animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 }); await loadedComparison(dialog, source.designId);
    await textButton(dialog, '返回后台').click(); const guard = page.getByRole('dialog', { name: '未保存 · AI整站设计要求', exact: true }); await textButton(guard, '继续编辑').click(); await expect(dialog).toBeVisible(); await expect(fine(titleUnit)).toBeChecked(); await expect(fine(copyUnit)).not.toBeChecked();
    await textButton(dialog, '返回后台').click(); await textButton(guard, '保留输入并离开').click(); await expect(dialog).not.toBeVisible(); await page.reload(); dialog = dialogOf(page); await expect(dialog).toBeVisible();
    await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText(/^挑选页面内区块/).click(); await dialog.getByText(/^挑选区块内部/).click(); await expect(fine(titleUnit)).toBeChecked(); await expect(fine(copyUnit)).not.toBeChecked(); await expect(block()).toHaveJSProperty('indeterminate', true); await expect(whole()).toHaveJSProperty('indeterminate', true);
    const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/ai/site-designs/select' && item.request().method() === 'POST'); await textButton(dialog, '预览选中修改').click(); const selectedHttp = await response; expect(selectedHttp.status()).toBe(201); expect(selectedHttp.request().postDataJSON().unitIds).toEqual([titleUnit.id]);
    const selected = await selectedHttp.json() as AiSiteDesignPreview; candidates.push(selected.designId); expect(selected.selection).toEqual({ sourceDesignId: source.designId, unitIds: [titleUnit.id] }); expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(firstManual.revision);
    await loadedComparison(dialog, selected.designId); let afterFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]'); await expect(afterFrame.getByText(originalCopy, { exact: true })).toBeVisible(); await expect(afterFrame.getByText(manualNote, { exact: true })).toBeVisible(); await expect(afterFrame.getByText(changedCopy, { exact: true })).toHaveCount(0);
    // 派生方案只剩一个frontier；再次手改未变兄弟，验证“内部全选”仍精准，不会归整块而触发冲突或覆盖。
    const single = selected.detailUnits || []; expect(single).toHaveLength(1); expect(single[0].nodeIds).toEqual([headingId]);
    const secondManualData = structuredClone(firstManualData); secondManualData.content[0].props.content[2].props.text = latestNote;
    const secondManual = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: firstManual.revision, patch: { editorData: { ...firstManual.state.editorData, [home.id]: secondManualData } } });
    const singleReview = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: selected.designId, action: 'apply' }); await page.goto(singleReview.reviewUrl); dialog = dialogOf(page); await expect(dialog).toBeVisible(); await loadedComparison(dialog, selected.designId);
    await dialog.getByText(/^只采用部分修改/).click(); await dialog.getByText(/^挑选页面内区块/).click(); await dialog.getByText(/^挑选区块内部/).click(); await fine(single[0]).uncheck(); await expect(textButton(dialog, '预览选中修改')).toBeDisabled(); await fine(single[0]).check();
    await expect(block()).not.toBeChecked(); await expect(block()).toHaveJSProperty('indeterminate', true); await expect(whole()).not.toBeChecked(); await expect(whole()).toHaveJSProperty('indeterminate', true); await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled();
    const finalResponse = page.waitForResponse(item => new URL(item.url()).pathname === '/api/ai/site-designs/select' && item.request().method() === 'POST'); await textButton(dialog, '预览选中修改').click(); const finalHttp = await finalResponse; expect(finalHttp.status()).toBe(201); expect(finalHttp.request().postDataJSON().unitIds).toEqual([single[0].id]);
    const final = await finalHttp.json() as AiSiteDesignPreview; candidates.push(final.designId); expect(final.selection).toEqual({ sourceDesignId: selected.designId, unitIds: [single[0].id] }); expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(secondManual.revision);
    await loadedComparison(dialog, final.designId); afterFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]'); await expect(afterFrame.getByText(originalCopy, { exact: true })).toBeVisible(); await expect(afterFrame.getByText(latestNote, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog); await expect(afterFrame.getByRole('heading', { name: changedTitle, exact: true })).toBeVisible(); await testInfo.attach('fine-selection-mobile-real-preview', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 }); await loadedComparison(dialog, final.designId);
    await textButton(dialog, '确认应用到网站草稿').click(); await expect(dialog).toContainText('已应用到网站草稿'); const applied = await api<StudioEnvelope>(control, '/api/studio'), data = applied.state.editorData[home.id] as Data;
    expect(data.content[0].props.content[0].props.text).toBe(changedTitle); expect(data.content[0].props.content[1]).toEqual(secondManualData.content[0].props.content[1]); expect(data.content[0].props.content[2]).toEqual(secondManualData.content[0].props.content[2]); expect(applied.state.products).toEqual(secondManual.state.products); expect(applied.state.sharedBlocks || []).toEqual(secondManual.state.sharedBlocks || []); expect(applied.activeReleaseId).toBe(secondManual.activeReleaseId);
    await textButton(dialog, '返回后台').click(); await expect(dialog).not.toBeVisible(); await page.goto('/admin#pages'); await expect(page.getByRole('heading', { name: /^网站页面/ })).toBeVisible(); await page.getByRole('button', { name: `编辑${home.title}`, exact: true }).click(); await expect(page.locator('.editor-screen')).toBeVisible();
    const canvas = page.frameLocator('.editor-canvas iframe'); await expect(canvas.locator('h1').filter({ hasText: changedTitle })).toBeVisible(); await expect(canvas.getByText(originalCopy, { exact: true })).toBeVisible(); await expect(canvas.getByText(latestNote, { exact: true })).toBeVisible(); await page.locator('.editor-left-panel').getByRole('tab', { name: /图层/ }).click(); await page.getByRole('treeitem').filter({ hasText: '公司介绍区' }).first().click();
    await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await page.getByRole('button', { name: '返回页面管理', exact: true }).click(); await expect(page.getByRole('heading', { name: /^网站页面/ })).toBeVisible(); expect((await api<StudioEnvelope>(control, '/api/studio')).state.editorData[home.id]).toEqual(data);
    const undoReview = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: final.designId, action: 'undo' }); await page.goto(undoReview.reviewUrl); dialog = dialogOf(page); await expect(dialog).toBeVisible(); await loadedComparison(dialog, final.designId); await textButton(dialog, '撤销本次整站设计').click(); await expect(dialog).toContainText('已撤销本次整站设计');
    const undone = await api<StudioEnvelope>(control, '/api/studio'); expect(undone.state.editorData).toEqual(secondManual.state.editorData); expect(undone.state.sharedBlocks || []).toEqual(secondManual.state.sharedBlocks || []); expect(undone.activeReleaseId).toBe(secondManual.activeReleaseId); expect((await tool<{ status: string }>(client, 'site_design_status', { designId: final.designId })).status).toBe('undone');
    expect(await api(control, '/api/ai/provider')).toEqual(provider); expect(ui.writes.filter(item => item.path === '/api/ai/site-designs')).toHaveLength(0); expect(ui.writes.filter(item => item.path === '/api/ai/site-designs/select')).toHaveLength(2);
  } catch (cause) {
    bodyFailure = cause; try { await testInfo.attach('fine-selection-primary-failure-screen', { body: await page.screenshot({ animations: 'disabled', timeout: 3000 }), contentType: 'image/png' }); } catch { /* 截图失败仍保留原异常。 */ } throw cause;
  } finally {
    const errors: string[] = [];
    try { await ui.closeOwnedPage(); } catch { errors.push('close-owned-page'); }
    try { await sdk('close', () => client.close()); } catch { errors.push('close-client'); }
    for (const id of candidates.reverse()) try { await api(control, `/api/ai/site-designs/${id}`, 'DELETE'); } catch { errors.push('delete-candidate'); }
    if (tokenId) try { await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); } catch { errors.push('revoke-token'); }
    if (seeded) try { const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, sharedBlocks: original.state.sharedBlocks || [] } }); } catch { errors.push('restore-isolated-state'); }
    await testInfo.attach('fine-selection-cleanup', { body: Buffer.from(JSON.stringify({ errors, usedIndependentApiContext: true, primaryFailurePreserved: !!bodyFailure })), contentType: 'application/json' }); await control.dispose(); if (!bodyFailure && errors.length) throw new Error(`Isolated fine selection cleanup failed: ${errors.join(',')}`);
  }
});
