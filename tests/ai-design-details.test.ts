import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentData, Data } from '@puckeditor/core';
import { buildAiDesignDetails, buildAiDesignSections, mergeAiDesignSections } from '../src/lib/ai-design-sections';

const text = (id: string, value = id): ComponentData => ({ type: 'Text', props: { id, text: value } });
const container = (id: string, content: ComponentData[]): ComponentData => ({ type: 'Container', props: { id, nodeLabel: `区块 ${id}`, content } });
function page(): Data { return { root: { props: { title: 'Sample page' } }, zones: {}, content: [container('root', [container('intro', [{ type: 'Heading', props: { id: 'title', text: 'Original title', level: 'h1' } }, text('description')]), container('benefits', [text('benefit-one'), text('benefit-two')])])] }; }
function node(data: Data, id: string): ComponentData {
  let found: ComponentData | undefined;
  const visit = (nodes: ComponentData[]) => { for (const item of nodes) { if (item.props.id === id) found = item; if (item.type === 'Container') visit(item.props.content); else for (const key of ['items', 'slides']) if (Array.isArray(item.props[key])) for (const panel of item.props[key]) if (Array.isArray(panel.content)) visit(panel.content); } };
  visit(data.content); assert.ok(found, id); return found;
}
function edit() { const before = page(), after = structuredClone(before); node(after, 'title').props.text = 'AI_TITLE'; node(after, 'description').props.text = 'AI_DESCRIPTION'; return { before, after }; }
const details = (before: Data, after: Data) => buildAiDesignDetails('home', '首页', before, after);
const merge = (current: Data, before: Data, after: Data, ids: string[], sections: string[] = []) => mergeAiDesignSections('home', current, before, after, sections, ids);

