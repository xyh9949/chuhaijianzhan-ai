import { randomUUID } from 'node:crypto';
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import type { Data } from '@puckeditor/core';
import sharp from 'sharp';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { PageItem, StudioState } from '../../src/lib/types';
import { expect, go, noOverflow, runtime, select, test, textButton } from './fixtures';

const control = () => playwrightRequest.newContext({ baseURL: runtime.origin, storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, maxRedirects: 0 });
const previewFrame = 'iframe[title="网站完整草稿预览"]';
const sandboxFrame = 'iframe[title="网站草稿隔离预览"]';
const embeddedPreview = (page: Page) => page.frameLocator(previewFrame);

async function readDraft(api: APIRequestContext): Promise<StudioEnvelope> {
  const response = await api.get('/api/studio');
  expect(response.ok()).toBe(true);
  return response.json();
}

async function patchDraft(api: APIRequestContext, expectedRevision: number, patch: Partial<StudioState>): Promise<StudioEnvelope> {
  const response = await api.patch('/api/studio', { data: { expectedRevision, patch } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function uploadMedia(api: APIRequestContext, name: string, folder: string, color: string) {
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer();
  const before = await readDraft(api);
  const response = await api.post('/api/media', { multipart: { file: { name, mimeType: 'image/png', buffer: png }, folder, expectedRevision: String(before.revision) } });
  expect(response.ok(), await response.text()).toBe(true);
  const after: StudioEnvelope = await response.json();
  return after.state.media.find(item => item.name === name)!;
}

test('手机素材切换搜索后仅移出当前筛选明确列出的文件，取消不写入', async ({ page, ui }, testInfo) => {
  const api = await control();
  const original = await readDraft(api);
  ui.allowWrite('POST', '/api/media/batch');
  try {
    const alfa = await uploadMedia(api, 'audit-alfa-hidden.png', '审核素材 A', '#a45b74');
    const bravo = await uploadMedia(api, 'audit-bravo-visible.png', '审核素材 B', '#3b8077');
    const draft = await readDraft(api);
    await page.setViewportSize({ width: 390, height: 850 });
    await go(page, 'media');
    const search = page.getByRole('textbox', { name: '搜索素材' });
    const selectFiltered = textButton(page, '选择当前筛选');
    const remove = textButton(page, '移出所选');
    await search.fill('audit-alfa-');
    await selectFiltered.click();
    await expect(page.getByRole('checkbox', { name: `选择素材 ${alfa.name}` })).toBeChecked();
    await search.fill('audit-bravo-');
    await expect(remove).toHaveCount(0);
    await selectFiltered.click();
    await remove.click();
    const dialog = page.getByRole('dialog', { name: '移出 1 份素材？' });
    await expect(dialog.getByText(bravo.name, { exact: true })).toBeVisible();
    await expect(dialog.getByText(alfa.name, { exact: true })).toHaveCount(0);
    await noOverflow(page, dialog);
    await testInfo.attach('mobile-remove-visible-file', { body: await dialog.screenshot(), contentType: 'image/png' });
    await dialog.getByRole('button', { name: /^取\s*消$/ }).click();
    await expect(dialog).toBeHidden();
    expect(ui.writes).toEqual([]);
    expect((await readDraft(api)).revision).toBe(draft.revision);
    await remove.click();
    const posted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/media/batch');
    await dialog.getByRole('button', { name: '移出素材库' }).click();
    expect((await posted).postDataJSON()).toEqual({ expectedRevision: draft.revision, ids: [bravo.id], action: 'remove' });
    await expect(dialog).toBeHidden();
    const after = await readDraft(api);
    expect(after.state.media.find(item => item.id === alfa.id)).toEqual(alfa);
    expect(after.state.media.some(item => item.id === bravo.id)).toBe(false);
    expect(after.activeReleaseId).toBe(draft.activeReleaseId);
  } finally {
    await ui.closeOwnedPage();
    await patchDraft(api, (await readDraft(api)).revision, { media: original.state.media });
    await api.dispose();
  }
});

test('桌面素材切换搜索和文件夹清除勾选，移动前核对文件名和目的文件夹', async ({ page, ui }, testInfo) => {
  const api = await control();
  const original = await readDraft(api);
  ui.allowWrite('POST', '/api/media/batch');
  try {
    const delta = await uploadMedia(api, 'audit-delta-hidden.png', '审核来源 Delta', '#565b9a');
    const echo = await uploadMedia(api, 'audit-echo-visible.png', '审核来源 Echo', '#588a7d');
    const draft = await readDraft(api);
    await go(page, 'media');
    const search = page.getByRole('textbox', { name: '搜索素材' });
    const checkbox = (name: string) => page.getByRole('checkbox', { name: `选择素材 ${name}` });
    const move = textButton(page, '移动到文件夹');
    await checkbox(delta.name).check();
    await page.getByRole('textbox', { name: '批量目标文件夹' }).fill('不得移动此勾选');
    await search.fill('audit-echo-');
    await expect(move).toHaveCount(0);
    await expect(checkbox(echo.name)).not.toBeChecked();
    await checkbox(echo.name).check();
    await page.getByRole('menuitem').filter({ hasText: echo.folder }).click();
    await expect(checkbox(echo.name)).not.toBeChecked();
    await expect(move).toHaveCount(0);
    await checkbox(echo.name).check();
    await page.getByRole('textbox', { name: '批量目标文件夹' }).fill('审核目标文件夹');
    await move.click();
    const dialog = page.getByRole('dialog', { name: '移动 1 份素材？' });
    await expect(dialog.getByText(echo.name, { exact: true })).toBeVisible();
    await expect(dialog.getByText('审核目标文件夹', { exact: true })).toBeVisible();
    await expect(dialog.getByText(delta.name, { exact: true })).toHaveCount(0);
    expect(ui.writes).toEqual([]);
    await testInfo.attach('desktop-confirm-move-visible-file', { body: await dialog.screenshot(), contentType: 'image/png' });
    const posted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/media/batch');
    await dialog.getByRole('button', { name: '确认移动' }).click();
    expect((await posted).postDataJSON()).toEqual({ expectedRevision: draft.revision, ids: [echo.id], action: 'move', folder: '审核目标文件夹' });
    await expect(dialog).toBeHidden();
    const after = await readDraft(api);
    expect(after.state.media.find(item => item.id === delta.id)).toEqual(delta);
    expect(after.state.media.find(item => item.id === echo.id)?.folder).toBe('审核目标文件夹');
    expect(after.activeReleaseId).toBe(draft.activeReleaseId);
  } finally {
    await ui.closeOwnedPage();
    await patchDraft(api, (await readDraft(api)).revision, { media: original.state.media });
    await api.dispose();
  }
});

const previewPathAlpha = '/recheck-fixture-alpha';
const previewPathBeta = '/recheck-fixture-beta';
const blockId = 'recheck-preview-block';
const blockName = 'Recheck shared preview block';
const alphaTitle = 'Recheck private Alpha';
const betaTitle = 'Recheck private Beta';
const authLink = 'Go to private Beta';
const anchorLink = 'Jump to lower section';
const lowerHeading = 'Lower fixture section';

/** 两张真实草稿同时引用同一模块，且有跨页按钮和足量内容可测实际滚动。 */
async function seedPreview(api: APIRequestContext, original: StudioEnvelope) {
  const updated = '2026-11-20T00:00:00Z';
  const alpha: PageItem = { id: 'recheck-preview-alpha', title: alphaTitle, slug: previewPathAlpha, type: '普通页面', status: 'draft', updated };
  const beta: PageItem = { id: 'recheck-preview-beta', title: betaTitle, slug: previewPathBeta, type: '普通页面', status: 'draft', updated };
  const heading = (id: string, text: string, options = {}) => ({ type: 'Heading', props: { id, level: 'h1', text, ...options } });
  const link = (id: string, text: string, href: string) => ({ type: 'ActionButton', props: { id, text, href } });
  const reference = (id: string) => ({ type: 'SharedBlock', props: { id, blockId } });
  const root = { props: { title: 'Draft recheck fixture', showChrome: 'no' } };
  const layout = (content: Data['content']): Data => ({ root, content });
  const padding = Array.from({ length: 10 }, (_, index) => ({ type: 'Text', props: { id: `recheck-padding-${index}`, text: 'Detailed test section. '.repeat(28), design: { desktop: { paddingTop: 40, paddingBottom: 40 }, mobile: { paddingTop: 40, paddingBottom: 40 } } } }));
  return patchDraft(api, original.revision, {
    pages: [...original.state.pages, alpha, beta],
    sharedBlocks: [...original.state.sharedBlocks || [], { id: blockId, name: blockName, updated, data: layout([heading('recheck-block-heading', blockName, { level: 'h2' })]) }],
    editorData: {
      ...original.state.editorData,
      [alpha.id]: layout([
        heading('recheck-alpha-heading', alpha.title), link('recheck-from-alpha', authLink, previewPathBeta),
        link('recheck-jump', anchorLink, '#recheck-lower'), reference('recheck-ref-alpha'),
        ...padding, heading('recheck-end', lowerHeading, { level: 'h2', anchor: 'recheck-lower' }),
      ]),
      [beta.id]: layout([heading('recheck-beta-heading', beta.title), reference('recheck-ref-beta')]),
    },
  });
}

async function restorePreview(api: APIRequestContext, original: StudioEnvelope) {
  const { pages, sharedBlocks, editorData } = original.state;
  await patchDraft(api, (await readDraft(api)).revision, { pages, sharedBlocks: sharedBlocks || [], editorData });
}

test('同步区块选定非默认引用页并切换到手机，刷新后保留所选页面与返回入口', async ({ page, ui }) => {
  const api = await control();
  const original = await readDraft(api);
  ui.allowWrite('PATCH', '/api/studio');
  try {
    await seedPreview(api, original);
    await go(page, 'global-design');
    await page.getByRole('tab', { name: '重复使用的内容' }).click();
    await page.getByRole('textbox', { name: '搜索同步区块' }).fill(blockName);
    await page.locator(`tr[data-row-key="${blockId}"]`).getByRole('button', { name: /^编\s*辑$/ }).click();
    await expect(page).toHaveURL(/#editor$/);
    await page.getByRole('button', { name: '预览页面', exact: true }).click();
    await expect(page).toHaveURL(/#preview$/);
    await expect(embeddedPreview(page).frameLocator(sandboxFrame).getByRole('heading', { name: alphaTitle })).toBeVisible();
    await select(page, '选择区块预览的引用页面', betaTitle);
    await page.locator('.editor-preview-topbar .ant-segmented-item').filter({ hasText: '手机' }).click();
    const iframe = page.locator(previewFrame);
    await expect(iframe).toHaveAttribute('src', `/preview${previewPathBeta}`);
    await expect(iframe).toHaveCSS('width', '390px');
    const revision = (await readDraft(api)).revision;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(iframe).toHaveAttribute('src', `/preview${previewPathBeta}`);
    await expect(iframe).toHaveCSS('width', '390px');
    await expect(embeddedPreview(page).frameLocator(sandboxFrame).getByRole('heading', { name: betaTitle })).toBeVisible();
    await textButton(page, '返回编辑器').click();
    await expect(page).toHaveURL(/#editor$/);
    await expect(page.locator('.editor-page-picker')).toContainText(blockName);
    expect((await readDraft(api)).revision).toBe(revision);
  } finally {
    await ui.closeOwnedPage();
    await restorePreview(api, original);
    await api.dispose();
  }
});

test('双标签真实退出后打开内嵌草稿站内链接，在顶层重新登录并移除原预览框', async ({ page, context, ui }, testInfo) => {
  const api = await control();
  const original = await readDraft(api);
  const email = `ui-preview-session-${randomUUID()}@example.invalid`;
  const password = `Ui-${randomUUID()}-aA1!`;
  let memberId = '';
  let other: Page | undefined;
  ui.allowWrite('POST', '/api/auth/sign-in/email');
  ui.allowWrite('POST', '/api/auth/sign-out');
  ui.allowWrite('PATCH', '/api/studio');
  async function login() {
    await page.getByRole('textbox', { name: '登录邮箱', exact: true }).fill(email);
    await page.getByLabel('登录密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: /登录工作区/ }).click();
    await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  }
  try {
    await seedPreview(api, original);
    const member = await api.post('/api/members', { data: { name: 'UI preview session member', email, password, role: 'editor' } });
    expect(member.status()).toBe(201);
    memberId = (await member.json()).member.id;
    // 使用专用编辑员真实会话，退出不会使同一测试套件的管理员票据失效。
    await context.clearCookies();
    await page.goto('/admin');
    await login();
    await go(page, 'pages');
    await page.locator('tr[data-row-key="recheck-preview-alpha"] .table-title').click();
    await expect(page).toHaveURL(/#editor$/);
    await page.getByRole('button', { name: '预览页面', exact: true }).click();
    await expect(page).toHaveURL(/#preview$/);
    const site = embeddedPreview(page).frameLocator(sandboxFrame);
    await expect(site.getByRole('link', { name: authLink })).toBeVisible();
    other = await context.newPage();
    await other.goto('/admin', { waitUntil: 'domcontentloaded' });
    await other.getByRole('button', { name: '打开工作区菜单' }).click();
    await other.getByText('退出登录', { exact: true }).click();
    await expect(other.getByRole('textbox', { name: '登录邮箱', exact: true })).toBeVisible();
    const directlyOpened = await other.request.get(`/preview${previewPathBeta}`, { maxRedirects: 0 });
    expect(directlyOpened.status()).toBe(307);
    expect(directlyOpened.headers().location).toBe('/admin');

    const route = page.waitForResponse(response => response.request().resourceType() === 'document' && new URL(response.url()).pathname === `/preview${previewPathBeta}`);
    await site.getByRole('link', { name: authLink }).click();
    expect((await route).status()).toBe(200);
    const expired = embeddedPreview(page);
    await expect(expired.getByRole('heading', { name: '预览登录已过期', exact: true })).toBeVisible();
    await expect(expired.getByRole('textbox', { name: '登录邮箱', exact: true })).toHaveCount(0);
    await expect(expired.frameLocator(sandboxFrame).getByRole('heading', { name: betaTitle })).toHaveCount(0);
    await testInfo.attach('expired-embedded-preview', { body: await page.screenshot(), contentType: 'image/png' });
    expect(page.url()).toBe(`${runtime.origin}/admin#preview`);
    await expired.getByRole('link', { name: '前往管理后台登录', exact: true }).click();
    await expect(page).toHaveURL(`${runtime.origin}/admin`);
    await expect(page.locator(previewFrame)).toHaveCount(0);
    await login();
    await expect(page.locator(previewFrame)).toHaveCount(0);
    expect(page.frames().filter(frame => frame.parentFrame() && new URL(frame.url()).pathname === '/admin')).toHaveLength(0);
  } finally {
    await other?.close();
    await ui.closeOwnedPage();
    if (memberId) expect((await api.patch(`/api/members/${memberId}`, { data: { disabled: true } })).ok()).toBe(true);
    await restorePreview(api, original);
    await api.dispose();
  }
});

test('草稿预览首次点击页内锚点后退，地址和原始滚动位置一起恢复', async ({ page, ui }) => {
  const api = await control();
  const original = await readDraft(api);
  try {
    const seeded = await seedPreview(api, original);
    const path = `${runtime.origin}/preview${previewPathAlpha}`;
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const sandbox = page.frameLocator(sandboxFrame);
    const jump = sandbox.getByRole('link', { name: anchorLink });
    await expect(jump).toBeInViewport();
    const scroll = () => page.evaluate(() => Math.round(scrollY));
    const before = await scroll();
    await jump.click();
    await expect(page).toHaveURL(`${path}#recheck-lower`);
    await expect.poll(scroll).toBeGreaterThan(before + 400);
    await expect(sandbox.getByRole('heading', { name: lowerHeading })).toBeInViewport();
    await page.goBack({ waitUntil: 'commit' });
    await expect(page).toHaveURL(path);
    await expect.poll(scroll).toBe(before);
    await expect(jump).toBeInViewport();
    await page.goForward({ waitUntil: 'commit' });
    await expect(page).toHaveURL(`${path}#recheck-lower`);
    await expect.poll(scroll).toBeGreaterThan(before + 400);
    expect((await readDraft(api)).revision).toBe(seeded.revision);
    expect(ui.writes).toEqual([]);
  } finally {
    await ui.closeOwnedPage();
    await restorePreview(api, original);
    await api.dispose();
  }
});
