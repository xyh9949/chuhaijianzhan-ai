import { test, expect, runtime, select, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Locator } from '@playwright/test';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiPageEditPreview } from '../../src/lib/ai-page-edit-types';
import type { AiProviderSummary } from '../../src/server/ai-provider';

const pageId = 'ui-ai-design';
async function countAboveExtra(input: Locator) {
  // 检查实际字数计数与说明文字的几何边界，覆盖手机下绝对定位计数压住extra的回归。
  await expect.poll(() => input.evaluate(element => {
    const item = element.closest('.ant-form-item');
    const count = item?.querySelector('.ant-input-data-count'), extra = item?.querySelector('.ant-form-item-extra');
    if (!count || !extra) return Infinity;
    const counterBounds = count.getBoundingClientRect(), extraBounds = extra.getBoundingClientRect();
    return counterBounds.height > 0 && extraBounds.height > 0 ? counterBounds.bottom - extraBounds.top : Infinity;
  }), { message: '字数计数应在说明文字上方，不能重叠' }).toBeLessThanOrEqual(0);
}
async function api<T>(control: APIRequestContext, path: string, method: 'GET' | 'PATCH' = 'GET', data?: unknown): Promise<T> {
  // 独立控制端不受页面关闭影响，只访问包装器创建的临时实例，且每次请求有界。
  const origin = new URL(runtime.origin);
  expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, headers: { Origin: runtime.origin }, timeout: 10000, ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}
function sample(image: string): Data {
  return {
    root: { props: { title: 'UI AI design workspace', brand: '', showChrome: 'no' } }, zones: {},
    content: [
      { type: 'Container', props: { id: 'ui-ai-hero', nodeLabel: '首页介绍区', layout: 'column', columns: 1, mobileColumns: 1, gap: 24, padding: 32, inset: 24, background: '#ffffff', image: '', minHeight: 0, align: 'start', content: [
        { type: 'Heading', props: { id: 'ui-ai-heading', text: 'UI synthetic factory', level: 'h1', size: 40, mobileSize: 28, align: 'left', style: 'sans', spacing: 0 } },
        { type: 'Text', props: { id: 'ui-ai-copy', text: 'Synthetic company information for design workflow verification.', size: 16, align: 'left', maxWidth: 600 } },
        { type: 'Image', props: { id: 'ui-ai-image', src: image, alt: 'Synthetic local preview image', height: 240, fit: 'cover', radius: 0 } },
      ] } },
      { type: 'ProductList', props: { id: 'ui-ai-loop', nodeLabel: 'AI产品卡片区', eyebrow: 'SYNTHETIC PRODUCTS', title: 'UI current products', columns: 3, mobileColumns: 1, count: 3, category: '', padding: 32 } },
    ],
  } as Data;
}

