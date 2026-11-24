import test from 'node:test';
import assert from 'node:assert/strict';
import { Script as NodeScript } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import type { Data } from '@puckeditor/core';
import { initialState } from '../src/lib/demo';
import { createPageData } from '../src/lib/page-data';
import { createSiteConfig } from '../src/lib/site-render-config';
import { createSharedBlockNodeCounter, getSharedBlockReferences, getSharedBlockUsage, namespaceBlockData, SHARED_BLOCK_MAX_NODES } from '../src/lib/shared-blocks';
import { createSandboxDocument, enabledSiteCode, safePreviewNavigation, siteCodeAssetUrl } from '../src/lib/site-code-render';
import { SandboxedSitePreview } from '../src/components/SandboxedSitePreview';
import type { SharedBlock, SiteCustomCode } from '../src/lib/types';

const reference = (id: string, blockId: string) => ({ type: 'SharedBlock', props: { id, blockId } });
const rootProps = (data: Data) => data.root.props as Record<string, unknown>;
function block(id: string, text = 'Reusable content'): SharedBlock {
  const data = createPageData('blank');
  Object.assign(rootProps(data), { showChrome: 'yes', design: { desktop: { backgroundColor: '#ffffff' } } });
  data.content = [{ type: 'Text', props: { id: 'same-text-id', text, size: 16, color: '#112233', design: { mobile: { fontSize: 19 } } } }];
  return { id, name: id, updated: '', data };
}
function html(data: Data, extra = {}) {
  return renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...initialState, pageId: 'home', ...extra }), data }));
}

test('shared references render synchronized content with isolated IDs/CSS and one site root', () => {
  const shared = block('offer');
  const data = createPageData('blank');
  data.content = [reference('first', 'offer'), reference('second', 'offer')];
  const rendered = html(data, { sharedBlocks: [shared] });
  assert.equal((rendered.match(/Reusable content/g) || []).length, 2);
  assert.equal((rendered.match(/class="editor-site"/g) || []).length, 1);
  assert.match(rendered, /data-page-id="home"/);
  assert.equal((rendered.match(/data-shared-block-id="offer"/g) || []).length, 2);
  assert.match(rendered, /data-design-css="shared-first--1"/);
  assert.match(rendered, /data-design-css="shared-second--1"/);
  assert.doesNotMatch(rendered, /\.editor-site&gt;\.editor-site-page|\.editor-site>\.editor-site-page|editor-site-nav/);
  shared.data.content[0].props.text = 'Updated everywhere';
  assert.equal((html(data, { sharedBlocks: [shared] }).match(/Updated everywhere/g) || []).length, 2);
});

test('layout uses the same blocks, preserves default chrome and respects per-page hiding', () => {
  const header = block('header', 'Unified header');
  const footer = block('footer', 'Unified footer');
  const data = createPageData('blank');
  Object.assign(rootProps(data), { showChrome: 'yes', headerMode: 'inherit', footerMode: 'inherit' });
  const extra = { sharedBlocks: [header, footer], siteLayout: { header: { mode: 'block', blockId: 'header' }, footer: { mode: 'block', blockId: 'footer' } } };
  const rendered = html(data, extra);
  assert.match(rendered, /class="site-header editor-site-shared-header"/);
  assert.match(rendered, /Unified header/);
  assert.match(rendered, /Unified footer/);
  assert.equal((rendered.match(/<header/g) || []).length, 1);
  assert.equal((rendered.match(/<footer/g) || []).length, 1);
  rootProps(data).headerMode = 'hidden';
  assert.doesNotMatch(html(data, extra), /Unified header/);
  assert.match(html(data, extra), /Unified footer/);
  rootProps(data).showChrome = 'no';
  assert.doesNotMatch(html(data, extra), /Unified header|Unified footer/);
  Object.assign(rootProps(data), { showChrome: 'yes', headerMode: 'inherit' });
  assert.match(html(data), /class="site-header editor-site-nav"/);
  assert.match(html(data), /class="site-footer editor-site-footer"/);
  assert.doesNotMatch(html(data, { ...extra, editorCanvas: true, editingBlockId: 'header' }), /Unified header|Unified footer/);
});

test('historical cycles and missing blocks fail locally without recursion or extra editable slots', () => {
  const a = block('a'); const b = block('b');
  a.data.content.push(reference('a-to-b', 'b'));
  b.data.content.push(reference('b-to-a', 'a'));
  const data = createPageData('blank'); data.content = [reference('instance', 'a'), reference('missing', 'missing')];
  const rendered = html(data, { sharedBlocks: [a, b], editorCanvas: true });
  assert.match(rendered, /同步区块不可用/);
  assert.doesNotMatch(rendered, /Reusable content/);
  const config = createSiteConfig(initialState);
  assert.equal(config.components.SharedBlock.fields, undefined);
  const chain = Array.from({ length: 10 }, (_, index) => block(`depth-${index}`, `Depth ${index}`));
  chain.forEach((item, index) => { if (index < 9) item.data.content.push(reference(`to-${index + 1}`, `depth-${index + 1}`)); });
  data.content = [reference('chain', 'depth-0')];
  assert.doesNotMatch(html(data, { sharedBlocks: chain }), /Depth 8|Depth 9/);
});

