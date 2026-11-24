import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { initialState } from '../src/lib/demo';
import { createPageData } from '../src/lib/page-data';
import { createSiteConfig } from '../src/lib/site-render-config';
import { compileDesignCss, designClassName, getLegacyDesign, resolveDesign, validateDesign } from '../src/lib/responsive-style';

test('three breakpoint styles inherit per property without modifying their input', () => {
  const design = { desktop: { fontSize: 52, color: '#123456', paddingTop: 40 }, tablet: { fontSize: 36 }, mobile: { paddingTop: 12 } };
  const before = JSON.stringify(design);
  assert.deepEqual(resolveDesign(design, 'desktop'), design.desktop);
  assert.deepEqual(resolveDesign(design, 'tablet'), { ...design.desktop, fontSize: 36 });
  assert.deepEqual(resolveDesign(design, 'mobile'), { fontSize: 36, color: '#123456', paddingTop: 12 });
  assert.equal(JSON.stringify(design), before);
  assert.equal(resolveDesign({ desktop: { fontSize: 24 } }, 'mobile', { fontSize: 14 }).fontSize, 24);
  assert.equal(resolveDesign({ desktop: { fontSize: 24 }, mobile: {} }, 'mobile').fontSize, 24);
});

test('style validation limits values, units, breakpoints and image paths', () => {
  assert.deepEqual(validateDesign(undefined), []);
  assert.deepEqual(validateDesign({ desktop: { width: '75%', maxWidth: 'none', height: 'auto', color: '#1234', marginTop: -24, backgroundImage: '/api/media/photo_1' }, mobile: { backgroundImage: '', display: 'none' } }), []);
  assert.deepEqual(validateDesign({ desktop: { maxWidth: 960, marginLeft: 'auto', marginRight: 'auto' } }), []);
  for (const value of [null, [], { watch: {} }, { mobile: [] }, { desktop: { fontSize: 201 } }, { desktop: { columns: 1.5 } }, { desktop: { width: '101%' } }, { desktop: { width: 'calc(100% - 20px)' } }, { desktop: { position: 'fixed' } }, { desktop: { shadow: '0 0 5px red' } }, { desktop: { backgroundImage: 'https://example.com/x.png' } }, { desktop: { backgroundImage: '/images/x.svg' } }, { desktop: { color: '</style><script>alert(1)</script>' } }]) assert.ok(validateDesign(value).length, JSON.stringify(value));
});

test('legacy defaults preserve mobile content sizes and allow explicit replacement', () => {
  assert.equal(getLegacyDesign('Heading', { size: 72, mobileSize: 38 }, 'mobile').fontSize, 38);
  assert.equal(getLegacyDesign('Text', { size: 18 }, 'mobile').fontSize, 14);
  assert.equal(getLegacyDesign('Container', { layout: 'grid', columns: 3, mobileColumns: 2, inset: 70 }, 'mobile').paddingLeft, 24);
  assert.equal(getLegacyDesign('ProductDetail', { imageHeight: 550 }, 'mobile').imageHeight, 360);
  assert.equal(resolveDesign({ desktop: { fontSize: 19 } }, 'mobile', getLegacyDesign('Text', { size: 18 }, 'mobile')).fontSize, 19);
});

test('compiler uses named container queries and maps container layout to its actual slot', () => {
  const name = designClassName('layout_1');
  const css = compileDesignCss('layout_1', { desktop: { display: 'grid', columns: 3, paddingLeft: 32 }, tablet: { columns: 2 }, mobile: { columns: 1, paddingLeft: 16 } }, 'Container');
  assert.match(css, new RegExp(`\\.${name}>\\.editor-site-slot\\{display:grid!important;grid-template-columns:repeat\\(3,`));
  assert.match(css, /@container form-site \(max-width:1024px\)/);
  assert.match(css, /@container form-site \(max-width:700px\)/);
  assert.match(css, /padding-left:16px!important/);
  assert.equal(compileDesignCss('x', undefined), '');
});

