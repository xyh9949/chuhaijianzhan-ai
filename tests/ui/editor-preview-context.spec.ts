import { request as playwrightRequest } from '@playwright/test';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { StudioState } from '../../src/lib/types';
import { expect, go, noOverflow, runtime, select, test, textButton } from './fixtures';

test('手机编辑器预览继承设备并打开区块真实引用页，后台跳主内容保留路由', async ({ page, ui }) => {
  test.setTimeout(80_000);
  const control = await playwrightRequest.newContext({ baseURL: runtime.origin, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, storageState: runtime.adminAuth });
  const read = async () => (await (await control.get('/api/studio')).json()) as StudioEnvelope;
  const patch = async (expectedRevision: number, content: Partial<StudioState>) => {
    const response = await control.patch('/api/studio', { data: { expectedRevision, patch: content } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const base = await read();
  const canvasSaves: Partial<StudioState>[] = [];
  // 预览前沿用编辑器现有的保存队列；隔离用例允许写入，并核对每次只保存当前区块。
  ui.allowWrite('PATCH', '/api/studio');
  page.on('request', request => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/studio') canvasSaves.push(request.postDataJSON().patch);
  });
  try {
    const timestamp = '2026-11-18T00:00:00.000Z';
    const pages = ['a', 'b'].map(id => ({ id: `preview-fixture-${id}`, slug: `/preview-fixture-${id}`, title: `Fixture Projects ${id}`, type: '普通页面', status: 'draft' as const, updated: timestamp }));
    const blocks = ['one', 'multi', 'unused'].map(id => ({ id: `preview-block-${id}`, name: `Preview block ${id}`, updated: timestamp, data: { root: { props: {} }, content: [{ type: 'Heading', props: { id: `heading-${id}`, level: 'h2', text: `Private block ${id}` } }] } }));
    const editorData = { ...base.state.editorData, ...Object.fromEntries(pages.map((item, index) => [item.id, { root: { props: { showChrome: 'no' } }, content: [{ type: 'Heading', props: { id: `heading-page-${index}`, level: 'h1', text: item.title } }, ...blocks.filter(block => block.id.endsWith('-multi') || index === 0 && block.id.endsWith('-one')).map(block => ({ type: 'SharedBlock', props: { id: `reference-${block.id}`, blockId: block.id } }))] }])) };
    // 只在独立临时实例准备数据，正式内容与配置不参与本用例。
    await patch(base.revision, { pages: [...base.state.pages, ...pages], sharedBlocks: [...base.state.sharedBlocks || [], ...blocks], editorData });
    await page.setViewportSize({ width: 375, height: 900 });
    await go(page, 'pages');
    const skip = page.getByRole('link', { name: '跳到主要内容' });
    await page.keyboard.press('Tab'); await expect(skip).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page.locator('#main-content')).toBeFocused();
    await expect(page).toHaveURL(/#pages$/); await page.reload(); await expect(page).toHaveURL(/#pages$/);

    async function openBlock(kind: string) {
      const beforeOpen = await read(), saveCount = canvasSaves.length;
      await go(page, 'global-design');
      await page.getByRole('tab', { name: '重复使用的内容' }).click();
      await page.getByRole('textbox', { name: '搜索同步区块' }).fill(`Preview block ${kind}`);
      // Ant Design 的两个中文字符按钮会插入空白；按实际可访问名称匹配。
      const edit = page.locator(`tr[data-row-key="preview-block-${kind}"]`).getByRole('button', { name: /^编\s*辑$/ });
      await expect(edit).toBeVisible(); await edit.click();
      await expect(page).toHaveURL(/#editor$/);
      await page.getByRole('button', { name: '预览页面', exact: true }).click();
      await expect(page).toHaveURL(/#preview$/);
      const afterOpen = await read(), blockId = `preview-block-${kind}`;
      const otherBlocks = (values: StudioState['sharedBlocks']) => values?.filter(block => block.id !== blockId);
      for (const saved of canvasSaves.slice(saveCount)) {
        expect(Object.keys(saved)).toEqual(['sharedBlocks']);
        expect(otherBlocks(saved.sharedBlocks)).toEqual(otherBlocks(beforeOpen.state.sharedBlocks));
      }
      expect(afterOpen.activeReleaseId).toBe(beforeOpen.activeReleaseId);
      expect(afterOpen.state.releases).toEqual(beforeOpen.state.releases);
      expect(afterOpen.state.pages).toEqual(beforeOpen.state.pages);
      expect(afterOpen.state.editorData).toEqual(beforeOpen.state.editorData);
    }
    const iframe = page.locator('iframe[title="网站完整草稿预览"]');
    const canvas = page.frameLocator('iframe[title="网站完整草稿预览"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await openBlock('one');
    await expect(iframe).toHaveCSS('width', '390px');
    await expect(iframe).toHaveAttribute('src', `/preview${pages[0].slug}`);
    await expect(canvas.getByRole('heading', { name: 'Private block one' })).toBeVisible();
    await noOverflow(page);
    await textButton(page, '返回编辑器').click();
    await expect(page.locator('.editor-page-picker')).toContainText('Preview block one');

    await openBlock('multi');
    await select(page, '选择区块预览的引用页面', 'Fixture Projects b');
    await expect(iframe).toHaveAttribute('src', `/preview${pages[1].slug}`);
    await expect(canvas.getByRole('heading', { name: 'Fixture Projects b' })).toBeVisible();

    await openBlock('unused');
    await expect(iframe).toHaveAttribute('src', '/preview/~block/preview-block-unused');
    await expect(canvas.getByRole('heading', { name: 'Private block unused' })).toBeVisible();
    await expect(page.getByText('区块独立预览 · 尚无可用引用页', { exact: true })).toBeVisible();
    expect(ui.writes).toEqual(canvasSaves.map(() => ({ method: 'PATCH', path: '/api/studio' })));
  } finally {
    const current = await read();
    if (current.revision !== base.revision) await patch(current.revision, { pages: base.state.pages, editorData: base.state.editorData, sharedBlocks: base.state.sharedBlocks || [] });
    await ui.closeOwnedPage(); await control.dispose();
  }
});

for (const width of [1440, 390]) test(`嵌入式预览的返回管理后台结束预览且不会套一层后台：${width}px`, async ({ page, ui }) => {
  await page.setViewportSize({ width, height: 900 });
  // 编辑器预览前会保存当前画布；允许隔离实例执行这一步。
  ui.allowWrite('PATCH', '/api/studio');
  await go(page, 'pages');
  // 使用无媒体的真实草稿，避免离开页面时浏览器主动取消图片干扰导航断言。
  await page.locator('tr[data-row-key="ui-page-1"] .table-title').click();
  await expect(page).toHaveURL(/#editor$/);
  await page.getByRole('button', { name: '预览页面', exact: true }).click();
  await expect(page).toHaveURL(/#preview$/);

  const preview = page.locator('iframe[title="网站完整草稿预览"]');
  await preview.contentFrame().getByRole('link', { name: '返回管理后台' }).click();
  await expect(page).toHaveURL(`${runtime.origin}/admin`);
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  await expect(preview).toHaveCount(0);
});

test('独立预览的返回管理后台在当前标签页打开工作台', async ({ page }) => {
  await page.goto(`/preview${runtime.fixture.longPagePath}`);
  await page.getByRole('link', { name: '返回管理后台' }).press('Enter');
  await expect(page).toHaveURL(`${runtime.origin}/admin`);
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
});
