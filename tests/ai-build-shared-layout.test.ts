import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render, type ComponentData, type Data } from '@puckeditor/core';
import { createAiBuildSharedLayout, legacyAiChromePageIds, prepareAiBuildChromeMigration } from '../src/lib/ai-build-shared-layout';
import type { AiSiteDirection } from '../src/lib/ai-builder-types';
import { createSiteConfig } from '../src/lib/site-render-config';
import type { PageItem, SiteLayout } from '../src/lib/types';
import { createEmptyDraft } from '../src/server/seed';
import type { DraftContent } from '../src/server/types';
import { collectReferences, validateDraft } from '../src/server/validation';

const oldRun = 'abcdefabcdef', newRun = '0123456789ab', date = '2026-11-18T00:00:00Z';
const direction: AiSiteDirection = { id: 'editorial', name: 'Editorial', layout: 'editorial', rationale: 'Sample', primary: '#294835', text: '#15211a', background: '#faf9f5', headingFont: 'serif' };
const page = (id: string, slug: string, title: string): PageItem => ({ id, slug, title, status: 'draft', type: '普通页面', updated: date });
const makeNode = (type: string, id: string, props: Record<string, unknown>): ComponentData => ({ type, props: { id, ...props } });
function body(label: string): Data {
  return { root: { props: { title: label } }, content: [makeNode('Heading', 'page-h1', { text: label, level: 'h1' })], zones: {} };
}
function render(draft: DraftContent, selected: PageItem) {
  const config = createSiteConfig({ ...draft, pageId: selected.id, currentPath: selected.slug });
  return renderToStaticMarkup(React.createElement(Render, { config, data: draft.editorData[selected.id] as Data }));
}
function oldSite() {
  const base = createEmptyDraft();
  base.settings.name = 'Example Company';
  const contact = page(`ai-${oldRun}-contact`, '/contact', 'Contact');
  const home = page('home', '/', 'Example Home');
  const showcase = page('new-case', '/showcase', 'Case Page');
  const branch = page('ai-bbbbbbbbbbbb-home', '/other', 'Independent page');
  // 模拟不同页面中内容等价、组件ID各异的旧生成副本，正文则各自保持。
  const copy = (item: PageItem, offset: number, origin = oldRun) => {
    let index = offset;
    const old = (type: string, props: Record<string, unknown>) => makeNode(type, `ai-${origin}-${++index}`, props);
    const link = (target: PageItem) => old('ActionButton', { text: target.title, href: target.slug, linkTarget: { kind: 'page', id: target.id }, kind: 'outline', align: 'left', design: { desktop: { fontSize: 13, color: '#15211a' }, mobile: { height: 36 } } });
    const menu = old('Container', { content: [link(home), link(contact)], columns: 2, layout: 'grid' });
    const heading = old('Container', { content: [old('Text', { text: 'Example Company', size: 20 }), menu], nodeLabel: 'AI生成品牌与页面导航' });
    const footer = old('Container', { content: [old('Text', { text: 'Example copyright' }), old('ActionButton', { text: 'Contact', href: '/contact', linkTarget: { kind: 'page', id: contact.id }, kind: 'theme', align: 'left' })], nodeLabel: 'AI生成页面页脚' });
    const props = { title: item.title, brand: 'Example Company', showChrome: 'no' };
    return { root: { props }, content: [heading, ...body(item.title).content, footer], zones: {} };
  };
  base.pages = [home, contact, showcase, branch];
  base.editorData = {
    [home.id]: copy(home, 0), [contact.id]: copy(contact, 10), [showcase.id]: body(showcase.title),
    [branch.id]: copy(branch, 100, 'bbbbbbbbbbbb'),
  };
  base.pageTemplates = [{
    id: `ai-template-${oldRun}-detail`, name: 'Generated detail', description: '', kind: 'product', sourcePath: '/products/:slug',
    data: copy(page('ignored', '/products/:slug', 'Detail body'), 30), updated: date,
  }];
  return { base, home, contact, showcase, branch };
}

