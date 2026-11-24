import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiProviderSummary } from '../../src/server/ai-provider';
import type { AiTranslationPreview } from '../../src/lib/ai-translation-types';

/** 只使用包装器的合成实例与本机模型，失败不回显包含认证头的运输异常。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  expect(new URL(runtime.origin).hostname).toBe('127.0.0.1'); expect(new URL(runtime.origin).port).not.toBe('3200');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated translation ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}

test('自配模型产品图文翻译：保护型号单位与图片，真实预览、确认、恢复撤销及原生续编', async ({ page, ui }, testInfo) => {
  test.setTimeout(100000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 15000 });
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<AiProviderSummary>(control, '/api/ai/provider'), source = original.state.products.find(item => item.id === 'p2')!;
  expect(provider.hasApiKey).toBe(false); let configured = false;
  const detail = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: `Supplied ${source.sku} panel 25 mm and 2 kg.` }] }, { type: 'image' as const, attrs: { src: '/images/chair.jpg', alt: 'Original supplied image' } }] };
  try {
    await api(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { products: original.state.products.map(item => item.id === source.id ? { ...item, detailContent: detail } : item) } });
    await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: provider.revision, enabled: true, baseUrl: `${runtime.modelOrigin}/v1`, model: 'ui-translation-model', allowLocal: true, apiKey: 'ui-design-synthetic' }); configured = true;
    ui.allowWrite('POST', '/api/ai/translations'); ui.allowWrite('PATCH', '/api/studio');
    await page.goto('/admin#products'); await page.locator(`tr[data-row-key="${source.id}"]`).getByRole('button', { name: `编辑${source.name}`, exact: true }).click();
    await textButton(page, 'AI翻译').click(); const dialog = page.getByRole('dialog', { name: 'AI翻译产品与文章', exact: true }); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('combobox', { name: '翻译目标语言' })).toBeVisible();
    // 明确只发送介绍与图文，不把型号、其他参数或整站记录默认交给模型。
    for (const checkbox of await dialog.getByRole('checkbox').all()) await checkbox.uncheck();
    await dialog.getByRole('checkbox', { name: /^产品介绍 ·/ }).check(); await dialog.getByRole('checkbox', { name: /^产品图文详情 ·/ }).check();
    const before = await api<StudioEnvelope>(control, '/api/studio');
    const generatedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/translations' && response.request().method() === 'POST');
    await textButton(dialog, '生成翻译预览').click(); const response = await generatedResponse; expect(response.ok()).toBe(true); const proposal = await response.json() as AiTranslationPreview;
    await expect(dialog.getByRole('tab', { name: '核对译文', exact: true })).toHaveAttribute('aria-selected', 'true'); await expect(dialog).toContainText(`DE Supplied ${source.sku} panel 25 mm and 2 kg.`);
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(before.revision);
    // 直接请求服务返回的完整详情URL，避免字段预览通过而真实路由被错误段数限制拦截。
    expect(proposal.beforeUrl).toBeTruthy(); expect(proposal.afterUrl).toBeTruthy();
    for (const path of [proposal.beforeUrl!, proposal.afterUrl!]) expect((await control.get(`${runtime.origin}${path}`)).status()).toBe(200);
    for (const path of [`${proposal.afterUrl}/extra`, proposal.afterUrl!.replace(/\/[^/]+$/, '/different-record'), `/preview/~translation/${proposal.id}/after`]) expect((await control.get(`${runtime.origin}${path}`)).status()).toBe(404);
    // Playwright test instrumentation会补全test.use默认storageState，必须明确覆盖，不能只newContext就称匿名。
    const anonymous = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] }, timeout: 15000 });
    try {
      expect(await anonymous.storageState()).toEqual({ cookies: [], origins: [] });
      const sessionCheck = await anonymous.get(`${runtime.origin}/api/studio`, { maxRedirects: 0 }); expect(sessionCheck.status()).toBe(401);
      const url = `${runtime.origin}${proposal.afterUrl}`, denied = await anonymous.get(url, { maxRedirects: 0 }), html = await denied.text();
      const fieldTexts = (value: unknown): string[] => {
        if (typeof value === 'string') return value.trim() ? [value] : [];
        if (!value || typeof value !== 'object') return [];
        const node = value as { type?: string; text?: string; content?: unknown[] };
        return [...(node.type === 'text' && node.text ? [node.text] : []), ...(node.content || []).flatMap(fieldTexts)];
      };
      const privateValues = [...new Set([proposal.sourceLabel, proposal.targetLabel, proposal.targetId, proposal.targetSku, ...proposal.fields.flatMap(field => [field.source, field.before, field.after].flatMap(fieldTexts))].filter((value): value is string => !!value))];
      // 检查正文与Flight中的原始/转义文本；诊断只记录布尔结果，避免报告再次公开私有译文。
      const leaked = privateValues.map(value => ({ length: value.length, found: [value, JSON.stringify(value).slice(1, -1), value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')].some(candidate => html.includes(candidate)) }));
      const renderedHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
      const noindex = (renderedHtml.match(/<meta\b[^>]*>/gi) || []).some(tag => /\bname=["']robots["']/i.test(tag) && /\bcontent=["'][^"']*\bnoindex\b/i.test(tag));
      const notFound = /<h1\b[^>]*>Page not found<\/h1>/.test(renderedHtml) && renderedHtml.includes('The page you requested is unavailable.');
      const renderedText = renderedHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      await testInfo.attach('translation-anonymous-preview-denial', { body: Buffer.from(JSON.stringify({ emptyStorageVerified: true, studioStatus: sessionCheck.status(), status: denied.status(), title: html.match(/<title>([\s\S]*?)<\/title>/i)?.[1].slice(0, 160) || '', renderedText, redirected: denied.url() !== url, location: denied.headers().location || null, notFound, noindex, privateTextChecks: leaked }, null, 2)), contentType: 'application/json' });
      // 本构建空身份直接返回404；不把Flight内常驻not-found文案当作拒绝证明，也不放宽为未经可见验证的流式200。
      expect(denied.status()).toBe(404); expect(denied.url()).toBe(url); expect(denied.headers().location).toBeUndefined();
      expect(noindex).toBe(true); expect(leaked.every(item => !item.found), '匿名响应不得包含任何候选原文、译文或记录身份').toBe(true);
    } finally { await anonymous.dispose(); }
    ui.allowWrite('POST', `/api/ai/translations/${proposal.id}/apply`); ui.allowWrite('POST', `/api/ai/translations/${proposal.id}/undo`);
    await textButton(dialog, '查看实际页面前后版本').click(); await expect(page.frameLocator('iframe[title="翻译后实际页面"]').frameLocator('iframe[title="网站草稿隔离预览"]').getByText(`DE Supplied ${source.sku} panel 25 mm and 2 kg.`, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 1000 }); await noOverflow(page, dialog);
    // 长Modal的元素全高截图可能包含祖先裁剪空白；截实际可见视口，并确保标题真实在屏幕内。
    const mobileTitle = dialog.getByText('AI翻译产品与文章', { exact: true }); await mobileTitle.scrollIntoViewIfNeeded(); await expect(mobileTitle).toBeInViewport();
    await testInfo.attach('translation-mobile-review', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await textButton(dialog, '保存选中译文到草稿').click(); await page.getByRole('dialog', { name: '保存选中的译文到草稿？', exact: true }).getByRole('button', { name: '确认保存译文', exact: true }).click(); await expect(dialog.getByText('译文已保存到草稿，可在原编辑器继续修改；核对语言状态后再发布。', { exact: true })).toBeVisible();
    const applied = await api<StudioEnvelope>(control, '/api/studio'), translated = applied.state.products.find(item => item.id === proposal.targetId)!; expect(translated.sku).toBe(`${source.sku}-de`); expect(translated.detailContent!.content![1]).toEqual(detail.content[1]); expect(translated.translationState).toBe('needs-review'); expect(applied.activeReleaseId).toBe(original.activeReleaseId);
    // 关闭重开只读恢复记录，不重复调用模型；撤销继续真实版本与引用保护。
    await textButton(dialog, '返回编辑').click(); await expect(dialog).toBeHidden(); await textButton(page, 'AI翻译').click(); await dialog.getByRole('tab', { name: /^最近记录/ }).click(); await textButton(dialog, '查看译文').first().click();
    await textButton(dialog, '撤销本次翻译').click(); await page.getByRole('dialog', { name: '撤销本次翻译？', exact: true }).getByRole('button', { name: '确认撤销翻译', exact: true }).click(); await expect(dialog.getByText('本次翻译已撤销，网站公开版本保持。', { exact: true })).toBeVisible(); expect((await api<StudioEnvelope>(control, '/api/studio')).state.products.some(item => item.id === proposal.targetId)).toBe(false);
    await textButton(dialog, '返回编辑').click(); const name = page.getByRole('textbox', { name: '产品名称', exact: true }); await name.fill('Original product remains freely editable'); await textButton(page, '保存产品').click(); await expect(name).toBeHidden();
    expect((await api<StudioEnvelope>(control, '/api/studio')).state.products.find(item => item.id === source.id)!.name).toBe('Original product remains freely editable');
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/ai/translations' }, { method: 'POST', path: `/api/ai/translations/${proposal.id}/apply` }, { method: 'POST', path: `/api/ai/translations/${proposal.id}/undo` }, { method: 'PATCH', path: '/api/studio' }]);
  } finally {
    await ui.closeOwnedPage(); const current = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { products: original.state.products } });
    if (configured) { const currentProvider = await api<AiProviderSummary>(control, '/api/ai/provider'); await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: currentProvider.revision, enabled: provider.enabled, baseUrl: provider.baseUrl, model: provider.model, allowLocal: provider.allowLocal, visionModel: provider.visionModel || '', clearApiKey: true }); }
    await control.dispose();
  }
});
