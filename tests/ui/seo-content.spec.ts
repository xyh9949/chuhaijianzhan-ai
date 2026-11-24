import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiProviderSummary } from '../../src/server/ai-provider';
import type { SeoContentContext, SeoContentPreview } from '../../src/lib/seo-content-types';
import type { SeoKeywordReport } from '../../src/lib/seo-types';
import type { RichNode } from '../../src/lib/presentation-content';
import { richTextPlainText } from '../../src/lib/presentation-content';

/** 仅访问包装器的随机合成实例，异常不回显Cookie或模型连接凭据。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  expect(new URL(runtime.origin).hostname).toBe('127.0.0.1'); expect(new URL(runtime.origin).port).not.toBe('3200');
  const response = await control.fetch(runtime.origin + path, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated SEO content ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}

/** Modal入场定位会移动/关闭过早打开的下拉；只点击当前门户的确切报告，并核对真实GET和受控选中值。 */
async function chooseReport(page: Page, combobox: Locator, label: string, reportId: string) {
  await expect.poll(() => page.locator('.ant-modal:visible').evaluateAll(panels => panels.some(panel => /(?:^|\s)\S+-(?:enter|appear|leave)(?:-\S+)?(?=\s|$)/.test(panel.className)))).toBe(false);
  await expect(combobox).toBeEnabled();
  if (await combobox.getAttribute('aria-expanded') !== 'true') await combobox.click();
  await expect(combobox).toHaveAttribute('aria-controls', /.+/);
  const popupId = await combobox.getAttribute('aria-controls') || await combobox.getAttribute('aria-owns'); expect(popupId).toMatch(/^[\w:.-]+$/);
  const popup = page.locator('.ant-select-dropdown:visible').filter({ has: page.locator(`[id="${popupId}"]`) });
  await expect(popup).not.toHaveClass(/(?:^|\s)\S+-(?:enter|appear|leave)(?:-\S+)?(?=\s|$)/);
  const option = popup.locator('.ant-select-item-option').and(page.getByTitle(label, { exact: true }));
  await expect(option).toHaveCount(1); await expect(option).toBeVisible(); await option.hover(); await expect(option).toHaveClass(/(?:^|\s)ant-select-item-option-active(?=\s|$)/);
  const [loaded] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === `/api/seo/sources/reports/${reportId}` && response.request().method() === 'GET'), option.click()]);
  expect(loaded.status()).toBe(200);
  await expect.poll(() => combobox.evaluate(input => [...input.closest('.ant-select')!.querySelectorAll('.ant-select-content[title],.ant-select-content-value[title]')].map(item => (item.getAttribute('title') || item.textContent || '').replace(/\s+/g, ' ').trim()))).toContain(label.replace(/\s+/g, ' ').trim());
  await expect(combobox).toHaveAttribute('aria-expanded', 'false');
}

