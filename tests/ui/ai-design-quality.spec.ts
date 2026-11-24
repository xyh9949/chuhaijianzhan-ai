import { request as playwrightRequest, type APIRequestContext, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComponentData } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { Product, MediaItem } from '../../src/lib/types';
import type { AiSiteBrief, AiSitePlan } from '../../src/lib/ai-builder-types';
import { compileAiSitePlan, normalizeAiSitePlan } from '../../src/lib/ai-site-generator';
import { test, expect, runtime, noOverflow, go } from './fixtures';

type Supplied = { id: string; fictional: true; brief: AiSiteBrief; plan: AiSitePlan; products: Product[]; media: MediaItem[] };
const supplied = JSON.parse(readFileSync(resolve('tests/fixtures/ai-quality-plans.json'), 'utf8')) as Supplied[];
async function api<T>(client: APIRequestContext, path = '/api/studio', method: 'GET' | 'PATCH' = 'GET', data?: unknown): Promise<T> {
  expect(new URL(runtime.origin).port).not.toBe('3200'); const response = await client.fetch(runtime.origin + path, { method, headers: { Origin: runtime.origin }, timeout: 15000, ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true); return response.json() as Promise<T>;
}
function detailNode(data: unknown): ComponentData | undefined {
  if (Array.isArray(data)) return data.map(detailNode).find(Boolean);
  if (!data || typeof data !== 'object') return undefined;
  const node = data as ComponentData; if (node.type === 'ProductDetail') return node;
  return Object.values(data).map(detailNode).find(Boolean);
}
async function loadImages(frame: FrameLocator, page: Page) {
  for (const image of await frame.locator('img').all()) { await image.scrollIntoViewIfNeeded(); await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true); }
  // 等当前真实iframe及宿主所用字体完成，再正常离页；不将被取消请求加入忽略名单。
  await frame.locator('html').evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
async function visibleThroughFrames(locator: Locator) {
  return locator.evaluate(element => new Promise<boolean>(done => { const observer = new IntersectionObserver(entries => { observer.disconnect(); done(entries[0].isIntersecting); }); observer.observe(element); }));
}
async function open(page: Page, path: string) { await page.goto(path); const frame = page.frameLocator('iframe[title="网站草稿隔离预览"]'); await expect(frame.locator('.editor-site')).toBeVisible(); return frame; }
async function choose(page: Page, combo: Locator, label: string) {
  await combo.click(); const id = await combo.getAttribute('aria-controls'); expect(id).toBeTruthy();
  const popup = page.locator('.ant-select-dropdown:visible').filter({ has: page.locator(`[id="${id}"]`) }); const option = popup.getByTitle(label, { exact: true }); await expect(option).toBeVisible(); await option.hover(); await option.click();
}
/** 普通API只预置可编辑原生fixture，不将预置数据冒称模型采用；模型/确认撤销链由industry用例另验。 */
async function seed(client: APIRequestContext, original: StudioEnvelope, item: Supplied) {
  const prefix = `/ui-quality-${item.id}`;
  // 素材URL全站唯一；复用已有ID并映射规划引用，避免破坏原站素材绑定。
  const media = [...original.state.media], mediaIds = new Map<string, string>(), mediaUrls = new Map<string, string>();
  for (const suppliedMedia of item.media) {
    let actual = media.find(value => value.url === suppliedMedia.url);
    if (!actual) {
      // 缺少的随包图片走真实上传接口，使用服务端生成的不可变素材信息。
      expect(suppliedMedia.url).toMatch(/^\/images\/[\w.-]+\.(?:png|jpg)$/);
      const current = await api<StudioEnvelope>(client), response = await client.post(runtime.origin + '/api/media', { headers: { Origin: runtime.origin }, timeout: 30000, multipart: { expectedRevision: String(current.revision), folder: 'Fictional quality regression', file: { name: suppliedMedia.name, mimeType: suppliedMedia.url.endsWith('.png') ? 'image/png' : 'image/jpeg', buffer: readFileSync(resolve('public', suppliedMedia.url.slice(1))) } } });
      expect(response.status(), await response.text()).toBe(201);
      actual = ((await response.json()) as StudioEnvelope & { media: MediaItem }).media; media.push(actual);
    }
    mediaIds.set(suppliedMedia.id, actual.id); mediaUrls.set(suppliedMedia.url, actual.url);
  }
  const products = item.products.map((product, index) => { const mapped = { ...product, image: mediaUrls.get(product.image) ?? product.image, ...(product.images ? { images: product.images.map(url => mediaUrls.get(url) ?? url) } : {}) }; return { ...mapped, id: `ui-quality-${item.id}-${index}`, slug: `ui-quality-${item.id}-${index}`, status: 'draft' as const, locale: 'en', ...(index === 1 ? { image: '/images/chair.jpg', images: ['/images/chair.jpg', '/images/interior.jpg'] } : {}) }; });
  const plan = { ...item.plan, pages: item.plan.pages.map(page => ({ ...page, sections: page.sections.map(section => section.mediaId ? { ...section, mediaId: mediaIds.get(section.mediaId) ?? section.mediaId } : section) })) };
  // 原有合成记录保留ID供旧绑定使用，以已有de语言分开本次en示例目录。
  const source = { ...original.state, products: [...products, ...original.state.products.map(product => ({ ...product, locale: 'de' }))], media, settings: { ...original.state.settings, email: '' } };
  const compiled = compileAiSitePlan(normalizeAiSitePlan(plan, item.brief), 'catalog', source, prefix), patch = { ...compiled.patch };
  const currentDetail = source.pages.find(page => page.slug === '/products/:slug');
  const generatedTemplate = patch.pageTemplates?.find(template => !source.pageTemplates?.some(old => old.id === template.id) && template.kind === 'product');
  if (currentDetail && generatedTemplate) patch.editorData = { ...patch.editorData, [currentDetail.id]: generatedTemplate.data };
  // 几何测试明确预置详情布局；不激活/发布模板，不额外留下未采用模板资产。
  delete patch.pageTemplates;
  const current = await api<StudioEnvelope>(client); await api(client, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { ...patch, products: source.products, media: source.media, settings: source.settings } });
  const saved = await api<StudioEnvelope>(client), detail = saved.state.pages.find(page => page.slug === '/products/:slug')!;
  expect(detail).toBeTruthy(); return { prefix, products, saved, detail, node: detailNode(saved.state.editorData[detail.id])! };
}
async function restore(client: APIRequestContext, original: StudioEnvelope) {
  const latest = await api<StudioEnvelope>(client);
  // 生成页与其共享头尾、菜单和目录卡片在同一版本恢复，避免临时页面删除后残留悬空链接。
  await api(client, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: {
    pages: original.state.pages, editorData: original.state.editorData, products: original.state.products,
    media: original.state.media, settings: original.state.settings, forms: original.state.forms || [],
    sharedBlocks: original.state.sharedBlocks || [],
    siteLayout: original.state.siteLayout || { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: [] },
  } });
}