test('hidden wrappers can be shown again at a narrower breakpoint', () => {
  const css = compileDesignCss('hidden', { desktop: { display: 'none' }, mobile: { display: 'flex', flexDirection: 'column' } }, 'Container');
  assert.match(css, /display:none!important/);
  assert.match(css, />\.editor-site-slot\{display:flex!important;flex-direction:column!important/);
  assert.match(css, new RegExp(`\\.${designClassName('hidden')}\\{display:flex!important;`));
});

test('image maximum height and border style keep explicit same and parent breakpoint values', () => {
  const bounded = compileDesignCss('image', { desktop: { maxHeight: 200, height: 300, borderStyle: 'dashed' }, mobile: { height: 400, borderWidth: 2 } }, 'Image');
  assert.match(bounded, /max-height:200px!important/);
  assert.doesNotMatch(bounded, /max-height:none/);
  assert.doesNotMatch(bounded, /border-style:solid/);
  assert.match(compileDesignCss('image', { mobile: { height: 500 } }, 'Image'), /max-height:none!important/);
});

test('button surface and product image styles target the visible children', () => {
  const button = compileDesignCss('cta', { mobile: { backgroundColor: '#123456', fontSize: 18, paddingTop: 14, columnSpan: 2 } }, 'ActionButton');
  assert.match(button, />\.editor-site-action\.ant-btn\{/);
  assert.match(button, /background-color:#123456!important/);
  assert.match(button, /grid-column:span 2!important/);
  const detail = compileDesignCss('detail', { mobile: { imageHeight: 240, objectFit: 'contain', fontSize: 24 } }, 'ProductDetail');
  assert.match(detail, />img,.*?editor-product-gallery-track img\{height:240px!important;max-height:none!important;object-fit:contain!important/);
  assert.match(detail, />\.editor-site-detail-copy>h1/);
});

test('CSS compiler discards unsafe historical styles and cannot terminate a style element', () => {
  const css = compileDesignCss('</style><script>x</script>', { desktop: { color: '</style><script>x</script>', backgroundImage: 'url(javascript:alert(1))', position: 'fixed', fontSize: 20 } });
  assert.doesNotMatch(css, /[<>]|javascript|position/);
  assert.match(css, /font-size:20px!important/);
  assert.notEqual(designClassName('a-b'), designClassName('ab'));
  const pageCss = compileDesignCss('root', { desktop: { color: '#123456' } }, 'Root');
  assert.match(pageCss, /^\.editor-site>\.editor-site-page\{/);
  assert.doesNotMatch(pageCss, new RegExp(designClassName('root')));
});

test('SSR emits responsive design styles with nested slots and actual grid children', () => {
  const data = createPageData('blank');
  Object.assign(data.root.props!, { design: { desktop: { backgroundColor: '#f1f5fa' }, mobile: { paddingLeft: 10 } } });
  data.content.push({ type: 'Container', props: { id: 'responsive-layout', layout: 'grid', columns: 2, mobileColumns: 1, gap: 20, padding: 40, inset: 32, background: '#fff', minHeight: 120, align: 'start', design: { desktop: { columns: 3 }, mobile: { columns: 1 } }, content: [{ type: 'Heading', props: { id: 'responsive-title', text: 'Responsive title', size: 48, mobileSize: 32, color: '#123456', align: 'left', style: 'sans', spacing: 0, design: { desktop: { columnSpan: 2 }, mobile: { columnSpan: 1, fontSize: 28 } } } }] } });
  const config = createSiteConfig({ ...initialState, editorData: {} });
  assert.equal(Object.values(config.components).every((component) => component.inline === true), true);
  const html = renderToStaticMarkup(React.createElement(Render, { config, data }));
  assert.match(html, /Responsive title/);
  assert.match(html, /data-design-css="responsive-layout"/);
  assert.match(html, /grid-column:span 2!important/);
  assert.match(html, /font-size:28px!important/);
  assert.match(html, /background-color:#f1f5fa!important/);
  assert.doesNotMatch(html, /data-puck-component|editor-topbar|puck-color/);
});
