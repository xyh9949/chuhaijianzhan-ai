import type { Data } from '@puckeditor/core';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { PageItem } from '../../src/lib/types';
import { expect, go, noOverflow, runtime, select, test, textButton } from './fixtures';

const run = 'ca5e12345678';
const entry = (key: string, slug: string, title: string): PageItem => ({ id: `ai-${run}-${key}`, slug, title, status: 'draft', type: '普通页面', updated: new Date().toISOString() });
const home = entry('home', '/legacy-example', 'Legacy Home'), contact = entry('contact', '/legacy-example/talk', 'Legacy Contact');
const catalogue = entry('products', '/legacy-example/products', 'Legacy Catalogue');
function legacy(page: PageItem, index: number): Data {
  const node = (type: string, props: Record<string, unknown>) => ({ type, props: { id: `ai-${run}-${++index}`, ...props } });
  const menu = node('Container', { layout: 'grid', columns: 3, content: [home, contact, catalogue].map(target => node('ActionButton', {
    text: target.title, href: target.slug, linkTarget: { kind: 'page', id: target.id }, kind: 'outline', align: 'left', design: { desktop: { fontSize: 13 } },
  })) });
  const header = node('Container', { nodeLabel: 'AI生成品牌与页面导航', content: [node('Text', { text: 'Synthetic Legacy Co.' }), menu] });
  const footer = node('Container', { nodeLabel: 'AI生成页面页脚', content: [node('Text', { text: 'Legacy footer' })] });
  const props = { title: page.title, brand: 'Synthetic Legacy Co.', showChrome: 'no' };
  const body = [node('Heading', { text: page.title, level: 'h1' })];
  if (page.id === catalogue.id) body.push(node('ContentList', { source: 'product', modelId: '', count: 12, columns: 2, mobileColumns: 1,
    titleField: 'builtin:name', descriptionField: 'builtin:description', imageField: 'builtin:image', linkField: 'builtin:url', emptyText: 'No products' }));
  return { root: { props }, content: [header, ...body, footer], zones: {} };
}
async function studio(client: APIRequestContext, patch?: Partial<StudioEnvelope['state']>, expectedRevision?: number) {
  const response = await client.fetch(`${runtime.origin}/api/studio`, patch ? { method: 'PATCH', data: { expectedRevision, patch } } : { method: 'GET' }).catch(() => {
    throw Error('Isolated site state request failed');
  });
  expect(response.ok(), 'Isolated site state status').toBe(true);
  return response.json() as Promise<StudioEnvelope>;
}

