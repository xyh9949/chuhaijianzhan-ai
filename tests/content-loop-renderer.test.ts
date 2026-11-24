import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import type { Data } from '@puckeditor/core';
import { initialState } from '../src/lib/demo';
import { createPageData, getPageKind } from '../src/lib/page-data';
import { createSiteConfig, type SiteRenderContext } from '../src/lib/site-render-config';
import { contentRouteErrors, getContentEntryPath, getTemplatePreviewPath } from '../src/lib/content-routes';
import { collectBindingReferences, contentBindingErrors } from '../src/lib/content-binding';
import { createSharedBlockNodeCounter, getSharedBlockReferences, getSharedBlockUsage, sharedBlockContainsLoop, SHARED_BLOCK_MAX_NODES } from '../src/lib/shared-blocks';
import { resolveSitePage } from '../src/lib/site-routing';
import { siteMetadata } from '../src/lib/site-metadata';
import { compileDesignCss, getLegacyDesign } from '../src/lib/responsive-style';
import type { SiteSnapshot } from '../src/server/types';
import type { FieldBinding, SharedBlock } from '../src/lib/types';
import {hasInvalidLoopPage} from '../src/lib/loop-pages';

const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const binding = (source: 'entry'|'product', field: string, extra: Partial<FieldBinding> = {}): FieldBinding => ({ source, field, mode: 'current', ...extra });
const data = (content: Data['content'], props: Record<string, unknown> = {}): Data => {
  const result = createPageData('blank');
  Object.assign(result.root.props!, { showChrome: 'no', ...props });
  result.content = content;
  return result;
};
const block = (id: string, content: Data['content'], root: Record<string, unknown> = {}): SharedBlock => ({ id, name: id, updated: '', data: data(content, root) });
function fixture(content: Data['content'] = []): SiteRenderContext {
  const state = structuredClone(initialState);
  return { ...state, pageId: 'case-template', pages: [
    { id: 'case-template', title: 'Cases template', slug: '/work/cases/:slug', contentModelId: 'cases', type: '内容详情模板', status: 'published', updated: '' },
    { id: 'product-template', title: 'Products', slug: '/products/:slug', type: '产品详情', status: 'published', updated: '' },
  ], contentModels: [{ id: 'cases', name: 'Cases', target: 'content', description: '', updated: '', fields: [] }], contentEntries: [
    { id: 'entry_a', modelId: 'cases', title: 'Alpine house', status: 'published', customFields: {}, updated: '' },
    { id: 'entry_b', modelId: 'cases', slug: 'lakeside', title: 'Lakeside hotel', seoTitle: 'Hotel SEO', seoDescription: 'Hotel description', status: 'published', customFields: {}, updated: '' },
    { id: 'entry_draft', modelId: 'cases', title: 'Private draft', status: 'draft', customFields: {}, updated: '' },
  ], products: [
    { ...state.products[0], id: 'product_a', name: 'Oak chair', status: 'published' },
    { ...state.products[0], id: 'product_b', name: 'Linen sofa', status: 'published' },
  ], sharedBlocks: [], editorData: { 'case-template': data(content, { bindingContext: { source: 'entry', recordId: 'entry_a', modelId: 'cases' } }), 'product-template': createPageData('product-detail') } };
}
function html(context: SiteRenderContext) { return renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig(context), data: context.editorData[context.pageId!] as Data })); }
function snapshot(context: SiteRenderContext): SiteSnapshot { return { ...initialState, ...context, schemaVersion: 4 } as SiteSnapshot; }
function cards(context: SiteRenderContext, source: 'entry'|'product') {
  context.sharedBlocks = [
    block('card', [node('Container', 'card-container', { content: [node('SharedBlock', 'inner', { blockId: 'card-text' })], layout: 'column', gap: 8, padding: 16, inset: 16, design: { desktop: { borderRadius: 8 }, mobile: { paddingLeft: 12 } } })], { bindingContext: { source: 'entry', recordId: 'entry_a' } }),
    block('card-text', [node('Heading', 'card-title', { bindings: { text: binding(source, source === 'entry' ? 'builtin:title' : 'builtin:name') }, design: { desktop: { fontSize: 24 }, mobile: { fontSize: 18 } } }), node('ActionButton', 'card-link', { text: 'Read more', bindings: { href: binding(source, 'builtin:url') } })]),
  ];
}

