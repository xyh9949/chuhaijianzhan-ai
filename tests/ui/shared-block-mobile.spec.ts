import { test, expect, runtime, go, hit, noOverflow } from './fixtures';

test('同步区块手机主要操作无需横拖，切换宽度保持分页', async ({ page, ui }) => {
  const name = `案例卡片 ${'LongReferenceName'.repeat(4)}`;
  // 只为列表准备工作区读取夹具，点击编辑进入真实画布，不写合成记录或站点设置。
  ui.studio(state => {
    state.sharedBlocks = Array.from({ length: 9 }, (_, index) => ({
      id: `ui-mobile-block-${index}`, name: index === 8 ? name : `测试同步区块 ${index}`, updated: '2026-11-19T00:00:00.000Z', data: { root: { props: { title: index === 8 ? name : `测试同步区块 ${index}` } }, content: [] },
    }));
  });
  await page.setViewportSize({ width: 1440, height: 940 });
  await go(page, 'global-design');
  await page.getByRole('tab', { name: /重复使用的内容/ }).click();
  const table = page.locator('.global-block-table');
  await expect(table.getByRole('columnheader', { name: '更新于', exact: true })).toBeVisible();
  await table.locator('.ant-pagination-next button').click();
  const row = table.locator('tr[data-row-key="ui-mobile-block-8"]');
  const edit = row.getByRole('button', { name: /^编\s*辑$/ });
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 940 });
    await expect(table.getByRole('columnheader', { name: '更新于', exact: true })).toHaveCount(0);
    await expect(table.locator('.ant-pagination-item-active')).toHaveAttribute('title', '2');
    await expect(row).toContainText(name);
    await expect(row.getByRole('button', { name: '0 个页面', exact: true })).toBeVisible();
    await noOverflow(page, table);
    await edit.scrollIntoViewIfNeeded();
    await hit(edit);
    await expect.poll(() => row.evaluate(el => {
      const bound = el.getBoundingClientRect();
      return bound.left >= 0 && bound.right <= innerWidth + 1;
    })).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 940 });
  await expect(table.getByRole('columnheader', { name: '更新于', exact: true })).toBeVisible();
  await expect(table.locator('.ant-pagination-item-active')).toHaveAttribute('title', '2');
  await page.setViewportSize({ width: 390, height: 940 });
  await edit.focus(); await edit.press('Enter');
  await expect(page.locator('.editor-topbar')).toContainText(name);
  expect(ui.writes).toEqual([]);
});

test.describe('只读同步区块', () => {
  test.use({ storageState: runtime.viewerAuth });
  test('手机列表保留名称和使用范围，不暴露写操作', async ({ page, ui }) => {
    ui.studio(state => {
      state.sharedBlocks = [{ id: 'ui-readonly-block', name: '只读案例卡片', updated: '2026-11-19T00:00:00.000Z', data: { root: { props: { title: '只读案例卡片' } }, content: [] } }];
    });
    await page.setViewportSize({ width: 1440, height: 940 }); await go(page, 'global-design');
    await page.getByRole('tab', { name: /重复使用的内容/ }).click();
    await page.setViewportSize({ width: 390, height: 940 });
    const row = page.locator('tr[data-row-key="ui-readonly-block"]');
    await expect(row).toContainText('只读案例卡片');
    await expect(row.getByRole('button', { name: '0 个页面', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: /^编\s*辑$/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /重命名|复制|删除/ })).toHaveCount(0);
    expect(ui.writes).toEqual([]);
  });
});
