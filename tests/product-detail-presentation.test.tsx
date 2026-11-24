import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import type { Data } from '@puckeditor/core';
import { createSiteConfig } from '../src/lib/site-render-config';
import { createEmptyDraft } from '../src/server/seed';
import { compileDesignCss } from '../src/lib/responsive-style';
import { validateDraft, validatePageData } from '../src/server/validation';
import { siteLinkErrors } from '../src/lib/site-links';
import { compileAiPageEdit } from '../src/lib/ai-page-edit';
import type { AiPageEditRequest } from '../src/lib/ai-page-edit-types';

function fixture() {
  const source = createEmptyDraft();
  source.pages.push({ id: 'contact', title: 'Contact', slug: '/contact', status: 'draft', type: '联系我们', updated: '2026-11-16T00:00:00.000Z' });
  source.products = [{ id: 'detail-product', name: 'Supplied Reading Chair', sku: 'SUPPLIED-REF-01', category: 'Supplied category', material: 'Supplied material', description: 'Supplied original description, without invented facts.', image: '/images/chair.jpg', status: 'published', detailContent: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original editable long detail.' }] }, { type: 'image', attrs: { src: '/images/studio.jpg', alt: 'Original supplied detail photograph' } }] } }];
  return source;
}
function data(props: Record<string, unknown> = {}): Data<Record<string, Record<string, unknown>>, { brand?: string; showChrome?: string }> { return { root: { props: { brand: '', showChrome: 'no' } }, content: [{ type: 'ProductDetail', props: { id: 'quality-detail', productId: '', layout: 'split', imageHeight: 500, padding: 0, cta: 'Discuss this product', ...props } }] }; }
function render(props: Record<string, unknown> = {}, source = fixture()) { return renderToStaticMarkup(<Render config={createSiteConfig({ ...source, pageId: 'home', previewProductId: source.products[0].id, previewPrefix: '/preview/quality' })} data={data(props)} />); }

test('旧详情缺省和显式图片优先完全相同，不自动改变旧页面', () => {
  const old = render(); assert.equal(old, render({ mobileOrder: 'image-first' }));
  assert.ok(old.indexOf('<img') < old.indexOf('<h1')); assert.ok(old.indexOf('Supplied original description') < old.indexOf('SUPPLIED-REF-01'));
});

test('身份优先只读真实产品一次：名称、参考号、行动先于原图，说明和原生长详情完整保留', () => {
  const html = render({ mobileOrder: 'identity-first', ctaColor: '#653f31' });
  assert.ok(html.indexOf('<h1') < html.indexOf('<img'), '真实产品名应先于图片');
  assert.ok(html.indexOf('SUPPLIED-REF-01') < html.indexOf('<img'), '参考号应先于图片');
  assert.ok(html.indexOf('Discuss this product') < html.indexOf('<img'), '主要行动应先于图片');
  assert.ok(html.indexOf('Supplied original description') > html.indexOf('<img'));
  assert.equal((html.match(/<h1\b/g) || []).length, 1); assert.equal((html.match(/SUPPLIED-REF-01/g) || []).length, 1);
  assert.match(html, /href="\/preview\/quality\/contact"/); assert.match(html, /--product-detail-cta-background:#653f31/);
  for (const value of ['Original editable long detail.', 'Original supplied detail photograph', 'Supplied material', '/images/chair.jpg', '/images/studio.jpg']) assert.ok(html.includes(value));
  const other = fixture(); other.products[0] = { ...other.products[0], name: 'Another supplied product', sku: 'NEXT-REF-02' };
  const next = render({ mobileOrder: 'identity-first' }, other); assert.match(next, /Another supplied product/); assert.match(next, /NEXT-REF-02/); assert.doesNotMatch(next, /SUPPLIED-REF-01/);
});

test('新呈现字段在草稿与发布都严格校验，历史缺省继续允许', () => {
  for (const publishing of [false, true]) {
    for (const props of [{}, { mobileOrder: 'image-first' }, { mobileOrder: 'identity-first', ctaColor: '#E9DF81' }, { ctaColor: '' }]) assert.doesNotThrow(() => validatePageData(data(props), '详情', publishing));
    for (const props of [{ mobileOrder: 'first' }, { mobileOrder: null }, { mobileOrder: ['identity-first'] }, { mobileOrder: { value: 'identity-first' } }, { ctaColor: 'red' }, { ctaColor: '#fff' }, { ctaColor: 'url(javascript:alert(1))' }, { ctaColor: null }]) assert.throws(() => validatePageData(data(props), '详情', publishing));
  }
});

test('新内部文字仍接收原生响应式字体和颜色，既有选择器继续有效', () => {
  const css = compileDesignCss('quality-detail', { mobile: { fontSize: 28, color: '#26362c' } }, 'ProductDetail');
  assert.match(css, />\.editor-site-detail-copy>h1/); assert.match(css, />\.editor-site-detail-copy>p/);
  // 身份和说明复用原copy语义类，已有响应式选择器即可覆盖，不增一套文字样式入口。
  const html = render({ mobileOrder: 'identity-first', design: { mobile: { fontSize: 28, color: '#26362c' } } });
  assert.match(html, /class="editor-site-detail-copy editor-site-detail-identity"/); assert.match(html, /class="editor-site-detail-copy editor-site-detail-body"/); assert.match(html, /font-size:28px!important/);
});

test('选型和概览详情的原生阅读顺序不同，且两种均保留真实资料及联系链接', () => {
  const source = fixture();
  source.products[0].specifications = [{ label: 'Span', value: '320 mm' }];
  for (const mobileOrder of ['specifications-first', 'overview-first']) {
    assert.doesNotThrow(() => validatePageData(data({ mobileOrder }), '详情', true));
  }
  const technical = render({ mobileOrder: 'specifications-first' }, source);
  const overview = render({ mobileOrder: 'overview-first' }, source);
  for (const html of [technical, overview]) {
    for (const value of ['SUPPLIED-REF-01', 'Supplied material', '320 mm', 'Original editable long detail.', 'Supplied original description']) {
      assert.equal(html.split(value).length - 1, 1, value);
    }
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, /href="\/preview\/quality\/contact"/);
    assert.ok(html.indexOf('Discuss this product') < html.indexOf('/images/chair.jpg'));
  }
  assert.ok(technical.indexOf('/images/chair.jpg') < technical.indexOf('320 mm'));
  assert.ok(technical.indexOf('320 mm') < technical.indexOf('Supplied original description'));
  assert.ok(overview.indexOf('Supplied original description') < overview.indexOf('/images/chair.jpg'));
  assert.ok(overview.indexOf('/images/chair.jpg') < overview.indexOf('320 mm'));
  source.products[0] = { ...source.products[0], image: '', material: '', specifications: [] };
  const withNoMediaOrSpecs = render({ mobileOrder: 'specifications-first' }, source);
  assert.doesNotMatch(withNoMediaOrSpecs, /editor-site-detail-specifications"/);
  assert.match(withNoMediaOrSpecs, /Supplied original description/);
});

test('真实固定/products/:slug和新旧联系页共存：详情按稳定目标ID，不猜路由目录', () => {
  const source = fixture(); source.pages.push({ id: 'new-contact', title: 'New Contact', slug: '/new-site/contact', status: 'draft', type: '联系我们', updated: '2026-11-16T00:00:00.000Z' }, { id: 'new-detail', title: 'New details', slug: '/products/:slug', status: 'draft', type: '产品详情', updated: '2026-11-16T00:00:00.000Z' });
  for (const page of source.pages) source.editorData[page.id] ||= { root: { props: {} }, content: [] };
  const detail = data({ mobileOrder: 'identity-first', linkTarget: { kind: 'page', id: 'new-contact' } }); source.editorData['new-detail'] = detail;
  assert.doesNotThrow(() => validateDraft(source)); assert.deepEqual(siteLinkErrors(source), []);
  const html = renderToStaticMarkup(<Render config={createSiteConfig({ ...source, pageId: 'new-detail', previewProductId: 'detail-product', previewPrefix: '/preview/quality' })} data={detail} />);
  assert.match(html, /href="\/preview\/quality\/new-site\/contact"/); assert.doesNotMatch(html, /href="\/preview\/quality\/contact"/);
  const removed = { ...source, pages: source.pages.filter(page => page.id !== 'new-contact') }; assert.ok(siteLinkErrors(removed).length);
  const disabled = renderToStaticMarkup(<Render config={createSiteConfig({ ...removed, pageId: 'new-detail', previewProductId: 'detail-product', previewPrefix: '/preview/quality' })} data={detail} />);
  assert.match(disabled, /disabled=""/); assert.doesNotMatch(disabled, /href="\/preview\/quality\/contact"/);
});

test('原生 AI 调序真正改变阅读顺序，两种隐式询盘去向及显式目标均保持', () => {
  const source=fixture();source.settings.email='orders@example.invalid';
  const detailPage={id:'product-detail',title:'Product details',slug:'/products/:slug',status:'draft' as const,type:'产品详情',updated:''};
  source.pages.push(detailPage);
  const options:AiPageEditRequest={pageId:detailPage.id,expectedRevision:0,instruction:'先展示规格，保持原有询盘路径',mode:'design',preserveText:true,lockedIds:[]};
  const compile=(order:string, override:Partial<AiPageEditRequest>={})=>compileAiPageEdit(source,{...options,...override},{summary:'调整产品详情顺序',operations:[{kind:'productDetailOrder',id:'quality-detail',order}],warnings:[]},'detail-order');

  source.editorData[detailPage.id]=data();
  const reordered=compile('specifications-first');
  const props=reordered.data.content[0].props;
  assert.equal(props.ctaFallback,'email');
  const technical=render(props,source);
  assert.ok(technical.indexOf('<h1')<technical.indexOf('<img'));
  assert.match(technical,/href="mailto:orders@example.invalid/);
  assert.equal(reordered.difference.layoutChanged,true);
  assert.doesNotMatch(reordered.warnings.join(),/0个一级标题/);
  assert.throws(()=>compile('overview-first',{viewport:'mobile'}),/全部设备/);
  assert.throws(()=>compile('overview-first',{lockedIds:['quality-detail']}),/锁定/);
  assert.throws(()=>compile('unsupported'),/有效顺序/);
  assert.throws(()=>validatePageData(data({ctaFallback:'unexpected'}),'详情',true),/询盘去向/);

  source.editorData[detailPage.id]=data({mobileOrder:'overview-first'});
  const galleryFirst=compile('image-first').data.content[0].props;
  assert.equal(galleryFirst.ctaFallback,'contact');
  assert.match(render(galleryFirst,source),/href="\/preview\/quality\/contact"/);
  source.editorData[detailPage.id]=data({linkTarget:{kind:'page',id:'contact'}});
  assert.deepEqual(compile('identity-first').data.content[0].props.linkTarget,{kind:'page',id:'contact'});
});
