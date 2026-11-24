import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { createInitialDraft } from '../src/server/seed';
import { createSiteConfig } from '../src/lib/site-render-config';
import { createPageData } from '../src/lib/page-data';

test('五个默认示例页面各渲染一个语义主标题，保留原响应式字号和原生详情标题', () => {
  const draft = createInitialDraft();
  const expected = { home: 72, about: 54, products: 56, craft: 58, contact: 58 };
  for (const [kind, size] of Object.entries(expected)) {
    const data = createPageData(kind);
    const html = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...draft, pageId: kind }), data }));
    assert.equal(html.match(/<h1[ >]/g)?.length, 1, kind);
    assert.match(html, new RegExp(`<h1[^>]*--editor-heading-size:${size}px;--editor-heading-mobile:38px`), kind);
  }
  const products = draft.products.map(product => ({ ...product, status: 'published' as const }));
  const data = createPageData('product-detail');
  const html = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...draft, products, pageId: 'product-detail', previewProductId: products[0].id }), data }));
  assert.equal(html.match(/<h1[ >]/g)?.length, 1);
  assert.deepEqual(createPageData('blank').content, []);
});
