import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTER_KITS, createStarterSnapshot } from '../src/lib/starter-kits';
import { actualSiteRoutes } from '../src/lib/site-redirects';
import { resolveSitePage } from '../src/lib/site-routing';
import { menuItemHref, navigationErrors } from '../src/lib/site-navigation';
import { contentBindingErrors, recordsForSource, resolveBindingValue } from '../src/lib/content-binding';
import { collectReferences, validateDraft, validatePageData } from '../src/server/validation';
import { componentCompatibilityErrors, KNOWN_COMPONENT_TYPES } from '../src/lib/component-contract';
import { isLocalImagePath } from '../src/lib/bundled-media';
import type { FieldBinding, MenuItem } from '../src/lib/types';

type Node = { type: string; props: Record<string, any> };
function nodesIn(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodesIn);
  if (!value || typeof value !== 'object') return [];
  const item = value as Node;
  return [...(typeof item.type === 'string' && item.props ? [item] : []), ...Object.values(value).flatMap(nodesIn)];
}

for (const kit of STARTER_KITS) {
  test(`${kit.id}：完整页面与全部详情可访问，菜单和业务按钮没有悬空内部地址`, () => {
    const snapshot = createStarterSnapshot(kit.id), routes = actualSiteRoutes(snapshot);
    assert.equal(snapshot.pages.length, kit.pageCount);
    assert.equal(new Set(routes.map(route => route.path)).size, routes.length);
    for (const route of routes) assert.ok(resolveSitePage(snapshot, route.path.split('/').filter(Boolean)), `${kit.id}: ${route.path}`);
    for (const page of snapshot.pages.filter(page => page.slug.includes(':'))) assert.ok(routes.some(route => resolveSitePage(snapshot, route.path.split('/').filter(Boolean))?.page.id === page.id), `详情模板未被任何示例使用：${page.slug}`);
    const checkHref = (href: string | undefined, label: string) => {
      assert.ok(href, label);
      if (href.startsWith('/') && !href.startsWith('/api/media/')) assert.ok(resolveSitePage(snapshot, new URL(href, 'https://example.invalid').pathname.split('/').filter(Boolean)), `${label}: ${href}`);
    };
    const checkMenu = (items: MenuItem[]) => items.forEach(item => { if (item.target || item.href) checkHref(menuItemHref(snapshot, item), item.label); if (item.children) checkMenu(item.children); });
    snapshot.siteLayout!.menus!.forEach(menu => checkMenu(menu.items));
    const data = [...snapshot.pages.map(page => snapshot.editorData[page.id]), ...snapshot.sharedBlocks!.map(block => block.data)];
    for (const node of nodesIn(data)) if (node.type === 'ActionButton' && node.props.href && !node.props.bindings?.href) checkHref(node.props.href, node.props.text);
    assert.deepEqual(navigationErrors(snapshot, true), []);
  });

  test(`${kit.id}：所有页面与面板保持原生可编辑组件、图片依赖完整且提供手机断点`, () => {
    const snapshot = createStarterSnapshot(kit.id);
    assert.doesNotThrow(() => validateDraft({ ...snapshot, settings: { ...snapshot.settings, domain: '', timezone: 'UTC' } }));
    const media = new Set(snapshot.media.map(image => image.url));
    for (const url of collectReferences(snapshot).urls) { assert.ok(media.has(url), `缺少媒体清单项：${url}`); assert.ok(isLocalImagePath(url), url); }
    assert.ok(snapshot.media.length > 0);
    const data = [...snapshot.pages.map(page => ({ name: page.title, data: snapshot.editorData[page.id] })), ...snapshot.sharedBlocks!.map(block => ({ name: block.name, data: block.data }))];
    for (const item of data) {
      assert.deepEqual(componentCompatibilityErrors(item.data), []);
      assert.doesNotThrow(() => validatePageData(item.data, item.name, true));
      const nodes = nodesIn(item.data); assert.ok(nodes.length, item.name);
      assert.ok(nodes.some(node => node.props.design?.mobile && Object.keys(node.props.design.mobile).length), `没有手机断点：${item.name}`);
      for (const node of nodes) {
        assert.ok(KNOWN_COMPONENT_TYPES.includes(node.type), node.type);
        assert.ok(node.props.id, `${item.name}: ${node.type}`);
        if (node.type === 'Container' && Number(node.props.columns) > 2) assert.ok(Number(node.props.design?.mobile?.columns ?? node.props.mobileColumns ?? node.props.columns) <= 2, `${item.name}: 手机仍为多列桌面布局`);
        if (['Accordion','Tabs','Carousel'].includes(node.type)) assert.equal(node.props.panelMode, 'free', `面板不能仅保存不可拖拽的固定文案：${node.props.id}`);
      }
    }
    for (const snippet of [snapshot.customCode?.global, ...Object.values(snapshot.customCode?.pages || {}), ...snapshot.pageTemplates?.map(template => template.code) || []]) if (snippet) assert.equal(snippet.jsEnabled, false);
    assert.deepEqual(contentBindingErrors(snapshot, true), []);
  });

  test(`${kit.id}：循环卡片以当前记录绑定真实标题、图片和详情，切换记录能产生各自内容`, () => {
    const snapshot = createStarterSnapshot(kit.id), loops = nodesIn(Object.values(snapshot.editorData)).filter(node => node.type === 'ContentLoop');
    assert.ok(loops.length);
    for (const loop of loops) {
      const source: 'product' | 'entry' = loop.props.source === 'product' ? 'product' : 'entry', modelId = loop.props.modelId;
      const block = snapshot.sharedBlocks!.find(item => item.id === loop.props.itemBlockId)!; assert.ok(block, loop.props.itemBlockId);
      const nodes = nodesIn(block.data), title = nodes.find(node => node.props.bindings?.text?.field === (source === 'product' ? 'builtin:name' : 'builtin:title'))?.props.bindings.text as FieldBinding;
      const image = nodes.find(node => node.type === 'Image' && node.props.bindings?.src)?.props.bindings.src as FieldBinding;
      const link = nodes.find(node => node.type === 'ActionButton' && node.props.bindings?.href?.field === 'builtin:url')?.props.bindings.href as FieldBinding;
      assert.ok(title && image && link, `卡片缺少标题/封面/详情绑定：${block.name}`);
      for (const binding of [title, image, link]) { assert.equal(binding.source, source); assert.equal(binding.mode, 'current'); assert.equal(binding.modelId, modelId); }
      const records = recordsForSource(snapshot, source, modelId); assert.ok(records.length >= 2);
      const renderedTitles = new Set<string>(), renderedLinks = new Set<string>();
      for (const record of records) {
        const context = { productId: source === 'product' ? record.id : undefined, bindingContext: { source, recordId: record.id, modelId } };
        const value = resolveBindingValue(title, 'text', snapshot, context), href = resolveBindingValue(link, 'href', snapshot, context);
        assert.equal(value, 'name' in record ? record.name : record.title); assert.ok(isLocalImagePath(resolveBindingValue(image, 'src', snapshot, context)));
        assert.ok(resolveSitePage(snapshot, href.split('/').filter(Boolean)), href); renderedTitles.add(value); renderedLinks.add(href);
      }
      assert.equal(renderedTitles.size, records.length); assert.equal(renderedLinks.size, records.length);
    }
  });
}