test('历史制造与家居规划真实回放：Furniture不拆词、手机20基线、动态详情身份及行动优先', async ({ page, ui }, testInfo) => {
  test.setTimeout(120000); const client = await playwrightRequest.newContext({ storageState: runtime.adminAuth }), original = await api<StudioEnvelope>(client);
  try {
    for (const item of supplied) {
      const ready = await seed(client, original, item);
      await page.setViewportSize({ width: 1280, height: 960 }); let frame = await open(page, `/preview${ready.prefix}`); const heading = frame.getByRole('heading', { level: 1 }); await expect(heading).toHaveCount(1);
      if (item.id === 'home-brand') {
        await expect(heading).toContainText('Furniture'); const pieces = await heading.evaluate(element => { const text = element.firstChild; if (!text) return 0; const at = text.textContent?.indexOf('Furniture') ?? -1; if (at < 0) return 0; const range = document.createRange(); range.setStart(text, at); range.setEnd(text, at + 9); return range.getClientRects().length; }); expect(pieces).toBe(1);
      }
      await loadImages(frame, page); await page.evaluate(() => scrollTo(0, 0)); await testInfo.attach(`${item.id}-home-desktop`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
      await page.setViewportSize({ width: 390, height: 960 }); await page.evaluate(() => scrollTo(0, 0)); await noOverflow(page); await expect.poll(() => frame.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const intro = heading.locator('xpath=ancestor::section[1]');
      for (const target of [heading, intro.locator('.editor-site-copy').first(), intro.locator('.editor-site-action').first()]) { await expect(target).toBeVisible(); const box = await target.boundingBox(); expect(box).toBeTruthy(); expect(Math.abs(box!.x - 20)).toBeLessThanOrEqual(2); }
      await testInfo.attach(`${item.id}-home-mobile`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' }); await loadImages(frame, page);
      // 原图的HTML高度只用于尺寸提示，不能把默认卡片拉成长图；真实动态资料和链接仍保留。
      for (const photo of await frame.locator('.editor-site-content-list .editor-site-product img').all()) {
        const bounds=await photo.boundingBox(); expect(bounds).toBeTruthy(); expect(bounds!.width).toBeGreaterThan(0);
        expect(Math.abs(bounds!.height-bounds!.width*1.1), '默认产品卡片保持既定4:4.4画幅，不能继承原图像素高度').toBeLessThanOrEqual(2);
      }
      for (const product of ready.products.slice(0, 2)) {
        frame = await open(page, `/preview/products/${product.slug}`); const identity = frame.locator('.editor-site-detail-identity'), photo = frame.locator('.editor-site-detail>img,.editor-site-detail>.editor-product-gallery'), name = identity.locator('h1'), reference = identity.locator('dd'), action = identity.locator('.editor-site-action');
        await expect(name).toHaveText(product.name); await expect(reference).toHaveText(product.sku); await expect(frame.locator('h1')).toHaveCount(1); await expect(action).toHaveAttribute('href', `/preview${ready.prefix}/contact`);
        const bounds = await Promise.all([name.boundingBox(), reference.boundingBox(), action.boundingBox(), photo.boundingBox()]); expect(bounds.every(Boolean)).toBe(true); for (const box of bounds.slice(0, 3)) expect(box!.y + box!.height).toBeLessThanOrEqual(bounds[3]!.y);
        expect(await visibleThroughFrames(name)).toBe(true); expect(await visibleThroughFrames(reference)).toBe(true); expect(await visibleThroughFrames(action)).toBe(true); await noOverflow(page); await expect.poll(() => frame.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await loadImages(frame, page); await page.evaluate(() => scrollTo(0, 0)); await testInfo.attach(`${item.id}-${product.id}-detail-mobile`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
      }
    }
    expect(ui.writes).toEqual([]);
  } finally { await ui.closeOwnedPage(); await restore(client, original); await client.dispose(); }
});

test('产品详情原生Puck配置：清空方向按钮色恢复主题、非法半色不保存、顺序可切换且真实资料保留', async ({ page, ui }) => {
  test.setTimeout(90000); const client = await playwrightRequest.newContext({ storageState: runtime.adminAuth }), original = await api<StudioEnvelope>(client);
  try {
    const ready = await seed(client, original, supplied.find(item => item.id === 'home-brand')!); ui.allowWrite('PATCH', '/api/studio');
    await go(page, 'pages'); await page.locator(`tr[data-row-key="${ready.detail.id}"]`).getByRole('button', { name: `编辑${ready.detail.title}`, exact: true }).click(); await expect(page.locator('.editor-screen')).toBeVisible();
    await page.locator('.editor-left-panel').getByRole('tab', { name: /图层/ }).click(); await page.getByRole('treeitem').filter({ hasText: 'ProductDetail' }).click();
    const input = page.getByRole('textbox', { name: '联系按钮颜色', exact: true }); await expect(input).toBeVisible(); await input.fill(''); await input.press('Tab');
    await expect.poll(async () => detailNode((await api<StudioEnvelope>(client)).state.editorData[ready.detail.id])?.props.ctaColor).toBe('');
    const cleared = await api<StudioEnvelope>(client); await input.fill('#fff'); await input.press('Tab'); await expect(page.getByText('请输入六位颜色，例如 #653f31；或清空恢复默认。', { exact: true })).toBeVisible(); expect((await api<StudioEnvelope>(client)).revision).toBe(cleared.revision);
    await input.fill('#224466'); await input.press('Tab'); await expect.poll(async () => detailNode((await api<StudioEnvelope>(client)).state.editorData[ready.detail.id])?.props.ctaColor).toBe('#224466');
    const field = page.locator('.editor-property').filter({ has: page.getByText('手机详情顺序', { exact: true }) }); await choose(page, field.getByRole('combobox'), '图片优先（原有方式）');
    await expect.poll(async () => detailNode((await api<StudioEnvelope>(client)).state.editorData[ready.detail.id])?.props.mobileOrder).toBe('image-first');
    await choose(page, field.getByRole('combobox'), '产品信息优先'); await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(page.locator('.editor-statusbar')).toContainText('草稿已保存');
    const saved = await api<StudioEnvelope>(client), node = detailNode(saved.state.editorData[ready.detail.id])!; expect(node.props.mobileOrder).toBe('identity-first'); expect(node.props.ctaColor).toBe('#224466'); expect(saved.state.products).toEqual(ready.saved.state.products); expect(saved.activeReleaseId).toBe(original.activeReleaseId);
    await loadImages(page.frameLocator('.editor-canvas iframe'), page); await page.setViewportSize({ width: 390, height: 960 }); await page.evaluate(() => document.fonts.ready); const preview = await open(page, `/preview/products/${ready.products[0].slug}`); const action = preview.locator('.editor-site-detail-identity .editor-site-action'); await expect(action).toHaveCSS('background-color', 'rgb(34, 68, 102)'); await expect(action).toHaveAttribute('href', `/preview${ready.prefix}/contact`); await expect(preview.locator('.editor-site-detail-identity h1')).toHaveText(ready.products[0].name); await loadImages(preview, page);
  } finally { await ui.closeOwnedPage(); await restore(client, original); await client.dispose(); }
});