test('独立detailUnits保留原section合同，ID短且前沿覆盖全部变更', () => {
  const { before, after } = edit(), snapshot = structuredClone({ before, after }), sections = buildAiDesignSections('home', '首页', before, after), result = details(before, after);
  assert.equal(sections.units.length, 1); assert.equal(result.units.length, 2); assert.deepEqual(result.units.map(unit => unit.nodeIds), [['title'], ['description']]);
  for (const unit of result.units) { assert.match(unit.id, /^detail:d1:[a-f0-9]{32}$/); assert.equal(unit.kind, 'detail'); assert.equal(unit.rootId, 'root'); assert.equal(unit.parentId, sections.units[0].id); assert.deepEqual(unit.pageIds, ['home']); assert.equal(unit.area, 'page'); }
  assert.notEqual(result.units[0].id, result.units[1].id); assert.deepEqual(result, details(before, after)); assert.deepEqual(merge(before, before, after, result.units.flatMap(unit => unit.nodeIds)).data, after); assert.deepEqual({ before, after }, snapshot);
});
test('单个深层变更仍提供细分，精准采用保留未选兄弟手改和新增子内容', () => {
  const { before, after } = edit(); node(after, 'description').props.text = node(before, 'description').props.text;
  const result = details(before, after); assert.deepEqual(result.units.map(unit => unit.nodeIds), [['title']]);
  const current = structuredClone(before); node(current, 'description').props.text = 'MANUAL_DESCRIPTION'; node(current, 'benefits').props.content.push(text('manual-benefit'));
  const merged = merge(current, before, after, ['title']); assert.equal(node(merged.data, 'title').props.text, 'AI_TITLE'); assert.deepEqual(node(merged.data, 'description'), node(current, 'description')); assert.deepEqual(node(merged.data, 'benefits'), node(current, 'benefits'));
  assert.deepEqual(merged.beforeForest.content, [node(before, 'title')]); assert.deepEqual(merged.afterForest.content, [node(after, 'title')]);
});
test('前沿子树改样式、类型或直接结构时整树原子化，其他分支仍可单独选择', () => {
  for (const change of [
    (data: Data) => { node(data, 'intro').props.design = { desktop: { gap: 30 } }; },
    (data: Data) => { node(data, 'intro').props.content.reverse(); },
    (data: Data) => { node(data, 'intro').props.content.push(text('new-note')); },
    (data: Data) => { node(data, 'intro').props.content.pop(); },
    (data: Data) => { node(data, 'title').type = 'Text'; },
  ]) {
    const before = page(), after = structuredClone(before); change(after); node(after, 'benefit-one').props.text = 'AI_BENEFIT';
    const units = details(before, after).units, expected = node(after, 'title').type === 'Text' ? 'title' : 'intro';
    assert.deepEqual(units.map(unit => unit.nodeIds), [[expected], ['benefit-one']]); assert.deepEqual(merge(before, before, after, units.flatMap(unit => unit.nodeIds)).data, after);
  }
});
test('根共同属性变化没有细分项，明确保留整体采用', () => {
  const { before, after } = edit(); node(after, 'root').props.design = { mobile: { gap: 20 } };
  const result = details(before, after), section = buildAiDesignSections('home', '首页', before, after).units[0]; assert.deepEqual(result.units, []); assert.match(result.unavailableReasons![section.id], /共同样式/);
  assert.throws(() => merge(before, before, after, ['title']), /所选内容已失效/);
});
test('跨子分支迁移停在最近共同父树，不能分开移出和移入', () => {
  const before = page(), after = structuredClone(before); node(after, 'benefits').props.content.push(node(after, 'intro').props.content.pop());
  assert.deepEqual(details(before, after).units, []);
  const nestedBefore = page(); node(nestedBefore, 'intro').props.content = [container('panel-a', [text('transfer')]), container('panel-b', [])];
  const nestedAfter = structuredClone(nestedBefore); node(nestedAfter, 'panel-b').props.content.push(node(nestedAfter, 'panel-a').props.content.pop()); node(nestedAfter, 'benefit-one').props.text = 'Independent copy';
  const units = details(nestedBefore, nestedAfter).units; assert.deepEqual(units.map(unit => unit.nodeIds), [['intro'], ['benefit-one']]);
  assert.deepEqual(merge(nestedBefore, nestedBefore, nestedAfter, units.flatMap(unit => unit.nodeIds)).data, nestedAfter);
});
test('真实Tabs/Accordion/Carousel插槽允许稳定下钻，改面板设置或跨插槽迁移停在面板树', () => {
  for (const [type, key] of [['Tabs', 'items'], ['Accordion', 'items'], ['Carousel', 'slides']]) {
    const before = page(); node(before, 'intro').props.content = [{ type, props: { id: 'panels', [key]: [{ title: 'Panel one', content: [text('panel-copy-one')] }, { title: 'Panel two', content: [text('panel-copy-two')] }] } }];
    const after = structuredClone(before); node(after, 'panel-copy-one').props.text = 'AI_PANEL'; assert.deepEqual(details(before, after).units.map(unit => unit.nodeIds), [['panel-copy-one']]);
    node(after, 'panels').props[key][0].title = 'Changed panel settings'; assert.deepEqual(details(before, after).units.map(unit => unit.nodeIds), [['panels']]);
    const moved = structuredClone(before); node(moved, 'panels').props[key][1].content.push(node(moved, 'panels').props[key][0].content.pop()); assert.deepEqual(details(before, moved).units.map(unit => unit.nodeIds), [['panels']]);
  }
});
test('结构g1根组没有细分，另一稳定根可继续提供内部单位', () => {
  const before = page(); before.content.unshift(text('obsolete')); before.content.push(container('last', [text('last-copy')]));
  const after = structuredClone(before); after.content.shift(); after.content.push(text('new-root')); node(after, 'title').props.text = 'AI_TITLE';
  const sections = buildAiDesignSections('home', '首页', before, after), result = details(before, after);
  assert.deepEqual(result.units.map(unit => unit.nodeIds), [['title']]); for (const section of sections.units.filter(unit => unit.id.startsWith('section:g1:'))) assert.match(result.unavailableReasons![section.id], /整体采用/);
  const newRoot = sections.units.find(unit => unit.nodeIds.includes('new-root'))!, merged = merge(before, before, after, ['title'], newRoot.nodeIds);
  assert.deepEqual(merged.data.content.map(item => item.props.id), ['obsolete', 'root', 'last', 'new-root']); assert.equal(node(merged.data, 'title').props.text, 'AI_TITLE');
  assert.deepEqual(merged.beforeForest.content.map(item => item.props.id), ['title']); assert.deepEqual(merged.afterForest.content.map(item => item.props.id), ['new-root', 'title']);
});
test('整根与其他根细分可混选，依赖森林不重叠且不夹带共同祖先', () => {
  const { before, after } = edit(); before.content.push(container('other-root', [text('other-copy')])); after.content.push(container('other-root', [text('other-copy', 'AI_OTHER')]));
  const result = merge(before, before, after, ['title'], ['other-root']);
  assert.deepEqual(result.beforeForest.content.map(item => item.props.id), ['other-root', 'title']); assert.deepEqual(result.afterForest.content.map(item => item.props.id), ['other-root', 'title']); assert.equal(node(result.data, 'description').props.text, 'description');
  assert.throws(() => merge(before, before, after, ['title'], ['root']), /不能重复选择/);
});
test('当前目标子树、祖先属性、结构或位置后改必须拒绝', () => {
  const { before, after } = edit();
  for (const change of [
    (data: Data) => { node(data, 'title').props.text = 'MANUAL'; },
    (data: Data) => { node(data, 'intro').props.design = { desktop: { gap: 16 } }; },
    (data: Data) => { node(data, 'intro').props.content.reverse(); },
    (data: Data) => { node(data, 'intro').props.content.push(text('manual-sibling')); },
    (data: Data) => { node(data, 'root').props.content.reverse(); },
    (data: Data) => { node(data, 'root').props.locked = true; },
  ]) {
    const current = structuredClone(before); change(current); const snapshot = structuredClone(current); assert.throws(() => merge(current, before, after, ['title']), /所选内容|共同父级/); assert.deepEqual(current, snapshot);
  }
});
test('当前未选兄弟的属性和内部结构不阻塞细分，精确资产树只含选项', () => {
  const { before, after } = edit(); node(after, 'description').props.text = 'description';
  node(after, 'title').props.relatedAsset = 'selected-value'; node(after, 'benefits').props.content.push({ type: 'SharedBlock', props: { id: 'unselected-card', blockId: 'not-selected' } });
  const current = structuredClone(before); node(current, 'benefits').props.design = { mobile: { columns: 1 } }; node(current, 'benefits').props.content.reverse();
  const merged = merge(current, before, after, ['title']); assert.deepEqual(node(merged.data, 'benefits'), node(current, 'benefits')); assert.doesNotMatch(JSON.stringify(merged.afterForest), /not-selected|unselected-card/);
});
test('当前未选锁保持，新增祖先锁拒绝，合并根结构仍须保护细分所在根的锁位置', () => {
  const { before, after } = edit(), current = structuredClone(before); node(current, 'benefit-one').props.locked = true;
  const safe = merge(current, before, after, ['title']); assert.deepEqual(node(safe.data, 'benefit-one'), node(current, 'benefit-one'));
  const locked = structuredClone(before); node(locked, 'intro').props.locked = true; assert.throws(() => merge(locked, before, after, ['title']), /共同父级/);
  const rootAdded = structuredClone(after); rootAdded.content.unshift(text('new-root')); assert.throws(() => merge(current, before, rootAdded, ['title'], ['new-root']), /锁定区块/);
});
test('目标祖先以外占用候选新节点ID仍拒绝，细分返回值保持深拷贝', () => {
  const before = page(), after = structuredClone(before); node(after, 'intro').props.content.push(text('candidate-new'));
  const current = structuredClone(before); node(current, 'benefits').props.content.push(text('candidate-new')); assert.throws(() => merge(current, before, after, ['intro']), /重复节点/);
  const snapshot = structuredClone(after), merged = merge(before, before, after, ['intro']); node(merged.data, 'candidate-new').props.text = 'Modified result'; merged.afterForest.content[0].props.content[0].props.text = 'Modified forest'; assert.deepEqual(after, snapshot);
});
test('伪造、重复、空选、顶层根和普通非前沿后代都不能作为细分项', () => {
  const { before, after } = edit();
  for (const ids of [[], ['title', 'title'], ['missing'], ['root'], ['intro'], ['benefit-one']]) assert.throws(() => merge(before, before, after, ids), /已失效/);
});
test('细分支持Puck namespace并忽略对象键序，路径身份区分不同页面和不同根', () => {
  const { before, after } = edit(); node(before, 'title').props.id = 'studio/title'; node(after, 'title').props.id = 'studio/title';
  const result = details(before, after), unit = result.units.find(item => item.nodeIds.includes('studio/title'))!; assert.ok(unit);
  assert.notEqual(unit.id, buildAiDesignDetails('contact', '联系', before, after).units.find(item => item.nodeIds.includes('studio/title'))!.id);
  const same = structuredClone(before); same.content[0].props = { content: same.content[0].props.content, nodeLabel: '区块 root', id: 'root' }; assert.deepEqual(details(before, same).units, []);
});
test('非空旧zones、重复ID、超过预算或页面共同配置变化保留原整页方式', () => {
  const { before, after } = edit();
  const zoned = structuredClone(after); zoned.zones = { 'old:content': [text('legacy')] }; assert.deepEqual(details(before, zoned).units, []);
  const common = structuredClone(after); common.root.props = { title: 'Other page settings' }; assert.deepEqual(details(before, common).units, []);
  const repeated = structuredClone(after); node(repeated, 'benefits').props.content.push(text('title')); assert.deepEqual(details(before, repeated).units, []);
  const oversized = structuredClone(after); node(oversized, 'benefits').props.content = Array.from({ length: 301 }, (_, index) => text(`large-${index}`)); assert.deepEqual(details(before, oversized).units, []);
});
test('图片按alt辨别，无文字内容使用实际插槽位置，不展示URL或节点ID', () => {
  const before = page(); node(before, 'intro').props.content.push({ type: 'Image', props: { id: 'private-image-id', src: '/api/media/private-url', alt: '生产车间' } }, { type: 'Spacer', props: { id: 'private-spacer-id', height: 10 } });
  const after = structuredClone(before); node(after, 'private-image-id').props.design = { mobile: { height: 100 } }; node(after, 'private-spacer-id').props.height = 30;
  const units = details(before, after).units; assert.equal(units[0].label, '图片区块·生产车间'); assert.equal(units[1].label, '页面区块 4');
  assert.doesNotMatch(units.map(unit => unit.label).join(' '), /private-|\/api\/media/);
});
