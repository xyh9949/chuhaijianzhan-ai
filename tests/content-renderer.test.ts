import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import type { Data } from '@puckeditor/core';
import { initialState } from '../src/lib/demo';
import { createSiteConfig, type SiteRenderContext } from '../src/lib/site-render-config';
import { collectBindingReferences, contentBindingErrors, fieldChoices, resolveBindingValue } from '../src/lib/content-binding';
import { createPageData } from '../src/lib/page-data';
import type { ContentModel, FieldBinding } from '../src/lib/types';

const model: ContentModel = { id: 'equipment', name: 'Equipment', target: 'product', description: '', updated: '', fields: [
  { id: 'weight', key: 'weight', label: 'Weight', type: 'number', unit: 'kg', required: false },
  { id: 'ready', key: 'ready', label: 'Ready', type: 'boolean', required: false },
  { id: 'finish', key: 'finish', label: 'Finish', type: 'select', options: [{ label: 'Matte', value: 'matte' }], required: false },
  { id: 'certs', key: 'certs', label: 'Certificates', type: 'multiselect', options: [{ label: 'ISO label', value: 'iso' }, { label: 'CE label', value: 'ce' }], required: false },
  { id: 'photos', key: 'photos', label: 'Product photos', type: 'gallery', required: false },
  { id: 'link', key: 'link', label: 'Technical sheet', type: 'url', required: false },
  { id: 'note', key: 'note', label: 'Note', type: 'textarea', required: false },
  { id: 'date', key: 'date', label: 'Date', type: 'date', required: false },
] };
const entryModel: ContentModel = { ...model, id: 'cases', target: 'content', name: 'Cases' };
const current = (field: string, extra: Partial<FieldBinding> = {}): FieldBinding => ({ source: 'product', mode: 'current', modelId: 'equipment', field, ...extra });
const node = (type: string, id: string, props: Record<string, unknown>) => ({ type, props: { id, ...props } });
const rootProps = (data: Data) => data.root.props as Record<string, unknown>;
function fixture(content: Data['content'] = [], root: Record<string, unknown> = {}): SiteRenderContext {
  const state = structuredClone(initialState);
  const page = state.pages.find(page => page.slug === '/products/:slug')!;
  const data = createPageData('blank');
  data.content = content;
  Object.assign(rootProps(data), { showChrome: 'no', ...root });
  return { ...state, pageId: page.id, pages: state.pages.map(page => ({ ...page, status: 'published' })), products: [
    { ...state.products[0], id: 'product_a', name: 'First product', status: 'published', modelId: 'equipment', customFields: { weight: 0, ready: false, finish: 'matte', certs: ['iso','ce'], photos: ['/images/sofa.jpg','/images/studio.jpg'], link: '/technical', note: '<script>alert(1)</script>', date: '2026-11-06' } },
    { ...state.products[0], id: 'product_b', name: 'Second product', status: 'published', modelId: 'equipment', customFields: { weight: 12 } },
  ], contentModels: structuredClone([model, entryModel]), contentEntries: [
    { id: 'entry_a', modelId: 'cases', title: 'First case', status: 'published', updated: '', customFields: { weight: 0, photos: ['/images/studio.jpg'], link: '/about', note: 'Project story' } },
    { id: 'entry_draft', modelId: 'cases', title: 'Private draft', status: 'draft', updated: '', customFields: {} },
  ], editorData: { [page.id]: data } };
}
function html(context: SiteRenderContext) {
  return renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig(context), data: context.editorData[context.pageId!] as Data }));
}
function onlyActivePage(context: SiteRenderContext) { return { ...context, pages: context.pages.filter(page => page.id === context.pageId) }; }

test('bindings preserve zero/false, option labels, units, dates, gallery first image and explicit fallbacks', () => {
  const source = fixture();
  const runtime = { productId: 'product_a' };
  for (const [field, expected] of [['weight','0 kg'],['ready','No'],['finish','Matte'],['certs','ISO label, CE label'],['date','2026-11-06']]) {
    assert.equal(resolveBindingValue(current(`field:${field}`), 'text', source, runtime), expected);
  }
  assert.equal(resolveBindingValue(current('field:photos'), 'src', source, runtime), '/images/sofa.jpg');
  assert.equal(resolveBindingValue(current('field:weight', { fallback: 'Missing' }), 'text', source, { productId: 'missing' }), 'Missing');
  assert.equal(resolveBindingValue(current(undefined as unknown as string, { fallback: 'Choose a field' }), 'text', source, runtime), 'Choose a field');
  assert.equal(resolveBindingValue(current('field:photos', { fallback: 'javascript:alert(1)' }), 'src', source), '');
  assert.equal(resolveBindingValue(current('field:link', { fallback: 'javascript:alert(1)' }), 'href', source), '');
  assert.equal(resolveBindingValue(current('builtin:url'), 'href', source, runtime), '/products/product_a');
  assert.equal(resolveBindingValue(current('builtin:url'), 'href', { ...source, pages: [] }, runtime), '');
  assert.equal(fieldChoices('product', model, 'src').every(choice => ['image','gallery'].includes(choice.type)), true);
  assert.equal(fieldChoices('entry', entryModel, 'href').some(choice => choice.value === 'builtin:url'), true);
});

