import { request as playwrightRequest, type Page } from '@playwright/test';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { StudioState } from '../../src/lib/types';
import { expect, go, runtime, test, textButton } from './fixtures';

const pageA = { id: 'repair-editor-a', title: 'Navigation Fixture Alpha', slug: '/repair-editor-a' };
const pageB = { id: 'repair-editor-b', title: 'Navigation Fixture Beta', slug: '/repair-editor-b' };
const sharedBlock = { id: 'repair-editor-block', name: 'Navigation Fixture Shared' };
const preview = (page: Page) => page.locator('iframe[title="网站完整草稿预览"]');
const previewReady = (page: Page) => expect(preview(page).contentFrame().getByRole('link', { name: '返回管理后台' })).toBeVisible();
const editor = (page: Page) => page.frameLocator('.editor-scaled-frame iframe');
const picker = (page: Page) => page.locator('.editor-page-picker');
// Puck 编辑模式下框内元素有可拖放覆盖层，以实际画布节点而非编辑期的辅助树定位标题。
const canvasHeading = (page: Page, text: string) => editor(page).locator('.editor-site-heading').filter({ hasText: text });

async function seedNavigation() {
  const control = await playwrightRequest.newContext({ baseURL: runtime.origin, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, storageState: runtime.adminAuth });
  const read = async () => (await (await control.get('/api/studio')).json()) as StudioEnvelope;
  const patch = async (revision: number, fields: Partial<StudioState>) => {
    const response = await control.patch('/api/studio', { data: { expectedRevision: revision, patch: fields } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const base = await read();
  const updated = '2026-11-19T00:00:00.000Z';
  const data = (text: string, id: string): Data => {
    const root = { props: { title: text, showChrome: 'no' } };
    return { root, content: [{ type: 'Heading', props: { id: `heading-${id}`, level: 'h1', text } }] };
  };
  const a = data(pageA.title, pageA.id);
  a.content.push({ type: 'ActionButton', props: { id: 'repair-editor-link', text: 'Visit the private Beta draft', href: pageB.slug } });
  a.content.push({ type: 'RichText', props: { id: 'repair-editor-anchor', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Jump to the Alpha heading', marks: [{ type: 'link', attrs: { href: '#heading-repair-editor-a' } }] }] }] } } });
  await patch(base.revision, {
    pages: [...base.state.pages, ...[pageA, pageB].map(item => ({ ...item, updated, type: '普通页面', status: 'draft' as const }))],
    editorData: { ...base.state.editorData, [pageA.id]: a, [pageB.id]: data(pageB.title, pageB.id) },
    sharedBlocks: [...base.state.sharedBlocks || [], { ...sharedBlock, updated, data: data(sharedBlock.name, sharedBlock.id) }],
  });
  return { read, async restore() { const current = await read(); await patch(current.revision, { pages: base.state.pages, editorData: base.state.editorData, sharedBlocks: base.state.sharedBlocks || [] }); await control.dispose(); } };
}

async function openRow(page: Page, item: typeof pageA) {
  await page.locator(`tr[data-row-key="${item.id}"] .table-title`).click();
  await expect(picker(page)).toContainText(item.title);
  await expect(canvasHeading(page, item.title)).toBeVisible();
}

test('审查修复：交互画布打开目标草稿，管理入口不会进入拖拽框', async ({ page, ui }) => {
  const fixture = await seedNavigation();
  ui.allowWrite('PATCH', '/api/studio');
  try {
    await go(page, 'pages'); await openRow(page, pageA);
    await textButton(page, '切换交互模式').click();
    const frame = page.locator('.editor-scaled-frame iframe');
    await editor(page).locator('a[href]').filter({ hasText: 'Jump to the Alpha heading' }).click();
    expect(await frame.evaluate(element => (element as HTMLIFrameElement).contentWindow?.location.href)).toBe('about:srcdoc');
    const [draft] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 9000 }),
      editor(page).locator('a[href]').filter({ hasText: 'Visit the private Beta draft' }).click({ timeout: 7000 }),
    ]);
    try {
      await expect(draft).toHaveURL(`${runtime.origin}/preview${pageB.slug}`);
      await expect(draft.frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: pageB.title })).toBeVisible();
      await draft.getByRole('link', { name: '返回管理后台' }).click();
      await expect(draft).toHaveURL(`${runtime.origin}/admin`);
      await expect(draft.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
    } finally { await draft.close(); }
    await expect(page).toHaveURL(/#editor$/);
    await textButton(page, '返回编辑模式').click();
    await expect(canvasHeading(page, pageA.title)).toBeVisible();
    await expect(editor(page).getByRole('heading', { name: '工作台', exact: true })).toHaveCount(0);
  } finally { await ui.closeOwnedPage(); await fixture.restore(); }
});

test('审查修复：普通页前进后退、区块刷新和宽幅预览保持各自编辑对象', async ({ page, ui }) => {
  const fixture = await seedNavigation();
  ui.allowWrite('PATCH', '/api/studio');
  try {
    await go(page, 'pages'); await openRow(page, pageA);
    await page.getByRole('button', { name: '返回页面管理', exact: true }).click();
    await expect(page).toHaveURL(/#pages$/); await openRow(page, pageB);
    await page.goBack(); await expect(page).toHaveURL(/#pages$/);
    await page.goBack(); await expect(picker(page)).toContainText(pageA.title);
    await expect(canvasHeading(page, pageA.title)).toBeVisible();
    // 从旧历史对象继续编辑，并在服务端核对只修改了 A 的布局。
    await page.getByRole('searchbox', { name: '查找元素' }).fill('标题');
    await page.locator('.editor-search-results').getByRole('button', { name: /标题/ }).click();
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect.poll(async () => {
      const { state } = await fixture.read();
      return [pageA, pageB].map(item => (state.editorData[item.id] as Data).content.length);
    }).toEqual([4, 1]);
    await page.goForward(); await expect(page).toHaveURL(/#pages$/);
    await page.goForward(); await expect(picker(page)).toContainText(pageB.title);
    await expect(canvasHeading(page, pageB.title)).toBeVisible();

    await page.getByRole('button', { name: '返回页面管理', exact: true }).click();
    await page.locator('aside.shell-sidebar').getByRole('menuitem', { name: '全站设计' }).click();
    await page.getByRole('tab', { name: '重复使用的内容' }).click();
    await page.getByRole('textbox', { name: '搜索同步区块' }).fill(sharedBlock.name);
    await page.locator(`tr[data-row-key="${sharedBlock.id}"]`).getByRole('button', { name: /^编\s*辑$/ }).click();
    await expect(picker(page)).toContainText(sharedBlock.name);
    await page.reload(); await expect(picker(page)).toContainText(sharedBlock.name);
    await expect(canvasHeading(page, sharedBlock.name)).toBeVisible();
    await page.getByRole('spinbutton', { name: '画布宽度' }).fill('1800');
    await page.getByRole('spinbutton', { name: '画布宽度' }).press('Tab');
    await page.getByRole('button', { name: '预览页面', exact: true }).click();
    await expect(preview(page)).toHaveCSS('width', '1800px'); await previewReady(page);
    await page.reload(); await expect(preview(page)).toHaveCSS('width', '1800px'); await previewReady(page);
    await page.goBack(); await expect(picker(page)).toContainText(sharedBlock.name);
    await expect(canvasHeading(page, sharedBlock.name)).toBeVisible();
    await page.goForward(); await expect(preview(page)).toHaveCSS('width', '1800px'); await previewReady(page);
    await textButton(page, '返回编辑器').click();
    await expect(picker(page)).toContainText(sharedBlock.name);
  } finally { await ui.closeOwnedPage(); await fixture.restore(); }
});

test('审查修复：清空页面后预览返回可真实撤销并重做', async ({ page, ui }) => {
  const fixture = await seedNavigation();
  ui.allowWrite('PATCH', '/api/studio');
  const count = async () => ((await fixture.read()).state.editorData[pageA.id] as { content: unknown[] }).content.length;
  try {
    await go(page, 'pages'); await openRow(page, pageA);
    await page.getByRole('tab', { name: '页面操作' }).click();
    await textButton(page, '清空当前页面').click();
    await textButton(page.getByRole('dialog', { name: '清空当前页面？' }), '清空页面').click();
    await expect.poll(count).toBe(0);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '预览页面', exact: true }).click();
    await previewReady(page);
    await textButton(page, '返回编辑器').click();
    await expect(picker(page)).toContainText(pageA.title);
    const undo = page.getByRole('button', { name: '撤销', exact: true });
    await expect(undo).toBeEnabled(); await undo.click();
    await expect(canvasHeading(page, pageA.title)).toBeVisible();
    await expect.poll(count).toBe(3);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(count).toBe(0);
    await undo.click();
    await expect.poll(count).toBe(3);
  } finally { await ui.closeOwnedPage(); await fixture.restore(); }
});

test.describe('审查修复：只读列表逐页预览', () => {
  test.use({ storageState: runtime.viewerAuth });
  for (const width of [1440, 390]) test(`从网站页面打开指定草稿 ${width}px`, async ({ page, ui }) => {
    await page.setViewportSize({ width, height: 900 });
    await go(page, 'pages');
    const search = page.getByRole('textbox', { name: '搜索页面', exact: true });
    await search.fill('UI Page 12');
    if (width < 768) await page.getByRole('button', { name: '查看页面详情：UI Page 12' }).click();
    const draftLink = page.getByRole('link', { name: '预览草稿：UI Page 12' });
    await expect(draftLink).toBeVisible();
    const [draft] = await Promise.all([page.context().waitForEvent('page', { timeout: 9000 }), draftLink.click({ timeout: 7000 })]);
    try {
      await expect(draft).toHaveURL(`${runtime.origin}/preview/ui/very-long-address-12`);
      await expect(draft.getByRole('link', { name: '返回管理后台' })).toBeVisible();
    } finally { await draft.close(); }
    await expect(page).toHaveURL(/#pages$/);
    expect(ui.writes).toEqual([]);
  });
});
