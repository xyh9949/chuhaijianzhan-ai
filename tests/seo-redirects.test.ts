import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialDraft } from '../src/server/seed';
import { redirectErrors, compileRedirects, suggestedRedirects, actualSiteRoutes } from '../src/lib/site-redirects';
import { publicSiteOrigin, seoErrors, serializeStructuredData } from '../src/lib/site-seo';
import { siteMetadata } from '../src/lib/site-metadata';
import { resolveSitePage } from '../src/lib/site-routing';
import { hasInvalidLoopPage } from '../src/lib/loop-pages';
import type { Data } from '@puckeditor/core';
import type { SiteSnapshot } from '../src/server/types';

test('公开源地址明确验证，JSON-LD闭合标签编码后仍还原原始事实', () => {
  assert.equal(publicSiteOrigin('https://example.com/'), 'https://example.com');
  for (const invalid of ['javascript:alert(1)', 'https://a.com/path', 'https://u:p@a.com', 'https://a.com?x=1', 'https://a.com#fragment', 'not-a-url']) assert.equal(publicSiteOrigin(invalid), undefined);
  const fact = { name: '</script><img src=x onerror=alert(1)>' }, json = serializeStructuredData(fact);
  assert.ok(!json.includes('</script>')); assert.deepEqual(JSON.parse(json), fact);
  const source = createInitialDraft(); source.pages[0].noindex = 'yes' as unknown as boolean;
  assert.ok(seoErrors(source).length);
});

test('重定向目标只读当前来源，拒绝占用、失效、外域和循环，网址建议不会自动写入', () => {
  const source = createInitialDraft(), page = source.pages.find(page => page.slug === '/about')!;
  const rule = { id: 'redirect', from: '/old-about', target: { kind: 'page' as const, id: page.id }, status: 301 as const };
  assert.deepEqual(redirectErrors({ ...source, redirects: [rule] }), []);
  assert.deepEqual(compileRedirects({ ...source, redirects: [{ ...rule, enabled: false }] }), []);
  assert.deepEqual(compileRedirects({ ...source, redirects: [rule] }), [{ from: '/old-about', to: '/about', status: 301 }]);
  for (const from of ['/about', '/admin/private', '//evil.example', '/a/../b', '/old?x=1', '/']) assert.ok(redirectErrors({ ...source, redirects: [{ ...rule, from }] }).length);
  assert.ok(redirectErrors({ ...source, redirects: [{ ...rule, target: { kind: 'page', id: 'missing' } }] }).length);
  assert.ok(redirectErrors({ ...source, redirects: [rule, { ...rule, id: 'another' }] }).length);
  const changed = { ...source, pages: source.pages.map(item => item.id === page.id ? { ...item, slug: '/new-about' } : item) };
  const suggested = suggestedRedirects(source, changed);
  assert.ok(suggested.some(item => item.from === '/about' && item.target.id === page.id));
  assert.equal(source.redirects, undefined);
  assert.equal(actualSiteRoutes(changed).some(item => item.path.includes(':slug')), false);
});

test('普通页面的SEO忽略无对应列表的分页和筛选参数', () => {
  const draft = createInitialDraft(), home = draft.pages.find(page => page.slug === '/')!;
  home.seoTitle = 'Custom page'; home.seoDescription = 'Verified description'; home.seoImage = '/images/interior.jpg';
  const snapshot: SiteSnapshot = { ...draft, schemaVersion: 7, settings: { ...draft.settings, publicUrl: 'https://www.example.com' } };
  const resolved = resolveSitePage(snapshot)!;
  const params = { page_alpha: '2', search_alpha: 'query', term_alpha: 'unknown', utm_source: 'test' };
  const normal = siteMetadata(snapshot, resolved, false, params);
  assert.equal(normal.title, `Custom page · ${draft.settings.name}`); assert.equal(normal.description, 'Verified description');
  assert.deepEqual(normal.alternates, { canonical: 'https://www.example.com/' });
  assert.equal(normal.robots, undefined);
  assert.equal(hasInvalidLoopPage(snapshot, resolved, params), false);
  assert.deepEqual(siteMetadata(snapshot, resolved, true).robots, { index: false, follow: false, nocache: true });
  assert.equal(siteMetadata(snapshot, resolved, true).alternates, undefined);
  home.noindex = true;
  assert.deepEqual(siteMetadata(snapshot, resolved).robots, { index: false, follow: true });
});

const loop = (id: string, query: { paginate: boolean; controls: boolean }) => ({
  type: 'ContentLoop', props: { id, source: 'product', itemBlockId: 'seo-card', query: { ...query, pageSize: 1 } },
});
const data = (content: Data['content'], props = {}): Data => ({ root: { props }, content });
const block = (id: string, content: Data['content']) => ({ id, name: id, updated: '', data: data(content) });