test('首次根站使用全站原生头尾，新增页和实际菜单共用同一资产', () => {
  const base = createEmptyDraft();
  base.settings.name = 'Example Company';
  const home = base.pages[0], contact = page('contact', '/contact', 'Contact'), detail = page('detail', '/products/:slug', 'Product');
  const setup = createAiBuildSharedLayout({ current: base, pages: [home, contact, detail], direction, run: newRun, date, contactPageId: contact.id, firstRootBuild: true });
  assert.equal(setup.global, true);
  assert.equal(setup.blocks.length, 2);
  assert.deepEqual(setup.siteLayout.menus?.[0].items.map(item => item.target?.id), [home.id, contact.id]);
  assert.equal(setup.pageChrome().header, undefined);
  assert.equal(setup.siteLayout.header.blockId, setup.blocks[0].id);
  const late = page('new-case', '/showcase', 'New Case');
  const draft: DraftContent = { ...base, pages: [home, contact, detail, late], siteLayout: setup.siteLayout, sharedBlocks: setup.blocks,
    editorData: Object.fromEntries([home, contact, detail, late].map(item => [item.id, body(item.title)])),
  };
  collectReferences(validateDraft(draft));
  assert.match(render(draft, late), /<header class="site-header editor-site-shared-header">/);
  const menu = draft.siteLayout?.menus?.[0];
  assert.ok(menu);
  menu.items[1].label = 'Talk to the team';
  for (const current of [home, contact, late]) {
    const html = render(draft, current);
    assert.equal((html.match(/<header /g) || []).length, 1);
    assert.equal((html.match(/<footer /g) || []).length, 1);
    assert.match(html, /href="\/contact">Talk to the team/);
  }
});

test('已有全站设置和备用前缀保留，新增页面仅引用自己共享的头尾菜单', () => {
  const base = createEmptyDraft();
  const alternate = page('alt-home', '/alternate', 'Alternate Home'), contact = page('alt-contact', '/alternate/contact', 'Talk to us');
  const configured: SiteLayout = { header: { mode: 'hidden', blockId: '' }, footer: { mode: 'default', blockId: '' },
    menus: [{ id: 'previous', name: 'Previous menu', items: [] }],
  };
  for (const firstRootBuild of [false, true]) {
    base.siteLayout = firstRootBuild ? configured : undefined;
    const setup = createAiBuildSharedLayout({ current: base, pages: [alternate, contact], direction, run: newRun, date, contactPageId: contact.id, firstRootBuild });
    assert.equal(setup.global, false);
    assert.equal(setup.pageChrome().rootProps.showChrome, 'no');
    assert.equal(setup.pageChrome().header?.type, 'SharedBlock');
    assert.equal(setup.pageChrome().footer?.props.blockId, setup.blocks[1].id);
    assert.deepEqual(setup.siteLayout.header, base.siteLayout?.header || { mode: 'default', blockId: '' });
    assert.deepEqual(setup.siteLayout.footer, base.siteLayout?.footer || { mode: 'default', blockId: '' });
    assert.deepEqual(setup.siteLayout.menus?.slice(0, -1), base.siteLayout?.menus || []);
  }
});

