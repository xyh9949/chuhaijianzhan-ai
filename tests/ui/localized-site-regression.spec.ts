import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { SeoDiagnosticReport } from '../../src/lib/seo-types';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { PageItem } from '../../src/lib/types';
import { expect, go, runtime, test, textButton } from './fixtures';

async function api<T>(client: APIRequestContext, path: string, method = 'GET', data?: unknown) {
  const response = await client.fetch(`${runtime.origin}${path}`, { method, ...(data ? { data } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

function draftPage(id: string, title: string, slug: string, locale?: string): PageItem {
  return { id, title, slug, ...(locale ? { locale } : {}), type: '普通页面', status: 'draft', updated: '' };
}

const heading = (id: string, text: string, anchor?: string) => ({ type: 'Heading', props: { id, level: 'h1', text, ...(anchor ? { anchor } : {}) } });
const layout = (content: object[], showChrome: 'yes' | 'no' = 'yes') => ({ root: { props: { showChrome } }, content });

test('只发布德语内页，站名与面包屑返回可访问的首页，德文文档采用自身语言', async ({ page, ui }) => {
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin }, maxRedirects: 0 });
  const visitor = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] }, maxRedirects: 0 });
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const home = draftPage('locale-regression-home', 'Deutsch Startseite', '/de', 'de');
  const shipping = draftPage('locale-regression-shipping', 'Versandhinweise', '/de/versand', 'de');
  const breadcrumb = { type: 'Breadcrumb', props: { id: 'locale-regression-breadcrumb', homeLabel: 'Homepage' } };
  try {
    await api(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: {
      pages: [...original.state.pages, home, shipping],
      editorData: { ...original.state.editorData, [home.id]: layout([heading('locale-home-h1', home.title)]), [shipping.id]: layout([heading('locale-shipping-h1', shipping.title), breadcrumb]) },
    } });
    ui.allowWrite('POST', '/api/releases/preview');
    ui.allowWrite('POST', '/api/releases');
    await page.setViewportSize({ width: 390, height: 900 });
    await go(page, 'releases');
    await textButton(page, '发布更改').click();
    const dialog = page.getByRole('dialog', { name: '发布网站更新' });
    await dialog.getByRole('checkbox', { name: 'Deutsch Startseite · de' }).uncheck();
    await dialog.getByRole('checkbox', { name: 'Versandhinweise · de' }).check();
    await textButton(dialog, '检查所选内容').click();
    await expect(dialog.getByText('所选内容检查通过')).toBeVisible();
    const previewLink = dialog.getByRole('link', { name: '预览本次发布内容' });
    const previewPath = (await previewLink.getAttribute('href'))!;
    const candidate = await control.get(`${runtime.origin}${previewPath}${shipping.slug}`);
    expect(candidate.status()).toBe(200);
    const candidateBrand = (await candidate.text()).match(/<a class="editor-site-brand" href="([^"]*)"/);
    expect(candidateBrand?.[1]).toBe(previewPath);
    const publish = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/releases');
    await textButton(dialog, '确认更新网站').click();
    expect((await publish).status()).toBe(201);
    await expect(dialog).toBeHidden();
    expect((await visitor.get(`${runtime.origin}${home.slug}`)).status()).toBe(404);

    const published = await page.goto(shipping.slug, { waitUntil: 'load' });
    expect(published?.status()).toBe(200);
    // 同时验证源 HTML 与真实浏览器；客户端水合不能替代正确的文档语言。
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    expect(await published?.text()).toMatch(/<html lang="de">/);
    await expect(page.locator('[data-site-release]')).toHaveAttribute('lang', 'de');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${original.state.settings.publicUrl}${shipping.slug}`);
    await expect(page.getByRole('link', { name: 'Homepage' })).toHaveAttribute('href', '/');
    const brand = page.locator('.editor-site-brand');
    await expect(brand).toHaveAttribute('href', '/');
    await brand.click();
    await expect(page).toHaveURL(`${runtime.origin}/`);
    await page.waitForLoadState('load');
    await expect(page.locator('html')).toHaveAttribute('lang', original.state.settings.language);

    const current = await api<StudioEnvelope>(control, '/api/studio');
    await api(control, '/api/releases', 'POST', { expectedRevision: current.revision, baseReleaseId: current.activeReleaseId, title: 'Locale regression: translated homepage added', pageIds: [home.id], includeTheme: false, includeSettings: false });
    await page.goto(shipping.slug, { waitUntil: 'load' });
    await expect(brand).toHaveAttribute('href', home.slug);
    await expect(page.getByRole('link', { name: 'Homepage' })).toHaveAttribute('href', home.slug);
    await brand.click();
    await expect(page.getByRole('heading', { name: home.title })).toBeVisible();
    await expect(page).toHaveURL(`${runtime.origin}${home.slug}`);
    await page.waitForLoadState('load');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  } finally {
    await ui.closeOwnedPage();
    const current = await api<StudioEnvelope>(control, '/api/studio');
    if (current.activeReleaseId !== original.activeReleaseId) await api(control, `/api/releases/${original.activeReleaseId}/activate`, 'POST', { expectedActiveReleaseId: current.activeReleaseId });
    await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { pages: original.state.pages, editorData: original.state.editorData } });
    await visitor.dispose(); await control.dispose();
  }
});

test('语言专用页眉真实可点的链接计入 SEO，隐藏页眉与自链接不掩盖孤立页', async ({ page, ui }) => {
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin }, maxRedirects: 0 });
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const source = draftPage('seo-locale-source', 'Deutsche Übersicht', '/de/ubersicht', 'de');
  const linked = draftPage('seo-locale-linked', 'Lieferhinweise', '/de/lieferung', 'de');
  const orphan = draftPage('seo-locale-orphan', 'Unverlinkte Seite', '/de/isoliert', 'de');
  const block = { id: 'seo-de-header', name: 'German SEO fixture header', updated: '', data: layout([{ type: 'ActionButton', props: { id: 'seo-de-go', text: linked.title, linkTarget: { kind: 'page', id: linked.id } } }], 'no') };
  try {
    const draft = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: {
      pages: [...original.state.pages, source, linked, orphan],
      editorData: { ...original.state.editorData, [source.id]: layout([heading('seo-de-title', source.title)]), [linked.id]: layout([heading('seo-de-linked', linked.title)]), [orphan.id]: layout([heading('seo-de-orphan', orphan.title), { type: 'ActionButton', props: { id: 'seo-de-self', text: 'Diese Seite', href: orphan.slug } }], 'no') },
      sharedBlocks: [...(original.state.sharedBlocks || []), block],
      siteLayout: { ...original.state.siteLayout, header: { mode: 'default', blockId: '', localeBlockIds: { de: block.id } }, footer: original.state.siteLayout?.footer || { mode: 'default', blockId: '' } },
    } });
    const report = await api<SeoDiagnosticReport>(control, '/api/seo/diagnostics');
    const orphanIds = report.issues.filter(issue => issue.code === 'orphan-page').map(issue => issue.target?.id);
    expect(orphanIds).not.toContain(linked.id);
    expect(orphanIds).toContain(orphan.id);
    await api(control, '/api/releases', 'POST', { expectedRevision: draft.revision, baseReleaseId: draft.activeReleaseId, title: 'Locale regression: translated header', pageIds: [source.id, linked.id, orphan.id], sharedBlockIds: [block.id], includeLayout: true, includeTheme: false, includeSettings: false });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(source.slug, { waitUntil: 'load' });
    const translatedLink = page.locator('header').getByRole('link', { name: linked.title });
    await expect(translatedLink).toHaveAttribute('href', linked.slug);
    await translatedLink.click();
    await expect(page.getByRole('heading', { name: linked.title })).toBeVisible();
    await expect(page).toHaveURL(`${runtime.origin}${linked.slug}`);
  } finally {
    await ui.closeOwnedPage();
    const current = await api<StudioEnvelope>(control, '/api/studio');
    if (current.activeReleaseId !== original.activeReleaseId) await api(control, `/api/releases/${original.activeReleaseId}/activate`, 'POST', { expectedActiveReleaseId: current.activeReleaseId });
    const defaultSlot = { mode: 'default', blockId: '' };
    await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, sharedBlocks: original.state.sharedBlocks || [], siteLayout: original.state.siteLayout || { header: defaultSlot, footer: defaultSlot } } });
    await control.dispose();
  }
});

test('私有预览页内按钮保留可复制的锚点，刷新与历史返回能重新定位', async ({ page, ui }) => {
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin }, maxRedirects: 0 });
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const target = draftPage('preview-anchor-regression', 'Private anchor fixture', '/private-anchor-fixture');
  const section = (id: string, title: string, anchor: string) => ({ type: 'Container', props: { id, minHeight: 800, content: [heading(`${id}-title`, title, anchor)] } });
  const action = (id: string, text: string, href: string) => ({ type: 'ActionButton', props: { id, text, href } });
  try {
    const draft = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: {
      pages: [...original.state.pages, target],
      editorData: { ...original.state.editorData, [target.id]: layout([action('go-second', 'Go to second section', '#section-second'), section('section-first-block', 'First section', 'section-first'), action('go-first', 'Go to first section', '#section-first'), section('section-second-block', 'Second section', 'section-second')], 'no') },
    } });
    const checked = await api<{ errors: string[], preview: { href: string } }>(control, '/api/releases/preview', 'POST', { expectedRevision: draft.revision, baseReleaseId: draft.activeReleaseId, title: 'Preview anchor regression', pageIds: [target.id], includeTheme: false, includeSettings: false });
    expect(checked.errors).toEqual([]);
    const path = `${checked.preview.href}${target.slug}`;
    await page.setViewportSize({ width: 390, height: 850 });
    const response = await page.goto(path, { waitUntil: 'load' });
    expect(response?.headers()['x-robots-tag']).toContain('noindex');
    const frame = page.locator('iframe[title="网站草稿隔离预览"]');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    const site = frame.contentFrame();
    const second = site.getByRole('heading', { name: 'Second section' });
    const first = site.getByRole('heading', { name: 'First section' });
    const atAnchor = (target: typeof first) => expect.poll(async () => Math.abs(await target.evaluate(element => element.getBoundingClientRect().top))).toBeLessThan(4);
    await site.getByRole('link', { name: 'Go to second section' }).click();
    await expect(page).toHaveURL(`${runtime.origin}${path}#section-second`);
    await atAnchor(second);
    await page.reload({ waitUntil: 'load' });
    await expect(page).toHaveURL(`${runtime.origin}${path}#section-second`);
    await atAnchor(second);
    await site.getByRole('link', { name: 'Go to first section' }).click();
    await expect(page).toHaveURL(`${runtime.origin}${path}#section-first`);
    await atAnchor(first);
    await page.goBack();
    await expect(page).toHaveURL(`${runtime.origin}${path}#section-second`);
    await atAnchor(second);
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(draft.revision);
    expect(ui.writes).toEqual([]);
  } finally {
    await ui.closeOwnedPage();
    const current = await api<StudioEnvelope>(control, '/api/studio');
    await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { pages: original.state.pages, editorData: original.state.editorData } });
    await control.dispose();
  }
});
