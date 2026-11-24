import { request, type Page, type Response } from '@playwright/test';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import { expect, go, runtime, select, test, textButton } from './fixtures';

const alpha = { id: 'canvas-recovery-alpha', slug: '/canvas-recovery-alpha', title: 'Canvas Recovery Alpha' };
const beta = { id: 'canvas-recovery-beta', slug: '/canvas-recovery-beta', title: 'Canvas Recovery Beta' };
const canvas = (page: Page) => page.frameLocator('.editor-scaled-frame iframe');
const heading = (page: Page, value: string) => canvas(page).locator('.editor-site-heading').filter({ hasText: value });

async function seed() {
  const api = await request.newContext({ baseURL: runtime.origin, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, storageState: runtime.adminAuth });
  const read = async () => await (await api.get('/api/studio')).json() as StudioEnvelope;
  const before = await read();
  const fixtureData = (name: string, id: string): Data => {
    const root = { props: { title: name, showChrome: 'no' } };
    return { root, content: ['First', 'Second', 'Third'].map((suffix, index) => ({ type: 'Heading', props: { id: `${id}-${index}`, level: index ? 'h2' : 'h1', text: `${name} ${suffix}` } })) };
  };
  const initial = fixtureData(alpha.title, alpha.id);
  async function patch(revision: number, pages: StudioEnvelope['state']['pages'], editorData: StudioEnvelope['state']['editorData']) {
    const response = await api.patch('/api/studio', { data: { expectedRevision: revision, patch: { pages, editorData } } });
    expect(response.status(), await response.text()).toBe(200);
  }
  await patch(before.revision, [...before.state.pages, ...[alpha, beta].map(value => ({ ...value, status: 'draft' as const, type: '普通页面', updated: '2026-11-19T00:00:00.000Z' }))], { ...before.state.editorData, [alpha.id]: initial, [beta.id]: fixtureData(beta.title, beta.id) });
  return {
    read,
    content: async (id = alpha.id) => ((await read()).state.editorData[id] as Data).content,
    async cleanup() {
      try { await patch((await read()).revision, before.state.pages, before.state.editorData); }
      finally { await api.dispose(); }
    },
  };
}

async function open(page: Page, which = alpha) {
  await go(page, 'pages');
  await page.locator(`tr[data-row-key="${which.id}"] .table-title`).click();
  await expect(heading(page, `${which.title} First`)).toHaveCount(1);
}

async function insert(page: Page, title: string) {
  await page.getByRole('searchbox', { name: '查找元素' }).fill(title);
  await textButton(page.locator('.editor-search-results'), title).click();
}

test('复查修复 #1：双标签冲突后重载当前画布，旧标签不能覆盖已保存正文', async ({ page, ui }) => {
  const fixture = await seed();
  ui.allowWrite('PATCH', '/api/studio');
  ui.expectHttpError('PATCH', '/api/studio', 409);
  const a = await page.context().newPage();
  const isStudioPatch = (response: Response) => new URL(response.url()).pathname === '/api/studio' && response.request().method() === 'PATCH';
  try {
    await open(a);
    await open(page);
    const winner = a.waitForResponse(response => isStudioPatch(response) && response.status() === 200);
    await insert(a, '正文');
    await winner;
    const savedByA = await fixture.content();
    expect(savedByA.map(item => item.type)).toEqual(['Heading', 'Heading', 'Heading', 'Text']);
    const conflict = page.waitForResponse(response => isStudioPatch(response) && response.status() === 409);
    await insert(page, '标题');
    await conflict;
    await expect(heading(page, 'A little room for possibility.')).toHaveCount(1);
    await expect(page.getByText('工作区同步未完成', { exact: true })).toBeVisible();
    await textButton(page, '重新加载').click();
    await page.getByRole('dialog', { name: '重新加载服务器版本？' }).getByRole('button', { name: /^确\s*定$/ }).click();
    await expect(page.getByText('工作区同步未完成', { exact: true })).toHaveCount(0);
    await expect(heading(page, 'A little room for possibility.')).toHaveCount(0);
    await expect(canvas(page).getByText(/Thoughtful design, natural materials/)).toBeVisible();
    const reloaded = await fixture.read();
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('草稿已保存；公开发布请进入发布管理。')).toBeVisible();
    expect((await fixture.read()).revision).toBe(reloaded.revision);
    expect(await fixture.content()).toEqual(savedByA);

    // 重新加载后仍能正常操作原生设计，确实保存的是 A 的正文加上 B 新添加的元素。
    await insert(page, '标题');
    await expect.poll(async () => (await fixture.content()).map(item => item.type)).toEqual(['Heading', 'Heading', 'Heading', 'Text', 'Heading']);
  } finally {
    await a.close();
    await ui.closeOwnedPage();
    await fixture.cleanup();
  }
});

