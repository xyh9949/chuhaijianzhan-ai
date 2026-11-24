import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { createFormDefinition } from '../../src/lib/form-content';
import { localeOf } from '../../src/lib/localization';
import type { PageItem } from '../../src/lib/types';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import { expect, go, noOverflow, runtime, test, textButton } from './fixtures';

async function request<T>(client: APIRequestContext, path: string, data?: unknown) {
  const response = await client.fetch(`${runtime.origin}${path}`, { method: data ? 'PATCH' : 'GET', ...(data ? { data } : {}) });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test('发布范围预览显示实际组合、支持站内跳转且保护草稿和线上版本', async ({ page, ui }) => {
  test.setTimeout(90000);
  const headers = { Origin: runtime.origin, Connection: 'close' };
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: headers, maxRedirects: 0 });
  const viewer = await playwrightRequest.newContext({ storageState: runtime.viewerAuth, extraHTTPHeaders: headers, maxRedirects: 0 });
  const anonymous = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] }, maxRedirects: 0 });
  const original = await request<StudioEnvelope>(control, '/api/studio');
  const home = original.state.pages.find(pageItem => pageItem.slug === '/')!;
  const about = original.state.pages.find(pageItem => pageItem.slug === '/about')!;
  const form = createFormDefinition('publish-scope-form');
  const selected: PageItem = { id: 'publication-check-selected', title: 'Selected launch page', slug: '/selected-launch-page', type: '普通页面', status: 'draft', updated: '' };
  const unselected: PageItem = { ...selected, id: 'publication-check-hidden', title: 'Unused private launch page', slug: '/private-launch-page' };
  const node = (type: string, id: string, props: object) => ({ type, props: { id, ...props } });
  const data = (...content: ReturnType<typeof node>[]) => ({ root: { props: { showChrome: 'no' } }, content });
  let preview: Page | undefined, seeded = false;
  try {
    // 在测试进程已有公开版本上只改草稿，建立真实的未选旧公开页、未选新页和已选表单。
    const draft = await request<StudioEnvelope>(control, '/api/studio', { expectedRevision: original.revision, patch: { pages: [...original.state.pages, selected, unselected], forms: [...(original.state.forms || []), form], editorData: { ...original.state.editorData,
      [home.id]: data(node('Heading', 'publication-home', { level: 'h1', text: 'Selected homepage copy' }), node('ActionButton', 'publication-cta', { text: 'Open selected launch page', href: '', linkTarget: { kind: 'page', id: selected.id } })),
      [about.id]: data(node('Text', 'publication-draft-about', { text: 'Unselected draft-only about copy' })),
      [selected.id]: data(node('Heading', 'publication-selected-title', { level: 'h1', text: 'Selected launch page' }), node('Form', 'publication-form', { formId: form.id })), [unselected.id]: data(node('Text', 'publication-private-copy', { text: 'Draft-only private copy' })),
    } } });
    seeded = true;
    ui.allowWrite('POST', '/api/releases/preview');
    await page.setViewportSize({ width: 390, height: 900 });
    await go(page, 'overview');
    await expect(page.getByRole('link', { name: /查看已发布网站$/ })).toHaveAttribute('href', '/');
    await expect(textButton(page, '预览草稿')).toBeVisible();
    await go(page, 'pages');
    const pageTable = page.locator('.pages-records-table');
    await page.getByRole('tab', { name: /^待更新 / }).click();
    await expect(pageTable.getByRole('row').filter({ has: page.getByRole('button', { name: home.title, exact: true }) })).toContainText('待更新');
    await expect(pageTable.getByRole('button', { name: unselected.title, exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: /^草稿 / }).click();
    await expect(pageTable.getByRole('button', { name: unselected.title, exact: true })).toBeVisible();
    await go(page, 'releases');
    await textButton(page, '发布更改').click();
    const dialog = page.getByRole('dialog', { name: '发布网站更新', exact: true });
    await noOverflow(page, dialog);
    await dialog.getByRole('checkbox', { name: /^Unused private launch page/ }).uncheck();
    await dialog.getByRole('checkbox', { name: `${about.title} · ${localeOf(original.state.settings, about)}`, exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: /^Selected launch page/ }).check();
    await dialog.getByRole('checkbox', { name: `${home.title} · ${localeOf(original.state.settings, home)}`, exact: true }).check();
    await dialog.getByText('其他全站设置（按需选择）', { exact: true }).click();
    const forms = dialog.getByRole('checkbox', { name: '询盘表单的字段和按钮' });
    await forms.check();
    await textButton(dialog, '检查所选内容').click();
    const open = dialog.getByRole('link', { name: '预览本次发布内容', exact: true });
    await expect(open).toBeVisible();
    const href = (await open.getAttribute('href'))!;
    expect(href).toMatch(/^\/preview\/~publication\/pubv-[\da-f-]{36}$/);
    await expect(textButton(dialog, '确认更新网站')).toBeEnabled();
    const opened = page.context().waitForEvent('page');
    await open.click(); preview = await opened;
    await preview.setViewportSize({ width: 390, height: 900 });
    const frame = preview.frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(frame.getByRole('heading', { level: 1, name: 'Selected homepage copy' })).toBeVisible();
    await noOverflow(preview);
    const cta = frame.getByRole('link').filter({ hasText: /^Open selected launch page$/ });
    await expect(cta).toHaveAttribute('href', `${href}${selected.slug}`);
    await cta.click();
    await expect(preview).toHaveURL(`${runtime.origin}${href}${selected.slug}`);
    await expect(frame.getByRole('heading', { level: 1, name: 'Selected launch page' })).toBeVisible();
    await frame.getByLabel('Name').fill('Synthetic preview test');
    await frame.getByLabel('Email').fill('preview@example.invalid');
    await frame.getByLabel('Message').fill('Synthetic form test that must stay in preview.');
    await frame.getByRole('button', { name: 'Send inquiry', exact: true }).click();
    await expect(frame.getByText('Preview only — no inquiry was sent.', { exact: true })).toBeVisible();

    expect((await control.get(`${runtime.origin}${href}${unselected.slug}`)).status()).toBe(404);
    expect((await anonymous.get(`${runtime.origin}${href}`)).status()).toBe(404);
    expect((await viewer.get(`${runtime.origin}${href}`)).status()).toBe(404);
    const oldPage = await control.get(`${runtime.origin}${href}${about.slug}`);
    expect(oldPage.ok()).toBe(true);
    expect(await oldPage.text()).not.toContain('Unselected draft-only about copy');
    expect(oldPage.headers()['cache-control']).toContain('no-store');
    expect(oldPage.headers()['x-robots-tag']).toContain('noindex');

    // 缺少表单的新范围不能确认发布；已打开的旧链接仍持有含表单的原范围。
    await forms.uncheck();
    await expect(open).toHaveCount(0);
    await expect(textButton(dialog, '确认更新网站')).toBeDisabled();
    await textButton(dialog, '检查所选内容').click();
    await expect(dialog.getByText('还有问题需要处理', { exact: true })).toBeVisible();
    await expect(open).toHaveCount(0);
    await expect(textButton(dialog, '确认更新网站')).toBeDisabled();
    expect((await control.get(`${runtime.origin}${href}`)).status()).toBe(200);
    expect(await request<StudioEnvelope>(control, '/api/studio')).toEqual(draft);
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/releases/preview' }, { method: 'POST', path: '/api/releases/preview' }]);
  } finally {
    await preview?.close();
    await ui.closeOwnedPage();
    if (seeded) {
      const current = await request<StudioEnvelope>(control, '/api/studio');
      await request(control, '/api/studio', { expectedRevision: current.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, forms: original.state.forms || [] } });
    }
    await control.dispose(); await viewer.dispose(); await anonymous.dispose();
  }
});
