import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { initialState } from '../src/lib/demo';
import { createPageData, getPageData } from '../src/lib/page-data';
import { createSiteConfig } from '../src/lib/site-render-config';
import { resolveSitePage, siteLinkHref } from '../src/lib/site-routing';
import { siteMetadata } from '../src/lib/site-metadata';
import { safeBackgroundImage, safeImageSrc, safeLinkHref } from '../src/lib/site-safety';
import { createInitialDraft } from '../src/server/seed';
import { validateDraft } from '../src/server/validation';
import type { SiteSnapshot } from '../src/server/types';

function fixture(): SiteSnapshot {
  const draft = structuredClone(initialState);
  return { schemaVersion: 1, releaseId: 'release_test', pages: draft.pages.map((page) => ({ ...page, status: 'published' })), products: draft.products.map((product) => ({ ...product, status: 'published' })), media: draft.media, theme: draft.theme, settings: draft.settings, editorData: Object.fromEntries(draft.pages.map((page) => [page.id, getPageData(page)])) };
}

test('稳定内部按钮与产品动态链接在SSR和私有预览使用同一新网址，旧静态href保持原样', () => {
  const snapshot = fixture(); snapshot.products[0].slug = 'arc-chair';
  const props = { id: 'stable', text: 'Stable target', href: '/old-static', kind: 'theme', align: 'left', linkTarget: { kind: 'product', id: snapshot.products[0].id } };
  const data = { root: { props: { showChrome: 'no' } }, content: [{ type: 'ActionButton', props }] };
  const render = (previewPrefix = '') => renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...snapshot, previewPrefix }), data }));
  assert.match(render(), /href="\/products\/arc-chair"/);
  assert.match(render('/preview'), /href="\/preview\/products\/arc-chair"/);
  delete (props as Partial<typeof props>).linkTarget;
  assert.match(render(), /href="\/old-static"/);
});

test('seed materializes each page without inventing a published release', () => {
  const draft = createInitialDraft();
  assert.equal(draft.pages.every((page) => page.status === 'draft'), true);
  assert.equal(draft.products.every((product) => product.status === 'draft'), true);
  assert.equal(Object.keys(draft.editorData).length, draft.pages.length);
  assert.doesNotThrow(() => validateDraft(draft));
});

test('real route resolution uses snapshot product IDs, exact paths first, and no template fallback', () => {
  const snapshot = fixture();
  const product = snapshot.products[0];
  assert.equal(resolveSitePage(snapshot)?.page.id, 'home');
  assert.equal(resolveSitePage(snapshot, ['about'])?.page.id, 'about');
  assert.equal(resolveSitePage(snapshot, ['products', product.id])?.product?.id, product.id);
  assert.equal(resolveSitePage(snapshot, ['products', 'unknown']), null);
  assert.equal(resolveSitePage(snapshot, ['..']), null);
  snapshot.pages.push({ id: 'exact', title: 'Exact', slug: `/products/${product.id}`, status: 'published', type: '普通页面', updated: '' });
  snapshot.editorData.exact = createPageData('blank');
  assert.equal(resolveSitePage(snapshot, ['products', product.id])?.page.id, 'exact');
  assert.equal(resolveSitePage(snapshot, ['products', product.id])?.data.content.length, 0);
  delete snapshot.editorData.home;
  assert.throws(() => resolveSitePage(snapshot), /missing/);
});

test('preview links stay in preview while media, external links and anchors keep their target', () => {
  assert.equal(siteLinkHref('/', '/preview'), '/preview');
  assert.equal(siteLinkHref('/?ref=nav#story', '/preview'), '/preview?ref=nav#story');
  assert.equal(siteLinkHref('/about?ref=nav#story', '/preview'), '/preview/about?ref=nav#story');
  assert.equal(siteLinkHref('/products/p1', '/preview'), '/preview/products/p1');
  for (const href of ['/api/media/image1', '/images/sofa.jpg', '/admin', '/preview/about', '#contact', 'https://example.com/', 'mailto:test@example.com']) assert.equal(siteLinkHref(href, '/preview'), href);
  assert.equal(siteLinkHref('/about'), '/about');
});