test('旧AI头尾迁移可在真实三端草稿核对、确认、恢复记录并撤销', async ({ page, ui }) => {
  test.setTimeout(95000);
  const origin = new URL(runtime.origin);
  expect(origin.hostname).toBe('127.0.0.1');
  expect(origin.port).not.toBe('3200');
  const client = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 12000 });
  for (const path of ['/api/ai/build/chrome-migration', '/api/ai/build/apply', '/api/ai/build/undo']) ui.allowWrite('POST', path);
  const original = await studio(client);
  const generated = [home, contact, catalogue];
  const bodies = Object.fromEntries(generated.map((item, index) => [item.id, legacy(item, index * 20)]));
  const seeded = await studio(client, { pages: [...original.state.pages, ...generated], editorData: { ...original.state.editorData, ...bodies } }, original.revision);
  try {
    await go(page, 'global-design');
    const open = () => textButton(page, '同步旧 AI 页面').click();
    const dialog = page.getByRole('dialog', { name: '同步旧 AI 页眉页脚', exact: true });
    await open();
    await select(page, '选择旧 AI 页面', 'Legacy Home');
    await dialog.getByRole('checkbox', { name: '同时开启旧 AI 产品目录的搜索、分类和分页' }).check();
    await textButton(dialog, '查看同步前后').click();
    await expect(dialog).toContainText('3 个页面');
    const frame = (title: string) => dialog.frameLocator(`iframe[title="${title}"]`).frameLocator('iframe[title="网站草稿隔离预览"]');
    const after = frame('同步后');
    await expect(frame('修改前').getByRole('heading', { name: 'Legacy Home', exact: true })).toBeVisible();
    await expect(after.getByRole('heading', { name: 'Legacy Home', exact: true })).toBeVisible();
    await expect(after.getByRole('navigation', { name: 'Website navigation' })).toBeVisible();
    expect((await studio(client)).revision).toBe(seeded.revision);

    await dialog.locator('.ant-segmented-item').filter({ hasText: '平板' }).click();
    await expect(after.getByRole('heading', { name: 'Legacy Home', exact: true })).toBeVisible();
    await dialog.locator('.ant-segmented-item').filter({ hasText: '手机' }).click();
    const nativeMenu = after.getByRole('navigation', { name: 'Website navigation' }).locator('.site-menu-mobile');
    const toggle = nativeMenu.locator(':scope > summary');
    await expect(toggle).toBeVisible();
    await toggle.press('Enter');
    await expect(nativeMenu).toHaveAttribute('open', '');
    await expect(nativeMenu.getByRole('link', { name: 'Legacy Contact' })).toBeVisible();
    await select(page, '头尾同步预览页面', 'Legacy Contact');
    await expect(after.getByRole('heading', { name: 'Legacy Contact', exact: true })).toBeVisible();
    await select(page, '头尾同步预览页面', 'Legacy Catalogue');
    await expect(frame('修改前').locator('.editor-site-content-list')).toBeVisible();
    await expect(after.locator('.editor-site-loop-item')).toHaveCount(12);
    const nextPage = after.locator('.site-loop-pagination a').first();
    await nextPage.press('Enter');
    await expect(after.locator('.site-loop-pagination')).toContainText('2 /');
    const filters = after.locator('.site-loop-filters');
    await filters.locator('select').selectOption({ label: '分类 Beta' });
    const search = filters.locator('input[type="search"]');
    await search.fill('UI-SKU-20');
    await search.press('Enter');
    await expect(after.locator('.editor-site-loop-item')).toHaveCount(1);
    await expect(after.locator('.editor-site-loop-item')).toContainText('UI Product 20');
    await noOverflow(page, dialog);

    await textButton(dialog, '采用同步方案').click();
    await textButton(page, '确认保存').click();
    await expect(dialog).toContainText('已保存为草稿');
    const adopted = await studio(client);
    expect(adopted.activeReleaseId).toBe(original.activeReleaseId);
    const updated = adopted.state.editorData as Record<string, Data>;
    for (const draft of [home, contact]) expect(updated[draft.id].content.map(item => item.type)).toEqual(['SharedBlock', 'Heading', 'SharedBlock']);
    expect(updated[catalogue.id].content.map(item => item.type)).toEqual(['SharedBlock', 'Heading', 'ContentLoop', 'SharedBlock']);
    expect(updated[home.id].content[0].props.blockId).toBe(updated[contact.id].content[0].props.blockId);
    expect(adopted.state.siteLayout?.menus?.at(-1)?.items.map(row => row.target?.id)).toEqual(generated.map(item => item.id));

    await page.reload();
    await open();
    await textButton(dialog, '查看记录').first().click();
    await expect(dialog).toContainText('已保存为草稿');
    await textButton(dialog, '撤销本次同步').click();
    await textButton(page, '确认撤销').click();
    await expect(dialog).toContainText('已撤销');
    const reverted = await studio(client);
    expect(reverted.activeReleaseId).toBe(original.activeReleaseId);
    for (const draft of generated) expect(reverted.state.editorData[draft.id]).toEqual(seeded.state.editorData[draft.id]);
    expect(reverted.state.sharedBlocks).toEqual(seeded.state.sharedBlocks);
    expect(reverted.state.siteLayout).toEqual(seeded.state.siteLayout);
    expect(ui.writes.map(write => write.path)).toEqual(['/api/ai/build/chrome-migration', '/api/ai/build/apply', '/api/ai/build/undo']);
  } finally {
    const latest = await studio(client);
    await studio(client, { pages: original.state.pages, editorData: original.state.editorData, sharedBlocks: original.state.sharedBlocks || [],
      siteLayout: original.state.siteLayout || { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: [] } }, latest.revision);
    await client.dispose();
  }
});
