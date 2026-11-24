import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { moveMenuItem, navigationErrors } from '../src/lib/site-navigation';
import { createInitialDraft } from '../src/server/seed';
import { validateDraft } from '../src/server/validation';
import { createSiteConfig } from '../src/lib/site-render-config';
import type { MenuItem } from '../src/lib/types';

test('菜单拖拽保留ID、支持三级并阻止自循环/超深移动', () => {
  const items: MenuItem[] = [{ id: 'a', label: 'A', href: '/', children: [{ id: 'b', label: 'B', href: '/', children: [{ id: 'c', label: 'C', href: '/' }] }] }, { id: 'd', label: 'D', href: '/' }];
  assert.equal(moveMenuItem(items, 'd', 'a', 'before')[0].id, 'd');
  assert.equal(moveMenuItem(items, 'c', 'd', 'inside')[1].children?.[0].id, 'c');
  assert.throws(() => moveMenuItem(items, 'a', 'c', 'inside'), /后代/);
  assert.throws(() => moveMenuItem(items, 'd', 'c', 'inside'), /三级/);
  assert.equal(items[0].children?.[0].children?.[0].id, 'c');
});

test('菜单校验拒绝危险链接、重复ID、失效目标与导航组件缺菜单', () => {
  const source = createInitialDraft();
  source.siteLayout = { header: { mode: 'default', blockId: '', menuId: 'main' }, footer: { mode: 'default', blockId: '' }, menus: [{ id: 'main', name: 'Main', items: [{ id: 'a', label: 'Home', target: { kind: 'page', id: 'home' } }] }] };
  assert.deepEqual(navigationErrors(source, true), []);
  source.siteLayout.menus![0].items.push({ id: 'a', label: 'Unsafe', href: 'javascript:alert(1)' });
  assert.ok(navigationErrors(source, true).length);
  source.siteLayout.menus![0].items = [{ id: 'safe', label: 'Broken', target: { kind: 'page', id: 'not-exists' } }];
  assert.match(navigationErrors(source, true).join(), /目标不可用/);
  assert.throws(() => validateDraft(source), /菜单/);
  source.siteLayout.menus = [];
  assert.match(navigationErrors(source).join(), /页眉/);
});

test('导航SSR包含内部目标与预览前缀，面包屑与锚点可重复渲染', () => {
  const source = createInitialDraft();
  source.siteLayout = { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: [{ id: 'main', name: 'Main', items: [{ id: 'a', label: 'Home', target: { kind: 'page', id: 'home' } }, { id: 'b', label: 'Email', href: 'mailto:test@example.com' }] }] };
  const data = { root: { props: { showChrome: 'no' } }, content: [{ type: 'Navigation', props: { id: 'nav', menuId: 'main', label: 'Main navigation', anchor: 'navigation' } }, { type: 'Breadcrumb', props: { id: 'crumb', homeLabel: 'Home' } }] };
  const html = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...source, pageId: 'home', previewPrefix: '/preview' }), data }));
  assert.match(html, /href="\/preview"/); assert.match(html, /mailto:test@example.com/); assert.match(html, /id="navigation"/); assert.match(html, /Breadcrumb/);
});

test('显式锚点别名只接受合法唯一名称，不允许数字/重复', () => {
  const draft = createInitialDraft();
  const component = (id: string, anchor: unknown) => ({ type: 'Text', props: { id, anchor, text: 'Test' } });
  draft.editorData.home = { root: { props: {} }, content: [component('a', 'details'), component('b', 'details')] };
  assert.throws(() => validateDraft(draft), /锚点/);
  draft.editorData.home = { root: { props: {} }, content: [component('a', 0)] };
  assert.throws(() => validateDraft(draft), /锚点/);
});
