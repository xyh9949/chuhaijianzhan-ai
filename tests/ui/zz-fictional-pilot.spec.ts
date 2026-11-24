import { request as playwrightRequest, type APIRequestContext, type FrameLocator } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import ExcelJS from 'exceljs';
import type { ComponentData, Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { PageItem, FormDefinition, Inquiry } from '../../src/lib/types';
import type { SiteSnapshot, PublicationSelection } from '../../src/server/types';
import type { AiSourceRecord, AiSourceProductPreview } from '../../src/server/ai-source-import';
import type { ExternalAiDesignView } from '../../src/server/external-ai-design';
import type { AiSiteDesignRequest, AiSiteDesignOperation } from '../../src/lib/ai-site-design-types';
import type { SeoDiagnosticReport } from '../../src/lib/seo-types';
import type { LaunchCheckReport } from '../../src/lib/launch-check-types';
import { withEditorRootDefaults } from '../../src/lib/editor-root-defaults';
import { test, expect, runtime, noOverflow, textButton } from './fixtures';

// 本次助手编写方案，真实走生产解析/保存/审核；不将固定程序冒充第三方模型的生成效果。
test.use({ trace: 'off' });
const COMPANY = 'Luma Ridge Furniture (Fictional Pilot)', HOME = 'pilot-home', LIST = 'pilot-products', DETAIL = 'pilot-product-detail', CONTACT = 'pilot-contact', FORM = 'pilot-inquiry';
const H1 = 'Seating for considered hospitality spaces.';
const productRows = [
  ['Harbor Lounge Chair', 'LR-DEMO-001', 'Hospitality lounge seating', 'Illustrative textile and wood', 'harbor-lounge-chair', 'FICTIONAL DEMO: A lounge seating concept for hotel reception and shared spaces. Specifications are illustrative and must be agreed before ordering.'],
  ['Cove Accent Chair', 'LR-DEMO-002', 'Hospitality lounge seating', 'Illustrative textile and wood', 'cove-accent-chair', 'FICTIONAL DEMO: An accent seating concept for hospitality corners and guest lounges. Specifications are illustrative and must be agreed before ordering.'],
  ['Haven Reading Chair', 'LR-DEMO-003', 'Hospitality lounge seating', 'Illustrative textile and wood', 'haven-reading-chair', 'FICTIONAL DEMO: A reading chair concept for hotel libraries and quiet spaces. Specifications are illustrative and must be agreed before ordering.'],
];
const companyLines = [COMPANY, 'FICTIONAL DEMO - local system rehearsal only.', 'Business concept: B2B lounge seating for hospitality spaces.', 'Intended audience: hotel furniture buyers in the US and UK.', 'Products: Harbor Lounge Chair, Cove Accent Chair, Haven Reading Chair.', 'Images are illustrations, not verified product photographs.', 'No real certifications, capacity, lead times, prices or customer claims.', 'Contact: pilot@luma-ridge.example.invalid'];
const form: FormDefinition = { id: FORM, name: 'Fictional pilot project inquiry', enabled: true, submitLabel: 'Send demo inquiry', successMessage: 'Demo inquiry received in the local test workspace.', fields: [
  { id: 'name', label: 'Your name', type: 'text', required: true, mapTo: 'name' },
  { id: 'company', label: 'Company', type: 'text', required: false, mapTo: 'company' },
  { id: 'email', label: 'Email', type: 'email', required: true, mapTo: 'email' },
  { id: 'message', label: 'Project brief', type: 'textarea', required: true, mapTo: 'message', maxLength: 2000 },
] };

function node(type: string, id: string, props: Record<string, unknown>): ComponentData { return { type, props: { id, ...props } }; }
function text(id: string, value: string) { return node('Text', id, { text: value, size: 16, color: '#53635a', align: 'left', maxWidth: 720 }); }
function heading(id: string, value: string, level = 'h2') { return node('Heading', id, { text: value, level, size: level === 'h1' ? 48 : 32, mobileSize: level === 'h1' ? 34 : 28, color: '#20392b', style: 'sans', align: 'left', spacing: 0 }); }
function container(id: string, content: ComponentData[], extra: Record<string, unknown> = {}) { return node('Container', id, { content, layout: 'column', columns: 1, mobileColumns: 1, padding: 48, inset: 48, gap: 20, background: '#ffffff', image: '', minHeight: 0, align: 'start', ...extra }); }
function data(title: string, content: ComponentData[]): Data { return withEditorRootDefaults({ root: { props: { title, brand: '', showChrome: 'yes' } }, content } as Data); }
function baselinePages() {
  const pages: PageItem[] = [
    { id: HOME, title: 'FICTIONAL DEMO · Luma Ridge', slug: '/', type: '首页', seoTitle: 'Luma Ridge Furniture | Fictional hospitality seating demo', seoDescription: 'A fictional B2B hospitality seating website for a local system rehearsal. Explore illustrative lounge chair concepts and a demonstration project inquiry form.' },
    { id: LIST, title: 'Seating collection', slug: '/collections', type: '产品列表', seoTitle: 'Hospitality seating collection | Luma Ridge fictional demo', seoDescription: 'Explore three fictional hospitality lounge chair concepts. Names, materials and product images are illustrative information for a local website rehearsal.' },
    { id: DETAIL, title: 'Product details', slug: '/products/:slug', type: '产品详情', seoTitle: 'Product information | Luma Ridge fictional demo', seoDescription: 'Product reference, illustrative material information and project contact options for the Luma Ridge fictional furniture demonstration.' },
    { id: CONTACT, title: 'Discuss your project', slug: '/contact', type: '联系我们', seoTitle: 'Project inquiry | Luma Ridge fictional furniture demo', seoDescription: 'Try the demonstration hospitality furniture inquiry form. This local test saves a synthetic inquiry without sending mail to a real recipient.' },
  // 默认动态详情由全站共享，不分配locale；固定内容页才声明自身语言。
  ].map(page => ({ ...page, ...(!page.slug.includes(':') ? { locale: 'en' } : {}), status: 'draft' as const, updated: new Date().toISOString(), noindex: true }));
  const loop = (id: string) => node('ProductList', id, { nodeLabel: 'Pilot dynamic seating cards', eyebrow: 'ILLUSTRATIVE COLLECTION', title: 'Three seating perspectives.', columns: 3, mobileColumns: 1, count: 3, category: '', padding: 48 });
  const editorData = {
    [HOME]: data('FICTIONAL DEMO · Luma Ridge', [container('pilot-hero', [
      container('pilot-copy', [text('pilot-eyebrow', 'FICTIONAL DEMO / HOSPITALITY SEATING'), heading('pilot-title', H1, 'h1'), text('pilot-intro', 'An illustrative collection for US and UK hotel furniture buyers. Explore clear product references, then share the requirements for your space.'), node('ActionButton', 'pilot-browse', { text: 'Explore seating', href: '', linkTarget: { kind: 'page', id: LIST }, kind: 'theme', align: 'left' })], { padding: 0, inset: 0 }),
      container('pilot-visual', [node('Image', 'pilot-hero-image', { src: '/images/chair.jpg', alt: 'Illustrative lounge chair; not a verified Luma Ridge product photo', height: 420, fit: 'contain', radius: 4 }), text('pilot-image-note', 'Illustrative image · fictional product concept')], { padding: 0, inset: 0 }),
    ]), loop('pilot-home-loop'), container('pilot-project', [heading('pilot-project-title', 'A useful conversation starts with a clear brief.'), text('pilot-project-copy', 'Tell us about your space, intended seating use and design priorities. This is a fictional local demonstration; no commercial quotation or delivery promise is offered.'), node('ActionButton', 'pilot-project-link', { text: 'Discuss your project', href: '', linkTarget: { kind: 'page', id: CONTACT }, kind: 'outline', align: 'left' })])]),
    [LIST]: data('Seating collection', [container('pilot-list-intro', [text('pilot-list-label', 'FICTIONAL DEMO / PRODUCT DIRECTORY'), heading('pilot-list-title', 'Lounge seating, clearly presented.', 'h1'), text('pilot-list-copy', 'Compare product references and illustrative materials. Photographs are examples; confirm every specification with a real supplier before purchase.')]), loop('pilot-catalog-loop')]),
    [DETAIL]: data('Product details', [node('ProductDetail', 'pilot-detail', { productId: '', layout: 'split', imageHeight: 480, padding: 48, cta: 'Discuss this concept', showCustomFields: 'yes' }), container('pilot-detail-note', [text('pilot-detail-disclosure', 'FICTIONAL DEMO. The image and material descriptions are illustrative. No certifications, production capacity, prices or delivery commitments have been verified.'), node('ActionButton', 'pilot-detail-contact', { text: 'Open the project inquiry form', href: '', linkTarget: { kind: 'page', id: CONTACT }, kind: 'outline', align: 'left' })])]),
    [CONTACT]: data('Discuss your project', [container('pilot-contact-intro', [text('pilot-contact-label', 'FICTIONAL DEMO / PROJECT ENQUIRY'), heading('pilot-contact-title', 'Tell us what your space needs.', 'h1'), text('pilot-contact-copy', 'Use this local demonstration form to describe a hospitality seating project. Submissions stay in the temporary test workspace; no real enquiry email is sent.'), node('Form', 'pilot-contact-form', { formId: FORM, buttonAlign: 'left', design: { desktop: { maxWidth: 760, columns: 1, gap: 20 } } })])]),
  };
  return { pages, editorData };
}

async function api<T>(control: APIRequestContext, path: string, method = 'GET', value?: unknown, expected = 200): Promise<T> {
  let response;
  try { response = await control.fetch(path, { method, ...(value === undefined ? {} : { data: value }) }); }
  catch { throw new Error(`Fictional pilot ${method} API transport failed`); }
  const result = await response.json();
  // 控制端只含本次虚构资料，保留生产校验的安全说明以定位422；从不输出头、Cookie或明文密钥。
  const reason = typeof result?.error === 'string' ? result.error.replace(/fsai_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1200) : 'no safe error message';
  expect(response.status(), `Fictional pilot ${method} ${path} status: ${response.status() === expected ? 'ok' : reason}`).toBe(expected); return result;
}
async function sdk<T>(action: string, run: () => Promise<T>): Promise<T> { try { return await run(); } catch { throw new Error(`Fictional pilot MCP ${action} failed`); } }
async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await sdk(name, () => client.callTool({ name, arguments: args })); expect(result.isError, `MCP ${name} should pass native validation`).not.toBe(true);
  return (result.structuredContent || JSON.parse((result.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text)) as T;
}
async function upload(control: APIRequestContext, bytes: Uint8Array, name: string, mimeType: string): Promise<AiSourceRecord> {
  let response;
  try { response = await control.post('/api/ai/sources', { multipart: { file: { name, mimeType, buffer: Buffer.from(bytes) } }, timeout: 30000 }); }
  catch { throw new Error('Fictional pilot private file upload failed'); }
  expect(response.status(), 'Production source upload status').toBe(201); return response.json();
}
async function loadedImages(frame: FrameLocator) {
  // 真实滚动触发懒加载，等图片传完再卸载预览；不把请求取消当成已完成的图片验证。
  const images = frame.locator('img[src]:not([src=""]):visible'); await expect.poll(() => images.count()).toBeGreaterThan(0);
  for (const image of await images.all()) {
    // 双层缩放iframe中的平滑滚动会让Playwright反复等待stable；只使用浏览器原生瞬时滚动，不改DOM或加载属性。
    await image.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' })); await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => { const item = element as HTMLImageElement; return item.complete && item.naturalWidth > 0; })).toBe(true);
  }
}
type ContextNode = { id: string; type: string; parentId?: string; productCardRef?: number };
type DesignContext = { request: AiSiteDesignRequest; context: { pages: { pageId: string; nodes: ContextNode[] }[]; productCards: { nodes: ContextNode[] }[]; chrome: { header: { nodes: ContextNode[] }; footer: { nodes: ContextNode[] } } } };
function designOperations(prepared: DesignContext): AiSiteDesignOperation[] {
  const card = (pageId: string, loopId: string): AiSiteDesignOperation => {
    const item = prepared.context.pages.find(page => page.pageId === pageId)!.nodes.find(item => item.id === loopId)!;
    expect(typeof item.productCardRef).toBe('number'); const nodes = prepared.context.productCards[item.productCardRef!].nodes;
    const frame = nodes.find(item => item.type === 'Container')!, image = nodes.find(item => item.type === 'Image')!, title = nodes.find(item => item.type === 'Heading')!;
    return { kind: 'page', pageId, operations: [{ kind: 'productCard', id: loopId, operations: [
      { kind: 'design', id: frame.id, design: { desktop: { backgroundColor: '#fffefa', borderWidth: 1, borderColor: '#d9e0d6', borderRadius: 4, paddingTop: 20, paddingRight: 20, paddingBottom: 24, paddingLeft: 20, gap: 16 }, mobile: { paddingTop: 16, paddingRight: 16, paddingBottom: 20, paddingLeft: 16 } } },
      { kind: 'design', id: image.id, design: { desktop: { height: 280, objectFit: 'contain', backgroundColor: '#f0f1e9' }, mobile: { height: 250 } } },
      { kind: 'design', id: title.id, design: { desktop: { fontSize: 25, fontWeight: 500, color: '#203e2e', lineHeight: 1.2 }, mobile: { fontSize: 23 } } },
      { kind: 'insert', parentId: frame.id, index: 2, node: { tempId: 'new-product-reference', type: 'Text', bindings: { text: 'builtin:sku' }, design: { desktop: { fontSize: 12, letterSpacing: 1, color: '#526456' } } } },
    ] }] };
  };
  const chromeId = (slot: 'header' | 'footer') => prepared.context.chrome[slot].nodes.find(item => item.type === 'Container')!.id;
  return [
    { kind: 'page', pageId: HOME, operations: [
      { kind: 'layout', id: 'pilot-hero', layout: 'grid', columns: 2, gap: 56 },
      { kind: 'design', id: 'pilot-hero', design: { desktop: { backgroundColor: '#f5f3eb', paddingTop: 76, paddingBottom: 76, paddingLeft: 64, paddingRight: 64, alignItems: 'center' }, mobile: { columns: 1, gap: 28, paddingTop: 36, paddingBottom: 36, paddingLeft: 24, paddingRight: 24 } } },
      { kind: 'design', id: 'pilot-title', design: { desktop: { fontFamily: 'serif', fontSize: 58, fontWeight: 400, lineHeight: 1.05, letterSpacing: -1.8 }, mobile: { fontSize: 39, lineHeight: 1.12, letterSpacing: -0.5 } } },
      { kind: 'design', id: 'pilot-eyebrow', design: { desktop: { fontSize: 12, letterSpacing: 1.5, color: '#3f5947' } } },
      { kind: 'design', id: 'pilot-project', design: { desktop: { backgroundColor: '#e9eee4', paddingTop: 60, paddingBottom: 60 }, mobile: { paddingTop: 32, paddingBottom: 32 } } },
    ] }, card(HOME, 'pilot-home-loop'), card(LIST, 'pilot-catalog-loop'),
    { kind: 'page', pageId: DETAIL, operations: [{ kind: 'design', id: 'pilot-detail', design: { desktop: { paddingTop: 64, paddingBottom: 64, gap: 56, imageHeight: 500, objectFit: 'contain' }, mobile: { columns: 1, paddingTop: 28, paddingBottom: 28, gap: 24, imageHeight: 320 } } }] },
    { kind: 'page', pageId: CONTACT, operations: [{ kind: 'design', id: 'pilot-contact-intro', design: { desktop: { backgroundColor: '#f5f3eb', paddingTop: 64, paddingBottom: 64 }, mobile: { paddingTop: 32, paddingBottom: 32 } } }] },
    { kind: 'chrome', slot: 'header', operations: [{ kind: 'design', id: chromeId('header'), design: { desktop: { paddingTop: 22, paddingBottom: 22, paddingLeft: 40, paddingRight: 40, borderWidth: 1, borderColor: '#dfe4db', backgroundColor: '#fffefa' }, mobile: { paddingTop: 16, paddingBottom: 16, paddingLeft: 24, paddingRight: 24, gap: 14 } } }] },
    { kind: 'chrome', slot: 'footer', operations: [{ kind: 'design', id: chromeId('footer'), design: { desktop: { backgroundColor: '#e9eee4', paddingTop: 40, paddingBottom: 40 }, mobile: { paddingTop: 28, paddingBottom: 28 } } }] },
    { kind: 'navigation', slot: 'header', locale: 'en', items: [{ label: 'Home', pageId: HOME }, { label: 'Seating collection', pageId: LIST }, { label: 'Project inquiry', pageId: CONTACT }] },
    { kind: 'theme', theme: { primary: '#254b36', background: '#fffefa', text: '#20392b', font: 'system', headingFont: 'Georgia', radius: 4 } },
  ];
}

test('虚构公司完整演练：资料导入、外部AI原生设计、真实预览、拖拽往返、本机发布及询盘', async ({ page, context, ui }, testInfo) => {
  test.setTimeout(240000); page.setDefaultTimeout(12000);
  expect(new URL(runtime.origin).hostname).toBe('127.0.0.1'); expect(new URL(runtime.origin).port).not.toBe('3200');
  const control = await playwrightRequest.newContext({ baseURL: runtime.origin, storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 20000 });
  const original = await api<StudioEnvelope>(control, '/api/studio'), providerBefore = await api(control, '/api/ai/provider');
  const originalSnapshot = original.state.releases.find(release => release.id === original.activeReleaseId)?.snapshot as SiteSnapshot | undefined;
  expect(original.state.settings.language).toBe('en');
  const sourceIds: string[] = [], evidence: Record<string, unknown> = { company: COMPANY, proposalAuthor: '本次助手编写原生操作，非第三方模型生成验收', isolatedOrigin: runtime.origin, images: 'Bundled chair illustration; no product photo claim', limitations: ['No real provider configured or evaluated', 'No Google/Search Console, real mailbox or public DNS/HTTPS verification'] };
  let client: Client | undefined, credentialId = '', changed = false, publishedId = '', bodyError: unknown;
  // 仅观察实际公开表单时间；不改fetch、定时器、按钮等待、提交或断言，也不保存令牌/请求体/凭据。
  const formTimingEvents: Record<string, unknown>[] = [], formTimingPending: Promise<void>[] = [];
  const ownedFormRequest = (url: string) => { const parsed = new URL(url); return parsed.origin === runtime.origin && [`/api/public/forms/${FORM}/session`, `/api/public/forms/${FORM}`].includes(parsed.pathname); };
  page.on('request', request => { if (request.method() === 'POST' && ownedFormRequest(request.url())) formTimingEvents.push({ event: 'node-request', path: new URL(request.url()).pathname, nodeDateNow: Date.now(), nodePerformanceNow: performance.now() }); });
  page.on('response', response => {
    if (response.request().method() !== 'POST' || !ownedFormRequest(response.url())) return;
    const entry: Record<string, unknown> = { event: 'node-response-headers', path: new URL(response.url()).pathname, nodeDateNow: Date.now(), nodePerformanceNow: performance.now(), status: response.status(), retryAfter: response.headers()['retry-after'] ?? null };
    formTimingEvents.push(entry);
    formTimingPending.push((async () => {
      try {
        const value = await response.json(); entry.nodeBodyReceivedDateNow = Date.now(); entry.nodeBodyReceivedPerformanceNow = performance.now();
        if (entry.path === `/api/public/forms/${FORM}/session`) {
          entry.minDelayMs = typeof value.minDelayMs === 'number' ? value.minDelayMs : null;
          // 签名令牌只在内存拆出issuedAt；visitId、nonce和令牌字符串从不进入诊断对象。
          if (typeof value.token === 'string') { const payload = JSON.parse(Buffer.from(value.token.split('.')[0], 'base64url').toString('utf8')); entry.tokenIssuedAt = Number.isSafeInteger(payload.issuedAt) ? payload.issuedAt : null; }
        } else { entry.error = typeof value.error === 'string' ? value.error.slice(0, 500) : null; entry.code = typeof value.code === 'string' ? value.code.slice(0, 100) : null; }
      } catch { entry.bodyObservationAvailable = false; }
    })());
  });
  await page.addInitScript(({ formPath, label }) => {
    if (location.pathname !== '/contact') return;
    const state: { events: Record<string, unknown>[]; resources: Record<string, unknown>[] } = { events: [], resources: [] };
    (window as unknown as { __pilotPublicFormTiming: typeof state }).__pilotPublicFormTiming = state;
    let lastDisabled: boolean | null = null;
    new MutationObserver(() => {
      for (const element of Array.from(document.querySelectorAll('button'))) if (element.textContent?.replace(/\s+/g, ' ').trim() === label && element.disabled !== lastDisabled) {
        lastDisabled = element.disabled;
        if (state.events.length < 20) state.events.push({ event: element.disabled ? 'button-disabled' : 'button-enabled', browserDateNow: Date.now(), browserPerformanceNow: performance.now(), browserTimeOrigin: performance.timeOrigin });
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    document.addEventListener('submit', () => { if (state.events.length < 20) state.events.push({ event: 'native-submit-event', browserDateNow: Date.now(), browserPerformanceNow: performance.now(), browserTimeOrigin: performance.timeOrigin }); }, true);
    new PerformanceObserver(list => {
      for (const value of list.getEntries()) {
        const resource = value as PerformanceResourceTiming, url = new URL(resource.name);
        if (url.origin === location.origin && [formPath, `${formPath}/session`].includes(url.pathname) && state.resources.length < 10) state.resources.push({ path: url.pathname, browserReceiptObservedDateNow: Date.now(), browserReceiptObservedPerformanceNow: performance.now(), browserTimeOrigin: performance.timeOrigin, startTime: resource.startTime, requestStart: resource.requestStart, responseStart: resource.responseStart, responseEnd: resource.responseEnd, duration: resource.duration });
      }
    }).observe({ type: 'resource', buffered: true });
  }, { formPath: `/api/public/forms/${FORM}`, label: form.submitLabel });
  ui.allowWrite('POST', '/api/ai/site-designs/apply'); ui.allowWrite('PATCH', '/api/studio');
  ui.allowWrite('POST', `/api/public/forms/${FORM}/session`); ui.allowWrite('POST', `/api/public/forms/${FORM}`);
  try {
    const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica), pdfPage = document.addPage([620, 790]);
    for (const [index, line] of companyLines.entries()) pdfPage.drawText(line, { x: 36, y: 735 - index * 30, size: 10, font });
    const pdfBytes = await document.save(), book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Seating products');
    sheet.addRow(['Name', 'SKU', 'Category', 'Material', 'Slug', 'Description']); for (const row of productRows) sheet.addRow(row);
    const xlsxBytes = new Uint8Array(await book.xlsx.writeBuffer());
    const pdf = await upload(control, pdfBytes, 'luma-ridge-fictional-company.pdf', 'application/pdf'); sourceIds.push(pdf.id);
    const excel = await upload(control, xlsxBytes, 'luma-ridge-fictional-products.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); sourceIds.push(excel.id);
    expect(pdf.source.kind).toBe('pdf'); expect(pdf.source.pages?.[0].text).toContain(COMPANY); expect(excel.source.sheets?.[0].rows).toHaveLength(4);
    await testInfo.attach('pilot-company-source.pdf', { body: Buffer.from(pdfBytes), contentType: 'application/pdf' });
    await testInfo.attach('pilot-products-source.xlsx', { body: Buffer.from(xlsxBytes), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const preview = await api<AiSourceProductPreview>(control, `/api/ai/sources/${excel.id}/preview`, 'POST', { expectedRevision: original.revision, sheetIndex: 1, headerRow: 1, mapping: { c1: 'builtin:name', c2: 'builtin:sku', c3: 'builtin:category', c4: 'builtin:material', c5: 'builtin:slug', c6: 'builtin:description' }, extraColumns: 'ignore' });
    expect(preview.errors).toEqual([]); expect(preview.rowCount).toBe(3); expect(preview.previewId).toBeTruthy();
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(original.revision);
    const imported = await api<StudioEnvelope & { importedProductIds: string[] }>(control, `/api/ai/sources/${excel.id}/apply`, 'POST', { previewId: preview.previewId, expectedRevision: original.revision }); changed = true;
    expect(imported.importedProductIds).toHaveLength(3); expect(imported.activeReleaseId).toBe(original.activeReleaseId);
    const products = imported.state.products.filter(product => imported.importedProductIds.includes(product.id)).map(product => ({ ...product, locale: 'en', image: '/images/chair.jpg', images: ['/images/chair.jpg'], noindex: true, seoTitle: `${product.name} | Luma Ridge fictional demo`, seoDescription: product.description }));
    expect(products.map(product => product.sku).sort()).toEqual(productRows.map(row => row[1]).sort());
    const baseline = baselinePages();
    const seeded = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: imported.revision, patch: { ...baseline, products, media: imported.state.media, sharedBlocks: [], contentModels: [], contentEntries: [], pageTemplates: [], taxonomies: [], redirects: [], forms: [form], customCode: { global: { css: '', js: '', cssEnabled: false, jsEnabled: false }, pages: {} }, siteLayout: { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: [] }, theme: { primary: '#42614d', background: '#ffffff', text: '#20392b', radius: 4, font: 'system' }, settings: { name: COMPANY, domain: 'luma-ridge.example.invalid', description: 'FICTIONAL DEMO. An illustrative hospitality seating collection for a local website system rehearsal. No commercial claims have been verified.', email: 'pilot@luma-ridge.example.invalid', language: 'en', timezone: 'UTC', locales: [{ code: 'en', label: 'English' }], publicUrl: runtime.origin } } });
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'Fictional Luma Ridge rehearsal', scopes: ['read', 'propose'], pageIds: null, recordIds: { productIds: [], entryIds: [] }, templateIds: [], expiresInDays: 1 }, 201); credentialId = credential.credential.id;
    client = new Client({ name: 'luma-ridge-fictional-pilot', version: '1.0.0' });
    await sdk('connect', () => client!.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Authorization: `Bearer ${credential.token}`, Origin: runtime.origin, Connection: 'close' } } })));
    const prepared = await tool<DesignContext>(client, 'site_design_context', { expectedRevision: seeded.revision, instruction: '为这家明确标注虚构的酒店座椅公司设计暖白与森林绿的商业网站。重组首页双栏首屏，制作动态产品卡片并显示SKU，统一导航与手机留白。不编造事实，生成后仍能自由拖拽。', preserveText: false, targets: { pageIds: seeded.state.pages.map(item => item.id), header: true, footer: true, navigation: true, style: true } });
    const operations = designOperations(prepared);
    const candidate = await tool<ExternalAiDesignView>(client, 'site_design_propose', { requestId: 'luma-ridge-fictional-design-v1', request: prepared.request, proposal: { summary: 'Luma Ridge · 暖白与森林绿的酒店座椅商业展示', intent: { goal: '让采购清楚浏览虚构产品、参考编号和联系入口', decisions: ['首页由纵排改为双栏首屏', '动态卡片加入当前产品SKU并保持详情链接', '全站原生页眉页脚和同语言导航统一', '手机首屏单列、减少留白并保持字号层级'], preserve: ['虚构演练声明', 'PDF和产品表中已核对的演示内容', '原生组件和动态绑定'], assumptions: ['所有产品和材料为虚构示意', '本次方案由助手编写，未调用用户自配模型'] }, operations, warnings: ['示意图片与虚构产品资料不能用于真实报价；请替换成客户已核实的资料。'] } });
    expect(candidate.status).toBe('pending'); expect(candidate.requiresBrowserConfirmation).toBe(true); expect(candidate.generatedContentEditable).toBe(true);
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(seeded.revision);
    const review = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: candidate.designId, action: 'apply' }); expect(new URL(review.reviewUrl).origin).toBe(runtime.origin);
    await page.goto(review.reviewUrl); const dialog = page.getByRole('dialog', { name: 'AI整站设计', exact: true });
    await expect(dialog).toContainText(candidate.summary);
    for (const title of ['修改前', 'AI建议']) {
      const frame = dialog.frameLocator(`iframe[title="${title}"]`).frameLocator('iframe[title="网站草稿隔离预览"]');
      await expect(frame.getByRole('heading', { name: H1, exact: true })).toBeVisible();
      await loadedImages(frame);
    }
    const after = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(after.locator('[data-loop-record]')).toHaveCount(3); await expect(after.getByText('LR-DEMO-001', { exact: true })).toBeVisible();
    await testInfo.attach('pilot-native-proposal.json', { body: Buffer.from(JSON.stringify({ request: prepared.request, operations, summary: candidate.summary, changes: candidate.changes }, null, 2)), contentType: 'application/json' });
    await testInfo.attach('pilot-design-before-desktop', { body: await dialog.locator('iframe[title="修改前"]').screenshot(), contentType: 'image/png' });
    await testInfo.attach('pilot-design-after-desktop', { body: await dialog.locator('iframe[title="AI建议"]').screenshot(), contentType: 'image/png' });
    await textButton(dialog, '确认应用到网站草稿').click(); await expect(dialog).toContainText('已应用到网站草稿');
    for (const title of ['修改前', 'AI建议']) await loadedImages(dialog.frameLocator(`iframe[title="${title}"]`).frameLocator('iframe[title="网站草稿隔离预览"]'));
    const applied = await api<StudioEnvelope>(control, '/api/studio'); expect(applied.activeReleaseId).toBe(original.activeReleaseId);
    expect((await tool<ExternalAiDesignView>(client, 'site_design_status', { designId: candidate.designId })).status).toBe('applied');
    expect((applied.state.editorData[HOME] as Data).content.find(item => item.type === 'ContentLoop')).toBeTruthy();
    evidence.design = { status: 'applied', affectedPages: candidate.affectedPages, nativeChanges: candidate.changes.length, importedRows: preview.rows, productIds: products.map(product => product.id), privateSourceParsing: { pdfPages: pdf.source.pages?.length, pdfText: pdf.source.pages?.[0].text, excelVisibleRows: excel.source.sheets?.[0].rows.length }, noAutomaticPublication: true };
    // 公开确认前，生成头尾确实可进入同一Puck；不操作往返不能改变已采用资产。
    const header = applied.state.sharedBlocks!.find(block => block.id === applied.state.siteLayout!.header.blockId)!;
    await textButton(dialog, '拖拽编辑页眉').click(); await expect(page.locator('.editor-screen')).toBeVisible(); await expect(page.locator('.editor-topbar')).toContainText(header.name);
    await page.getByRole('button', { name: '返回页面管理', exact: true }).click();
    // 返回包含异步flush；先等真实目标出现，避免后一次hash导航被尚未完成的返回覆盖。
    await expect(page.getByRole('heading', { name: '全站设计', exact: true })).toBeVisible();
    const roundTrip = await api<StudioEnvelope>(control, '/api/studio'); expect(roundTrip.state.sharedBlocks!.find(block => block.id === header.id)!.data).toEqual(header.data);
    await page.goto('/admin#editor'); await expect(page.locator('.editor-screen')).toBeVisible();
    // 同文档hash导航不会重跑init script；通过原生目标选择器从页眉明确切回首页。
    await page.getByRole('combobox', { name: '当前编辑页面', exact: true }).click();
    // 同名页面标题也会出现在生成卡片名称中，按真实option完整title选择，不用包含文本匹配。
    await page.locator('.ant-select-dropdown:visible').getByTitle('FICTIONAL DEMO · Luma Ridge', { exact: true }).click();
    await expect(page.locator('.editor-page-picker')).toContainText('FICTIONAL DEMO · Luma Ridge');
    const canvas = page.frameLocator('.editor-canvas iframe');
    await testInfo.attach('pilot-selected-editor-diagnostic', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    await testInfo.attach('pilot-editor-heading-diagnostic', { body: Buffer.from(JSON.stringify({ headings: await canvas.locator('h1,h2,h3').allTextContents(), selectedPage: await page.locator('.editor-page-picker').textContent() })), contentType: 'application/json' });
    // Puck把画布从可访问树隐藏，交互由旁边图层承载；视觉检查定位实际渲染的原生h1。
    await expect(canvas.locator('h1').filter({ hasText: H1 })).toBeVisible(); await loadedImages(canvas);
    await page.locator('.editor-left-panel').getByRole('tab', { name: /图层/ }).click(); await expect(page.getByRole('tree', { name: '页面图层', exact: true })).toBeVisible();
    await testInfo.attach('pilot-native-puck-editor', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    await page.getByRole('treeitem').filter({ hasText: 'Pilot dynamic seating cards' }).click(); await page.getByRole('button', { name: '编辑卡片设计', exact: true }).click();
    await expect(page.getByRole('button', { name: '返回来源页面', exact: true })).toBeVisible();
    await loadedImages(page.frameLocator('.editor-canvas iframe'));
    await testInfo.attach('pilot-native-product-card-editor', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    await page.getByRole('button', { name: '返回来源页面', exact: true }).click();
    await expect(page.frameLocator('.editor-canvas iframe').locator('h1').filter({ hasText: H1 })).toBeVisible(); await loadedImages(page.frameLocator('.editor-canvas iframe'));
    await page.getByRole('button', { name: '返回页面管理', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^网站页面/ })).toBeVisible();
    const current = await api<StudioEnvelope>(control, '/api/studio'); expect(current.state.editorData[HOME]).toEqual(applied.state.editorData[HOME]); expect(current.state.sharedBlocks).toEqual(applied.state.sharedBlocks);
    await testInfo.attach('pilot-editable-site.json', { body: Buffer.from(JSON.stringify({ pages: current.state.pages, products: current.state.products, editorData: current.state.editorData, sharedBlocks: current.state.sharedBlocks, theme: current.state.theme, siteLayout: current.state.siteLayout, forms: current.state.forms }, null, 2)), contentType: 'application/json' });
    const diagnostic = await api<SeoDiagnosticReport>(control, '/api/seo/diagnostics'); evidence.localSeo = diagnostic;
    const selection: PublicationSelection = { expectedRevision: current.revision, baseReleaseId: current.activeReleaseId, title: 'FICTIONAL DEMO · Luma Ridge local rehearsal', pageIds: current.state.pages.map(item => item.id), productIds: products.map(item => item.id), sharedBlockIds: current.state.sharedBlocks?.map(item => item.id) || [], contentModelIds: [], contentEntryIds: [], removePageIds: (originalSnapshot?.pages || []).map(item => item.id), removeProductIds: (originalSnapshot?.products || []).map(item => item.id), removeSharedBlockIds: (originalSnapshot?.sharedBlocks || []).map(item => item.id), removeContentModelIds: (originalSnapshot?.contentModels || []).map(item => item.id), removeContentEntryIds: (originalSnapshot?.contentEntries || []).map(item => item.id), includeTheme: true, includeSettings: true, includeLayout: true, includeCode: true, includeCatalog: true, includeForms: true, includeTemplates: true };
    const publicationCheck = await api<{ errors: string[]; warnings: string[] }>(control, '/api/releases/preview', 'POST', selection); expect(publicationCheck.errors).toEqual([]);
    const published = await api<StudioEnvelope & { releaseId: string }>(control, '/api/releases', 'POST', selection, 201); publishedId = published.releaseId; expect(published.activeReleaseId).toBe(publishedId);
    const readiness = await api<LaunchCheckReport>(control, '/api/launch-check'); evidence.publication = { releaseId: publishedId, preview: publicationCheck, readiness, scope: '127.0.0.1 temporary instance only' };
    await context.clearCookies();
    await page.goto('/'); await expect(page.getByRole('heading', { name: H1, exact: true })).toBeVisible(); await expect(page.getByText('FICTIONAL DEMO / HOSPITALITY SEATING', { exact: true })).toBeVisible();
    await expect(page.locator('[data-loop-record]')).toHaveCount(3);
    await testInfo.attach('pilot-public-home-desktop', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    for (const width of [375, 390]) { await page.setViewportSize({ width, height: 844 }); await noOverflow(page); await testInfo.attach(`pilot-public-home-mobile-${width}`, { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }); }
    await page.goto('/products/harbor-lounge-chair'); await expect(page.getByRole('heading', { name: 'Harbor Lounge Chair', exact: true })).toBeVisible(); await expect(page.getByText('LR-DEMO-001', { exact: true })).toBeVisible(); await noOverflow(page);
    await testInfo.attach('pilot-public-product-mobile', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    await page.goto('/contact'); await expect(page.getByRole('heading', { name: 'Tell us what your space needs.', exact: true })).toBeVisible(); await noOverflow(page);
    await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Synthetic pilot buyer'); await page.getByRole('textbox', { name: 'Company', exact: true }).fill('Fictional Hotel Test'); await page.getByRole('textbox', { name: 'Email', exact: true }).fill('buyer@pilot.example.invalid'); await page.getByRole('textbox', { name: 'Project brief', exact: true }).fill('FICTIONAL DEMO: Local rehearsal inquiry only. No real customer, order or email delivery.');
    await expect(textButton(page, 'Send demo inquiry')).toBeEnabled(); await textButton(page, 'Send demo inquiry').click(); await expect(page.getByRole('status')).toContainText(form.successMessage);
    const inquiries = await api<{ items: Inquiry[] }>(control, '/api/inquiries'), inquiry = inquiries.items.find(item => item.email === 'buyer@pilot.example.invalid');
    expect(inquiry?.origin).toBe('website'); expect(inquiry?.sourcePath).toBe('/contact'); expect(inquiry?.releaseId).toBe(publishedId);
    const notifications = await api<{ configuration: { mode: string }; jobs: { status: string }[] }>(control, `/api/notifications?inquiryId=${inquiry!.id}`); expect(['mock', 'none']).toContain(notifications.configuration.mode); expect(notifications.jobs.some(job => job.status === 'sent')).toBe(false);
    expect(await api(control, '/api/ai/provider')).toEqual(providerBefore);
    evidence.completed = { productionPdfAndExcelExtraction: true, mappingReviewedAndApplied: true, externalMcpSubmittedNativeDesign: true, browserConfirmedRealBeforeAndAfter: true, nativePuckNoOperationRoundTrip: true, localSeoDiagnostic: true, localPublicHomeAndDynamicDetails: true, mobileWidths: [375, 390], publicInquirySaved: true, mailMode: notifications.configuration.mode, providerUnchanged: true, realThirdPartyModelQualityVerified: false };
    await testInfo.attach('pilot-public-contact-inquiry', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    await testInfo.attach('pilot-evidence.json', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
  } catch (cause) {
    bodyError = cause;
    try {
      await testInfo.attach('pilot-failure-state', { body: Buffer.from(JSON.stringify({ alerts: await page.getByRole('alert').allTextContents(), editorVisible: await page.locator('.editor-screen').isVisible(), picker: await page.locator('.editor-page-picker').allTextContents(), headings: await page.getByRole('heading').allTextContents() })), contentType: 'application/json' });
      await testInfo.attach('pilot-failure-screen', { body: await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 3000 }), contentType: 'image/png' });
    } catch { /* 诊断不记录输入、Cookie或请求头，也不替换原失败。 */ }
    throw cause;
  }
  finally {
    try {
      await Promise.all(formTimingPending);
      const browser = await page.evaluate(() => (window as unknown as { __pilotPublicFormTiming?: { events: Record<string, unknown>[]; resources: Record<string, unknown>[] } }).__pilotPublicFormTiming ?? null);
      await testInfo.attach('pilot-form-timing.json', { body: Buffer.from(JSON.stringify({ diagnosticOnly: true, tokenBodyRecorded: false, requestBodyOrHeadersRecorded: false, waitsSubmissionAssertionsAndAllowlistUnchanged: true, nodeEvents: formTimingEvents, browser, browserReceiptScope: 'resource完成观察时刻；实际请求开始由ResourceTiming.requestStart记录' }, null, 2)), contentType: 'application/json' });
    } catch { /* 诊断不可用不替换主失败，也不改变原恢复和关闭流程。 */ }
    const errors: string[] = []; await ui.closeOwnedPage(); if (client) try { await client.close(); } catch { errors.push('MCP close'); }
    if (credentialId) try { await api(control, `/api/external-ai/tokens/${credentialId}`, 'DELETE'); } catch { errors.push('credential revoke'); }
    for (const id of sourceIds) try { await api(control, `/api/ai/sources/${id}`, 'DELETE'); } catch { errors.push('source removal'); }
    if (publishedId && original.activeReleaseId) try { await api(control, `/api/releases/${original.activeReleaseId}/activate`, 'POST', { expectedActiveReleaseId: publishedId }); } catch { errors.push('public snapshot restore'); }
    if (changed) try {
      const latest = await api<StudioEnvelope>(control, '/api/studio'), source = original.state;
      const keys = ['pages', 'products', 'media', 'theme', 'settings', 'editorData', 'siteLayout', 'customCode'] as const;
      const patch: Record<string, unknown> = Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
      // 原草稿缺省这些区域时也须显式恢复有效默认；PATCH省略会保留候选的区块指针。
      patch.siteLayout = source.siteLayout || { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: [] };
      patch.customCode = source.customCode || { global: { css: '', js: '', cssEnabled: false, jsEnabled: false }, pages: {} };
      for (const key of ['sharedBlocks', 'contentModels', 'contentEntries', 'taxonomies', 'redirects', 'forms', 'pageTemplates'] as const) patch[key] = source[key] || [];
      await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch });
    } catch (cause) { errors.push(`draft restore: ${cause instanceof Error ? cause.message.replace(/fsai_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1400) : 'unknown validation failure'}`); }
    await testInfo.attach('pilot-cleanup.json', { body: Buffer.from(JSON.stringify({ errors, previousPublicSnapshotRestored: !!publishedId && !!original.activeReleaseId && !errors.includes('public snapshot restore'), temporaryInstanceDeletedByWrapper: true, syntheticInquiryAndReleaseHistoryRemovedWithInstance: true })), contentType: 'application/json' });
    await control.dispose(); if (!bodyError && errors.length) throw new Error(`Fictional pilot cleanup failed: ${errors.join(', ')}`);
  }
});
