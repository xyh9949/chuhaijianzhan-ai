import { request as playwrightRequest } from '@playwright/test';
import { getProductPath } from '../../src/lib/content-routes';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import { expect, go, runtime, test, textButton } from './fixtures';

test('另一标签页发布后，旧草稿筛选的产品移除确认被拒绝并可重新核对', async ({ page, context, ui }, testInfo) => {
  test.setTimeout(90_000);
  const admin = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin } });
  const guest = await playwrightRequest.newContext({ maxRedirects: 0 });
  async function readStudio(): Promise<StudioEnvelope> {
    const response = await admin.get(`${runtime.origin}/api/studio`);
    expect(response.ok()).toBe(true);
    return response.json();
  }
  const original = await readStudio();
  const product = { ...original.state.products.find(item => item.id === 'p7')!, id: 'product-stale-removal', name: 'Release race sample chair', slug: 'release-race-sample-chair', sku: 'UI-STALE-REMOVAL' };
  const publicPath = getProductPath(original.state, product)!;
  expect(publicPath).toBeTruthy();
  const publisher = await context.newPage();
  ui.allowWrite('PATCH', '/api/studio');
  ui.allowWrite('POST', '/api/releases/preview');
  ui.allowWrite('POST', '/api/releases');
  ui.expectHttpError('PATCH', '/api/studio', 409);
  try {
    // 仅用 API 准备一条隔离产品，发布、过期确认和重新加载都按用户实际操作。
    const seed = await admin.patch(`${runtime.origin}/api/studio`, { data: { expectedRevision: original.revision, patch: { products: [...original.state.products, product] } } });
    expect(seed.ok()).toBe(true);
    const draft: StudioEnvelope = await seed.json();
    expect((await guest.get(`${runtime.origin}${publicPath}`)).status()).toBe(404);

    await go(page, 'products');
    await page.getByRole('tab', { name: /^草稿 / }).click();
    await page.getByRole('textbox', { name: '搜索产品' }).fill(product.sku);
    const row = page.locator(`tr[data-row-key="${product.id}"]`);
    await row.getByRole('checkbox').check();
    await textButton(page, '批量移除').click();
    const removal = page.getByRole('dialog', { name: '移除 1 件产品草稿？' });
    await expect(removal.getByText(product.name, { exact: true })).toBeVisible();

    await go(publisher, 'releases');
    await textButton(publisher, '发布更改').click();
    const publication = publisher.getByRole('dialog', { name: '发布网站更新' });
    await publication.getByText(/^产品资料 · 已选 0 \/ /).click();
    await publication.getByRole('checkbox', { name: new RegExp(`^${product.name} · `) }).check();
    await textButton(publication, '检查所选内容').click();
    const publishResponse = publisher.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/releases');
    await textButton(publication, '确认更新网站').click();
    expect((await publishResponse).status()).toBe(201);
    await expect(publication).toBeHidden();
    const published = await readStudio();
    expect(published.revision).toBe(draft.revision);
    expect(published.activeReleaseId).not.toBe(draft.activeReleaseId);
    const live = await guest.get(`${runtime.origin}${publicPath}`);
    expect(live.status()).toBe(200);
    expect(await live.text()).toContain(product.name);

    const removeResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/studio');
    await textButton(removal, '确认移除').click();
    const rejected = await removeResponse;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().postDataJSON().expectedActiveReleaseId).toBe(draft.activeReleaseId);
    expect((await rejected.json()).error).toContain('线上版本已变化');
    await expect(removal).toBeHidden();
    await expect(page.getByText('工作区同步未完成', { exact: true })).toBeVisible();
    await testInfo.attach('stale-removal-rejected', { body: await page.screenshot(), contentType: 'image/png' });

    await textButton(page, '重新加载').click();
    await page.getByRole('dialog', { name: '重新加载服务器版本？' }).getByRole('button', { name: /^确\s*定$/ }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole('tab', { name: /^已发布 / }).click();
    await expect(row.getByText('已发布', { exact: true })).toBeVisible();
    const after = await readStudio();
    expect(after.revision).toBe(draft.revision);
    expect(after.activeReleaseId).toBe(published.activeReleaseId);
    expect(after.state.products.find(item => item.id === product.id)?.name).toBe(product.name);
    expect((await guest.get(`${runtime.origin}${publicPath}`)).status()).toBe(200);
  } finally {
    await publisher.close();
    const current = await readStudio();
    if (current.activeReleaseId !== original.activeReleaseId) {
      const rollback = await admin.post(`${runtime.origin}/api/releases/${original.activeReleaseId}/activate`, { data: { expectedActiveReleaseId: current.activeReleaseId } });
      expect(rollback.ok()).toBe(true);
    }
    if (current.revision !== original.revision) {
      const cleanup = await admin.patch(`${runtime.origin}/api/studio`, { data: { expectedRevision: current.revision, patch: { products: original.state.products } } });
      expect(cleanup.ok()).toBe(true);
    }
    await admin.dispose();
    await guest.dispose();
  }
});