test('oem-solutions：完整覆盖型号对比表、前后对比、交付时间线、选型详情、多产品询价与可复用页面模板', () => {
  const snapshot = createStarterSnapshot('oem-solutions');
  const allPageNodes = nodesIn(Object.values(snapshot.editorData));
  assert.ok(allPageNodes.some(node => node.type === 'ComparisonTable' && Array.isArray(node.props.modelColumns) && node.props.modelColumns.length === 3));
  assert.ok(allPageNodes.some(node => node.type === 'ImageComparison' && node.props.mode === 'toggle'));
  assert.ok(allPageNodes.some(node => node.type === 'ImageComparison' && node.props.mode === 'split'));
  assert.ok(allPageNodes.some(node => node.type === 'ProjectTimeline' && Array.isArray(node.props.items) && node.props.items.length >= 4));
  assert.ok(allPageNodes.some(node => node.type === 'ProductDetail' && node.props.mobileOrder === 'specifications-first'));
  assert.ok(snapshot.forms?.some(form => form.enabled && form.multiProduct === true));
  assert.ok(snapshot.pageTemplates && snapshot.pageTemplates.length >= 1);
  // 校验页面与页面模板资产的节点 ID 各自唯一，不发生共享引用或冲突
  const pageIds = new Set(nodesIn(snapshot.editorData['hf-solutions']).map(node => node.props.id));
  const templateIds = nodesIn(snapshot.pageTemplates[0].data).map(node => node.props.id);
  assert.ok(templateIds.length > 0 && templateIds.every(id => !pageIds.has(id)));
});
