import { request as playwrightRequest, type Page } from '@playwright/test';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { PageItem } from '../../src/lib/types';
import { withEditorRootDefaults } from '../../src/lib/editor-root-defaults';
import { expect, go, noOverflow, runtime, test, textButton } from './fixtures';

const target: PageItem = { id: 'ui-trade-components', title: 'Buyer information', slug: '/ui-trade-components', locale: 'en', status: 'draft', type: '普通页面', updated: '' };
const tableTitle = 'Compare buyer options';
const imageTitle = 'Compare project photos';
const add = async (page: Page, title: string) => {
  await page.getByRole('searchbox', { name: '查找元素', exact: true }).fill(title);
  await textButton(page.locator('.editor-search-results'), title).click();
};

async function selectNode(page: Page, label: string) {
  const panel = page.locator('.editor-left-panel');
  await panel.getByRole('tab', { name: /图层/ }).click();
  await panel.getByRole('tree', { name: '页面图层' }).getByText(label, { exact: true }).click();
  await panel.getByRole('tab', { name: /元素/ }).click();
}

test('外贸组件的画布编辑和手机发布体验', async ({ page, ui, browser }, testInfo) => {
  test.setTimeout(100_000);
  page.setDefaultTimeout(12_000);
  const control = await playwrightRequest.newContext({ baseURL: runtime.origin, extraHTTPHeaders: { Origin: runtime.origin }, storageState: runtime.adminAuth });
  const api = async <T>(path: string, method = 'GET', data?: unknown): Promise<T> => {
    const response = await control.fetch(path, { method, ...(data === undefined ? {} : { data }) });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json();
  };
  const read = () => api<StudioEnvelope>('/api/studio');
  const original = await read();
  const data = withEditorRootDefaults({ root: { props: { title: target.title, showChrome: 'no' } as Data['root']['props'] }, content: [{ type: 'Heading', props: { id: 'ui-trade-title', text: target.title, level: 'h1' } }] });
  ui.allowWrite('PATCH', '/api/studio');

  try {
    await api('/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { pages: [...original.state.pages, target], editorData: { ...original.state.editorData, [target.id]: data } } });
    await go(page, 'pages');
    await page.locator(`tr[data-row-key="${target.id}"] .table-title`).click();
    const canvas = page.frameLocator('.editor-scaled-frame iframe');
    await expect(canvas.locator('.editor-site-heading').filter({ hasText: target.title })).toBeVisible();

    await add(page, '产品型号对比表');
    await selectNode(page, 'Compare models');
    await page.getByRole('textbox', { name: '对比表标题', exact: true }).fill(tableTitle);
    await page.getByRole('textbox', { name: '产品列 1 名称', exact: true }).fill('Sample A');
    await page.getByRole('textbox', { name: '产品列 2 名称', exact: true }).fill('Sample B');
    await page.getByRole('textbox', { name: '参数 1 名称', exact: true }).fill('Finish');
    await page.getByRole('textbox', { name: '参数 1 · 产品列 1 的值', exact: true }).fill('Matte');
    await page.getByRole('textbox', { name: '参数 1 · 产品列 2 的值', exact: true }).fill('Satin');
    const table = canvas.getByRole('table', { name: tableTitle });
    const matrix = async (columns: string[], values: string[]) => {
      await expect(table.getByRole('columnheader')).toHaveText(columns);
      await expect(table.getByRole('row').filter({ hasText: 'Finish' }).getByRole('cell')).toHaveText(values);
    };
    await matrix(['Sample A', 'Sample B'], ['Matte', 'Satin']);
    // Puck 在最后一次编辑后等待 250ms 归组历史，模拟填完后停顿再执行列移动和撤销。
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '右移产品列 1', exact: true }).click();
    await matrix(['Sample B', 'Sample A'], ['Satin', 'Matte']);
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await matrix(['Sample A', 'Sample B'], ['Matte', 'Satin']);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await matrix(['Sample B', 'Sample A'], ['Satin', 'Matte']);

    await add(page, '项目时间线');
    await selectNode(page, 'Project milestones');
    await page.getByRole('textbox', { name: '时间线标题', exact: true }).fill('Delivery milestones');
    await page.getByRole('textbox', { name: '阶段 1 标题', exact: true }).fill('Confirm the finish sample');

    // 将时间线拖到画布标题上方，验证拖拽引用、页面顺序和保存结果。
    const timeline = canvas.getByRole('heading', { name: 'Delivery milestones', exact: true });
    await timeline.scrollIntoViewIfNeeded();
    const start = await timeline.boundingBox(), finish = await canvas.locator('.editor-site-heading').filter({ hasText: target.title }).boundingBox();
    if (!start || !finish) throw new Error('找不到时间线及页面标题的拖拽坐标');
    const x = start.x + Math.min(40, start.width / 2), y = start.y + start.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 12, { steps: 5 });
    await page.mouse.move(finish.x + Math.min(40, finish.width / 2), finish.y + 3, { steps: 20 });
    await page.mouse.up();
    await expect.poll(async () => ((await read()).state.editorData[target.id] as Data).content.map(node => node.type)).toEqual(['ProjectTimeline', 'Heading', 'ComparisonTable']);

    await add(page, '图片前后对比');
    await selectNode(page, 'ImageComparison');
    await page.getByRole('textbox', { name: '对比标题（选填）', exact: true }).fill(imageTitle);
    // 两张图片通过和正式编辑相同的素材选择控件配置，避免只验证静态数据夹具。
    for (const [index, label, alt] of [[0, '演示 · 室内', 'Studio interior before'], [1, '演示 · 椅子', 'Chair sample after']] as const) {
      const picker = page.getByRole('combobox', { name: '从素材库选择图片', exact: true }).nth(index);
      // 键盘按唯一素材名搜索和选择，避免外层画布/属性滚动中途改变浮层位置。
      await picker.fill(label);
      await expect(page.locator('.ant-select-dropdown:visible .ant-select-item-option').getByText(label, { exact: true })).toBeVisible();
      await picker.press('Enter');
      await page.getByRole('textbox', { name: '替代文字', exact: true }).nth(index).fill(alt);
    }

    await textButton(page, '插入现成区块').click();
    const library = page.getByRole('dialog', { name: '现成业务区块', exact: true });
    await library.getByRole('searchbox', { name: '搜索业务区块', exact: true }).fill('采购指南');
    await library.getByRole('button', { name: '预览采购指南', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '采购指南', exact: true });
    await expect(preview.getByRole('heading', { name: 'Prepare your first enquiry.' })).toBeVisible();
    await textButton(preview, '插入这个区块').click();
    await expect(canvas.locator('.editor-site-heading').filter({ hasText: 'Prepare your first enquiry.' })).toBeVisible();
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('草稿已保存；公开发布请进入发布管理。', { exact: true })).toBeVisible();
    await expect.poll(async () => ((await read()).state.editorData[target.id] as Data).content.map(node => node.type)).toEqual(['ProjectTimeline', 'Heading', 'ComparisonTable', 'ImageComparison', 'Container']);
    const draft = await read();
    const publish = { expectedRevision: draft.revision, baseReleaseId: draft.activeReleaseId, title: 'Synthetic buyer component verification', pageIds: [target.id], includeTheme: false, includeSettings: false };
    expect((await api<{ errors: string[] }>('/api/releases/preview', 'POST', publish)).errors).toEqual([]);
    const released = await api<StudioEnvelope>('/api/releases', 'POST', publish);
    expect(released.activeReleaseId).not.toBe(original.activeReleaseId);

    const mobile = await browser.newContext({ baseURL: runtime.origin, viewport: { width: 390, height: 900 }, javaScriptEnabled: false, serviceWorkers: 'block' });
    const foreign: string[] = [];
    await mobile.route('**/*', route => {
      const { origin, protocol } = new URL(route.request().url());
      if (origin === runtime.origin || protocol === 'data:') return route.continue();
      foreign.push(origin);
      return route.abort();
    });
    try {
      const visitor = await mobile.newPage();
      expect((await visitor.goto(target.slug))?.status()).toBe(200);
      const region = visitor.getByRole('region', { name: tableTitle });
      await noOverflow(visitor);
      await expect(region.getByRole('columnheader')).toHaveText(['Sample B', 'Sample A']);
      await expect(region.getByRole('row').filter({ hasText: 'Finish' }).getByRole('cell')).toHaveText(['Satin', 'Matte']);
      expect(await region.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      await region.focus();
      await expect(region).toBeFocused();
      await visitor.keyboard.press('ArrowRight');
      await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      await expect(visitor.getByRole('heading', { name: 'Confirm the finish sample' })).toBeVisible();
      const images = visitor.getByRole('group', { name: imageTitle });
      await expect(images.getByRole('img', { name: 'Studio interior before' })).toBeVisible();
      await images.locator('label').filter({ hasText: /^After$/ }).click();
      await expect(images.getByRole('img', { name: 'Chair sample after' })).toBeVisible();
      await expect(images.getByRole('img', { name: 'Studio interior before' })).toHaveCount(0);
      await expect(visitor.getByRole('heading', { name: 'Prepare your first enquiry.' })).toBeVisible();
      await noOverflow(visitor);
      expect(foreign).toEqual([]);
      await testInfo.attach('published-trade-components-mobile', { body: await visitor.screenshot({ fullPage: true }), contentType: 'image/png' });
    } finally { await mobile.close(); }
  } finally {
    await ui.closeOwnedPage();
    const latest = await read();
    if (latest.activeReleaseId !== original.activeReleaseId) await api(`/api/releases/${original.activeReleaseId}/activate`, 'POST', { expectedActiveReleaseId: latest.activeReleaseId });
    if (latest.revision !== original.revision) await api('/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: original.state.pages, editorData: original.state.editorData } });
    await control.dispose();
  }
});