for (const route of ['刷新预览后返回', '切页后用浏览器后退'] as const) {
  test(`复查修复 #4：清空后${route}，按原页面撤销与重做`, async ({ page, ui }) => {
    const fixture = await seed();
    ui.allowWrite('PATCH', '/api/studio');
    try {
      await open(page);
      const original = await fixture.content();
      const other = await fixture.content(beta.id);
      await page.getByRole('tab', { name: '页面操作' }).click();
      await textButton(page, '清空当前页面').click();
      await textButton(page.getByRole('dialog', { name: '清空当前页面？' }), '清空页面').click();
      if (route === '刷新预览后返回') {
        // 直接点预览，让保存与Puck各自完成，避免测试预先等待撤销点而掩盖快速跳转的丢失。
        await page.getByRole('button', { name: '预览页面', exact: true }).click();
        const preview = page.frameLocator('iframe[title="网站完整草稿预览"]');
        await expect(preview.getByRole('link', { name: '返回管理后台' })).toBeVisible();
        await expect.poll(fixture.content).toEqual([]);
        await page.reload();
        await expect(preview.getByRole('link', { name: '返回管理后台' })).toBeVisible();
        await textButton(page, '返回编辑器').click();
      } else {
        await expect.poll(fixture.content).toEqual([]);
        await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
        await select(page, '当前编辑页面', beta.title);
        await expect(heading(page, `${beta.title} First`)).toHaveCount(1);
        await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
        await page.goBack();
      }
      await expect(page.locator('.editor-page-picker')).toContainText(alpha.title);
      const undo = page.getByRole('button', { name: '撤销', exact: true });
      await expect(undo).toBeEnabled();
      await undo.click();
      await expect(heading(page, `${alpha.title} Third`)).toHaveCount(1);
      await expect.poll(fixture.content).toEqual(original);
      await page.getByRole('button', { name: '重做', exact: true }).click();
      await expect.poll(fixture.content).toEqual([]);
      await undo.click();
      await expect.poll(fixture.content).toEqual(original);
      expect(await fixture.content(beta.id)).toEqual(other);
    } finally {
      await ui.closeOwnedPage();
      await fixture.cleanup();
    }
  });
}

test('复查修复 #4：实际鼠标拖拽后仍可撤销重做，刷新保持顺序', async ({ page, ui }) => {
  const fixture = await seed();
  ui.allowWrite('PATCH', '/api/studio');
  try {
    await open(page);
    const ids = async () => (await fixture.content()).map(item => item.props.id);
    const original = await ids();
    const first = heading(page, `${alpha.title} First`), last = heading(page, `${alpha.title} Third`);
    await first.scrollIntoViewIfNeeded();
    await last.scrollIntoViewIfNeeded();
    const start = await first.boundingBox();
    const finish = await last.boundingBox();
    if (!start || !finish) throw new Error('找不到真实的画布拖拽坐标');
    expect(start.y).toBeLessThan(finish.y);
    // 指针移过拖拽阈值后将首项放到第三项下方，浏览器和服务器都要确认重排。
    const x = start.x + start.width / 2, y = start.y + start.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 12, { steps: 5 });
    await page.mouse.move(finish.x + finish.width / 2, finish.y + Math.max(3, finish.height - 3), { steps: 20 });
    await page.mouse.up();
    const reordered = [original[1], original[2], original[0]];
    await expect.poll(ids).toEqual(reordered);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(ids).toEqual(original);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(ids).toEqual(reordered);
    await page.reload();
    await expect(canvas(page).locator('.editor-site-heading')).toHaveText([`${alpha.title} Second`, `${alpha.title} Third`, `${alpha.title} First`]);
  } finally {
    await ui.closeOwnedPage();
    await fixture.cleanup();
  }
});
