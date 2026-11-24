import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Locator, type Route } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiSiteDesignRequest, AiSiteDesignPreview } from '../../src/lib/ai-site-design-types';
import type { AiVisualCapture, AiVisualReview } from '../../src/lib/ai-visual-types';

/** 控制请求仅操作包装器的合成实例，不回显带Cookie或连接密钥的底层异常。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  expect(new URL(runtime.origin).hostname).toBe('127.0.0.1'); expect(new URL(runtime.origin).port).not.toBe('3200');
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Only isolated API paths are allowed');
  const response = await control.fetch(runtime.origin + path, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated API ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}
async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args }).catch(() => { throw new Error(`Isolated MCP ${name} failed`); });
  expect(result.isError, `${name} should succeed`).not.toBe(true);
  return (result.structuredContent || JSON.parse((result.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text)) as T;
}
/** 切设备/候选会销毁旧iframe；先真实滚动并确认图片读完，不能用标题出现代替图片加载。 */
async function previewImagesReady(dialog: Locator, sides: ('修改前' | 'AI建议')[]) {
  for (const side of sides) {
    await dialog.locator(`iframe[title="${side}"]`).scrollIntoViewIfNeeded({ timeout: 10000 });
    const image = dialog.frameLocator(`iframe[title="${side}"]`).frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('img', { name: 'Synthetic chair example', exact: true });
    await image.scrollIntoViewIfNeeded({ timeout: 10000 });
    await expect.poll(() => image.evaluate(element => { const image = element as HTMLImageElement; return image.complete && image.naturalWidth > 0; }), { message: `${side}真实预览图片应完整加载后再切换` }).toBe(true);
  }
}
test('AI视觉检查真实三端截图、明确外发同意、定位及带入继续调整，未确认不改网站', async ({ page, ui }, testInfo) => {
  test.setTimeout(180000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 20000 });
  const client = new Client({ name: 'visual-review-ui', version: '1' }); let tokenId = '', candidateId = '', refinedId = '', bodyFailure: unknown;
  const original = await api<StudioEnvelope>(control, '/api/studio'), home = original.state.pages.find(item => item.slug === '/')!;
  const provider = await api<{ revision: number; enabled: boolean; hasApiKey: boolean; baseUrl: string; model: string; visionModel?: string; allowLocal: boolean }>(control, '/api/ai/provider');
  expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
  try {
    const seeded = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, [home.id]: { root: { props: { title: 'Visual review sample', showChrome: 'no' } }, content: [
      { type: 'Heading', props: { id: 'ui-visual-heading', text: 'Original visual heading', level: 'h1', size: 36, mobileSize: 28 } },
      { type: 'Text', props: { id: 'ui-visual-copy', text: 'Synthetic website information for actual screenshot verification.', size: 16 } },
      { type: 'Image', props: { id: 'ui-visual-image', src: '/images/chair.jpg', alt: 'Synthetic chair example', height: 260, fit: 'contain' } },
    ] } } } });
    await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: provider.revision, enabled: true, baseUrl: `${runtime.modelOrigin}/v1`, model: 'synthetic-design', visionModel: 'synthetic-vision', allowLocal: true, apiKey: 'ui-design-synthetic' });
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI visual candidate', scopes: ['read', 'propose'], pageIds: [home.id] }); tokenId = credential.credential.id;
    await client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })).catch(() => { throw new Error('Isolated visual MCP connect failed'); });
    const request: AiSiteDesignRequest = { expectedRevision: seeded.revision, instruction: '改变标题，保留真实图片与正文，供视觉首屏检查。', targets: { pageIds: [home.id], header: false, footer: false, navigation: false, style: false }, preserveText: false };
    const context = await tool<{ request: AiSiteDesignRequest }>(client, 'site_design_context', request as unknown as Record<string, unknown>);
    const proposal = await tool<AiSiteDesignPreview>(client, 'site_design_propose', { requestId: 'ui-visual-site-source', request: context.request, proposal: { summary: 'UI actual screenshot candidate', operations: [{ kind: 'page', pageId: home.id, operations: [{ kind: 'text', id: 'ui-visual-heading', text: 'Actual visual candidate heading' }] }], warnings: [] } }); candidateId = proposal.designId;
    const reviewLink = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: proposal.designId, action: 'apply' });
    ui.allowWrite('POST', '/api/ai/visual/captures'); ui.allowWrite('POST', '/api/ai/visual/reviews');
    await page.goto(reviewLink.reviewUrl); const dialog = page.getByRole('dialog', { name: 'AI整站设计', exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: 'Actual visual candidate heading', exact: true })).toBeVisible();
    await dialog.getByText('让AI看看实际页面（可选）', { exact: true }).click();
    const captureResponse = page.waitForResponse(response => response.url().endsWith('/api/ai/visual/captures') && response.request().method() === 'POST');
    await textButton(dialog, '生成真实截图').click(); const capture = await (await captureResponse).json() as AiVisualCapture;
    expect(capture.images.map(image => image.device).sort()).toEqual(['desktop', 'mobile', 'tablet']);
    for (const image of capture.images) { const response = await control.get(runtime.origin + image.url).catch(() => { throw new Error('Isolated visual image read failed'); }); expect(response.ok()).toBe(true); expect(response.headers()['content-type']).toContain('image/jpeg'); const bytes = await response.body(); expect([...bytes.subarray(0, 2)]).toEqual([255, 216]); expect(bytes.length).toBeGreaterThan(1000); }
    const send = textButton(dialog, '发送所选截图检查'); await expect(send).toBeDisabled();
    await dialog.getByRole('checkbox', { name: '发送电脑截图', exact: true }).uncheck(); await dialog.getByRole('checkbox', { name: '发送平板截图', exact: true }).uncheck();
    await dialog.getByRole('textbox', { name: '视觉检查重点', exact: true }).fill('UI_AI_VISUAL_FLOW');
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/ai/visual/captures' }]);
    await dialog.getByRole('checkbox', { name: '我已核对，允许将勾选截图和本次要求发送给自配AI', exact: true }).check();
    const reviewResponse = page.waitForResponse(response => response.url().endsWith('/api/ai/visual/reviews') && response.request().method() === 'POST');
    await send.click(); const checked = await (await reviewResponse).json() as AiVisualReview;
    expect(checked.issues[0].device).toBe('mobile'); expect(checked.issues[0].nodeId).toBe('ui-visual-heading');
    await expect(dialog.getByText('UI视觉：标题层级需要核对', { exact: true })).toBeVisible();
    await previewImagesReady(dialog, ['修改前', 'AI建议']);
    await page.setViewportSize({ width: 390, height: 1000 });
    await dialog.locator('.ant-segmented-item').filter({ hasText: '修改前' }).click(); await expect(dialog.locator('iframe[title="AI建议"]')).toHaveCount(0);
    await previewImagesReady(dialog, ['修改前']);
    const afterUrl = new URL(proposal.previewPages.find(item => item.pageId === home.id)!.afterUrl!, runtime.origin).href;
    // 故意让新挂载候选慢于旧250ms定位延迟，验证依赖真实沙箱就绪而非碰巧装载够快。
    const delayedPreview = async (route: Route) => { await new Promise(resolve => setTimeout(resolve, 600)); await route.fallback(); };
    await page.route(afterUrl, delayedPreview);
    try {
      const navigation = page.waitForRequest(request => request.url() === afterUrl && request.isNavigationRequest());
      await textButton(dialog, '在预览定位').click(); await navigation;
      await expect(dialog.getByText('正在定位预览中的对应内容…', { exact: true })).toBeVisible();
      await expect(dialog.getByText('已在AI建议预览中定位，标记稍后自动消失。', { exact: true })).toBeVisible();
    } finally { await page.unroute(afterUrl, delayedPreview); }
    await noOverflow(page, dialog); await testInfo.attach('visual-review-mobile', { body: await dialog.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await textButton(dialog, '带入继续调整').click(); await expect(dialog.getByRole('textbox', { name: '继续整站设计要求', exact: true })).toHaveValue(checked.suggestedInstruction);
    await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled();
    const after = await api<StudioEnvelope>(control, '/api/studio'); expect(after.revision).toBe(seeded.revision); expect(after.state.editorData).toEqual(seeded.state.editorData); expect(after.activeReleaseId).toBe(seeded.activeReleaseId);
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/ai/visual/captures' }, { method: 'POST', path: '/api/ai/visual/reviews' }]);
    // 截图浏览器不可用只关闭自动截图，不伪造成功，也不影响已有真实预览。
    ui.jsonGet('/api/ai/visual/status', { available: false, providerReady: true, reason: 'UI synthetic screenshot runtime unavailable' });
    await dialog.getByText('让AI看看实际页面（可选）', { exact: true }).click(); await dialog.getByText('让AI看看实际页面（可选）', { exact: true }).click();
    await expect(dialog.getByText('当前不能自动生成截图', { exact: true })).toBeVisible(); await expect(textButton(dialog, '重新生成截图')).toBeDisabled();
    ui.allowWrite('DELETE', `/api/ai/visual/captures/${capture.id}`); await textButton(dialog, '移除此组截图').click(); await page.getByRole('button', { name: '移除截图和评审', exact: true }).click();
    await expect(dialog.getByText('此组截图和对应评审已移除，设计方案及网站保持。', { exact: true })).toBeVisible(); expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(seeded.revision);
    ui.allowWrite('POST', '/api/ai/site-designs'); ui.allowWrite('POST', '/api/ai/site-designs/apply'); ui.allowWrite('POST', '/api/ai/site-designs/undo');
    await previewImagesReady(dialog, ['AI建议']);
    const continuedResponse = page.waitForResponse(response => response.url().endsWith('/api/ai/site-designs') && response.request().method() === 'POST');
    await textButton(dialog, '继续调整整站方案').click(); const continued = await (await continuedResponse).json() as AiSiteDesignPreview; refinedId = continued.designId; expect(refinedId).not.toBe(candidateId);
    await expect(dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: 'Actual visual candidate heading', exact: true })).toBeVisible();
    await previewImagesReady(dialog, ['AI建议']);
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(seeded.revision);
    await textButton(dialog, '确认应用到网站草稿').click(); await expect(textButton(dialog, '撤销本次整站设计')).toBeVisible();
    const applied = await api<StudioEnvelope>(control, '/api/studio'); expect(applied.revision).toBe(seeded.revision + 1); expect(applied.activeReleaseId).toBe(seeded.activeReleaseId);
    const actualHeading = (applied.state.editorData[home.id] as Data).content.find(node => node.props.id === 'ui-visual-heading')!; expect(actualHeading.props.text).toBe('Actual visual candidate heading'); expect(actualHeading.props.design.mobile.fontSize).toBe(27);
    await textButton(dialog, '撤销本次整站设计').click(); await expect(textButton(dialog, '撤销本次整站设计')).toBeDisabled();
    const undone = await api<StudioEnvelope>(control, '/api/studio'); expect(undone.state.editorData).toEqual(seeded.state.editorData); expect(undone.activeReleaseId).toBe(seeded.activeReleaseId);
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/ai/visual/captures' }, { method: 'POST', path: '/api/ai/visual/reviews' }, { method: 'DELETE', path: `/api/ai/visual/captures/${capture.id}` }, { method: 'POST', path: '/api/ai/site-designs' }, { method: 'POST', path: '/api/ai/site-designs/apply' }, { method: 'POST', path: '/api/ai/site-designs/undo' }]);

  } catch (cause) {
    bodyFailure = cause;
    try { await testInfo.attach('visual-primary-failure', { body: await page.screenshot({ animations: 'disabled', timeout: 3000 }), contentType: 'image/png' }); } catch { /* 截图失败不能替换真正的业务断言。 */ }
    throw cause;
  } finally {
    const errors: string[] = [];
    try { await ui.closeOwnedPage(); } catch { errors.push('owned-page-close'); }
    try { await client.close(); } catch { errors.push('client-close'); }
    try { const current = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { editorData: original.state.editorData } }); } catch { errors.push('draft-restore'); }
    try { const configured = await api<{ revision: number }>(control, '/api/ai/provider'); await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: configured.revision, enabled: provider.enabled, baseUrl: provider.baseUrl, model: provider.model, visionModel: provider.visionModel || '', allowLocal: provider.allowLocal, clearApiKey: true }); } catch { errors.push('provider-restore'); }
    if (refinedId) try { await api(control, `/api/ai/site-designs/${refinedId}`, 'DELETE'); } catch { errors.push('refined-candidate-delete'); }
    if (candidateId) try { await api(control, `/api/ai/site-designs/${candidateId}`, 'DELETE'); } catch { errors.push('candidate-delete'); }
    if (tokenId) try { await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); } catch { errors.push('token-delete'); }
    await control.dispose(); await testInfo.attach('visual-cleanup', { body: Buffer.from(JSON.stringify({ errors, primaryFailurePreserved: !!bodyFailure })), contentType: 'application/json' });
    if (!bodyFailure && errors.length) throw new Error(`Visual cleanup failed: ${errors.join(', ')}`);
  }
});