test('entry paths, editor samples and route resolution share custom-slug and stable-ID rules', () => {
  const context = fixture(), page = context.pages[0];
  assert.equal(getContentEntryPath(context, context.contentEntries![0]), '/work/cases/entry_a');
  assert.equal(getContentEntryPath(context, context.contentEntries![1]), '/work/cases/lakeside');
  assert.equal(getTemplatePreviewPath(context, page), '/work/cases/entry_a');
  assert.equal(getTemplatePreviewPath({ ...context, contentEntries: [] }, page), undefined);
  assert.equal(getPageKind(page), 'blank');
  const resolved = resolveSitePage(snapshot(context), ['work','cases','lakeside']);
  assert.equal(resolved?.entry?.id, 'entry_b');
  assert.equal(resolved?.page.id, page.id);
  assert.equal(resolveSitePage(snapshot(context), ['work','cases','entry_b']), null);
  assert.equal(resolveSitePage(snapshot(context), ['work','cases','entry_draft']), null);
  assert.equal(siteMetadata(snapshot(context), resolved).title, `Hotel SEO · ${context.settings.name}`);
  assert.equal(siteMetadata(snapshot(context), resolved).description, 'Hotel description');
  assert.deepEqual(siteMetadata(snapshot(context), resolved, true).robots, { index: false, follow: false, nocache: true });
});

test('route validation rejects generated/static collisions, effective duplicate segments and reserved prefixes', () => {
  const context = fixture();
  assert.deepEqual(contentRouteErrors(context), []);
  context.pages.push({ ...context.pages[0], id: 'static', slug: '/work/cases/lakeside', contentModelId: undefined });
  assert.match(contentRouteErrors(context).join('\n'), /普通页面冲突/);
  context.pages.pop(); context.contentEntries![1].slug = 'entry_a';
  assert.match(contentRouteErrors(context).join('\n'), /短路径 entry_a 重复/);
  context.contentEntries![1].slug = ''; context.pages[0].slug = '/api/cases/:slug';
  assert.equal(getContentEntryPath(context, context.contentEntries![0]), undefined);
  assert.match(contentRouteErrors(context).join('\n'), /系统或产品路径/);
});

test('actual entry detail overrides its sample while fixed bindings stay fixed', () => {
  const context = fixture([node('Heading','current',{ bindings: { text: binding('entry', 'builtin:title') } }), node('Text','fixed',{ bindings: { text: binding('entry','builtin:title',{ mode: 'fixed', recordId: 'entry_a' }) } }), node('ActionButton','link',{ text: 'Detail', bindings: { href: binding('entry','builtin:url') } })]);
  context.previewEntryId = 'entry_b'; context.previewPrefix = '/preview';
  const rendered = html(context);
  assert.match(rendered, />Lakeside hotel<\/h2>/);
  assert.match(rendered, />Alpine house<\/p>/);
  assert.match(rendered, /href="\/preview\/work\/cases\/lakeside"/);
  assert.deepEqual(contentBindingErrors(context, true), []);
});

