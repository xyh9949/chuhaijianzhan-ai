import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { queryContent, queryErrors, loopParam } from '../src/lib/content-query';
import { taxonomyErrors } from '../src/lib/taxonomy';
import { hasInvalidLoopPage } from '../src/lib/loop-pages';
import { createSiteConfig } from '../src/lib/site-render-config';
import { createInitialDraft } from '../src/server/seed';
import { resolveSitePage } from '../src/lib/site-routing';
import { createSharedBlockNodeCounter } from '../src/lib/shared-blocks';
import type { ContentModel, Product } from '../src/lib/types';
import type { SiteSnapshot } from '../src/server/types';

const model: ContentModel = { id: 'model', name: 'Model', description: '', target: 'product', updated: '', fields: [{ id: 'weight', key: 'weight', label: 'Weight', type: 'number', required: false }, { id: 'flag', key: 'flag', label: 'Flag', type: 'boolean', required: false }] };
const records: Product[] = Array.from({ length: 31 }, (_, i): Product => ({ id: `p-${String(i).padStart(2, '0')}`, name: `Product ${i}`, sku: `S${i}`, image: '', category: 'Legacy', description: '', material: '', status: 'published', modelId: model.id, sortOrder: i, termIds: [i % 2 ? 'odd' : 'even'], customFields: i < 2 ? { weight: i, flag: !!i } : {} }));
const source = { products: records, contentModels: [model], taxonomies: [{ id: 'tax', name: 'Type', source: 'product' as const, terms: [{ id: 'odd', label: 'Odd', slug: 'odd' }, { id: 'even', label: 'Even', slug: 'even' }] }] };

test('31条每页12的三页无重复遗漏，各循环参数独立且无JS可分享', () => {
  const query = { paginate: true, pageSize: 12, sort: 'builtin:sortOrder', controls: true };
  const pages = [1, 2, 3].map(page => queryContent(source, 'product', model.id, query, 'alpha', { [loopParam('alpha', 'page')]: String(page) }));
  assert.deepEqual(pages.map(page => page.records.length), [12, 12, 7]);
  assert.equal(new Set(pages.flatMap(page => page.records.map(item => item.id))).size, 31);
  assert.equal(queryContent(source, 'product', model.id, query, 'beta', { [loopParam('alpha', 'page')]: '3' }).page, 1);
  assert.equal(queryContent(source, 'product', model.id, query, 'alpha', { [loopParam('alpha', 'page')]: '4' }).outOfRange, true);
  for (const invalid of ['0', '-1', 'abc', ['2']]) assert.equal(queryContent(source, 'product', model.id, query, 'alpha', { [loopParam('alpha', 'page')]: invalid }).page, 1);
  assert.equal(queryContent(source, 'product', model.id, query, 'alpha', { [loopParam('alpha', 'page')]: '9'.repeat(50) }).outOfRange, true);
});

test('0/false不等同缺失，分类/搜索与条件组合不会读取草稿', () => {
  assert.deepEqual(queryContent(source, 'product', model.id, { filters: [{ field: 'field:weight', op: 'eq', value: 0 }, { field: 'field:flag', op: 'eq', value: false }] }, 'a').records.map(item => item.id), ['p-00']);
  const found = queryContent(source, 'product', model.id, { controls: true, pageSize: 50 }, 'a', { [loopParam('a', 'search')]: 'Product', [loopParam('a', 'term')]: 'even' });
  assert.equal(found.total, 16);
  const hidden = { ...source, products: [{ ...records[0], status: 'draft' as const }] };
  assert.equal(queryContent(hidden, 'product', model.id, {}, 'a').total, 0);
  const empty = queryContent(source, 'product', model.id, { controls: true, paginate: true }, 'a', { [loopParam('a', 'search')]: 'no-match' });
  assert.equal(empty.total, 0); assert.equal(empty.outOfRange, false);
});