test('迁移旧根站冻结一个真正全站的头尾范围，保留正文和另一组独立页面', () => {
  const { base, home, contact, showcase, branch } = oldSite();
  assert.deepEqual(legacyAiChromePageIds(base), [home.id, contact.id, branch.id]);
  const before = structuredClone(base);
  const result = prepareAiBuildChromeMigration(base, { pageId: home.id, mode: 'global' }, newRun, date);
  assert.deepEqual(base, before);
  assert.deepEqual(result.pageIds, [home.id, contact.id, showcase.id]);
  const candidate: DraftContent = { ...base, ...result.patch };
  collectReferences(validateDraft(candidate));
  assert.deepEqual((candidate.editorData[home.id] as Data).content, body(home.title).content);
  assert.deepEqual((candidate.editorData[contact.id] as Data).content, body(contact.title).content);
  assert.deepEqual(candidate.editorData[branch.id], base.editorData[branch.id]);
  assert.deepEqual(candidate.pageTemplates?.[0].data.content, body('Detail body').content);
  assert.equal(candidate.siteLayout?.menus?.[0].items[1].target?.id, contact.id);
  for (const item of [home, contact, showcase]) {
    const html = render(candidate, item);
    assert.equal((html.match(/<header /g) || []).length, 1);
    assert.equal((html.match(/<footer /g) || []).length, 1);
    assert.match(html, /editor-site-shared-header/);
    assert.match(html, /Example copyright/);
  }
});

test('旧备用目录只统一同组；跟随现有全站时原菜单和区块不被改写', () => {
  const { base, home, branch } = oldSite();
  base.siteLayout = { header: { mode: 'default', blockId: '', menuId: 'real' }, footer: { mode: 'default', blockId: '' }, menus: [{ id: 'real', name: 'Existing', items: [] }] };
  const isolated = prepareAiBuildChromeMigration(base, { pageId: branch.id, mode: 'shared' }, newRun, date);
  assert.deepEqual(isolated.pageIds, [branch.id]);
  assert.deepEqual(isolated.patch.siteLayout?.header, base.siteLayout.header);
  assert.equal((isolated.patch.editorData?.[branch.id] as Data).content[0].type, 'SharedBlock');
  assert.deepEqual(isolated.patch.editorData?.[home.id], base.editorData[home.id]);
  const follow = prepareAiBuildChromeMigration(base, { pageId: home.id, mode: 'inherit' }, newRun, date);
  assert.equal(follow.patch.siteLayout, undefined);
  assert.equal(follow.patch.sharedBlocks, undefined);
  assert.deepEqual((follow.patch.editorData?.[home.id] as Data).content, body(home.title).content);
  assert.throws(() => prepareAiBuildChromeMigration(base, { pageId: branch.id, mode: 'global' }, newRun, date), /根首页/);
});

test('不同的手工副本、锁定内容和非生成页面都不会被迁移', () => {
  const { base, home, contact, showcase } = oldSite();
  const altered = structuredClone(base);
  ((altered.editorData[contact.id] as Data).content[0].props.content as ComponentData[])[0].props.text = 'Intentionally separate';
  assert.throws(() => prepareAiBuildChromeMigration(altered, { pageId: home.id, mode: 'shared' }, newRun, date), /已有独立/);
  assert.throws(() => prepareAiBuildChromeMigration(base, { pageId: showcase.id, mode: 'inherit' }, newRun, date), /没有可识别/);
  (base.editorData[showcase.id] as Data).content[0].props.locked = true;
  assert.throws(() => prepareAiBuildChromeMigration(base, { pageId: home.id, mode: 'global' }, newRun, date), /锁定区块/);
  assert.doesNotThrow(() => prepareAiBuildChromeMigration(base, { pageId: home.id, mode: 'shared' }, newRun, date));
});

test('现有多语言站仍保留原全站规则和旧分组菜单的可达性', () => {
  const { base, home } = oldSite();
  base.settings.locales = [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }];
  assert.throws(() => prepareAiBuildChromeMigration(base, { pageId: home.id, mode: 'global' }, newRun, date), /单语言根首页/);
  const alternate = prepareAiBuildChromeMigration(base, { pageId: home.id, mode: 'shared' }, newRun, date);
  const header = alternate.patch.sharedBlocks?.[0];
  const menu = header?.data.content[0].props.content[1].props.content[0];
  assert.equal(menu?.props.localeMenuIds.de, alternate.patch.siteLayout?.menus?.[0].id);
  assert.equal(alternate.patch.siteLayout?.header.mode, 'default');
  collectReferences(validateDraft({ ...base, ...alternate.patch }));
});