test('unsafe href and image schemes are rejected; valid raster paths remain usable', () => {
  for (const href of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,test', '//evil.example', '/\\evil']) assert.equal(safeLinkHref(href), undefined);
  for (const src of ['data:image/svg+xml,<svg/>', '/image.svg', 'javascript:alert(1)', 'data:image/png;base64,PHNjcmlwdD4=']) assert.equal(safeImageSrc(src), undefined);
  assert.equal(safeImageSrc('/images/sofa.jpg'), '/images/sofa.jpg');
  assert.equal(safeImageSrc('/api/media/image1'), '/api/media/image1');
  assert.equal(safeBackgroundImage('javascript:alert(1)'), undefined);
});

test('SSR renders nested slots, preserves theme controls and escapes input text', () => {
  const snapshot = fixture();
  snapshot.editorData.__themeControls = { contentWidth: 960, buttonStyle: 'outline', buttonSize: 'small' };
  const config = createSiteConfig(snapshot);
  assert.deepEqual(Object.keys(config.components).sort(), ['CompanyFacts', 'ActionButton', 'Container', 'Heading', 'Image', 'ProductDetail', 'ProductList', 'Spacer', 'Text', 'SharedBlock', 'ContentList', 'ContentLoop', 'Navigation', 'Breadcrumb', 'RichText', 'Icon', 'Divider', 'Gallery', 'Accordion', 'Tabs', 'Video', 'Carousel', 'Download', 'Form', 'LanguageSwitcher', 'ComparisonTable', 'ProjectTimeline', 'ImageComparison', 'studio/SpecificationTable'].sort());
  assert.equal(config.components.Container.fields?.content.type, 'slot');
  const data = createPageData('home');
  const html = renderToStaticMarkup(React.createElement(Render, { config, data }));
  assert.match(html, /Room for/);
  assert.match(html, /--editor-site-width:960px/);
  assert.match(html, /--editor-site-primary:#25634E/);
  assert.match(html, /font-family:Georgia/);
  assert.match(html, /ant-btn-sm/);
  assert.match(html, /href="\/products\//);
  assert.doesNotMatch(html, /editor-topbar|puck-color|Manrope/);
  const unsafe = createPageData('blank');
  unsafe.content.push({ type: 'Text', props: { id: 'xss-text', text: '<img src=x onerror=alert(1)>', size: 14, color: '#000000', align: 'left', maxWidth: 500 } });
  const escaped = renderToStaticMarkup(React.createElement(Render, { config, data: unsafe }));
  assert.match(escaped, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(escaped, /<img src="x"/);
});

test('SEO is taken from the resolved snapshot and draft preview is noindex', () => {
  const snapshot = fixture();
  snapshot.products[0].seoTitle = 'Snapshot SEO title';
  snapshot.products[0].seoDescription = 'Snapshot SEO description';
  snapshot.settings.language = 'en-US';
  const resolved = resolveSitePage(snapshot, ['products', snapshot.products[0].id]);
  const metadata = siteMetadata(snapshot, resolved);
  assert.equal(metadata.title, 'Snapshot SEO title · Morrow 家居');
  assert.equal(metadata.description, 'Snapshot SEO description');
  assert.equal(metadata.openGraph?.locale, 'en_US');
  assert.deepEqual(siteMetadata(snapshot, resolved, true).robots, { index: false, follow: false, nocache: true });
  assert.deepEqual(siteMetadata(null, null).robots, { index: false, follow: false });
});

test('product specifications render from snapshot and unavailable detail routes do not create dead links', () => {
  const snapshot = fixture();
  snapshot.products[0].specifications = [{ label: 'Width', value: '120 cm' }];
  const data = createPageData('product-detail');
  const html = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...snapshot, previewProductId: snapshot.products[0].id }), data }));
  assert.match(html, /<dt>Width<\/dt><dd>120 cm<\/dd>/);
  snapshot.pages = snapshot.pages.filter((page) => page.slug !== '/products/:slug');
  const collection = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig(snapshot), data: createPageData('products') }));
  assert.doesNotMatch(collection, /href="\/products\//);
  assert.equal(siteMetadata(snapshot, resolveSitePage(snapshot))?.openGraph?.locale, undefined);
});