test('AI设计真实预览、手机继续调整、采用、原生卡片编辑和撤销闭环', async ({ page, ui }, testInfo) => {
  test.setTimeout(100000); page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ baseURL: runtime.origin, storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  for (const [method, path] of [['PATCH', '/api/studio'], ['POST', '/api/ai/edits'], ['POST', '/api/ai/edits/apply'], ['POST', '/api/ai/edits/undo']] as const) ui.allowWrite(method, path);
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const provider = await api<AiProviderSummary>(control, '/api/ai/provider');
  // 隔离运行不应带入任何真实凭据；若种子边界变化则先失败，不覆盖未知密钥。
  expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
  expect(original.state.pages.some(item => item.id === pageId)).toBe(false);
  const image = original.state.media.find(item => item.id === runtime.fixture.mediaId)?.url || '/images/chair.jpg';
  let seeded = false, configured = false, bodyFailure: unknown;
  try {
    await api(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { pages: [...original.state.pages, { id: pageId, title: 'UI AI design workspace', slug: '/ui-ai-design-workspace', status: 'draft', type: '普通页面', locale: 'en', updated: new Date().toISOString() }], editorData: { ...original.state.editorData, [pageId]: sample(image) } } }); seeded = true;
    // 页面恢复仅作用于后台顶层，不能在无存储权限的预览沙箱中读取sessionStorage。
    await page.addInitScript(id => { if (window.top !== window) return; sessionStorage.setItem('form-studio:active-page', id); sessionStorage.removeItem('form-studio:editing-shared-block'); sessionStorage.removeItem('form-studio:loop-card-origin'); }, pageId);
    // 编辑器使用独立全屏布局，不能等待普通后台页面的shell-layout。
    await page.goto('/admin#editor');
    await expect(page.locator('.editor-screen')).toBeVisible();
    await page.getByRole('button', { name: 'AI调整页面或区块', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'AI设计助手 · UI AI design workspace', exact: true });
    await expect(dialog.getByRole('button', { name: 'AI服务设置', exact: true })).toBeVisible();
    await expect(dialog).toContainText('你说想法，AI帮你设计排版');
    await textButton(dialog, '返回编辑器').click();
    await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: provider.revision, enabled: true, baseUrl: `${runtime.modelOrigin}/v1`, model: 'ui-design-model', allowLocal: true, apiKey: 'ui-design-synthetic' }); configured = true;
    await page.getByRole('button', { name: 'AI调整页面或区块', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'AI设计助手 · UI AI design workspace', exact: true });
    await dialog.getByRole('textbox', { name: 'AI调整要求', exact: true }).fill('UI_AI_DESIGN_FLOW 让首页面向海外采购更专业，重新设计动态产品卡片，手机也方便阅读。');
    await countAboveExtra(dialog.getByRole('textbox', { name: 'AI调整要求', exact: true }));
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/edits' && response.request().method() === 'POST');
    await textButton(dialog, '生成调整方案').click();
    const firstHttp = await firstResponse; expect(firstHttp.status()).toBe(201); const first = await firstHttp.json() as AiPageEditPreview;
    await expect(dialog).toContainText('我对你想法的理解');
    await expect(dialog.getByRole('textbox', { name: '继续调整要求', exact: true })).toBeVisible();
    const beforeApply = await api<StudioEnvelope>(control, '/api/studio');
    expect((beforeApply.state.editorData[pageId] as Data).content[1].type).toBe('ProductList');
    expect(beforeApply.state.sharedBlocks).toEqual(original.state.sharedBlocks);
    const preview = dialog.locator('.ai-design-preview');
    const frame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(frame.getByText(runtime.fixture.longName, { exact: true }).first()).toBeVisible();
    await expect(frame.locator('[data-shared-block-id]').first()).toBeVisible();
    for (const label of ['电脑', '平板', '手机']) {
      await preview.locator('.ant-segmented-item').filter({ hasText: label }).click();
      await expect(preview).toContainText(`${label}基础排版已检查`);
      await expect(frame.locator('[data-loop-record="p1"]')).toBeVisible();
      // 双层缩放iframe不使用Playwright的stable滚动等待；原生瞬时滚动后仍核对可见与完整图片加载。
      const productImage = frame.locator('[data-loop-record="p1"] img').first();
      await productImage.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await expect(productImage).toBeVisible();
      await expect.poll(() => productImage.evaluate(element => { const image = element as HTMLImageElement; return image.complete && image.naturalWidth > 0; }), { message: `${label}动态产品图片应真实加载` }).toBe(true);
      if (label !== '平板') await testInfo.attach(`ai-design-preview-${label === '电脑' ? 'desktop' : 'mobile'}`, { body: await dialog.locator('iframe[title="AI建议"]').screenshot(), contentType: 'image/png' });
    }
    await noOverflow(page, dialog);
    // 后台本身也用真实手机视口验证；只切换浏览器尺寸，不改变页面DOM或绕过交互。
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog.getByRole('textbox', { name: '继续调整要求', exact: true })).toBeVisible();
    await expect(textButton(dialog, '确认应用到草稿')).toBeEnabled();
    await textButton(dialog, '确认应用到草稿').scrollIntoViewIfNeeded();
    await expect(textButton(dialog, '确认应用到草稿')).toBeInViewport();
    await expect(dialog.getByRole('combobox', { name: '继续调整屏幕', exact: true })).toBeEnabled();
    await dialog.getByRole('textbox', { name: '继续调整要求', exact: true }).fill('UI_AI_CONTINUE 保留这版首页和产品卡片，手机上留白再紧凑一点。');
    await countAboveExtra(dialog.getByRole('textbox', { name: '继续调整要求', exact: true }));
    await expect(textButton(dialog, '继续调整这版')).toBeEnabled();
    await textButton(dialog, '继续调整这版').scrollIntoViewIfNeeded();
    await expect(textButton(dialog, '继续调整这版')).toBeInViewport();
    await noOverflow(page, dialog);
    await testInfo.attach('ai-design-admin-mobile', { body: await page.screenshot(), contentType: 'image/png' });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(preview).toContainText('手机基础排版已检查');
    await dialog.getByRole('textbox', { name: '继续调整要求', exact: true }).fill('UI_AI_CONTINUE 保留这版首页和产品卡片，手机上留白再紧凑一点。');
    await select(page, '继续调整屏幕', '只调手机');
    const nextResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/edits' && response.request().method() === 'POST');
    await textButton(dialog, '继续调整这版').click();
    const nextHttp = await nextResponse; expect(nextHttp.status()).toBe(201); const next = await nextHttp.json() as AiPageEditPreview;
    expect(next.refinement?.baseEditId).toBe(first.editId);
    expect(next.refinement?.round).toBe(1);
    expect(nextHttp.request().postDataJSON().viewport).toBe('mobile');
    expect(nextHttp.request().postDataJSON().previewFeedback).toHaveLength(3);
    await expect(dialog).toContainText('第1轮调整');
    const afterRefine = await api<StudioEnvelope>(control, '/api/studio');
    expect(afterRefine.state.editorData).toEqual(beforeApply.state.editorData);
    expect(afterRefine.state.sharedBlocks).toEqual(beforeApply.state.sharedBlocks);
    await expect(frame.getByText(runtime.fixture.longName, { exact: true }).first()).toBeVisible();
    await textButton(dialog, '确认应用到草稿').click();
    await expect(dialog).toContainText('已应用，可在7天内撤销');
    const applied = await api<StudioEnvelope>(control, '/api/studio');
    const appliedData = applied.state.editorData[pageId] as Data;
    expect(appliedData.content[0].props.design.desktop.paddingTop).toBe(64);
    expect(appliedData.content[0].props.design.mobile.paddingTop).toBe(18);
    const loop = appliedData.content[1]; expect(loop.type).toBe('ContentLoop');
    expect(applied.state.sharedBlocks?.some(block => block.id === loop.props.itemBlockId)).toBe(true);
    expect(applied.activeReleaseId).toBe(original.activeReleaseId);
    await textButton(dialog, '返回编辑器').click();
    await page.locator('.editor-left-panel').getByRole('tab', { name: /图层/ }).click();
    await page.getByRole('treeitem').filter({ hasText: 'AI产品卡片区' }).click();
    await page.getByRole('button', { name: '编辑卡片设计', exact: true }).click();
    await expect(page.locator('.editor-topbar')).toContainText('循环卡片');
    await expect(page.getByRole('button', { name: '返回来源页面', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回来源页面', exact: true }).click();
    await expect(page.locator('.editor-topbar')).not.toContainText('循环卡片');
    const afterCardVisit = await api<StudioEnvelope>(control, '/api/studio');
    const expectedCardData = applied.state.sharedBlocks?.find(block => block.id === loop.props.itemBlockId)?.data;
    const actualCardData = afterCardVisit.state.sharedBlocks?.find(block => block.id === loop.props.itemBlockId)?.data;
    // 记录有界字段差异，定位只打开Puck后出现的默认值规范化；不能把撤销409当成成功。
    const cardDifferences: { path: string; before: unknown; after: unknown }[] = [];
    let visited = 0, omitted = 0;
    const brief = (value: unknown) => value === undefined ? '[missing]' : typeof value === 'string' ? value.slice(0, 240) : typeof value === 'object' && value !== null ? JSON.stringify(value).slice(0, 240) : value;
    const compare = (before: unknown, after: unknown, path: string) => {
      if (Object.is(before, after)) return;
      if (++visited > 1000) { omitted++; return; }
      if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
        const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
        for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) compare(left[key], right[key], `${path}.${key}`);
      } else if (cardDifferences.length < 40) cardDifferences.push({ path: path.slice(0, 200), before: brief(before), after: brief(after) });
      else omitted++;
    };
    compare(expectedCardData, actualCardData, 'data');
    await testInfo.attach('ai-card-after-native-editor-diff', { body: Buffer.from(JSON.stringify({ cardId: loop.props.itemBlockId, expectedPresent: expectedCardData !== undefined, actualPresent: actualCardData !== undefined, differences: cardDifferences, omitted }, null, 2)), contentType: 'application/json' });
    expect(actualCardData, '仅打开原生卡片编辑再返回应保持卡片内容').toEqual(expectedCardData);
    await page.getByRole('button', { name: 'AI调整页面或区块', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'AI设计助手 · UI AI design workspace', exact: true });
    await dialog.getByRole('tab', { name: '看效果与继续调整', exact: true }).click();
    await textButton(dialog, '撤销这次AI修改').click();
    await expect(dialog).toContainText('已撤销这次AI修改，其他页面和资料保留');
    const undone = await api<StudioEnvelope>(control, '/api/studio');
    expect(undone.state.editorData[pageId]).toEqual(beforeApply.state.editorData[pageId]);
    expect(undone.state.sharedBlocks || []).toEqual(beforeApply.state.sharedBlocks || []);
    expect(undone.activeReleaseId).toBe(original.activeReleaseId);
    expect(ui.writes.filter(item => item.path === '/api/ai/edits')).toHaveLength(2);
  } catch (cause) {
    bodyFailure = cause;
    // 先留真实失败界面，清理错误不能盖掉最初的动作/断言失败；不记录Cookie、口令或请求头。
    try { await testInfo.attach('ai-design-primary-failure-screen', { body: await page.screenshot({ animations: 'disabled', timeout: 3000 }), contentType: 'image/png' }); } catch { /* 截图失败仍保留原异常。 */ }
    throw cause;
  } finally {
    const errors: string[] = [];
    // 先卸载自己拥有的画布，阻止旧自动保存；独立控制端继续恢复模型和草稿，分别记录失败。
    try { await ui.closeOwnedPage(); } catch { errors.push('owned-page-close'); }
    if (configured) try { const latest = await api<AiProviderSummary>(control, '/api/ai/provider'); await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: latest.revision, enabled: provider.enabled, baseUrl: provider.baseUrl, model: provider.model, allowLocal: provider.allowLocal, clearApiKey: true }); } catch { errors.push('provider-restore'); }
    if (seeded) try { const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, sharedBlocks: original.state.sharedBlocks || [] } }); } catch { errors.push('draft-restore'); }
    await testInfo.attach('ai-design-cleanup', { body: Buffer.from(JSON.stringify({ errors, primaryFailurePreserved: !!bodyFailure })), contentType: 'application/json' });
    await control.dispose(); if (!bodyFailure && errors.length) throw new Error(`AI design cleanup failed: ${errors.join(', ')}`);
  }
});
