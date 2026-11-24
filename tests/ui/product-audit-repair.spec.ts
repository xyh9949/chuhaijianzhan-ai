import type { Page } from '@playwright/test';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import { expect, go, noOverflow, runtime, test, textButton } from './fixtures';

const row = (page: Page, id: string) => page.locator(`tr[data-row-key="${id}"]`);
const productButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function readDraft(page: Page): Promise<StudioEnvelope> {
  const response = await page.request.get(`${runtime.origin}/api/studio`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function restoreProducts(page: Page, original: StudioEnvelope) {
  // 仅回收本用例在隔离实例中的产品草稿，保留同一测试启动时的公开版本。
  const latest = await readDraft(page);
  if (latest.revision === original.revision) return;
  const response = await page.request.patch(`${runtime.origin}/api/studio`, {
    headers: { Origin: runtime.origin }, data: { expectedRevision: latest.revision, patch: { products: original.state.products } },
  });
  expect(response.ok()).toBe(true);
}

test('产品批量移除逐项核对：搜索及翻页清除旧选择，取消保留草稿，确认只移除列出的产品', async ({ page, ui }) => {
  const original = await readDraft(page);
  const hidden = original.state.products.find(item => item.id === 'p2')!;
  const visible = original.state.products.find(item => item.id === 'p3')!;
  ui.allowWrite('PATCH', '/api/studio');
  try {
    await go(page, 'products');
    await row(page, hidden.id).getByRole('checkbox').check();
    const bulk = textButton(page, '批量移除');
    await expect(bulk).toBeVisible();
    await page.getByRole('textbox', { name: '搜索产品' }).fill(visible.sku);
    await expect(row(page, hidden.id)).toHaveCount(0);
    await expect(row(page, visible.id)).toBeVisible();
    await expect(bulk).toHaveCount(0);
    expect(ui.writes).toEqual([]);

    await page.getByRole('textbox', { name: '搜索产品' }).fill('');
    await row(page, hidden.id).getByRole('checkbox').check();
    await page.locator('.ant-pagination-item-2').click();
    await expect(bulk).toHaveCount(0);
    await page.locator('.ant-pagination-item-1').click();
    await expect(row(page, hidden.id).getByRole('checkbox')).not.toBeChecked();

    await page.setViewportSize({ width: 390, height: 900 });
    await row(page, visible.id).getByRole('checkbox').check();
    await bulk.click();
    const confirm = page.getByRole('dialog', { name: '移除 1 件产品草稿？' });
    await expect(confirm.getByText(visible.name, { exact: true })).toBeVisible();
    await expect(confirm.getByText(visible.sku, { exact: true })).toBeVisible();
    await expect(confirm.getByText(hidden.name, { exact: true })).toHaveCount(0);
    await noOverflow(page, confirm);
    await confirm.getByRole('button', { name: /^取\s*消$/ }).click();
    await expect(confirm).toBeHidden();
    expect(ui.writes).toEqual([]);
    expect((await readDraft(page)).revision).toBe(original.revision);

    await bulk.click();
    await confirm.getByRole('button', { name: '确认移除' }).click();
    await expect(confirm).toBeHidden();
    await expect(row(page, visible.id)).toHaveCount(0);
    const after = await readDraft(page);
    expect(after.activeReleaseId).toBe(original.activeReleaseId);
    expect(after.state.products.map(item => item.id)).toEqual(original.state.products.filter(item => item.id !== visible.id).map(item => item.id));
    expect(after.state.releases.find(item => item.status === 'current')?.snapshot).toEqual(original.state.releases.find(item => item.status === 'current')?.snapshot);
    expect(ui.writes).toEqual([{ method: 'PATCH', path: '/api/studio' }]);
  } finally { await restoreProducts(page, original); }
});

test('编辑已上线产品后列表和表单显示待更新，旧公开快照仍保留该产品', async ({ page, ui }) => {
  const original = await readDraft(page);
  const target = original.state.products.find(item => item.id === 'p2')!;
  const changed = `${target.name} reviewed draft`;
  ui.allowWrite('PATCH', '/api/studio');
  try {
    await go(page, 'products');
    await expect(row(page, target.id).getByText('已发布', { exact: true })).toBeVisible();
    await productButton(page, target.name).click();
    await page.getByPlaceholder('例如：Arc 弧线休闲椅').fill(changed);
    await textButton(page, '保存产品').click();
    await expect(row(page, target.id).getByText('待更新', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '待更新 1' }).click();
    await expect(productButton(page, changed)).toBeVisible();
    await page.getByRole('tab', { name: '草稿 0' }).click();
    await expect(productButton(page, changed)).toHaveCount(0);
    await page.getByRole('tab', { name: '待更新 1' }).click();
    await productButton(page, changed).click();
    await expect(page.getByText('网站仍展示上次发布的资料', { exact: true })).toBeVisible();
    const after = await readDraft(page);
    expect(after.state.products.find(item => item.id === target.id)?.name).toBe(changed);
    expect(after.activeReleaseId).toBe(original.activeReleaseId);
    expect(after.state.releases.find(item => item.status === 'current')?.snapshot).toEqual(original.state.releases.find(item => item.status === 'current')?.snapshot);
  } finally { await restoreProducts(page, original); }
});

test('CSV 导入的长名称、型号、分类、介绍和材质均可继续编辑并原样保留', async ({ page, ui }) => {
  const original = await readDraft(page);
  const name = 'UI repair imported product ' + 'n'.repeat(130);
  const sku = 'UI-REPAIR-LONG-' + 'S'.repeat(66);
  const category = 'UI import category ' + 'c'.repeat(72);
  const description = 'Product facts for isolation. '.repeat(68).trim();
  const material = 'Oak notes. '.repeat(20).trim();
  ui.allowWrite('POST', '/api/content-import/preview');
  ui.allowWrite('POST', '/api/content-import/commit');
  ui.allowWrite('PATCH', '/api/studio');
  try {
    await go(page, 'products');
    await textButton(page, '批量导入产品').click();
    const dialog = page.getByRole('dialog', { name: '批量导入产品草稿' });
    await dialog.locator('input[type=file]').setInputFiles({ name: 'product-repair.csv', mimeType: 'text/csv', buffer: Buffer.from(`name,sku,category,image,material,description\n${name},${sku},${category},/images/chair.jpg,${material},${description}\n`) });
    await dialog.getByRole('button', { name: '预检全部记录' }).click();
    await expect(dialog.getByText(/预检通过，共1条/)).toBeVisible();
    await dialog.getByRole('button', { name: '确认新增1条草稿' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('textbox', { name: '搜索产品' }).fill(sku);
    await productButton(page, name).click();
    await expect(page.getByPlaceholder('例如：橡木 / 亚麻织物')).toHaveValue(material);
    await expect(page.getByPlaceholder('向客户介绍这款产品的主要特点与适用场景。')).toHaveValue(description);
    await page.getByPlaceholder('例如：橡木 / 亚麻织物').fill('Revised white oak');
    await textButton(page, '保存产品').click();
    await expect(page.getByRole('heading', { name: '产品管理' })).toBeVisible();
    const after = await readDraft(page);
    expect(after.state.products.find(item => item.sku === sku)).toMatchObject({ name, sku, category, description, material: 'Revised white oak' });
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/content-import/preview' }, { method: 'POST', path: '/api/content-import/commit' }, { method: 'PATCH', path: '/api/studio' }]);
  } finally { await restoreProducts(page, original); }
});
