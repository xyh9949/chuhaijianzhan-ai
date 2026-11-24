import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiProviderSummary } from '../../src/server/ai-provider';
import type { SiteTranslationPreview } from '../../src/lib/ai-site-translation-types';

/** 此流程只跑包装器的临时站点与合成模型，不读取正式实例或真实付费配置。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  expect(new URL(runtime.origin).hostname).toBe('127.0.0.1'); expect(new URL(runtime.origin).port).not.toBe('3200');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated site translation ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}

test('整站翻译闭环：页眉页脚导航、实际手机预览、按范围采用和安全撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(100000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 15000 });
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<AiProviderSummary>(control, '/api/ai/provider');
  expect(provider.hasApiKey).toBe(false); let configured = false, appliedId: string | undefined;
  try {
    // 用极小的原生页面验证完整链路，避免夹带其他测试长文本导致超过明确的单次模型预算。
    const source = original.state.pages.find(item => item.slug === '/')!;
    const editorData = structuredClone(original.state.editorData);
    for (const value of Object.values(editorData)) { const data = value as { root?: { props?: Record<string, unknown> } }; if (data.root?.props) data.root.props.brand = original.state.settings.name; }
    editorData[source.id] = { root: { props: { title: 'Synthetic factory home', brand: original.state.settings.name, showChrome: 'yes' } }, content: [{ type: 'Heading', props: { id: 'translation-title', text: 'Synthetic factory workshop', level: 'h1', size: 40, mobileSize: 28 } }, { type: 'Download', props: { id: 'translation-download', fileUrl: '' } }] };
    await api(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { editorData } });
    await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: provider.revision, enabled: true, baseUrl: `${runtime.modelOrigin}/v1`, model: 'ui-site-translation-model', allowLocal: true, apiKey: 'ui-design-synthetic' }); configured = true;
    ui.allowWrite('POST', '/api/ai/site-translations');
    await page.goto('/admin#pages'); await textButton(page, 'AI翻译网站').click();
    const dialog = page.getByRole('dialog', { name: 'AI翻译网站', exact: true }); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '清空选择', exact: true }).click(); await dialog.getByRole('checkbox', { name: new RegExp(`^${source.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).check();
    const generatedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/site-translations' && response.request().method() === 'POST');
    await textButton(dialog, '生成翻译预览').click(); const response = await generatedResponse; expect(response.ok()).toBe(true); const proposal = await response.json() as SiteTranslationPreview;
    await expect(dialog.getByRole('tab', { name: '核对并采用', exact: true })).toHaveAttribute('aria-selected', 'true'); expect(proposal.pages.length).toBe(1);
    const before = await api<StudioEnvelope>(control, '/api/studio'); expect(before.state.pages.length).toBe(original.state.pages.length);
    for (const path of [proposal.pages[0].beforeUrl, proposal.pages[0].afterUrl]) expect((await control.get(`${runtime.origin}${path}`)).status()).toBe(200);
    expect((await control.get(`${runtime.origin}${proposal.pages[0].afterUrl}/wrong-page`)).status()).toBe(404);
    // 明确空身份核查HTTP拒绝及私有文字不泄露，不能继承全局管理员storageState。
    const anonymous = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] }, timeout: 15000 });
    try { expect(await anonymous.storageState()).toEqual({ cookies: [], origins: [] }); const denied = await anonymous.get(`${runtime.origin}${proposal.pages[0].afterUrl}`, { maxRedirects: 0 }); expect(denied.status()).toBe(404); const html = await denied.text(); expect(html.includes('Synthetic factory workshop')).toBe(false); expect(html.includes(proposal.pages[0].targetId)).toBe(false); } finally { await anonymous.dispose(); }
    // Segmented的radio是0x0辅助输入，沿已验证用例点击实际可见标签。
    await dialog.locator('.ant-segmented-item').filter({ hasText: '手机' }).click(); await expect(dialog.getByRole('radio', { name: /手机$/ })).toBeChecked();
    const preview = page.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    // AiDesignPreview本身声明390px视口；检查实际iframe内的页面文字，不能只看字段回显。
    await expect(dialog.locator('iframe').last()).toHaveAttribute('src', proposal.pages[0].afterUrl);
    await expect(preview.getByRole('heading', { name: 'DE Synthetic factory workshop', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 1000 }); await noOverflow(page, dialog);
    await testInfo.attach('site-translation-mobile-review', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    ui.allowWrite('POST', `/api/ai/site-translations/${proposal.id}/apply`); ui.allowWrite('POST', `/api/ai/site-translations/${proposal.id}/undo`);
    await textButton(dialog, '采用译文到草稿').click(); await page.getByRole('dialog', { name: '采用此范围的译文到草稿？', exact: true }).getByRole('button', { name: '确认采用译文', exact: true }).click();
    await expect(dialog).toContainText('译文已保存到网站草稿'); appliedId = proposal.id;
    const adopted = await api<StudioEnvelope>(control, '/api/studio'); expect(adopted.state.pages.some(item => item.id === proposal.pages[0].targetId)).toBe(true); expect(adopted.state.siteLayout!.header.localeBlockIds![proposal.targetLocale]).toBeTruthy(); expect(adopted.state.siteLayout!.footer.localeBlockIds![proposal.targetLocale]).toBeTruthy(); expect(adopted.activeReleaseId).toBe(original.activeReleaseId);
    const native = JSON.stringify(adopted.state.editorData[proposal.pages[0].targetId]); expect(native).toContain('Synthetic factory workshop'); expect(native).toContain('Download');
    await textButton(dialog, '撤销本次翻译').click(); await page.getByRole('dialog', { name: '撤销本次网站翻译？', exact: true }).getByRole('button', { name: '确认撤销', exact: true }).click(); await expect(dialog).toContainText('本次翻译已撤销');
    const undone = await api<StudioEnvelope>(control, '/api/studio'); expect(undone.state.pages.some(item => item.id === proposal.pages[0].targetId)).toBe(false); expect(undone.activeReleaseId).toBe(original.activeReleaseId); appliedId = undefined;
    expect(ui.writes.filter(item => item.path.startsWith('/api/ai/site-translations'))).toEqual([{ method: 'POST', path: '/api/ai/site-translations' }, { method: 'POST', path: `/api/ai/site-translations/${proposal.id}/apply` }, { method: 'POST', path: `/api/ai/site-translations/${proposal.id}/undo` }]);
  } finally {
    await ui.closeOwnedPage();
    if (appliedId) { const current = await api<StudioEnvelope>(control, '/api/studio'); await api(control, `/api/ai/site-translations/${appliedId}/undo`, 'POST', { expectedRevision: current.revision }); }
    const current = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, siteLayout: original.state.siteLayout, sharedBlocks: original.state.sharedBlocks || [], forms: original.state.forms || [] } });
    if (configured) { const currentProvider = await api<AiProviderSummary>(control, '/api/ai/provider'); await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: currentProvider.revision, enabled: provider.enabled, baseUrl: provider.baseUrl, model: provider.model, allowLocal: provider.allowLocal, visionModel: provider.visionModel || '', clearApiKey: true }); }
    await control.dispose();
  }
});
