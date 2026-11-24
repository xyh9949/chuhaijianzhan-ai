import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { STARTER_KITS } from '../src/lib/starter-kits';
import { resolveStarterPreview } from '../src/lib/starter-preview';
import { createSiteConfig } from '../src/lib/site-render-config';
import { siteLinkHref } from '../src/lib/site-routing';
import { getContentEntryPath, getProductPath } from '../src/lib/content-routes';
import { safePreviewNavigation } from '../src/lib/site-code-render';
import { siteMetadata } from '../src/lib/site-metadata';
import { hasInvalidLoopPage } from '../src/lib/loop-pages';

test('完整案例预览解析自身静态页与产品/内容详情，未知路径不回退到客户草稿', () => {
  for (const kit of STARTER_KITS) {
    const home = resolveStarterPreview(['~starter', kit.id])!;
    assert.equal(home.resolved.page.slug, '/');
    assert.equal(home.previewPrefix, `/preview/~starter/${kit.id}`);
    for (const page of home.snapshot.pages.filter(page => !page.slug.includes(':'))) {
      const result = resolveStarterPreview(['~starter', kit.id, ...page.slug.split('/').filter(Boolean)])!;
      assert.equal(result.resolved.page.id, page.id);
      assert.deepEqual(siteMetadata(result.snapshot, result.resolved, true).robots, { index: false, follow: false, nocache: true });
    }
    for (const product of home.snapshot.products) {
      const path = getProductPath(home.snapshot, product);
      if (path) assert.equal(resolveStarterPreview(['~starter', kit.id, ...path.slice(1).split('/')])?.resolved.product?.id, product.id);
    }
    for (const entry of home.snapshot.contentEntries || []) {
      const path = getContentEntryPath(home.snapshot, entry);
      if (path) assert.equal(resolveStarterPreview(['~starter', kit.id, ...path.slice(1).split('/')])?.resolved.entry?.id, entry.id);
    }
    for (const path of [['missing-customer-page'], ['..'], ['products', 'missing'], ['about', 'unexpected']]) assert.equal(resolveStarterPreview(['~starter', kit.id, ...path]), null);
  }
  for (const path of [[], ['~starter'], ['~starter', 'unknown'], ['~template', 'manufacturing']]) assert.equal(resolveStarterPreview(path), null);
});

test('案例页眉页脚与业务按钮保持案例前缀，原草稿链接规则保持不变', () => {
  for (const kit of STARTER_KITS) {
    const { snapshot, resolved, previewPrefix } = resolveStarterPreview(['~starter', kit.id])!;
    const html = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...snapshot, pageId: resolved.page.id, currentPath: '/', previewPrefix }), data: resolved.data }));
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
    assert.ok(hrefs.includes(`${previewPrefix}/about`), `${kit.id} 缺少关于页入口`);
    assert.ok(hrefs.includes(`${previewPrefix}/contact`), `${kit.id} 缺少联系页入口`);
    assert.ok(hrefs.every(href => !href.startsWith('/preview') || href === previewPrefix || href.startsWith(`${previewPrefix}/`)), kit.id);
    assert.equal(siteLinkHref('/about?source=menu#story', previewPrefix), `${previewPrefix}/about?source=menu#story`);
  }
  assert.equal(siteLinkHref('/about', '/preview'), '/preview/about');
  assert.equal(siteLinkHref('/preview/~template/example', '/preview'), '/preview/~template/example');
});

test('案例循环卡片、筛选和分页共用命名空间且拒绝越界页码', () => {
  const { snapshot, previewPrefix, resolved } = resolveStarterPreview(['~starter', 'manufacturing'])!;
  const page = { ...resolved.page, slug: '/catalog' };
  const data = { root: { props: { title: 'Synthetic loop page', showChrome: 'no' } }, content: [{ type: 'ContentLoop', props: { id: 'case-loop', source: 'product', itemBlockId: 'starter-card', count: 1, columns: 2, query: { paginate: true, controls: true } } }] };
  const config = createSiteConfig({ ...snapshot, previewPrefix, pageId: page.id, currentPath: page.slug });
  const html = renderToStaticMarkup(React.createElement(Render, { config, data }));
  assert.match(html, /action="\/preview\/~starter\/manufacturing\/catalog"/);
  assert.match(html, /href="\/preview\/~starter\/manufacturing\/catalog\?page_case-loop=2"/);
  assert.ok(html.includes(`href="${previewPrefix}${getProductPath(snapshot, snapshot.products[0])}"`));
  assert.equal(hasInvalidLoopPage(snapshot, { page, data }, { 'page_case-loop': '99' }), true);
});

test('案例沙箱只允许当前案例导航，保持私有预览安全边界', () => {
  const prefix = '/preview/~starter/manufacturing', origin = 'https://example.com';
  assert.equal(safePreviewNavigation(`${prefix}/products/sample-1?ref=card#spec`, origin, prefix), `${prefix}/products/sample-1?ref=card#spec`);
  for (const path of ['/preview/about', '/preview/~starter/services', '/preview/~template/asset', `${prefix}-other/about`, `${prefix}/../services`, `${prefix}/%2e%2e/services`, `${prefix}/%2f..%2f..%2fadmin`, `${prefix}\\..\\admin`, '/admin', 'https://evil.test/preview/~starter/manufacturing']) assert.equal(safePreviewNavigation(path, origin, prefix), null, path);
  assert.equal(safePreviewNavigation('/preview/about', origin), '/preview/about');
  assert.equal(safePreviewNavigation('/preview/~template/asset', origin), '/preview/~template/asset');
});