test('产品型号搜索不依赖导入分类，仍受语言、发布状态和分类筛选限制', () => {
  const product = { ...records[0], name: 'Arc Banquette', sku: 'LR-DEMO-006', locale: 'en' };
  const catalogue = { ...source, locale: 'en', settings: { language: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }] }, products: [product, { ...product, id: 'other-language', locale: 'de' }, { ...product, id: 'not-public', status: 'draft' as const }] };
  const search = loopParam('catalogue', 'search'), term = loopParam('catalogue', 'term');
  const find = (text: string, category = '', productCategories = false) => queryContent(catalogue, 'product', model.id, { controls: true, paginate: true, productCategories }, 'catalogue', { [search]: text, [term]: category });
  assert.deepEqual(find(' lr-demo-006 ').records.map(record => record.id), [product.id]);
  assert.deepEqual(find('Arc').records.map(record => record.id), [product.id]);
  assert.equal(find('LR-DEMO-006', 'even').total, 1);
  assert.equal(find('LR-DEMO-006', 'odd').total, 0);
  assert.equal(find('LR-DEMO-006', 'category:Legacy', true).total, 1);
});

test('查询与分类校验限制类型、循环、失效引用及表达式，旧无query不改变顺序', () => {
  assert.deepEqual(queryErrors({ filters: [{ field: 'field:flag', op: 'eq', value: false }] }, source, 'product', model.id), []);
  for (const query of [{ sql: 'select *' }, { pageSize: 1000 }, { sort: 'field:missing' }, { filters: [{ field: 'field:flag', op: 'gte', value: 0 }] }, { filters: [{ field: 'field:weight', op: 'eq', value: '0' }] }, { termIds: ['ghost'] }]) assert.ok(queryErrors(query, source, 'product', model.id).length);
  assert.deepEqual(queryContent({ ...source, products: [...records].reverse() }, 'product', model.id, undefined, 'a', {}, 3).records.map(item => item.id), ['p-30', 'p-29', 'p-28']);
  assert.deepEqual(taxonomyErrors(source), []);
  assert.match(taxonomyErrors({ ...source, taxonomies: [] }).join(), /不存在/);
  assert.match(taxonomyErrors({ products: [], taxonomies: [{ ...source.taxonomies[0], terms: [{ id: 'a', label: 'A', slug: 'a', parentId: 'b' }, { id: 'b', label: 'B', slug: 'b', parentId: 'a' }] }] }).join(), /循环/);
});

test('SSR两个循环保留彼此参数，提前检查无效页数，展开预算使用查询每页上限', () => {
  const draft = createInitialDraft();
  const card = { id: 'card', name: 'Card', updated: '', data: { root: { props: {} }, content: [{ type: 'Text', props: { id: 'copy', text: 'Card' } }] } };
  const loop = (id: string) => ({ type: 'ContentLoop', props: { id, source: 'product', modelId: model.id, itemBlockId: card.id, count: 1, title: id, query: { paginate: true, controls: true, pageSize: 12 } } });
  const snapshot: SiteSnapshot = { ...draft, ...source, schemaVersion: 6, settings: draft.settings, sharedBlocks: [card], editorData: { ...draft.editorData, home: { root: { props: { showChrome: 'no' } }, content: [loop('alpha'), loop('beta')] } } };
  const params = { [loopParam('beta', 'page')]: '2' }, resolved = resolveSitePage(snapshot)!;
  assert.equal(hasInvalidLoopPage(snapshot, resolved, { [loopParam('alpha', 'page')]: '4' }), true);
  assert.equal(hasInvalidLoopPage(snapshot, resolved, params), false);
  const html = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...snapshot, pageId: 'home', queryParams: params, currentPath: '/' }), data: resolved.data }));
  assert.match(html, /page_beta=2/); assert.match(html, /page_alpha=2/); assert.equal((html.match(/data-loop-record=/g) || []).length, 24);
  assert.ok(createSharedBlockNodeCounter([card])(loop('alpha')) >= 13);
});
