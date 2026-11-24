import { test, expect, runtime, go, select, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiSiteDesignPreview, AiSiteDesignRequest } from '../../src/lib/ai-site-design-types';
import type { AiProviderSummary } from '../../src/server/ai-provider';

const aboutId = 'ui-site-about', standaloneId = 'ui-site-standalone';
async function api<T>(control: APIRequestContext, path: string, method: 'GET' | 'PATCH' = 'GET', data?: unknown): Promise<T> {
  const origin = new URL(runtime.origin);
  expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Only the isolated API is allowed');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, headers: { Origin: runtime.origin }, ...(data === undefined ? {} : { data }) }).catch(cause => {
    // Playwright原始运输异常附带认证请求头；报告只保留错误类别和受控路径，不传原cause/call log。
    const category = cause instanceof Error ? cause.message.match(/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND)\b/)?.[0] || (cause.name === 'TimeoutError' ? 'TimeoutError' : 'request failed') : 'request failed';
    throw new Error(`Isolated API transport ${method} ${path}: ${category}`);
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}
function content(headingId: string, title: string, chrome = true): Data {
  return { root: { props: { title, brand: '', showChrome: chrome ? 'yes' : 'no' } }, zones: {}, content: [
    { type: 'Container', props: { id: `${headingId}-section`, content: [
      { type: 'Heading', props: { id: headingId, text: title, level: 'h1', size: 40, mobileSize: 28, style: 'sans', align: 'left', spacing: 0 } },
      { type: 'Text', props: { id: `${headingId}-text`, text: 'Synthetic site design content. No real business claims.', size: 16, align: 'left', maxWidth: 680 } },
      ...(chrome ? [{ type: 'ActionButton', props: { id: `${headingId}-contact`, text: 'Contact the team', href: '#contact', kind: 'outline', align: 'left' } }] : []),
    ], layout: 'column', columns: 1, mobileColumns: 1, gap: 24, padding: 40, inset: 24, background: 'transparent', image: '', minHeight: 0, align: 'start' } },
  ] } as Data;
}
async function countAboveExtra(input: Locator) {
  await expect.poll(() => input.evaluate(element => {
    const item = element.closest('.ant-form-item'), count = item?.querySelector('.ant-input-data-count'), extra = item?.querySelector('.ant-form-item-extra');
    if (!count || !extra) return Infinity;
    const a = count.getBoundingClientRect(), b = extra.getBoundingClientRect();
    return a.height && b.height ? a.bottom - b.top : Infinity;
  }), { message: '整站设计输入的字数计数不能压住说明' }).toBeLessThanOrEqual(0);
}
const modal = (page: Page) => page.getByRole('dialog', { name: 'AI整站设计', exact: true });
async function activatePreviewElement(element: Locator) {
  // Chrome将缩放opaque沙箱的指针错误路由到外层iframe；此处测原生键盘，完整预览另测普通指针。
  await expect(element).toBeVisible(); await element.focus();
  await expect.poll(() => element.evaluate(target => target.ownerDocument.activeElement === target)).toBe(true);
  await element.press('Enter');
}