test('repeated shared references are bounded before allocating their expanded render tree', () => {
  const leaf = block('leaf'); const many = block('many'); const huge = block('huge');
  many.data.content = Array.from({ length: 100 }, (_, index) => reference(`leaf-${index}`, 'leaf'));
  huge.data.content = Array.from({ length: 100 }, (_, index) => reference(`many-${index}`, 'many'));
  const blocks = [leaf, many, huge];
  assert.ok(createSharedBlockNodeCounter(blocks)(huge.data) > SHARED_BLOCK_MAX_NODES);
  const data = createPageData('blank'); data.content = [reference('large', 'huge')];
  assert.doesNotMatch(html(data, { sharedBlocks: blocks }), /Reusable content/);
});

test('reference analysis includes nested blocks and layout inheritance without inventing text dependencies', () => {
  const leaf = block('leaf'); const outer = block('outer');
  outer.data.content.push(reference('nested', 'leaf'));
  const data = createPageData('blank'); data.content = [reference('one', 'outer'), reference('two', 'outer')];
  assert.deepEqual(getSharedBlockReferences(data), ['outer']);
  const inherited = createPageData('blank'); rootProps(inherited).showChrome = 'yes';
  const hidden = createPageData('blank');
  const pages = ['direct', 'inherited', 'hidden'].map((id) => ({ ...initialState.pages[0], id }));
  const usage = getSharedBlockUsage('leaf', { pages, editorData: { direct: data, inherited, hidden }, sharedBlocks: [leaf, outer], siteLayout: { header: { mode: 'block', blockId: 'outer' }, footer: { mode: 'default', blockId: '' } } });
  assert.deepEqual(usage, { pageIds: ['direct', 'inherited'], blockIds: ['outer'], layoutSlots: ['header'] });
});

test('repeated copying rebuilds nested IDs without mutation or increasing ID length', () => {
  const original = createPageData('home'); const before = JSON.stringify(original);
  let copy = original;
  for (let index = 0; index < 10; index++) copy = namespaceBlockData(copy, `block-12345678-1234-1234-1234-${index}`);
  assert.equal(JSON.stringify(original), before);
  const ids: string[] = [];
  JSON.stringify(copy, (key, value) => { if (key === 'id') ids.push(value); return value; });
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.every((id) => id.length <= 100), true);
  assert.equal(ids.some((id) => id.includes('home-')), false);
});

test('draft code remains outside parent SSR markup and is safely encoded for sandbox execution', () => {
  const malicious = '</script><img src=x onerror="window.parent.attacked=true"><script>';
  const parent = renderToStaticMarkup(React.createElement(SandboxedSitePreview, { css: [`body{content:"${malicious}"}`], scripts: [`window.attack=${JSON.stringify(malicious)}`], language: 'en', children: React.createElement('main', null, 'Safe body') }));
  assert.match(parent, /Safe body/);
  assert.doesNotMatch(parent, /window.attack|onerror|<script/);
  const document = createSandboxDocument({ markup: '<main>Safe body</main>', styles: [], css: [malicious], scripts: [malicious], language: 'en', baseUrl: 'https://example.com/preview' });
  assert.equal((document.match(/<script>/g) || []).length, 1);
  assert.equal((document.match(/<\/script>/g) || []).length, 1);
  assert.doesNotMatch(document, /<img/);
  const source = document.slice(document.indexOf('<script>') + 8, document.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new NodeScript(source));
});

test('sandbox parent accepts preview-only routes and code URLs bind immutable snapshot targets', () => {
  const origin = 'https://example.com';
  for (const href of ['/admin', '//evil.test/preview', '/preview/../admin', '/preview/%2e%2e/admin', '/preview/%2f..%2fadmin', '/preview\\..\\admin', '/preview-other', 'javascript:alert(1)', 'https://example.com/preview']) assert.equal(safePreviewNavigation(href, origin), null, href);
  assert.equal(safePreviewNavigation('/preview/about?x=1#team', origin), '/preview/about?x=1#team');
  const snippet = { css: 'body{color:red}', js: 'window.ready=true', cssEnabled: true, jsEnabled: true };
  const customCode: SiteCustomCode = { global: snippet, pages: { home: snippet, other: snippet } };
  assert.deepEqual(enabledSiteCode(customCode, 'home').map((entry) => entry.target), ['global', 'home']);
  assert.equal(siteCodeAssetUrl('release-1', 'home', 'js'), '/api/site-code/release-1/home/js');
});
