import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiProviderSummary } from '../../src/server/ai-provider';
import type { AiBuildPlanRun, AiBuildPreviewRun } from '../../src/lib/ai-build-resume-types';
import { test, expect, runtime, hit, noOverflow, select, textButton } from './fixtures';
import { observePreviewImages } from './visual-preview-images';

async function api<T>(client: APIRequestContext, path: string, method: 'GET' | 'PATCH' | 'POST' = 'GET', data?: unknown): Promise<T> {
  const origin = new URL(runtime.origin);
  expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  const response = await client.fetch(`${runtime.origin}${path}`, { method, timeout: 15000, maxRedirects: 0, headers: { Origin: runtime.origin }, ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

// 真实生产接口和原生页面，只固定本机提供方回复；不会读取真实AI或把合成设计当质量验收。
test('服务站需求解读、三方向真实预览、二次确认与恢复后安全撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth });
  // Playwright会给newContext补默认管理员storageState；匿名上下文必须显式清空，不能误测管理员。
  const anonymous = await playwrightRequest.newContext({storageState:{cookies:[],origins:[]}}), viewer = await playwrightRequest.newContext({ storageState: runtime.viewerAuth });
  const anonymousSession=await anonymous.get(`${runtime.origin}/api/auth/get-session`,{timeout:10000,maxRedirects:0});expect(anonymousSession.status()).toBe(200);expect(await anonymousSession.json()).toBeNull();
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<AiProviderSummary>(control, '/api/ai/provider');
  expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
  let configured = false, seeded = false, applied = false, undone = false, previewId = '', retainedPlanId = '';
  try {
    // 零产品业务必须用真实空原生产品集合，不靠GET夹具伪装服务站输入。
    await api(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { products: [] } }); seeded = true;
    await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: provider.revision, enabled: true, baseUrl: `${runtime.modelOrigin}/v1`, model: 'ui-industry-service-model', allowLocal: true, apiKey: 'ui-design-synthetic' }); configured = true;
    for (const [method, path] of [['POST', '/api/ai/build/plan'], ['POST', '/api/ai/build/plan/retention'], ['POST', '/api/ai/build/plan/revise'], ['POST', '/api/ai/build/preview'], ['POST', '/api/ai/build/apply'], ['POST', '/api/ai/build/undo'], ['PATCH', '/api/studio']] as const) ui.allowWrite(method, path);
    await page.goto('/admin#templates');
    await expect(page.getByRole('tab', { name: 'AI快速建站', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'AI建站公司名称', exact: true }).fill('UI_AI_INDUSTRY_SERVICES');
    await page.getByRole('textbox', { name: 'AI建站所属行业', exact: true }).fill('Professional services; zero physical products');
    await page.getByRole('textbox', { name: 'AI建站业务说明', exact: true }).fill('FICTIONAL DEMO: Three services: market exploration, offer clarity and workflow review. Help buyers clarify their question and contact the practice. Do not invent products, customers, credentials or outcomes. Real contact and team information are missing.');
    await page.getByRole('textbox', { name: 'AI建站目标买家', exact: true }).fill('UK and Irish B2B founders');
    await page.getByRole('textbox', { name: 'AI建站重点市场', exact: true }).fill('UK and Ireland');
    const planResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/build/plan' && response.request().method() === 'POST');
    await page.getByRole('button').filter({ hasText: '生成整站方案' }).click(); expect((await planResponse).ok()).toBe(true);
    await expect(page.getByText('AI 对需求的理解', { exact: true })).toBeVisible();
    await expect(page.getByText('以服务与沟通为主', { exact: true })).toBeVisible();
    await expect(page.getByText('让潜在客户明确服务范围并发起需求沟通', { exact: true })).toBeVisible();
    await page.getByText('必须遵守与待补资料 · 2项要求 / 1项待补', { exact: true }).click();
    await expect(page.getByText('不创建商品目录', { exact: true })).toBeVisible();
    await expect(page.getByText('真实联系资料与团队信息待补', { exact: true })).toBeVisible();
    await expect(page.getByText('Discuss your brief', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'AI建站网址前缀', exact: true }).fill('/industry-services-ui');
    const keepResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/build/plan/retention' && response.request().method() === 'POST');
    await textButton(page, '长期保存方案').click();
    const kept = await keepResponse; expect(kept.ok(), await kept.text()).toBe(true);
    const retained = await kept.json() as AiBuildPlanRun;
    retainedPlanId = retained.planId;
    expect(retained.savedPlan?.prefix).toBe('/industry-services-ui');
    await expect(textButton(page, '方案已长期保存')).toBeDisabled();
    // 只在本次隔离浏览器实例调整测试记录创建时间；服务器实际有效期及恢复路径照常生效。
    expect(runtime.dataDirectory).toMatch(/form-studio-ui-/);
    const database = new Database(join(runtime.dataDirectory!, 'studio.sqlite'), { fileMustExist: true });
    try {
      expect(database.prepare("UPDATE cms_ai_build SET created_at=? WHERE id=? AND kind='plan'").run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), retainedPlanId).changes).toBe(1);
    } finally { database.close(); }
    await page.reload();
    await textButton(page, '继续之前的建站').click();
    const savedRuns = page.getByRole('dialog', { name: '继续之前的建站', exact: true });
    // has 从每条记录向下查找，内部定位器不能再要求包含外层对话框。
    const longPlan = savedRuns.getByRole('listitem').filter({ has: page.getByText('UI_AI_INDUSTRY_SERVICES', { exact: true }) });
    await expect(longPlan.getByText('长期方案', { exact: true })).toBeVisible();
    await textButton(longPlan, '读取方案').click();
    await expect(page.getByRole('textbox', { name: 'AI建站网址前缀', exact: true })).toHaveValue('/industry-services-ui');
    // 同一份模型方案可在手机面板增页、改文案和按钮，并在三个方向的真实网站中沿用。
    await textButton(page, '修改页面、文案和按钮').click();
    const planEditor = page.getByRole('dialog', { name: '修改建站方案', exact: true });
    await expect(planEditor).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await noOverflow(page, planEditor);
    await textButton(planEditor, '新增页面').click();
    // Ant Design 在必填项的可访问名称前带有星号；按实际标签末尾定位，不依赖装饰字符。
    await planEditor.getByRole('textbox', { name: /页面名称$/ }).fill('Quality notes', { timeout: 8000 });
    await planEditor.getByRole('textbox', { name: /页面网址$/ }).fill('/quality-notes', { timeout: 8000 });
    await planEditor.getByRole('textbox', { name: '区块文案', exact: true }).fill('Details supplied and reviewed by our website editor.');
    await textButton(planEditor, '上移页面').click();
    await select(page, '编辑页面', 'Home · /');
    await planEditor.getByRole('textbox', { name: /按钮文案$/ }).fill('Request a reviewed brief', { timeout: 8000 });
    const buttonTarget = planEditor.getByRole('combobox', { name: '按钮目标页面', exact: true });
    await buttonTarget.click();
    await expect(buttonTarget).toHaveAttribute('aria-expanded', 'true');
    const dropdownId = await buttonTarget.getAttribute('aria-controls');
    const popup = page.locator('.ant-select-dropdown:visible').filter({ has: page.locator(`[id="${dropdownId}"]`) });
    const targetOption = popup.getByTitle('Quality notes · /quality-notes', { exact: true });
    // 手机弹层紧贴抽屉底部；先核对真实命中位置，再点击，避免自动滚动让虚拟列表重定位。
    await hit(targetOption);
    const targetBox = (await targetOption.boundingBox())!;
    await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
    await expect(buttonTarget).toHaveAttribute('aria-expanded', 'false');
    await expect(planEditor.getByTitle('Quality notes · /quality-notes', { exact: true })).toBeVisible();
    const reviseResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/build/plan/revise' && response.request().method() === 'POST');
    await textButton(planEditor, '保存方案修改').click();
    const revisedResponse = await reviseResponse;
    expect(revisedResponse.ok(), await revisedResponse.text()).toBe(true);
    const revised = await revisedResponse.json() as AiBuildPlanRun;
    expect(revised.planId).not.toBe(retainedPlanId);
    retainedPlanId = revised.planId;
    expect(revised.savedPlan?.prefix).toBe('/industry-services-ui');
    await expect(planEditor).toBeHidden();
    await page.setViewportSize({ width: 1600, height: 1000 });
    const before = await api<StudioEnvelope>(control, '/api/studio'), structures: string[] = [], mobileStructures: string[] = [];
    for (const [index, name] of ['服务导读', '服务模块', '编号方法'].entries()) {
      const compiledResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/build/preview' && response.request().method() === 'POST');
      await page.getByRole('button', { name: `预览${name}`, exact: true }).click();
      const compiled = await compiledResponse; expect(compiled.ok()).toBe(true);
      const candidate = await compiled.json() as { previewId: string; pages: { slug: string }[] }; previewId = candidate.previewId;
      expect(candidate.pages.map(item => item.slug)).toEqual(['/industry-services-ui', '/industry-services-ui/services', '/industry-services-ui/approach', '/industry-services-ui/quality-notes', '/industry-services-ui/contact']);
      expect(candidate.pages.some(item => item.slug.includes('/products'))).toBe(false);
      const dialog = page.getByRole('dialog', { name: '生成网站的私有预览', exact: true }); await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`正在查看：${name}`);
      const outer = dialog.locator('iframe[title="AI生成网站预览"]'); await outer.scrollIntoViewIfNeeded();
      const actual = dialog.frameLocator('iframe[title="AI生成网站预览"]').frameLocator('iframe[title="网站草稿隔离预览"]');
      await expect(actual.getByRole('heading', { level: 1, name: 'Clarity before your next move.', exact: true })).toBeVisible();
      await expect(actual.getByRole('link').filter({ hasText: /^Request a reviewed brief$/ })).toHaveAttribute('href', `/preview/~ai/${previewId}/industry-services-ui/quality-notes`);
      await expect(actual.locator('.editor-site-products')).toHaveCount(0);
      await expect.poll(async () => (await observePreviewImages(actual.locator('img'))).every(image => !image.intersecting || image.complete && image.naturalWidth > 0)).toBe(true);
      // 比较实际容器树与网格列；不把颜色、字体或随机生成ID计作结构差异。
      structures.push(await actual.locator('.editor-site-page').evaluate(element => JSON.stringify([...element.querySelectorAll('.editor-site-section,.editor-site-slot')].map(node => ({ tag: node.tagName, class: [...node.classList].filter(value => value.startsWith('editor-site-')).sort(), children: node.children.length, columns: getComputedStyle(node).gridTemplateColumns })))));
      // 三个方向都核实际390断点；不能只测最后一个，或把无可见作用的单列包装算成差异。
      await dialog.locator('.ant-segmented-item').filter({ hasText: '手机' }).click();
      await expect(outer).toHaveCSS('width', '390px');
      await expect.poll(() => actual.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await actual.locator('html').evaluate(element => element.ownerDocument.fonts.ready);
      const mobileFacts = await actual.locator('.editor-site-page').evaluate(element => {
        const visible = (node: Element) => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
        const leaves = [...element.querySelectorAll('h1,h2,h3,.editor-site-copy,.editor-site-action,img')].filter(visible).map(node => {
          const box = node.getBoundingClientRect();
          return { role: /^H[1-3]$/.test(node.tagName) ? node.tagName : node.tagName === 'IMG' ? 'image' : node.classList.contains('editor-site-action') ? 'action' : /^\d{2}$/.test(node.textContent?.trim() || '') ? 'ordinal' : 'copy', x: box.x, y: box.y };
        }).sort((a, b) => Math.round(a.y / 3) - Math.round(b.y / 3) || a.x - b.x);
        const grids = [...element.querySelectorAll('.editor-site-slot')].filter(visible).map(node => {
          const columns = getComputedStyle(node).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
          return { columns, items: [...node.children].filter(visible).length };
        }).filter(grid => grid.columns > 1 && grid.items > 1);
        return { flow: leaves.map(leaf => leaf.role), grids };
      });
      mobileStructures.push(JSON.stringify(mobileFacts));
      await testInfo.attach(`service-direction-${index + 1}-mobile-layout`, { body: Buffer.from(JSON.stringify(mobileFacts, null, 2)), contentType: 'application/json' });
      await testInfo.attach(`service-direction-${index + 1}-mobile`, { body: await outer.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
      if (index === 2) {
        await page.setViewportSize({ width: 390, height: 900 }); await noOverflow(page, dialog);
        await testInfo.attach('service-direction-mobile', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
        await page.setViewportSize({ width: 1600, height: 1000 });
      }
      await textButton(dialog, '关闭预览').click();
      if (index < 2) await textButton(page, '返回调整方向').click();
    }
    expect(new Set(structures).size, '同色同字体三方向应有真实容器或网格差异').toBe(3);
    expect(new Set(mobileStructures).size, '手机三方向须有可见顺序或有效轨道差异，单列包装/颜色/字体不计').toBe(3);
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(before.revision);
    // 真实匿名、只读成员及管理员错误Origin均拒绝，且草稿完全不写。
    for (const [client, headers, status] of [[anonymous, { Origin: runtime.origin }, 401], [viewer, { Origin: runtime.origin }, 403], [control, { Origin: 'https://example.invalid' }, 403]] as const) {
      const response = await client.post(`${runtime.origin}/api/ai/build/undo`, { headers, timeout: 10000, maxRedirects: 0, data: { previewId, expectedRevision: before.revision } }); expect(response.status()).toBe(status);
    }
    expect(await api<StudioEnvelope>(control, '/api/studio')).toEqual(before);
    await textButton(page, '保存为草稿并拖拽编辑').click();
    const confirmation = page.getByRole('dialog', { name: '确认保存本次建站草稿？', exact: true }); await expect(confirmation).toBeVisible();
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(before.revision);
    const applyResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/build/apply' && response.request().method() === 'POST');
    await textButton(confirmation, '确认保存建站草稿').click(); expect((await applyResponse).ok()).toBe(true); applied = true;
    await expect(page.locator('.editor-screen')).toBeVisible();
    const saved = await api<StudioEnvelope>(control, '/api/studio'); expect(saved.activeReleaseId).toBe(before.activeReleaseId); expect(saved.state.products).toEqual([]);
    const home = saved.state.pages.find(item => item.slug === '/industry-services-ui')!; expect(home).toBeTruthy(); expect(saved.state.editorData[home.id]).toBeTruthy();
    const quality = saved.state.pages.find(item => item.slug === '/industry-services-ui/quality-notes');
    expect(quality?.title).toBe('Quality notes');
    expect(JSON.stringify(saved.state.editorData[quality!.id])).toContain('Details supplied and reviewed by our website editor.');
    // Puck打开后再确认真实目标图片加载；过早离开会主动取消仍在传输的素材，不能把这种取消藏进审计例外。
    const editorCanvas = page.frameLocator('.editor-canvas iframe'); await expect(editorCanvas.locator('[data-page-id]')).toHaveAttribute('data-page-id', home.id);
    const editorImages = editorCanvas.locator('img'); await expect(editorImages).not.toHaveCount(0);
    for (const image of await editorImages.all()) { await image.scrollIntoViewIfNeeded(); await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true); }
    // 重新挂载并从本人服务端记录读取；不向session注入候选，不再次生成。
    await page.goto('/admin#templates'); await textButton(page, '继续之前的建站').click();
    const runs = page.getByRole('dialog', { name: '继续之前的建站', exact: true }); await textButton(runs, '查看已保存记录').click();
    await expect(page.getByText('本次建站记录', { exact: true })).toBeVisible();
    const read = await api<AiBuildPreviewRun>(control, `/api/ai/build/runs/${previewId}`); expect(read.canUndo).toBe(true);
    await textButton(page, '撤销本次建站').click(); const undoConfirmation = page.getByRole('dialog', { name: '撤销本次建站草稿？', exact: true }); await expect(undoConfirmation).toBeVisible();
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(saved.revision);
    const undoResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/build/undo' && response.request().method() === 'POST');
    await textButton(undoConfirmation, '确认撤销本次建站').click(); expect((await undoResponse).ok()).toBe(true); undone = true;
    await expect(page.getByText('本次建站已撤销。其他内容和公开版本继续保持当前状态。', { exact: true })).toBeVisible();
    const restored = await api<StudioEnvelope>(control, '/api/studio');
    expect(restored.state.pages).toEqual(before.state.pages); expect(restored.state.editorData).toEqual(before.state.editorData); expect(restored.state.products).toEqual([]); expect(restored.state.settings).toEqual(before.state.settings); expect(restored.state.theme).toEqual(before.state.theme); expect(restored.activeReleaseId).toBe(before.activeReleaseId);
    expect(ui.writes.filter(item => item.path === '/api/ai/build/plan')).toHaveLength(1); expect(ui.writes.filter(item => item.path === '/api/ai/build/plan/retention')).toHaveLength(1); expect(ui.writes.filter(item => item.path === '/api/ai/build/plan/revise')).toHaveLength(1); expect(ui.writes.filter(item => item.path === '/api/ai/build/preview')).toHaveLength(3); expect(ui.writes.filter(item => item.path === '/api/ai/build/apply')).toHaveLength(1); expect(ui.writes.filter(item => item.path === '/api/ai/build/undo')).toHaveLength(1);
  } finally {
    await ui.closeOwnedPage();
    if (applied && !undone) { const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/ai/build/undo', 'POST', { previewId, expectedRevision: latest.revision }); }
    if (retainedPlanId) await api(control, '/api/ai/build/plan/retention', 'POST', { planId: retainedPlanId, keep: false });
    if (seeded) { const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { products: original.state.products } }); }
    if (configured) { const latest = await api<AiProviderSummary>(control, '/api/ai/provider'); await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: latest.revision, enabled: false, clearApiKey: true, baseUrl: provider.baseUrl, model: provider.model, allowLocal: provider.allowLocal }); }
    await anonymous.dispose(); await viewer.dispose(); await control.dispose();
  }
});