test('entry loop gives every nested shared card its record, URL and independent responsive CSS IDs', () => {
  const context = fixture([node('ContentLoop','cases-loop',{ source: 'entry', modelId: 'cases', itemBlockId: 'card', count: 50, design: { desktop: { columns: 3, gap: 28 }, mobile: { columns: 1 } } })]);
  cards(context, 'entry'); context.previewEntryId = 'entry_b'; context.previewPrefix = '/preview';
  const rendered = html(context);
  assert.match(rendered, /data-content-loop="cases-loop"/);
  const items = [...rendered.matchAll(/<article[^>]+data-loop-record="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
  assert.deepEqual(items.map(item => item[1]), ['entry_a','entry_b']);
  assert.match(items[0][2], />Alpine house<\/h2>/); assert.match(items[0][2], /href="\/preview\/work\/cases\/entry_a"/);
  assert.match(items[1][2], />Lakeside hotel<\/h2>/); assert.match(items[1][2], /href="\/preview\/work\/cases\/lakeside"/);
  assert.doesNotMatch(rendered, /Private draft/);
  const styleIds = [...rendered.matchAll(/data-design-css="([^"]+)"/g)].map(match => match[1]);
  assert.ok(styleIds.length >= 5); assert.equal(new Set(styleIds).size, styleIds.length);
  assert.match(rendered, /\.editor-site-loop-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)!important;gap:28px!important/);
  assert.deepEqual(contentBindingErrors(context, true), []);
});

test('product loop inside an entry detail clears outer entry context through nested shared blocks', () => {
  const context = fixture([node('ContentLoop','products-loop',{ source: 'product', itemBlockId: 'card', count: 2 })]);
  cards(context, 'product'); context.previewEntryId = 'entry_b';
  const rendered = html(context);
  assert.match(rendered, />Oak chair<\/h2>/); assert.match(rendered, />Linen sofa<\/h2>/);
  assert.match(rendered, /href="\/products\/product_a"/); assert.match(rendered, /href="\/products\/product_b"/);
  assert.doesNotMatch(rendered, /Lakeside hotel|Alpine house/);
  assert.deepEqual(contentBindingErrors(context, true), []);
  context.pageId = 'product-template'; context.editorData['product-template'] = context.editorData['case-template'];
  context.previewEntryId = undefined; context.previewProductId = 'product_b';
  assert.match(html(context), />Oak chair<\/h2>/);
});

test('template sample is neither a publication dependency nor required after sample record deletion', () => {
  const context = fixture([node('Heading','title',{ bindings: { text: binding('entry','builtin:title') } })]);
  context.contentEntries = context.contentEntries!.filter(entry => entry.id === 'entry_b');
  assert.deepEqual(contentBindingErrors(context), []);
  assert.deepEqual(contentBindingErrors(context, true), []);
  assert.equal(collectBindingReferences(context).entryIds.has('entry_a'), false);
  assert.equal(collectBindingReferences(context).modelIds.has('cases'), true);
  context.editorCanvas = true;
  assert.match(html(context), />Lakeside hotel<\/h2>/);
});

test('loop bindings require matching source and model, and entry URL requires its model template', () => {
  const context = fixture([node('ContentLoop','cases-loop',{ source: 'entry', modelId: 'cases', itemBlockId: 'card' })]);
  cards(context, 'product');
  assert.match(contentBindingErrors(context, true).join('\n'), /当前记录绑定需要页面内容上下文/);
  cards(context, 'entry');
  context.pages[0].slug = '/ordinary'; context.pages[0].contentModelId = undefined;
  assert.match(contentBindingErrors(context, true).join('\n'), /内容链接需要同时发布该模型的详情模板/);
});

test('loop dependencies include cards, reject nested loops defensively and multiply rendering budgets', () => {
  const context = fixture([node('ContentLoop','cases-loop',{ source: 'entry', modelId: 'cases', itemBlockId: 'card', count: 2 })]);
  cards(context, 'entry');
  assert.deepEqual(getSharedBlockReferences(context.editorData['case-template']), ['card']);
  assert.deepEqual(getSharedBlockUsage('card-text', context).pageIds, ['case-template']);
  assert.equal(sharedBlockContainsLoop('card', context.sharedBlocks), false);
  context.sharedBlocks![1].data.content.push(node('ContentLoop','nested',{ source: 'entry', itemBlockId: 'card' }));
  assert.equal(sharedBlockContainsLoop('card', context.sharedBlocks), true);
  assert.doesNotMatch(html(context), /data-loop-record=/);
  const heavy = block('heavy', Array.from({ length: 201 }, (_, i) => node('Text', `text-${i}`, { text: 'x' })));
  assert.ok(createSharedBlockNodeCounter([heavy])(data([node('ContentLoop','heavy-loop',{ itemBlockId: 'heavy', count: 50 })])) > SHARED_BLOCK_MAX_NODES);
});

test('loop responsive layout targets only the outer grid and inherits legacy mobile defaults', () => {
  const css = compileDesignCss('loop', { desktop: { columns: 4, gap: 18 }, tablet: { columns: 2 }, mobile: { columns: 1, gap: 12 } }, 'ContentLoop');
  assert.match(css, />\.editor-site-loop-grid/);
  assert.match(css, /@container form-site \(max-width:700px\)/);
  assert.doesNotMatch(css, /editor-site-slot|editor-site-product-grid/);
  assert.equal(getLegacyDesign('ContentLoop', { gap: 18, padding: 30, mobileColumns: 2 }, 'mobile').columns, 2);
});
test('产品关联案例使用真实URL记录、关系顺序与同范围分页，卡片不继承外层产品',()=>{
 const relation={source:'product',modelId:'goods',fieldId:'related-cases'},loop=node('ContentLoop','related-cases-loop',{source:'entry',modelId:'cases',relation,itemBlockId:'card',query:{pageSize:1,paginate:true},count:6,emptyText:'No linked cases'}),context=fixture();
 context.contentModels!.push({id:'goods',name:'Goods',target:'product',description:'',updated:'',fields:[{id:'related-cases',key:'cases',label:'Cases',type:'relation',required:false,relation:{source:'entry',modelId:'cases',multiple:true,onDelete:'restrict'}}]});
 context.products.forEach((p,i)=>{p.modelId='goods';p.customFields={'related-cases':i?[]:['entry_b','entry_a']};});
 context.pageId='product-template';context.previewProductId='product_a';context.editorData['product-template']=data([loop],{bindingContext:{source:'product',recordId:'product_b',modelId:'goods'}});cards(context,'entry');
 let rendered=html(context);assert.match(rendered,/data-loop-record="entry_b"/);assert.doesNotMatch(rendered,/data-loop-record="entry_a"/);assert.match(rendered,/>Lakeside hotel<\/h2>/);assert.match(rendered,/href="\/work\/cases\/lakeside"/);
 const s=snapshot(context),resolved=resolveSitePage(s,['products','product_a'])!;assert.equal(hasInvalidLoopPage(s,resolved,{page_related_cases_loop:'3'}),false);assert.equal(hasInvalidLoopPage(s,resolved,{'page_related-cases-loop':'3'}),true);assert.equal(hasInvalidLoopPage(s,resolved,{'page_related-cases-loop':'2'}),false);
 context.previewProductId='product_b';rendered=html(context);assert.doesNotMatch(rendered,/data-loop-record=/);assert.match(rendered,/No linked cases/);
});
