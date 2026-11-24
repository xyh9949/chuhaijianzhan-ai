import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Locator } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiSiteDesignPreview } from '../../src/lib/ai-site-design-types';
import type { AiVisualCapture } from '../../src/lib/ai-visual-types';
import { visualFullNativePatch } from '../fixtures/visual-full-native';
import { observePreviewImages } from './visual-preview-images';

async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  expect(new URL(runtime.origin).hostname).toBe('127.0.0.1'); expect(new URL(runtime.origin).port).not.toBe('3200');
  const response = await control.fetch(runtime.origin + path, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated visual full API ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}
async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args }).catch(() => { throw new Error(`Isolated visual full MCP ${name} failed`); }); expect(result.isError, `${name}应通过原生候选校验`).not.toBe(true);
  return (result.structuredContent || JSON.parse((result.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text)) as T;
}
/** 摘要先于iframe就绪；核对真实内容、文档与可见图片，避免后续操作取消仍在装载的预览资源。 */
async function previewReady(dialog: Locator, sides = ['修改前', 'AI建议']) {
  for (const side of sides) {
    const parent = dialog.frameLocator(`iframe[title="${side}"]`), frame = parent.frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(frame.getByRole('heading', { name: side === '修改前' ? 'Original full page heading' : 'Candidate full page heading', exact: true })).toBeVisible();
    await expect.poll(() => parent.locator('html').evaluate(element => element.ownerDocument.readyState)).toBe('complete');
    // 预览可能仍在Modal下方；先真实滚到轮播图片，让浏览器按可见性触发lazy加载，不能只改loading或等离屏图。
    await dialog.locator(`iframe[title="${side}"]`).scrollIntoViewIfNeeded();
    const first = frame.locator('.site-carousel-track img').first(); await first.scrollIntoViewIfNeeded(); await expect(first).toBeInViewport();
    await expect.poll(() => first.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect.poll(async () => { const observations = await observePreviewImages(frame.locator('img')); return observations.every(image => image.observed && (!image.intersecting || image.complete && image.naturalWidth > 0)); }).toBe(true);
    const observations = await observePreviewImages(frame.locator('img'));
    await test.info().attach(`visual-full-${side}-image-visibility`, { body: Buffer.from(JSON.stringify({ observations, readyScope: 'actual-intersections', invisibleLazyImagesAreNotClaimedLoaded: true })), contentType: 'application/json' });
  }
}

test('AI整页视觉检查：真实长页分段、原生菜单标签轮播、明确部分覆盖和继续，零提交零模型', async ({ page, ui }, testInfo) => {
  test.setTimeout(180000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 20000 });
  const client = new Client({ name: 'visual-full-ui', version: '1' }); const original = await api<StudioEnvelope>(control, '/api/studio'), home = original.state.pages.find(item => item.slug === '/')!;
  let tokenId = '', candidateId = '', primary: unknown;
  try {
    const seeded = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: visualFullNativePatch(original.state, home.id) });
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI full visual candidate', scopes: ['read', 'propose'], pageIds: [home.id] }); tokenId = credential.credential.id;
    await client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })).catch(() => { throw new Error('Isolated visual full MCP connect failed'); });
    const context = await tool<{ request: Record<string, unknown> }>(client, 'site_design_context', { expectedRevision: seeded.revision, instruction: 'Only update the existing heading; preserve all native components and supplied data.', targets: { pageIds: [home.id], header: false, footer: false, navigation: false, style: false }, preserveText: false });
    const proposal = await tool<AiSiteDesignPreview>(client, 'site_design_propose', { requestId: 'ui-full-visual-source', request: context.request, proposal: { summary: 'Actual native full-page candidate', warnings: [], operations: [{ kind: 'page', pageId: home.id, operations: [{ kind: 'text', id: 'ui-full-heading', text: 'Candidate full page heading' }] }] } }); candidateId = proposal.designId;
    const reviewLink = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: proposal.designId, action: 'apply' });
    ui.allowWrite('POST', '/api/ai/visual/captures'); await page.goto(reviewLink.reviewUrl);
    const dialog = page.getByRole('dialog', { name: 'AI整站设计', exact: true }); await expect(dialog).toBeVisible(); await previewReady(dialog);
    await dialog.getByText('让AI看看实际页面（可选）', { exact: true }).click(); await dialog.getByText('检查更多页面内容', { exact: true }).click();
    await dialog.getByRole('combobox', { name: '视觉检查范围', exact: true }).click(); await page.locator('.ant-select-dropdown:visible').getByText('滚动检查整页（分段）', { exact: true }).click();
    await dialog.getByRole('spinbutton', { name: '每设备截图页段数', exact: true }).fill('2'); await dialog.getByRole('checkbox', { name: '同时检查菜单、标签页等原生交互', exact: true }).check();
    await dialog.getByRole('combobox', { name: '视觉截图设备', exact: true }).click(); const dropdown = page.locator('.ant-select-dropdown:visible'); await dropdown.getByText('电脑', { exact: true }).click(); await dropdown.getByText('平板', { exact: true }).click(); await page.keyboard.press('Escape');
    const capturedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/visual/captures' && response.request().method() === 'POST'); await textButton(dialog, '生成真实截图').click(); const response = await capturedResponse; expect(response.ok()).toBe(true); const captured = await response.json() as AiVisualCapture;
    expect(captured.pageCoverage![0].device).toBe('mobile'); expect(captured.pageCoverage![0].complete).toBe(false); expect(captured.pageCoverage![0].nextStartSection).toBe(3); expect(captured.images.some(image => image.id === 'mobile-section-2' && image.section!.from > 0)).toBe(true);
    for (const kind of ['menu', 'accordion', 'tabs', 'carousel', 'form']) expect(captured.observations!.some(item => item.kind === kind && item.status === 'checked'), `真实原生${kind}应被观察`).toBe(true);
    expect(captured.images.filter(image => image.coverage === 'interaction')).toHaveLength(4); expect(await textButton(dialog, '发送所选截图检查').isDisabled()).toBe(true);
    await dialog.getByText(new RegExp(`截图覆盖与本地检查`)).click(); await expect(dialog.getByText('部分页段', { exact: true })).toBeVisible();
    await expect.poll(() => dialog.locator('.ant-image-img').evaluateAll(images => images.length > 0 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await dialog.getByRole('spinbutton', { name: '每设备截图页段数', exact: true }).fill('6');
    const continuedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/visual/captures' && response.request().method() === 'POST'); await textButton(dialog, '继续检查手机后续页段').click(); const continued = await (await continuedResponse).json() as AiVisualCapture;
    expect(continued.images[0].id).toBe('mobile-section-3'); expect(continued.images[0].section!.from).toBeGreaterThan(captured.images[1].section!.from); expect(continued.pageCoverage![0].complete).toBe(false); expect(continued.pageCoverage![0].reason).toContain('前面的页段未包含');
    await expect(dialog.getByRole('combobox', { name: '查看已生成截图组', exact: true })).toBeVisible();
    await expect.poll(() => dialog.locator('.ant-image-img').evaluateAll(images => images.length > 0 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await page.setViewportSize({ width: 390, height: 1000 }); await previewReady(dialog, ['AI建议']); await noOverflow(page); await testInfo.attach('visual-full-mobile-viewport', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    const after = await api<StudioEnvelope>(control, '/api/studio'); expect(after.revision).toBe(seeded.revision); expect(after.activeReleaseId).toBe(original.activeReleaseId); expect(after.state.inquiries).toEqual(original.state.inquiries);
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/ai/visual/captures' }, { method: 'POST', path: '/api/ai/visual/captures' }]);
  } catch (error) {
    primary = error;
    try { await testInfo.attach('visual-full-primary-failure', { body: await page.screenshot({ animations: 'disabled', timeout: 3000 }), contentType: 'image/png' }); } catch { /* 保留首要失败，不让诊断截图覆盖它。 */ }
    throw error;
  }
  finally {
    const errors: string[] = []; try { await ui.closeOwnedPage(); } catch { errors.push('page-close'); } try { await client.close(); } catch { errors.push('mcp-close'); }
    try { const current = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { editorData: original.state.editorData, forms: original.state.forms || [], siteLayout: original.state.siteLayout || { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: [] } } }); } catch { errors.push('source-restore'); }
    if (candidateId) try { await api(control, `/api/ai/site-designs/${candidateId}`, 'DELETE'); } catch { errors.push('candidate-delete'); }
    if (tokenId) try { await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); } catch { errors.push('token-delete'); }
    await control.dispose(); await testInfo.attach('visual-full-cleanup', { body: Buffer.from(JSON.stringify({ errors, primaryFailurePreserved: !!primary })), contentType: 'application/json' }); if (!primary && errors.length) throw new Error(`Visual full cleanup failed: ${errors.join(', ')}`);
  }
});