test('SEO正文按真实报告行生成、组合原生预览、确认保存和撤销，图链与未选搜索字段保持', async ({ page, ui }, testInfo) => {
  test.setTimeout(150000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 20000 });
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<AiProviderSummary>(control, '/api/ai/provider'), product = original.state.products.find(item => item.id === 'p2')!;
  expect(provider.hasApiKey).toBe(false); let reportId = '', proposalId = '', configured = false;
  const doc: RichNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Supplied ${product.sku} steel sample 25 mm.`, marks: [{ type: 'link', attrs: { href: '/' } }] }] }, { type: 'image', attrs: { src: '/images/chair.jpg', alt: 'SEO original supplied photograph' } }] };
  try {
    await api(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { products: original.state.products.map(item => item.id === product.id ? { ...item, detailContent: doc, seoTitle: 'UI original SEO title', seoDescription: 'UI original SEO description' } : item) } });
    const imported = await api<SeoKeywordReport>(control, '/api/seo/sources/keywords/import', 'POST', { sourceName: 'UI SEO synthetic CSV fixture', sourceUrl: 'https://example.invalid/seo-source', startDate: '2026-10-01', endDate: '2026-10-31', country: 'usa', languageCode: 'en', csv: 'keyword,search_volume,cpc,competition,competition_index\nsteel sample,0,,,\nunselected subject,125,,,' }); reportId = imported.id;
    await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: provider.revision, enabled: true, baseUrl: `${runtime.modelOrigin}/v1`, model: 'ui-seo-content-model', allowLocal: true, apiKey: 'ui-design-synthetic' }); configured = true;
    // CSV保留原文件行号（含标题行），引用采用服务端实际返回的行号。
    const selectedRow = imported.rows[0].rowNumber;
    const context = await api<SeoContentContext>(control, `/api/seo/content/context?kind=product&id=${product.id}`), link = context.links.find(item => item.url === '/')!; expect(link).toBeTruthy();
    ui.allowWrite('POST', '/api/seo/content');
    await page.goto('/admin#seo'); const contentPicker=page.getByRole('combobox', { name: '选择内容完善正文', exact: true }); await contentPicker.click(); await contentPicker.fill(product.name); await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: product.name }).click();
    const dialog = page.getByRole('dialog', { name: '根据搜索数据完善正文', exact: true }); await expect(dialog).toBeVisible();
    const reportLabel = `${imported.source.name} · ${imported.scope.startDate}～${imported.scope.endDate} · ${imported.scope.timeZone}${imported.scope.country ? ` · ${imported.scope.country}` : ''}${imported.scope.languageCode ? ` · ${imported.scope.languageCode}` : ''}${imported.scope.device ? ` · ${imported.scope.device}` : ''}`;
    await chooseReport(page, dialog.getByRole('combobox', { name: '正文优化数据报告', exact: true }), reportLabel, imported.id);
    await dialog.getByRole('checkbox', { name: `使用报告第${selectedRow}行`, exact: true }).check(); await expect(dialog).toContainText('估计月均搜索量 0');
    await dialog.getByText('选择可引用的真实站内内容（选填）', { exact: true }).click(); await dialog.getByRole('combobox', { name: '正文优化真实内链', exact: true }).click(); await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: `${link.label} · ${link.url}` }).first().click(); await dialog.getByRole('textbox', { name: '正文优化要求', exact: true }).fill('UI_AI_SEO_CONTENT: add supplied selection context, supported FAQ and related company link.');
    const before = await api<StudioEnvelope>(control, '/api/studio'), generatedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/seo/content' && response.request().method() === 'POST');
    await textButton(dialog, '生成正文优化预览').click(); const response = await generatedResponse; expect(response.ok()).toBe(true); const proposal = await response.json() as SeoContentPreview; proposalId = proposal.id;
    expect(proposal.evidence[0].rowNumbers).toEqual([selectedRow]); expect(proposal.evidence[0].country).toBe('usa'); expect(proposal.evidence[0].source).toBe('csv'); expect(proposal.changes.map(item => item.key)).toEqual(expect.arrayContaining(['body', 'faq', 'links', 'seoTitle', 'seoDescription'])); expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(before.revision);
    await expect(dialog.getByRole('checkbox', { name: '采用搜索标题', exact: true })).not.toBeChecked(); await expect(dialog.getByRole('checkbox', { name: '采用搜索介绍', exact: true })).not.toBeChecked();
    // 先改勾选再打开实际页面，真实after只包含本次选择，不拿全量建议冒充组合预览。
    await dialog.getByRole('checkbox', { name: '采用买家问答', exact: true }).uncheck(); await textButton(dialog, '查看所选范围的实际页面对比').click();
    const afterFrame = dialog.frameLocator('iframe[title="SEO正文修改后实际页面"]').frameLocator('iframe[title="网站草稿隔离预览"]'), bodyDoc = proposal.changes.find(item => item.key === 'body')!.doc!, firstParagraph = bodyDoc.content!.find(item => item.type === 'paragraph')!.content!.find(item => item.type === 'text')!.text!;
    await expect(afterFrame.getByText(firstParagraph, { exact: true })).toBeVisible(); const faqDoc = proposal.changes.find(item => item.key === 'faq')!.doc!, question = faqDoc.content!.find(item => item.type === 'heading')!.content![0].text!; await expect(afterFrame.getByText(question, { exact: true })).toHaveCount(0); await expect(afterFrame.getByRole('img', { name: 'SEO original supplied photograph', exact: true })).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 1000 }); await noOverflow(page, dialog); await dialog.getByText('根据搜索数据完善正文', { exact: true }).scrollIntoViewIfNeeded(); await testInfo.attach('seo-content-mobile-viewport', { body: await page.screenshot({ fullPage: false, animations: 'disabled' }), contentType: 'image/png' });
    ui.allowWrite('POST', `/api/seo/content/${proposal.id}/apply`); ui.allowWrite('POST', `/api/seo/content/${proposal.id}/undo`);
    await textButton(dialog, '保存选中范围到草稿').click(); await page.getByRole('dialog', { name: '保存选中的正文优化范围？', exact: true }).getByRole('button', { name: '确认保存选中范围', exact: true }).click(); await expect(dialog.getByText('选中范围已保存到草稿，仍可原生编辑；公开网站没有改变。', { exact: true })).toBeVisible();
    const saved = await api<StudioEnvelope>(control, '/api/studio'), next = saved.state.products.find(item => item.id === product.id)!; expect(next.detailContent!.content!.slice(0, 2)).toEqual(doc.content); expect(richTextPlainText(next.detailContent!)).toContain(firstParagraph); expect(richTextPlainText(next.detailContent!)).not.toContain(question); expect(next.seoTitle).toBe('UI original SEO title'); expect(next.seoDescription).toBe('UI original SEO description'); expect(saved.activeReleaseId).toBe(original.activeReleaseId);
    await textButton(dialog, '撤销本次正文优化').click(); await page.getByRole('dialog', { name: '撤销本次正文优化？', exact: true }).getByRole('button', { name: '确认撤销正文优化', exact: true }).click(); await expect(dialog.getByText('本次正文建议已撤销，其他内容和公开网站保持。', { exact: true })).toBeVisible(); const reverted = await api<StudioEnvelope>(control, '/api/studio'); expect(reverted.state.products.find(item => item.id === product.id)!.detailContent).toEqual(doc); expect(reverted.activeReleaseId).toBe(original.activeReleaseId);
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/seo/content' }, { method: 'POST', path: `/api/seo/content/${proposal.id}/apply` }, { method: 'POST', path: `/api/seo/content/${proposal.id}/undo` }]);
  } finally {
    await ui.closeOwnedPage(); const current = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { products: original.state.products } });
    if (proposalId) await api(control, `/api/seo/content/${proposalId}`, 'DELETE'); if (reportId) await api(control, `/api/seo/sources/reports/${reportId}`, 'DELETE');
    if (configured) { const currentProvider = await api<AiProviderSummary>(control, '/api/ai/provider'); await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: currentProvider.revision, enabled: provider.enabled, baseUrl: provider.baseUrl, model: provider.model, visionModel: provider.visionModel || '', allowLocal: provider.allowLocal, clearApiKey: true }); }
    await control.dispose();
  }
});
