import { request as playwrightRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { getProductPath } from '../../src/lib/content-routes';
import { localeOf } from '../../src/lib/localization';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { Product } from '../../src/lib/types';
import { expect, go, hit, noOverflow, runtime, test, textButton } from './fixtures';

const versions = { v1: '双标签实测 V1', v2: '双标签实测 V2 仅发布产品甲' };
const release = (page: Page, title: string) => page.locator('.sys-release-item').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const activation = (page: Page) => page.getByRole('dialog', { name: /^切换公开网站到/ });
const currentVersion = (page: Page, title: string) => release(page, title).getByText('当前公开版本', { exact: true });
const cancel = (dialog: Locator) => dialog.getByRole('button', { name: /^取\s*消$/ });

async function api<T>(client: APIRequestContext, path: string, method = 'GET', data?: unknown) {
  const response = await client.fetch(`${runtime.origin}${path}`, { method, ...(data ? { data } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function editProduct(page: Page, product: Product, name: string) {
  await go(page, 'products');
  await page.getByRole('button', { name: product.name, exact: true }).click();
  await page.getByPlaceholder('例如：Arc 弧线休闲椅').fill(name);
  const response = page.waitForResponse(result => result.request().method() === 'PATCH' && new URL(result.url()).pathname === '/api/studio');
  await textButton(page, '保存产品').click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
}

async function openPublish(page: Page, title: string, products: { name: string; locale: string }[]) {
  await textButton(page, '发布更改').click();
  const dialog = page.getByRole('dialog', { name: '发布网站更新' });
  await dialog.locator('#release-title').fill(title);
  const section = dialog.getByRole('button', { name: /^产品资料 · 已选/ });
  if (await section.getAttribute('aria-expanded') === 'false') await section.click();
  for (const product of products) await dialog.getByRole('checkbox', { name: `${product.name} · ${product.locale}`, exact: true }).check();
  await textButton(dialog, '检查所选内容').click();
  const link = dialog.getByRole('link', { name: '预览本次发布内容', exact: true });
  await expect(link).toBeVisible();
  return { dialog, link, href: (await link.getAttribute('href'))! };
}

async function openPreview(page: Page, link: Locator) {
  // 新标签使用 noopener，按当前会话的新页面事件捕获，不依赖父窗口引用。
  const [preview] = await Promise.all([page.context().waitForEvent('page', { timeout: 10_000 }), link.click()]);
  await expect(preview.frameLocator('iframe[title="网站草稿隔离预览"]').locator('body')).toBeVisible();
  return preview;
}

async function expectProduct(page: Page, path: string, name: string, inPreview = false) {
  const response = await page.goto(`${runtime.origin}${path}`, { waitUntil: 'load' });
  expect(response?.status()).toBe(200);
  const target = inPreview ? page.frameLocator('iframe[title="网站草稿隔离预览"]') : page;
  await expect(target.getByRole('heading', { name, exact: true }).first()).toBeVisible();
}

test('实操双标签发布预览独立，过时回退可读取新版本并重新确认', async ({ page, context, browser, ui }, testInfo) => {
  test.setTimeout(120_000);
  context.setDefaultTimeout(12_000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin } });
  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const external: string[] = [];
  await visitor.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === runtime.origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    external.push(url.origin); return route.abort();
  });
  const customer = await visitor.newPage();
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const [a, b] = ['p2', 'p4'].map(id => original.state.products.find(product => product.id === id)!);
  const pathA = getProductPath(original.state, a)!;
  const pathB = getProductPath(original.state, b)!;
  const nextA = 'Publication draft A for V2';
  const nextB = 'Publication draft B kept private';
  const selection = (product: Product, name = product.name) => ({ name, locale: localeOf(original.state.settings, product) });
  let tab: Page | undefined, previewA: Page | undefined, previewB: Page | undefined;
  ui.allowWrite('POST', '/api/releases/preview');
  ui.allowWrite('POST', '/api/releases');
  ui.allowWrite('PATCH', '/api/studio');
  try {
    await page.setViewportSize({ width: 390, height: 900 });
    await customer.setViewportSize({ width: 390, height: 900 });
    await go(page, 'releases');
    const first = await openPublish(page, versions.v1, [selection(a), selection(b)]);
    await textButton(first.dialog, '确认更新网站').click();
    await expect(currentVersion(page, versions.v1)).toBeVisible();
    const v1 = (await api<StudioEnvelope>(control, '/api/studio')).activeReleaseId!;
    expect(v1).not.toBe(original.activeReleaseId);
    await expectProduct(customer, pathA, a.name);
    await editProduct(page, a, nextA);
    await editProduct(page, b, nextB);
    await go(page, 'releases');

    // 同一会话不同窗口分别只检查甲、乙，预览应各用自己的候选组合且均保持公开 V1。
    const scopeA = await openPublish(page, versions.v2, [selection(a, nextA)]);
    previewA = await openPreview(page, scopeA.link);
    await expectProduct(previewA, `${scopeA.href}${pathA}`, nextA, true);
    await expectProduct(previewA, `${scopeA.href}${pathB}`, b.name, true);
    tab = await context.newPage();
    await go(tab, 'releases');
    const scopeB = await openPublish(tab, '双标签独立预检产品乙', [selection(b, nextB)]);
    expect(scopeA.href).not.toBe(scopeB.href);
    previewB = await openPreview(tab, scopeB.link);
    await expectProduct(previewB, `${scopeB.href}${pathA}`, a.name, true);
    await expectProduct(previewB, `${scopeB.href}${pathB}`, nextB, true);
    const firstReload = await previewA.reload({ waitUntil: 'load' });
    expect(firstReload?.status()).toBe(200);
    await expect(previewA.frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: b.name, exact: true }).first()).toBeVisible();
    await expect(scopeA.link).toHaveAttribute('href', scopeA.href);
    await expect(textButton(scopeA.dialog, '确认更新网站')).toBeEnabled();
    await expectProduct(customer, pathA, a.name);
    expect((await api<StudioEnvelope>(control, '/api/studio')).activeReleaseId).toBe(v1);
    await testInfo.attach('原标签范围在另一标签预检后仍可刷新', { body: await previewA.screenshot(), contentType: 'image/png' });

    await cancel(scopeB.dialog).click();
    await textButton(scopeA.dialog, '确认更新网站').click();
    await expect(currentVersion(page, versions.v2)).toBeVisible();
    const published = await api<StudioEnvelope>(control, '/api/studio');
    const v2 = published.activeReleaseId!;
    expect(v2).not.toBe(v1);
    for (const scope of [scopeA, scopeB]) expect((await control.get(`${runtime.origin}${scope.href}`)).status()).toBe(404);
    await expectProduct(customer, pathA, nextA);
    await expectProduct(customer, pathB, b.name);
    expect(published.state.products.find(product => product.id === b.id)?.name).toBe(nextB);

    const activateV1 = `/api/releases/${v1}/activate` as const;
    const activateV2 = `/api/releases/${v2}/activate` as const;
    ui.allowWrite('POST', activateV1);
    ui.allowWrite('POST', activateV2);
    ui.expectHttpError('POST', activateV1, 409);
    await textButton(release(page, versions.v1), '查看版本内容').click();
    const drawer = page.getByRole('dialog', { name: '已发布的版本内容' });
    await expect(drawer.getByText(versions.v1, { exact: true })).toBeVisible();
    await textButton(drawer, '切换公开版本').click();
    await noOverflow(page, activation(page));
    await cancel(activation(page)).click();
    await expect(activation(page)).toBeHidden();
    expect(ui.writes.filter(write => write.path === activateV1)).toEqual([]);
    expect((await api<StudioEnvelope>(control, '/api/studio')).activeReleaseId).toBe(v2);

    // 标签一保留旧确认框，标签二先切换，再验证旧确认只得到真实409。
    await textButton(drawer, '切换公开版本').click();
    await tab.reload();
    await expect(currentVersion(tab, versions.v2)).toBeVisible();
    await textButton(release(tab, versions.v1), '切换到此版本').click();
    await textButton(activation(tab), '切换公开版本').click();
    await expect(currentVersion(tab, versions.v1)).toBeVisible();
    await expectProduct(customer, pathA, a.name);
    const rejection = page.waitForResponse(response => new URL(response.url()).pathname === activateV1 && response.request().method() === 'POST');
    await textButton(activation(page), '切换公开版本').click();
    expect((await rejection).status()).toBe(409);
    await expect(activation(page).getByText('线上版本已变化，请刷新后重新选择')).toBeVisible();
    const readLatest = textButton(activation(page), '读取最新版本');
    await hit(readLatest);
    await testInfo.attach('旧回退确认显示可直接读取最新版本', { body: await page.screenshot(), contentType: 'image/png' });
    await readLatest.click();
    await expect(activation(page)).toBeHidden();
    await expect(drawer).toBeHidden();
    await expect(currentVersion(page, versions.v1)).toBeVisible();
    expect(ui.writes.filter(write => write.path === activateV1)).toHaveLength(2);
    const restored = await api<StudioEnvelope>(control, '/api/studio');
    expect(restored.activeReleaseId).toBe(v1);
    expect(restored.revision).toBe(published.revision);
    // 状态标签会随当前公开版本重算，草稿字段本身必须完全保留。
    expect(restored.state.products.map(product => ({ ...product, status: undefined }))).toEqual(published.state.products.map(product => ({ ...product, status: undefined })));

    await textButton(release(page, versions.v2), '切换到此版本').click();
    await textButton(activation(page), '切换公开版本').click();
    await expect(currentVersion(page, versions.v2)).toBeVisible();
    await expectProduct(customer, pathA, nextA);
    await expectProduct(customer, pathB, b.name);
    const retried = await api<StudioEnvelope>(control, '/api/studio');
    expect(retried.activeReleaseId).toBe(v2);
    expect(retried.revision).toBe(published.revision);
    expect(retried.state.products).toEqual(published.state.products);
    expect(external).toEqual([]);
    await testInfo.attach('发布回退并发回执', { body: Buffer.from(JSON.stringify({ firstPreviewAfterOtherCheck: firstReload?.status(), oldPreviewAfterPublish: 404, staleConfirmation: 409, v1, v2, revision: retried.revision, writes: ui.writes }, null, 2)), contentType: 'application/json' });
  } finally {
    await previewB?.close(); await previewA?.close(); await tab?.close();
    const current = await api<StudioEnvelope>(control, '/api/studio');
    // 回收测试名称与公开指针，其他用例继续从随机测试实例的原始快照读取。
    if (current.activeReleaseId !== original.activeReleaseId) await api(control, `/api/releases/${original.activeReleaseId}/activate`, 'POST', { expectedActiveReleaseId: current.activeReleaseId });
    if (current.revision !== original.revision) await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { products: original.state.products } });
    await visitor.close(); await control.dispose();
  }
});
