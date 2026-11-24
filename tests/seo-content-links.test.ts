import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Data } from '@puckeditor/core';
import protocol from '../src/lib/protocol.json';
import type { RichNode } from '../src/lib/presentation-content';
import { seoContentInternalPath, seoContentLinkPublicationErrors } from '../src/lib/seo-content-links';
import { createEmptyDraft } from '../src/server/seed';
import type { DraftContent, SiteSnapshot } from '../src/server/types';

const link = (href: string): RichNode => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Supplied link', marks: [{ type: 'link', attrs: { href } }] }] }] });
function data(href: string): Data { return { root: { props: {} }, content: [{ type: 'RichText', props: { id: 'link-block', doc: link(href) } }] }; }
function source(): DraftContent {
  const value = createEmptyDraft(); value.settings.publicUrl = 'https://factory.example'; value.settings.locales = [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }];
  value.pages.push({ id: 'about', title: 'About', slug: '/about', type: '普通页面', status: 'draft', updated: '' }, { id: 'de-about', title: 'Über uns', slug: '/de/about', locale: 'de', type: '普通页面', status: 'draft', updated: '' }, { id: 'product-detail', title: 'Product detail', slug: '/products/:slug', type: '产品详情', status: 'draft', updated: '' }, { id: 'news-detail', title: 'News detail', slug: '/news/:slug', contentModelId: 'news', type: '内容详情', status: 'draft', updated: '' });
  for (const page of value.pages) value.editorData[page.id] = { root: { props: {} }, content: [] };
  value.products = [{ id: 'sample', slug: 'sample', name: 'Sample', sku: '', category: '', material: '', description: '', image: '', status: 'draft' }];
  value.contentModels = [{ id: 'news', name: 'News', target: 'content', description: '', fields: [], updated: '' }];
  value.contentEntries = [{ id: 'news-item', modelId: 'news', title: 'News item', slug: 'sample', customFields: {}, status: 'draft', updated: '' }]; return value;
}
function published(value: DraftContent): SiteSnapshot { return { ...structuredClone(value), schemaVersion: protocol.snapshot, products: value.products.map(item => ({ ...item, status: 'published' })), contentEntries: value.contentEntries?.map(item => ({ ...item, status: 'published' })) }; }

test('literal内链只去查询与锚点，同源绝对路径可认，拒绝协议相对、编码斜线和点段猜测', () => {
  for (const href of ['/about?source=seo#facts', 'https://factory.example/about?source=seo#facts']) assert.equal(seoContentInternalPath(href, 'https://factory.example'), '/about');
  for (const href of ['https://other.example/about', '//factory.example/about', '/a/../about', '/%2e%2e/about', '/a%2Fabout', '/a%5cabout', '/admin/users', '/about\n', '/\\about']) assert.equal(seoContentInternalPath(href, 'https://factory.example'), undefined);
  assert.equal(seoContentInternalPath('/about%20company'), '/about%20company');
});

test('已知草稿页面必须包含于公开快照，路径由不同ID合法承接时允许，未改输入', () => {
  const draft = source(), candidate = published(draft); candidate.editorData.home = data('/about?via=seo#facts'); candidate.pages = candidate.pages.filter(page => page.id !== 'about');
  const before = JSON.stringify({ draft, candidate }); assert.equal(seoContentLinkPublicationErrors(candidate, draft).length, 1); assert.equal(JSON.stringify({ draft, candidate }), before);
  candidate.pages.push({ ...draft.pages[1], id: 'replacement' }); candidate.editorData.replacement = { root: { props: {} }, content: [] }; assert.deepEqual(seoContentLinkPublicationErrors(candidate, draft), []);
});

test('产品及独立内容内链要求真实记录和详情模板，不把缺模板的猜测地址列为已有目标', () => {
  const draft = source(), candidate = published(draft); candidate.editorData.home = data('/products/sample'); candidate.products = []; assert.equal(seoContentLinkPublicationErrors(candidate, draft).length, 1);
  candidate.editorData.home = data('/news/sample'); candidate.contentEntries = []; assert.equal(seoContentLinkPublicationErrors(candidate, draft).length, 1);
  candidate.contentEntries = published(draft).contentEntries; candidate.pages = candidate.pages.filter(page => page.id !== 'news-detail'); assert.equal(seoContentLinkPublicationErrors(candidate, draft).length, 1);
  const noTemplate = source(); noTemplate.pages = noTemplate.pages.filter(page => page.id !== 'news-detail'); assert.deepEqual(seoContentLinkPublicationErrors(candidate, noTemplate), []);
});

test('来自上一公开版本的已知目标仍校验，同语言路径逐一对应，外链和未知普通URL不臆测', () => {
  const draft = source(), active = published(draft); draft.pages = draft.pages.filter(page => page.id !== 'about'); const candidate = published(draft); candidate.editorData.home = data('https://factory.example/about#facts'); assert.equal(seoContentLinkPublicationErrors(candidate, draft, active).length, 1);
  candidate.editorData.home = data('/de/about'); assert.deepEqual(seoContentLinkPublicationErrors(candidate, draft, active), []); candidate.pages = candidate.pages.filter(page => page.id !== 'de-about'); assert.equal(seoContentLinkPublicationErrors(candidate, draft, active).length, 1);
  for (const href of ['/unknown-normal-page', 'https://other.example/about', '/about%2f', '//factory.example/about']) { candidate.editorData.home = data(href); assert.deepEqual(seoContentLinkPublicationErrors(candidate, draft, active), []); }
});

test('检查原生产品长详情、文章富文、同步区块、模板及嵌套Puck富文链接', () => {
  const draft = source(), candidate = published(draft); candidate.pages = candidate.pages.filter(page => page.id !== 'about'); candidate.products[0].detailContent = link('/about'); candidate.contentEntries![0].richTextFields = { body: link('/about') }; candidate.sharedBlocks = [{ id: 'shared', name: 'Shared', data: data('/about'), updated: '' }]; candidate.pageTemplates = [{ id: 'template', name: 'Template', description: '', kind: 'page', data: data('/about'), updated: '' }]; candidate.editorData.home = { root: { props: {} }, content: [{ type: 'Section', props: { id: 'nested', body: data('/about').content } }] };
  const errors = seoContentLinkPublicationErrors(candidate, draft); assert.equal(errors.length, 5); for (const label of ['页面', '产品', '内容', '同步区块', '模板']) assert.ok(errors.some(message => message.startsWith(label)));
});
