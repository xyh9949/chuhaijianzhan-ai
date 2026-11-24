import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { ComponentData } from '@puckeditor/core';
import { getProductPath } from '../../src/lib/content-routes';
import { withEditorRootDefaults } from '../../src/lib/editor-root-defaults';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { FormDefinition, Inquiry, PageItem } from '../../src/lib/types';
import { expect, go, noOverflow, runtime, test, textButton } from './fixtures';

const formId = 'ui-multi-product-quote';
const contactPath = '/request-a-quote';
const catalogPath = '/rfq-directory';
const formPath = `/api/public/forms/${formId}`;
const buyerEmail = 'two-product-test@example.invalid';

async function json<T>(client: APIRequestContext, route: string, method = 'GET', data?: unknown) {
  const response = await client.fetch(`${runtime.origin}${route}`, { method, ...(data === undefined ? {} : { data }) });
  const error = response.ok() ? '' : String((await response.json().catch(() => ({}))).error || '');
  expect(response.ok(), `${method} ${route}: ${response.status()} ${error}`).toBe(true);
  return response.json() as Promise<T>;
}

test('手机跨目录与详情页选两款并提交一条询价，原样重试只通知一次', async ({ page, context, ui }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin } });
  const studio = () => json<StudioEnvelope>(control, '/api/studio');
  const original = await studio();
  const first = original.state.products.find(item => item.id === 'p2')!;
  const second = original.state.products.find(item => item.id === 'p4')!;
  const form: FormDefinition = {
    id: formId, name: 'UI project inquiry', enabled: true, submitLabel: 'Send project inquiry', successMessage: 'Project inquiry received.',
    fields: [
      { id: 'quote-name', type: 'text', label: 'Your name', mapTo: 'name', required: true },
      { id: 'quote-email', type: 'email', label: 'Email', mapTo: 'email', required: true },
      { id: 'quote-product', type: 'product', label: 'Old product selector', mapTo: 'product', required: true },
      { id: 'quote-message', type: 'textarea', label: 'Project brief', mapTo: 'message', required: true },
    ],
  };
  const pageItem = (id: string, title: string, slug: string): PageItem => ({ id, title, slug, type: '普通页面', updated: '', status: 'draft', locale: 'en' });
  const catalog = pageItem('ui-quote-catalog', 'Inquiry directory', catalogPath);
  const contact = pageItem('ui-quote-contact', 'Request a quote', contactPath);
  const node = (type: string, id: string, props: object): ComponentData => ({ type, props: { id, ...props } });
  const data = (title: string, ...content: ComponentData[]) => withEditorRootDefaults({ root: { props: { title } }, content });
  ui.allowWrite('PATCH', '/api/studio');
  ui.allowWrite('POST', `${formPath}/session`);
  ui.allowWrite('POST', formPath);

  try {
    // 仅在随机端口准备目录和一个普通表单。后台用真实开关启用，浏览器从公开页面完成选品及提交。
    await json(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: {
      forms: [...original.state.forms || [], form], pages: [...original.state.pages, catalog, contact], settings: { ...original.state.settings, publicUrl: runtime.origin },
      editorData: { ...original.state.editorData,
        [catalog.id]: data(catalog.title, node('Heading', 'quote-catalog-heading', { text: catalog.title, level: 'h1' }), node('ProductList', 'quote-product-list', { title: 'Products', count: 6, columns: 2, mobileColumns: 1 })),
        [contact.id]: data(contact.title, node('Heading', 'quote-contact-heading', { text: contact.title, level: 'h1' }), node('Form', 'quote-form-element', { formId })),
      },
    } });
    await go(page, 'global-design');
    await page.getByRole('tab', { name: /网站表单/ }).click();
    await page.locator(`tr[data-row-key="${formId}"]`).getByRole('button', { name: /^编\s*辑$/ }).click();
    const dialog = page.getByRole('dialog', { name: '编辑表单定义' });
    await dialog.getByRole('switch', { name: '允许多产品询价' }).click();
    await textButton(dialog, '保存表单草稿').click();
    await expect(dialog).toBeHidden();
    const draft = await studio();
    expect(draft.state.forms?.find(item => item.id === formId)?.multiProduct).toBe(true);
    const release = { expectedRevision: draft.revision, baseReleaseId: draft.activeReleaseId, title: 'Synthetic RFQ browser verification', pageIds: [catalog.id, contact.id], includeForms: true, includeSettings: true, includeTheme: false };
    expect((await json<{ errors: string[] }>(control, '/api/releases/preview', 'POST', release)).errors).toEqual([]);
    const published = await json<StudioEnvelope>(control, '/api/releases', 'POST', release);
    expect(published.activeReleaseId).not.toBe(original.activeReleaseId);

    const administratorCookies = await context.cookies();
    await context.clearCookies();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(catalogPath);
    await page.getByRole('button', { name: `Add to inquiry: ${first.name}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `Remove from inquiry: ${first.name}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.goto(getProductPath(draft.state, second)!);
    await page.getByRole('button', { name: `Add to inquiry: ${second.name}`, exact: true }).click();
    await page.getByRole('link', { name: 'View inquiry list (2)', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${contactPath}\\?rfq=1$`));
    await expect(page.getByLabel('Old product selector')).toHaveCount(0);
    await page.getByRole('spinbutton', { name: `Quantity: ${first.name}` }).fill('24');
    await page.getByRole('spinbutton', { name: `Quantity: ${second.name}` }).fill('12');
    await page.getByRole('textbox', { name: `Specifications or purchase requirements: ${second.name}` }).fill('Specify the finish and packaging.');
    await page.getByLabel('Your name', { exact: true }).fill('Synthetic procurement team');
    await page.getByLabel('Email', { exact: true }).fill(buyerEmail);
    await page.getByLabel('Project brief', { exact: true }).fill('Two models for a local verification.');
    await noOverflow(page);
    expect(await page.getByLabel('Your name', { exact: true }).evaluate(element => Math.min(element.getBoundingClientRect().left, innerWidth - element.getBoundingClientRect().right))).toBeGreaterThanOrEqual(16);
    await testInfo.attach('mobile-multi-product-form', { body: await page.screenshot(), contentType: 'image/png' });
    const submitted = page.waitForResponse(response => new URL(response.url()).pathname === formPath && response.request().method() === 'POST');
    await textButton(page, form.submitLabel).click();
    const response = await submitted;
    expect(response.status()).toBe(200);
    await expect(page.getByText(form.successMessage, { exact: true })).toBeVisible();
    const retry = await page.request.post(`${runtime.origin}${formPath}`, { headers: { Origin: runtime.origin }, data: response.request().postDataJSON() });
    expect(retry.ok()).toBe(true);
    const inquiries = (await studio()).state.inquiries.filter(item => item.email === buyerEmail);
    expect(inquiries).toHaveLength(1);
    const inquiry = inquiries[0];
    expect(inquiry.items).toEqual([
      { productId: first.id, sku: first.sku, name: first.name, quantity: 24 },
      { productId: second.id, sku: second.sku, name: second.name, quantity: 12, requirements: 'Specify the finish and packaging.' },
    ]);
    await expect.poll(async () => (await json<{ jobs: { status: string }[] }>(control, `/api/notifications?inquiryId=${inquiry.id}`)).jobs.map(job => job.status), { timeout: 12_000 }).toEqual(['mock_sent']);
    await context.clearCookies();
    await context.addCookies(administratorCookies);
    await go(page, 'inquiries');
    await page.getByRole('textbox', { name: '搜索询盘' }).fill(second.sku);
    await textButton(page, inquiry.name).click();
    const drawer = page.getByRole('dialog', { name: '询盘详情' });
    await expect(drawer.getByText('询价清单（2 款）', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Specify the finish and packaging.', { exact: true })).toBeVisible();
  } finally {
    const latest = await studio();
    for (const inquiry of latest.state.inquiries.filter(item => item.email === buyerEmail)) {
      await json(control, `/api/inquiries/${inquiry.id}`, 'DELETE', { expectedRevision: (inquiry as Inquiry & { revision: number }).revision });
    }
    if (latest.activeReleaseId !== original.activeReleaseId) await json(control, `/api/releases/${original.activeReleaseId}/activate`, 'POST', { expectedActiveReleaseId: latest.activeReleaseId });
    if (latest.revision !== original.revision) await json(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { forms: original.state.forms || [], pages: original.state.pages, editorData: original.state.editorData, settings: original.state.settings } });
    await control.dispose();
  }
});