test('real product context overrides sample; fixed records remain fixed; scalar content is escaped in every element', () => {
  const context = fixture([
    node('Heading','title',{ text: 'Old static', bindings: { text: current('builtin:name') } }),
    node('Text','fixed',{ text: 'Old text', bindings: { text: current('field:note', { mode: 'fixed', recordId: 'product_a' }) } }),
    node('Image','photo',{ alt: 'Old alt', bindings: { src: current('field:photos', { mode: 'fixed', recordId: 'product_a' }), alt: current('builtin:name') } }),
    node('ActionButton','button',{ text: 'Old button', href: '/', bindings: { text: current('field:weight'), href: current('builtin:url') } }),
  ], { bindingContext: { source: 'product', recordId: 'product_a', modelId: 'equipment' } });
  context.previewProductId = 'product_b'; context.previewPrefix = '/preview';
  const rendered = html(context);
  assert.match(rendered, />Second product<\/h2>/);
  assert.match(rendered, /alt="Second product"/);
  assert.match(rendered, /src="\/images\/sofa.jpg"/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /href="\/preview\/products\/product_b"/);
  assert.match(rendered, /12 kg/);
  assert.doesNotMatch(rendered, /Old static|Old text|Old button|<script>/);
});

test('ordinary pages bind current entry context and clearing bindings restores original content', () => {
  const context = fixture([node('Text','entry',{ text: 'Static restored', bindings: { text: current('builtin:title', { source: 'entry', modelId: 'cases' }) } })], { bindingContext: { source: 'entry', recordId: 'entry_a' } });
  context.pages.find(page => page.id === context.pageId)!.slug = '/case-study';
  assert.match(html(context), /First case/);
  assert.deepEqual(contentBindingErrors(onlyActivePage(context), true), []);
  (context.editorData[context.pageId!] as Data).content[0].props.bindings = {};
  assert.match(html(context), /Static restored/);
  rootProps(context.editorData[context.pageId!] as Data).bindingContext = {};
  assert.deepEqual(contentBindingErrors(onlyActivePage(context), true), []);
});

test('product detail renders typed extensions and preserves explicit component selection with no page context', () => {
  const context = fixture([node('ProductDetail','detail',{ productId: 'product_a', cta: 'Enquire' })]);
  const rendered = html(context);
  for (const text of ['0 kg','No','Matte','ISO label, CE label','2026-11-06']) assert.ok(rendered.includes(text));
  assert.match(rendered, /data-product-field="photos"/);
  assert.match(rendered, /href="\/technical"/);
  assert.doesNotMatch(rendered, /<script>/);
  (context.editorData[context.pageId!] as Data).content[0].props.showCustomFields = 'no';
  assert.doesNotMatch(html(context), /data-product-field=/);
  context.editorCanvas = true;
  (context.editorData[context.pageId!] as Data).content[0].props.productId = 'product_b';
  assert.match(html(context), />Second product<\/h1>/);
});

test('content list maps model fields, excludes draft entries, preserves preview links and mobile layout', () => {
  const context = fixture([node('ContentList','cases-list',{ source: 'entry', modelId: 'cases', titleField: 'builtin:title', descriptionField: 'field:weight', imageField: 'field:photos', linkField: 'field:link', count: 8, columns: 3, mobileColumns: 1, design: { desktop: { gap: 25, columns: 3 }, mobile: { columns: 1, fontSize: 18 } } })]);
  context.previewPrefix = '/preview';
  const rendered = html(context);
  assert.match(rendered, /data-content-record="entry_a"/);
  assert.match(rendered, /First case/);
  assert.match(rendered, />0 kg<\/p>/);
  assert.match(rendered, /src="\/images\/studio.jpg"/);
  assert.match(rendered, /href="\/preview\/about"/);
  assert.match(rendered, /\.editor-site-product-grid\{gap:25px!important;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)!important;/);
  assert.match(rendered, /@container form-site \(max-width:700px\)/);
  assert.match(rendered, /grid-template-columns:repeat\(1,minmax\(0,1fr\)\)!important/);
  assert.doesNotMatch(rendered, /Private draft|entry_draft/);
  assert.deepEqual(contentBindingErrors(onlyActivePage(context), true), []);
  (context.editorData[context.pageId!] as Data).content[0].props.modelId = 'missing';
  assert.match(html(context), /No content is available yet/);
});