test('多列表只保留自身开启且有效的页码，筛选参数按实际查询归一', () => {
  const draft = createInitialDraft();
  const snapshot: SiteSnapshot = {
    ...draft, schemaVersion: 7, settings: { ...draft.settings, publicUrl: 'https://www.example.com' },
    products: draft.products.slice(0, 3).map(product => ({ ...product, status: 'published' })),
    sharedBlocks: [block('seo-card', [{ type: 'Text', props: { id: 'card-label', text: 'Card' } }])],
    editorData: { ...draft.editorData, home: data([
      loop('alpha', { paginate: true, controls: true }), loop('beta', { paginate: true, controls: false }),
      loop('gamma', { paginate: false, controls: true }),
    ], { showChrome: 'no' }) },
  };
  const resolved = resolveSitePage(snapshot)!;
  const pages = { page_beta: '3', page_alpha: '2', search_beta: 'disabled', search_gamma: ['ignored'], page_gamma: '20', page_unknown: '10' };
  const meta = siteMetadata(snapshot, resolved, false, pages);
  assert.equal(meta.alternates?.canonical, 'https://www.example.com/?page_alpha=2&page_beta=3');
  assert.equal(meta.robots, undefined);
  assert.equal(hasInvalidLoopPage(snapshot, resolved, pages), false);
  const filtered = siteMetadata(snapshot, resolved, false, { ...pages, term_gamma: 'no-results' });
  assert.equal(filtered.alternates?.canonical, 'https://www.example.com/');
  assert.deepEqual(filtered.robots, { index: false, follow: true });
  assert.equal(siteMetadata(snapshot, resolved, false, { page_alpha: '1', search_alpha: '  ' }).alternates?.canonical, 'https://www.example.com/');
  const invalid = { ...pages, page_alpha: '4' };
  assert.equal(hasInvalidLoopPage(snapshot, resolved, invalid), true);
  assert.deepEqual(siteMetadata(snapshot, resolved, false, invalid), { title: 'Page not found', robots: { index: false, follow: false } });
});

test('本地语言条件详情只识别实际模板和正确命名空间的共享头尾查询', () => {
  const draft = createInitialDraft();
  const products = draft.products.slice(0, 3).map(product => ({ ...product, status: 'published' as const }));
  const translationGroupId = 'paired';
  const german = { ...products[0], id: 'de-item', slug: 'artikel', locale: 'de', translationGroupId, modelId: 'goods', customFields: { related: ['de-other', products[0].id, 'de-third'] } };
  const conditional = loop('conditional-loop', { paginate: true, controls: true });
  const snapshot: SiteSnapshot = {
    ...draft, schemaVersion: 14,
    settings: { ...draft.settings, language: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }], publicUrl: 'https://www.example.com' },
    products: [{ ...products[0], translationGroupId }, ...products.slice(1), german,
      { ...products[1], id: 'de-other', locale: 'de' }, { ...products[2], id: 'de-third', locale: 'de' }],
    contentModels: [{
      id: 'goods', name: 'Goods', target: 'product', description: '', updated: '',
      fields: [{ id: 'related', key: 'related', label: 'Related', type: 'relation', required: false, relation: { source: 'product', multiple: true, onDelete: 'restrict' } }],
    }],
    editorData: { ...draft.editorData, 'product-detail': data([loop('default-loop', { paginate: true, controls: true })]) },
    pageTemplates: [{
      id: 'german-detail', name: 'German', kind: 'product', updated: '', description: '',
      detailRule: { enabled: true, priority: 1, locale: 'de' },
      data: data([{ ...conditional, props: { ...conditional.props, relation: { source: 'product', modelId: 'goods', fieldId: 'related' } } }], {
        footerMode: 'hidden', bindingContext: { source: 'product', recordId: 'de-other' },
      }),
    }],
    sharedBlocks: [
      block('seo-card', [{ type: 'Text', props: { id: 'card-label', text: 'Card' } }]),
      block('german-header', [{ type: 'SharedBlock', props: { id: 'nested-ref', blockId: 'inner-list' } }]),
      block('inner-list', [loop('inner-loop', { paginate: true, controls: true })]),
      block('german-footer', [loop('footer-loop', { paginate: true, controls: true })]),
    ],
    siteLayout: {
      header: { mode: 'default', blockId: '', localeBlockIds: { de: 'german-header' } },
      footer: { mode: 'block', blockId: 'german-footer' }, menus: [],
    },
  };
  const resolved = resolveSitePage(snapshot, ['de', 'products', 'artikel'])!;
  assert.equal(resolved.detailTemplateId, 'german-detail');
  const ignored = { 'search_default-loop': 'a', 'search_inner-loop': 'b', 'page_shared-site-footer--1': '90' };
  const defaultMetadata = siteMetadata(snapshot, resolved, false, ignored);
  assert.equal(defaultMetadata.robots, undefined);
  assert.equal(defaultMetadata.alternates?.languages?.de, 'https://www.example.com/de/products/artikel');
  const params = { ...ignored, 'page_shared-shared-site-header--1--1': '2', 'page_conditional-loop': '2' };
  const paged = siteMetadata(snapshot, resolved, false, params);
  assert.equal(paged.alternates?.canonical, 'https://www.example.com/de/products/artikel?page_conditional-loop=2&page_shared-shared-site-header--1--1=2');
  assert.equal(paged.alternates?.languages, undefined);
  assert.equal(hasInvalidLoopPage(snapshot, resolved, { 'page_shared-shared-site-header--1--1': '4' }), true);
  assert.equal(hasInvalidLoopPage(snapshot, resolved, { 'page_conditional-loop': '3' }), true);
  assert.deepEqual(siteMetadata(snapshot, resolved, false, { 'search_shared-shared-site-header--1--1': 'missing' }).robots, { index: false, follow: true });
  assert.equal(siteMetadata(snapshot, resolved, true, params).alternates, undefined);
});