test('AI整站设计头尾导航、跨页同步、独立页跟随、拖拽往返和撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(140000);
  page.setDefaultTimeout(10000);
  // 独立请求上下文不随浏览器页面关闭而失效；只使用包装器本轮管理员与本机来源。
  // 浏览器交互会跨过服务端5秒闲置期，控制通道显式短连接，避免旧池连接竞态；业务浏览器请求保持默认。
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  try {
  for (const [method, path] of [['PATCH', '/api/studio'], ['POST', '/api/ai/site-designs'], ['POST', '/api/ai/site-designs/apply'], ['POST', '/api/ai/site-designs/undo']] as const) ui.allowWrite(method, path);
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<AiProviderSummary>(control, '/api/ai/provider');
  expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
  const home = original.state.pages.find(item => item.slug === '/'); expect(home).toBeTruthy();
  expect(original.state.pages.some(item => [aboutId, standaloneId].includes(item.id))).toBe(false);
  const now = new Date().toISOString(), layout = { header: { ...original.state.siteLayout?.header, mode: 'default', blockId: '' }, footer: { ...original.state.siteLayout?.footer, mode: 'default', blockId: '' }, menus: original.state.siteLayout?.menus || [] };
  let seeded = false, configured = false, bodyError: unknown;
  try {
    const baseline = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: {
      pages: [...original.state.pages, { id: aboutId, title: 'UI Site About', slug: '/ui-site-about', locale: 'en', status: 'draft', type: '普通页面', updated: now }, { id: standaloneId, title: 'UI Site Standalone', slug: '/ui-site-standalone', locale: 'en', status: 'draft', type: '普通页面', updated: now }],
      editorData: { ...original.state.editorData, [home!.id]: content('ui-site-home-heading', 'UI Site Home'), [aboutId]: content('ui-site-about-heading', 'UI Site About'), [standaloneId]: content('ui-site-standalone-heading', 'UI Site Standalone', false) }, siteLayout: layout,
    } }); seeded = true;
    await go(page, 'global-design');
    await page.getByRole('button', { name: 'AI设计整个网站', exact: true }).click();
    let dialog = modal(page);
    await expect(dialog.getByRole('button', { name: 'AI服务设置', exact: true })).toBeVisible();
    await textButton(dialog, '返回后台').click();
    await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: provider.revision, enabled: true, baseUrl: `${runtime.modelOrigin}/v1`, model: 'ui-site-design-model', allowLocal: true, apiKey: 'ui-design-synthetic' }); configured = true;
    await page.getByRole('button', { name: 'AI设计整个网站', exact: true }).click(); dialog = modal(page);
    await expect(dialog.getByRole('textbox', { name: 'AI整站设计要求', exact: true })).toBeEnabled();
    await textButton(dialog, '范围与保留选项（可选）').click();
    const selected = dialog.getByRole('combobox', { name: '整站设计页面范围', exact: true });
    await selected.focus(); await page.keyboard.press('Backspace');
    for (const name of ['页眉', '页脚', '导航', '全站风格']) { await expect(dialog.getByRole('checkbox', { name, exact: true })).not.toBeChecked(); await expect(dialog.getByRole('checkbox', { name, exact: true })).toBeDisabled(); }
    await textButton(dialog, '选择整个网站').click();
    for (const name of ['页眉', '页脚', '导航', '全站风格']) await expect(dialog.getByRole('checkbox', { name, exact: true })).toBeChecked();
    await textButton(dialog, '范围与保留选项（可选）').click();
    const main = dialog.getByRole('textbox', { name: 'AI整站设计要求', exact: true });
    await main.fill('UI_AI_SITE_DESIGN_FLOW 统一页眉页脚、导航和跨页面风格，让海外采购浏览更清楚；独立页面先保持隐藏头尾。'); await countAboveExtra(main);
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/site-designs' && response.request().method() === 'POST');
    await textButton(dialog, '生成整站设计方案').click();
    const firstHttp = await firstResponse; expect(firstHttp.status(), await firstHttp.text()).toBe(201); const first = await firstHttp.json() as AiSiteDesignPreview;
    expect(firstHttp.request().postDataJSON()).not.toHaveProperty('previewFeedback');
    await expect(dialog).toContainText('我对你想法的理解');
    expect(first.affectedPages.map(item => item.pageId)).toEqual(expect.arrayContaining([home!.id, aboutId, standaloneId]));
    const beforeApply = await api<StudioEnvelope>(control, '/api/studio');
    expect(beforeApply.state.siteLayout).toEqual(baseline.state.siteLayout); expect(beforeApply.state.theme).toEqual(baseline.state.theme); expect(beforeApply.state.editorData).toEqual(baseline.state.editorData);
    const preview = dialog.locator('.ai-design-preview'), frame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    const beforeFrame = dialog.frameLocator('iframe[title="修改前"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(frame.locator('header.editor-site-shared-header')).toBeVisible(); await expect(frame.locator('footer.editor-site-shared-footer')).toBeVisible();
    await expect(frame.getByRole('heading', { name: 'UI Site Home', exact: true })).toBeVisible();
    await expect.poll(() => frame.getByRole('heading', { name: 'UI Site Home', exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(36);
    // 从默认页脚升级为原生区块后，原有#contact联系入口仍指向真实页脚，不能因命名空间而失效。
    const homePreview = first.previewPages.find(item => item.pageId === home!.id)!;
    const full = await page.context().newPage(); full.setDefaultTimeout(10000); await full.setViewportSize({ width: 1280, height: 480 });
    try {
      for (const [side, url] of [['before', homePreview.beforeUrl!], ['after', homePreview.afterUrl!]] as const) {
        await full.goto(url); const actual = full.frameLocator('iframe[title="网站草稿隔离预览"]');
        await expect(actual.locator('footer#contact')).toBeVisible(); await expect(actual.locator('#contact')).toHaveCount(1);
        await actual.locator('a[href="#contact"]').click();
        await expect.poll(() => actual.locator('footer#contact').evaluate(element => { const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; })).toBe(true);
        await testInfo.attach(`site-contact-full-${side}`, { body: await full.screenshot(), contentType: 'image/png' });
        if (side === 'after') {
          await actual.getByRole('link', { name: 'About our factory', exact: true }).click(); await expect(actual.getByRole('heading', { name: 'UI Site About', exact: true })).toBeVisible(); await testInfo.attach('site-navigation-full', { body: Buffer.from(JSON.stringify({ url: full.url() })), contentType: 'application/json' });
          const nativeMenu = actual.getByRole('navigation', { name: 'Website navigation', exact: true }).locator('.site-menu-mobile');
          // 被压成开关宽度的下拉面板仍会报可见，需要核对实际可读空间和指针可达性。
          for (const width of [320, 375, 390]) {
            await full.setViewportSize({ width, height: 844 });
            const toggle = nativeMenu.locator(':scope > summary');
            await expect(toggle).toBeVisible(); await toggle.click(); await expect(nativeMenu).toHaveAttribute('open', '');
            const bounds = await nativeMenu.evaluate(element => {
              const summary = element.querySelector('summary')!, panel = element.querySelector('.site-menu-panel')!, a = summary.getBoundingClientRect(), b = panel.getBoundingClientRect();
              return { toggle: a.toJSON(), panel: b.toJSON(), width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
            });
            expect(bounds.panel.width, `${width}px 手机折叠菜单必须有足够宽度阅读标题`).toBeGreaterThanOrEqual(200);
            expect(bounds.panel.left).toBeGreaterThanOrEqual(0); expect(bounds.panel.right).toBeLessThanOrEqual(bounds.width + 1);
            expect(bounds.panel.top).toBeGreaterThanOrEqual(bounds.toggle.bottom - 1);
            expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
            await testInfo.attach(`site-mobile-navigation-open-geometry-${width}`, { body: Buffer.from(JSON.stringify(bounds, null, 2)), contentType: 'application/json' });
            if (width === 390) await testInfo.attach('site-mobile-navigation-open', { body: await full.screenshot(), contentType: 'image/png' });
            const toAbout = width === 375;
            await nativeMenu.getByRole('link', { name: toAbout ? 'About our factory' : 'Company', exact: true }).click();
            await expect(actual.getByRole('heading', { name: toAbout ? 'UI Site About' : 'UI Site Home', exact: true })).toBeVisible();
            await expect(nativeMenu).not.toHaveAttribute('open', '');
          }
          await testInfo.attach('site-mobile-navigation-full', { body: await full.screenshot(), contentType: 'image/png' });
        }
      }
    } finally { await full.close(); await page.bringToFront(); }
    for (const [current, title] of [[beforeFrame, '修改前'], [frame, 'AI建议']] as const) {
      const outer = dialog.locator(`iframe[title="${title}"]`); await outer.scrollIntoViewIfNeeded();
      await expect(current.locator('footer#contact')).toBeVisible(); await expect(current.locator('#contact')).toHaveCount(1);
      const contactLink = current.locator('a[href="#contact"]'); await expect(contactLink).toHaveCount(1); await expect(contactLink).toContainText('Contact the team');
      const metrics = await contactLink.evaluate(element => { const rect = element.getBoundingClientRect(), footer = document.querySelector('footer#contact')!.getBoundingClientRect(), point = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return { link: rect.toJSON(), footer: footer.toJSON(), innerWidth, innerHeight, scrollX, scrollY, centerHit: { tag: point?.tagName, href: point?.closest('a')?.getAttribute('href'), className: point?.className }, hitLink: point === element || element.contains(point) }; });
      const bounds = await outer.evaluate(element => ({ bounds: element.getBoundingClientRect().toJSON(), computedTransform: getComputedStyle(element).transform, viewportWidth: innerWidth, viewportHeight: innerHeight }));
      await testInfo.attach(`site-contact-inline-${title}`, { body: Buffer.from(JSON.stringify({ metrics, outer: bounds }, null, 2)), contentType: 'application/json' });
      await activatePreviewElement(contactLink);
      await expect.poll(() => current.locator('footer#contact').evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.bottom > 0 && bounds.top < innerHeight; })).toBe(true);
    }
    // 实际点击候选导航，前后对比和选择页应一起切换，不借GET夹具替代跨页渲染。
    const aboutLink = frame.getByRole('link', { name: 'About our factory', exact: true }); await expect(aboutLink).toHaveCount(1);
    await testInfo.attach('site-navigation-inline-before', { body: Buffer.from(JSON.stringify(await aboutLink.evaluate(element => { const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return { href: element.getAttribute('href'), bounds: rect.toJSON(), scrollX, scrollY, innerWidth, innerHeight, centerHitHref: hit?.closest('a')?.getAttribute('href') }; }))), contentType: 'application/json' });
    await activatePreviewElement(aboutLink);
    await expect(frame.getByRole('heading', { name: 'UI Site About', exact: true })).toBeVisible();
    await expect.poll(() => dialog.getByRole('combobox', { name: '整站设计预览页面', exact: true }).evaluate(element => element.closest('.ant-select')?.textContent)).toContain('UI Site About');
    await expect.poll(() => frame.getByRole('heading', { name: 'UI Site About', exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(32);
    await preview.locator('.ant-segmented-item').filter({ hasText: '手机' }).click(); await expect(preview).toContainText('手机基础排版已检查');
    const company = frame.getByRole('navigation', { name: 'Company home', exact: true });
    await expect(company.getByRole('link', { name: baseline.state.settings.name, exact: true })).toBeVisible(); await expect(company.locator('summary')).toHaveCount(0);
    const mainNavigation = frame.getByRole('navigation', { name: 'Website navigation', exact: true }), menu = mainNavigation.locator('.site-menu-mobile'), menuToggle = menu.locator(':scope > summary');
    await expect(menuToggle).toBeVisible();
    await activatePreviewElement(menuToggle); await expect(menu).toHaveAttribute('open', ''); await activatePreviewElement(menuToggle); await expect(menu).not.toHaveAttribute('open', '');
    await testInfo.attach('site-mobile-brand-and-navigation', { body: await dialog.locator('iframe[title="AI建议"]').screenshot(), contentType: 'image/png' });
    await select(page, '整站设计预览页面', 'UI Site Standalone');
    await expect(frame.getByRole('heading', { name: 'UI Site Standalone', exact: true })).toBeVisible(); await expect(frame.locator('header')).toHaveCount(0); await expect(frame.locator('footer')).toHaveCount(0);
    for (const label of ['电脑', '平板', '手机']) { await preview.locator('.ant-segmented-item').filter({ hasText: label }).click(); await expect(preview).toContainText(`${label}基础排版已检查`); }
    await page.setViewportSize({ width: 390, height: 844 });
    const followup = dialog.getByRole('textbox', { name: '继续整站设计要求', exact: true });
    await followup.fill('UI_AI_SITE_CONTINUE 保留其他设计，手机页脚更紧凑；独立页面也使用新页眉，页脚继续隐藏。'); await countAboveExtra(followup);
    await noOverflow(page, dialog); await testInfo.attach('ai-site-design-mobile', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.setViewportSize({ width: 1600, height: 1000 });
    const nextResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/site-designs' && response.request().method() === 'POST');
    await textButton(dialog, '继续调整整站方案').click();
    const nextHttp = await nextResponse; expect(nextHttp.status(), await nextHttp.text()).toBe(201); const next = await nextHttp.json() as AiSiteDesignPreview;
    expect(next.refinement?.baseDesignId).toBe(first.designId); expect(next.refinement?.round).toBe(1);
    const sent = nextHttp.request().postDataJSON() as AiSiteDesignRequest;
    expect(sent.previewFeedback?.length).toBeGreaterThan(0); expect(sent.previewFeedback!.length).toBeLessThanOrEqual(5);
    expect(sent.previewFeedback!.some(item => item.pageId === standaloneId && item.reports.length > 0)).toBe(true);
    expect(sent.previewFeedback!.every(item => sent.targets.pageIds.includes(item.pageId) && item.reports.length <= 3)).toBe(true);
    expect(JSON.stringify(sent.previewFeedback).length).toBeLessThanOrEqual(10000);
    const pending = await api<StudioEnvelope>(control, '/api/studio'); expect(pending.state.editorData).toEqual(baseline.state.editorData); expect(pending.state.siteLayout).toEqual(baseline.state.siteLayout); expect(pending.state.theme).toEqual(baseline.state.theme);
    await expect(frame.getByRole('heading', { name: 'UI Site Standalone', exact: true })).toBeVisible(); await expect(frame.locator('header.editor-site-shared-header')).toBeVisible(); await expect(frame.locator('footer')).toHaveCount(0);
    await select(page, '整站设计预览页面', 'UI Site About');
    await preview.locator('.ant-segmented-item').filter({ hasText: '手机' }).click();
    await expect(frame.locator('footer#contact')).toBeVisible(); await expect(frame.locator('#contact')).toHaveCount(1);
    await expect.poll(() => frame.locator('footer .editor-site-section').first().evaluate(el => parseFloat(getComputedStyle(el).paddingTop))).toBe(24);
    await testInfo.attach('ai-site-design-preview', { body: await dialog.locator('iframe[title="AI建议"]').screenshot(), contentType: 'image/png' });
    await textButton(dialog, '确认应用到网站草稿').click(); await expect(dialog).toContainText('已应用到网站草稿');
    const applied = await api<StudioEnvelope>(control, '/api/studio');
    expect(applied.state.theme.primary).toBe('#2456a6'); expect(applied.state.siteLayout?.header.mode).toBe('block'); expect(applied.state.siteLayout?.footer.mode).toBe('block');
    const h = applied.state.sharedBlocks?.find(block => block.id === applied.state.siteLayout?.header.blockId), f = applied.state.sharedBlocks?.find(block => block.id === applied.state.siteLayout?.footer.blockId); expect(h).toBeTruthy(); expect(f).toBeTruthy();
    const nav = applied.state.siteLayout?.menus?.find(menu => menu.id === applied.state.siteLayout?.header.menuId);
    expect(nav?.items.map(item => item.target?.id)).toEqual(expect.arrayContaining([home!.id, aboutId]));
    expect((applied.state.editorData[standaloneId] as Data).root.props).toMatchObject({ showChrome: 'yes', footerMode: 'hidden' }); expect(applied.activeReleaseId).toBe(original.activeReleaseId);
    const viewApplied = async () => {
      await page.getByRole('button', { name: 'AI设计整个网站', exact: true }).click(); const current = modal(page); await current.getByRole('tab', { name: '设计记录', exact: true }).click(); await current.locator('.ant-list-item').filter({ hasText: next.summary }).first().getByRole('button', { name: '查看方案', exact: true }).click();
      // 先实际读到两侧候选，再离开去编辑；避免用例在文档请求未完成时立即销毁刚创建的预览。
      for (const side of ['修改前', 'AI建议']) await expect(current.frameLocator(`iframe[title="${side}"]`).frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: /^UI Site (?:Home|About|Standalone)$/ })).toBeVisible();
      return current;
    };
    // 两个资产都正常进入原生Puck后返回；不做手改，撤销不得因默认属性补齐而误判冲突。
    for (const [slot, label, block] of [['header', '页眉', h!], ['footer', '页脚', f!]] as const) {
      await textButton(dialog, `拖拽编辑${label}`).click(); await expect(page.locator('.editor-screen')).toBeVisible(); await expect(page.locator('.editor-topbar')).toContainText('同步区块'); await expect(page.locator('.editor-topbar')).toContainText(block.name);
      await page.getByRole('button', { name: '返回页面管理', exact: true }).click(); await expect(page.getByRole('heading', { name: '全站设计', exact: true })).toBeVisible();
      const afterVisit = await api<StudioEnvelope>(control, '/api/studio'); expect(afterVisit.state.sharedBlocks?.find(item => item.id === block.id)?.data, `${slot}无操作往返不产生伪修改`).toEqual(block.data);
      dialog = await viewApplied();
    }
    await textButton(dialog, '撤销本次整站设计').click(); await expect(dialog).toContainText('已撤销本次整站设计');
    const undone = await api<StudioEnvelope>(control, '/api/studio');
    expect(undone.state.editorData).toEqual(baseline.state.editorData); expect(undone.state.siteLayout).toEqual(baseline.state.siteLayout); expect(undone.state.theme).toEqual(baseline.state.theme); expect(undone.state.sharedBlocks || []).toEqual(baseline.state.sharedBlocks || []); expect(undone.activeReleaseId).toBe(original.activeReleaseId);
    await textButton(dialog, '返回后台').click(); await go(page, 'pages'); await page.getByRole('button', { name: 'AI设计整个网站', exact: true }).click(); await expect(modal(page)).toBeVisible(); await expect(modal(page).getByRole('textbox', { name: 'AI整站设计要求', exact: true })).toBeEnabled();
    expect(ui.writes.filter(item => item.path === '/api/ai/site-designs')).toHaveLength(2);
  } catch (cause) {
    bodyError = cause;
    try { await testInfo.attach('site-design-body-failure', { body: Buffer.from(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause), url: page.url(), frames: page.frames().map(item => ({ url: item.url(), parentUrl: item.parentFrame()?.url() })), dialog: await modal(page).count() ? (await modal(page).innerText({ timeout: 1000 })).slice(0, 8000) : '' }, null, 2)), contentType: 'application/json' }); await testInfo.attach('site-design-failure-screen', { body: await page.screenshot({ timeout: 3000 }), contentType: 'image/png' }); } catch { /* 诊断失败不能覆盖原断言。 */ }
    throw cause;
  }
  finally {
    // 清理独立执行，失败单独附证据；不能让关闭后的请求或空闲等待覆盖真正的业务断言。
    const cleanupErrors: string[] = [];
    try { await ui.closeOwnedPage(); } catch (cause) { cleanupErrors.push(`close: ${cause instanceof Error ? cause.message : String(cause)}`); }
    if (configured) try { const current = await api<AiProviderSummary>(control, '/api/ai/provider'); await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: current.revision, enabled: provider.enabled, baseUrl: provider.baseUrl, model: provider.model, allowLocal: provider.allowLocal, clearApiKey: true }); } catch (cause) { cleanupErrors.push(`provider: ${cause instanceof Error ? cause.message : String(cause)}`); }
    if (seeded) try { const current = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, siteLayout: original.state.siteLayout, theme: original.state.theme, sharedBlocks: original.state.sharedBlocks || [] } }); } catch (cause) { cleanupErrors.push(`studio: ${cause instanceof Error ? cause.message : String(cause)}`); }
    await testInfo.attach('site-design-cleanup', { body: Buffer.from(JSON.stringify({ usedIndependentApiContext: true, errors: cleanupErrors }, null, 2)), contentType: 'application/json' });
    if (!bodyError && cleanupErrors.length) throw new Error(`Isolated cleanup failed: ${cleanupErrors.join('; ')}`);
  }
  } finally { await control.dispose(); }
});