test('reusable blocks inherit route/page context; their editing samples are not public dependencies', () => {
  const context = fixture([node('SharedBlock','instance',{ blockId: 'product-heading' })]);
  const blockData = createPageData('blank');
  rootProps(blockData).bindingContext = { source: 'product', recordId: 'sample_only', modelId: 'equipment' };
  blockData.content = [node('Heading','inside',{ text: 'Static', bindings: { text: current('builtin:name') } })];
  context.sharedBlocks = [{ id: 'product-heading', name: 'Product heading', updated: '', data: blockData }];
  context.previewProductId = 'product_b';
  assert.match(html(context), />Second product<\/h2>/);
  assert.deepEqual(contentBindingErrors(onlyActivePage(context), true), []);
  const refs = collectBindingReferences(onlyActivePage(context));
  assert.equal(refs.productIds.has('sample_only'), false);
  assert.deepEqual([...refs.modelIds], ['equipment']);
  context.pages.find(page => page.id === context.pageId)!.slug = '/selected-product';
  context.previewProductId = undefined;
  rootProps(context.editorData[context.pageId!] as Data).bindingContext = { source: 'product', recordId: 'product_a' };
  assert.match(html(context), />First product<\/h2>/);
  assert.deepEqual(contentBindingErrors(onlyActivePage(context), true), []);
  assert.equal(collectBindingReferences(onlyActivePage(context)).productIds.has('product_a'), true);
});

test('validation rejects mismatched fields/models/records and incomplete bindings only block publishing', () => {
  const context = fixture([node('Text','bound',{ bindings: { text: current('') } })]);
  const data = context.editorData[context.pageId!] as Data;
  assert.deepEqual(contentBindingErrors(onlyActivePage(context)), []);
  assert.match(contentBindingErrors(onlyActivePage(context), true).join('\n'), /请选择绑定字段/);
  data.content[0].props.bindings.text.field = 'field:photos';
  assert.match(contentBindingErrors(onlyActivePage(context)).join('\n'), /不存在或不兼容 text/);
  data.content[0].props.bindings.text = current('builtin:name', { mode: 'fixed', recordId: 'gone' });
  assert.match(contentBindingErrors(onlyActivePage(context)).join('\n'), /固定绑定记录 gone 不存在/);
  data.content[0].props.bindings.text = current('builtin:name');
  context.pages.find(page => page.id === context.pageId)!.slug = '/ordinary';
  assert.deepEqual(contentBindingErrors(onlyActivePage(context)), []);
  assert.match(contentBindingErrors(onlyActivePage(context), true).join('\n'), /需要页面内容上下文/);
  rootProps(data).bindingContext = { source: 'product', recordId: 'product_a' };
  context.products[0].modelId = 'different';
  assert.match(contentBindingErrors(onlyActivePage(context), true).join('\n'), /与页面模型不匹配/);
  delete context.products[0].modelId;
  assert.match(contentBindingErrors(onlyActivePage(context), true).join('\n'), /与页面模型不匹配/);
  context.products[0].modelId = 'equipment';
  data.content[0].props.bindings.text = current('field:weight');
  context.contentModels![0].fields.find(field => field.id === 'weight')!.label = 'Renamed mass';
  assert.deepEqual(contentBindingErrors(onlyActivePage(context), true), []);
  context.contentModels![0].fields = context.contentModels![0].fields.filter(field => field.id !== 'weight');
  assert.match(contentBindingErrors(onlyActivePage(context)).join('\n'), /field:weight 不存在/);
});

test('references include fixed bindings, page context and list models without treating free text as dependencies', () => {
  const context = fixture([
    node('Text','fixed',{ text: 'product_b', bindings: { text: current('builtin:title', { source: 'entry', modelId: 'cases', mode: 'fixed', recordId: 'entry_a' }) } }),
    node('ContentList','list',{ source: 'product', modelId: 'equipment', titleField: 'builtin:name' }),
  ], { bindingContext: { source: 'product', recordId: 'product_a' } });
  const refs = collectBindingReferences(onlyActivePage(context));
  assert.deepEqual([...refs.productIds], ['product_a']);
  assert.deepEqual([...refs.entryIds], ['entry_a']);
  assert.deepEqual([...refs.modelIds].sort(), ['cases','equipment']);
});
