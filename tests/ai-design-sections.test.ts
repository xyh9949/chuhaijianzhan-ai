import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentData, Data } from '@puckeditor/core';
import { buildAiDesignSections, mergeAiDesignSections, MAX_AI_DESIGN_SECTION_ROOTS, MAX_AI_DESIGN_SECTION_UNITS } from '../src/lib/ai-design-sections';

type TestRootProps = { title?: string; showChrome?: 'yes' | 'no'; style?: { color: string } };
type TestData = Data<Record<string, ComponentData['props']>, TestRootProps>;
const text = (id: string, value = id): ComponentData => ({ type: 'Text', props: { id, text: value } });
const container = (id: string, children: ComponentData[]): ComponentData => ({ type: 'Container', props: { id, nodeLabel: `区块 ${id}`, content: children } });
function page(): TestData { return { root: { props: { title: 'Sample page', showChrome: 'yes' } }, content: [container('hero', [text('hero-copy')]), container('features', [text('feature-copy')])], zones: {} }; }
function edit(): { before: TestData; after: TestData } {
  const before = page(), after = structuredClone(before); after.content[0].props.content[0].props.text = 'New hero'; after.content[1].props.design = { mobile: { columns: 1, gap: 20 } }; return { before, after };
}

test('稳定根单位保持独立字段合同、短哈希身份和顺序，不修改输入', () => {
  const { before, after } = edit(), original = structuredClone({ before, after });
  const result = buildAiDesignSections('home', '首页', before, after);
  assert.equal(result.unavailableReason, undefined); assert.equal(result.units.length, 2);
  assert.deepEqual(result.units.map(unit => unit.nodeIds), [['hero'], ['features']]);
  for (const unit of result.units) { assert.match(unit.id, /^section:[a-f0-9]{32}$/); assert.equal(unit.parentId, 'page:home'); assert.equal(unit.kind, 'section'); assert.equal(unit.area, 'page'); assert.deepEqual(unit.pageIds, ['home']); }
  assert.notEqual(result.units[0].id, result.units[1].id); assert.notEqual(result.units[0].id, buildAiDesignSections('contact', '联系', before, after).units[0].id);
  assert.deepEqual(result, buildAiDesignSections('home', '首页', before, after)); assert.deepEqual({ before, after }, original);
});
test('整根替换只带入所选子树，保留同页未选手改，并返回准确依赖森林', () => {
  const { before, after } = edit(), current = structuredClone(before); current.content[1].props.content.push(text('manual-copy', 'Manual information'));
  const snapshot = structuredClone({ before, after, current }), merged = mergeAiDesignSections('home', current, before, after, ['hero']);
  assert.deepEqual(merged.data.content[0], after.content[0]); assert.deepEqual(merged.data.content[1], current.content[1]);
  assert.deepEqual(merged.beforeForest.content, [before.content[0]]); assert.deepEqual(merged.afterForest.content, [after.content[0]]); assert.deepEqual(merged.afterForest.root, { props: {} });
  assert.deepEqual({ before, after, current }, snapshot); merged.data.content[0].props.content[0].props.text = 'Changed return'; assert.equal(after.content[0].props.content[0].props.text, 'New hero');
});
test('同根内部可插删重排、改变类型和自由嵌套，保持完整最终子树', () => {
  const before = page(), after = structuredClone(before);
  after.content[0] = { type: 'Tabs', props: { id: 'hero', items: [{ title: 'First', content: [text('new-tab')] }, { title: 'Second', content: [{ type: 'Carousel', props: { id: 'nested-carousel', slides: [{ content: [text('nested-slide')] }] } }] }] } };
  after.content[1].props.content = [text('new-first'), before.content[1].props.content[0]];
  const result = buildAiDesignSections('home', '首页', before, after); assert.equal(result.units.length, 2);
  assert.deepEqual(mergeAiDesignSections('home', before, before, after, ['hero', 'features']).data, after);
});
test('同一根内部移动存续节点不会被误报跨根，业务JSON内相同id不当作节点', () => {
  const before = page(); before.content[0].props.content.push(container('hero-inner', [])); before.content[0].props.extraData = { id: 'feature-copy' };
  const after = structuredClone(before), child = after.content[0].props.content.shift(); after.content[0].props.content[0].props.content.push(child);
  assert.equal(buildAiDesignSections('home', '首页', before, after).units.length, 1);
});
test('支持Puck带namespace斜线ID，键序和空zones规范化不产生虚假变化', () => {
  const before = page(); before.content[0].props.id = 'studio/hero'; const after = structuredClone(before); delete after.zones;
  after.content[0].props = { content: after.content[0].props.content, nodeLabel: '区块 hero', id: 'studio/hero' };
  assert.deepEqual(buildAiDesignSections('home', '首页', before, after), { units: [] }); after.content[0].props.content[0].props.text = 'Updated';
  assert.deepEqual(buildAiDesignSections('home', '首页', before, after).units[0].nodeIds, ['studio/hero']);
});
test('每页及全站数量上限明确，超过根预算整页回退', () => {
  assert.equal(MAX_AI_DESIGN_SECTION_ROOTS, 100); assert.equal(MAX_AI_DESIGN_SECTION_UNITS, 200);
  const before = page(), after = structuredClone(before); before.content = Array.from({ length: 101 }, (_, i) => text(`root-${i}`)); after.content = structuredClone(before.content);
  assert.match(buildAiDesignSections('home', '首页', before, after).unavailableReason!, /100/);
});
for (const [label, mutate, pattern] of [
  ['页面共同样式', (data: TestData) => { data.root.props = { ...data.root.props, style: { color: '#123456' } }; }, /共同样式/],
  ['页面共同显隐', (data: TestData) => { data.root.props = { ...data.root.props, showChrome: 'no' }; }, /共同样式/],
  ['旧独立插槽', (data: TestData) => { data.zones = { 'hero:content': [text('legacy')] }; }, /旧版/],
  ['重复嵌套ID', (data: TestData) => data.content[1].props.content.push(text('hero-copy')), /重复/],
  ['无稳定ID', (data: TestData) => { data.content[0].props.id = ''; }, /稳定标识/],
] as const) test(`${label}安全退回整页并说明原因`, () => {
  const before = page(), after = structuredClone(before); mutate(after);
  const result = buildAiDesignSections('home', '首页', before, after); assert.deepEqual(result.units, []); assert.match(result.unavailableReason!, pattern);
  assert.throws(() => mergeAiDesignSections('home', before, before, after, ['hero']), pattern);
});
test('跨Tabs/Accordion/Carousel插槽的存续节点搬到别根必须关联采用', () => {
  for (const [type, key] of [['Tabs', 'items'], ['Accordion', 'items'], ['Carousel', 'slides']]) {
    const before = page(); before.content[0] = { type, props: { id: 'hero', [key]: [{ title: 'Panel', content: [text('retained')] }] } };
    const after = structuredClone(before); after.content[1].props.content.push(after.content[0].props[key][0].content.pop());
    const units = buildAiDesignSections('home', '首页', before, after).units; assert.equal(units.length, 1); assert.deepEqual(units[0].nodeIds, ['hero', 'features']); assert.match(units[0].id, /^section:g1:[a-f0-9]{32}$/);
    assert.throws(() => mergeAiDesignSections('home', before, before, after, ['hero']), /整组/); assert.deepEqual(mergeAiDesignSections('home', before, before, after, units[0].nodeIds).data, after);
  }
});
test('所选根被手改或加锁拒绝，未选根的手改和锁保持', () => {
  const { before, after } = edit();
  for (const change of [(data: Data) => { data.content[0].props.locked = true; }, (data: Data) => { data.content[0].props.content[0].props.text = 'Manual hero'; }]) { const current = structuredClone(before); change(current); assert.throws(() => mergeAiDesignSections('home', current, before, after, ['hero']), /所选区块已有修改/); }
  const current = structuredClone(before); current.content[1].props.locked = true; const merged = mergeAiDesignSections('home', current, before, after, ['hero']); assert.deepEqual(merged.data.content[1], current.content[1]);
});
test('当前页面根结构或共同样式变化有冲突，绝不覆盖', () => {
  const { before, after } = edit();
  for (const change of [(data: Data) => data.content.reverse(), (data: Data) => data.content.pop(), (data: Data) => data.content.push(text('manual-root')), (data: Data) => { data.root.props = { ...data.root.props, title: 'Manual title' }; }]) {
    const current = structuredClone(before); change(current); const snapshot = structuredClone(current); assert.throws(() => mergeAiDesignSections('home', current, before, after, ['hero']), /页面结构或共同样式/); assert.deepEqual(current, snapshot);
  }
});
test('未选根后来占用候选的新后代ID时合并拒绝，真实资产引用不当节点ID', () => {
  const { before, after } = edit(); after.content[0].props.content.push({ type: 'SharedBlock', props: { id: 'candidate-card', blockId: 'shared-business-card' } });
  const current = structuredClone(before); current.content[1].props.content.push(text('candidate-card'));
  assert.throws(() => mergeAiDesignSections('home', current, before, after, ['hero']), /重复节点/);
  current.content[1].props.content.pop(); current.content[1].props.content.push({ type: 'SharedBlock', props: { id: 'manual-reference', blockId: 'shared-business-card' } });
  assert.equal(mergeAiDesignSections('home', current, before, after, ['hero']).afterForest.content[0].props.content.at(-1).props.blockId, 'shared-business-card');
});
test('空选、重复、未知、未变化根和子节点不可伪装成根单位', () => {
  const { before, after } = edit(); after.content[1] = structuredClone(before.content[1]);
  for (const ids of [[], ['hero', 'hero'], ['missing'], ['feature-copy'], ['features']]) assert.throws(() => mergeAiDesignSections('home', before, before, after, ids), /所选区块已失效/);
});
test('嵌套及节点预算拒绝过大快照，避免无限扫描', () => {
  const before = page(), after = structuredClone(before); let cursor = after.content[0];
  for (let i = 0; i < 18; i++) { const next = container(`nested-${i}`, []); cursor.props.content = [next]; cursor = next; }
  assert.match(buildAiDesignSections('home', '首页', before, after).unavailableReason!, /预算/);
  after.content[0].props.content = Array.from({ length: 301 }, (_, index) => text(`child-${index}`)); assert.match(buildAiDesignSections('home', '首页', before, after).unavailableReason!, /预算/);
});
test('区块名称优先人工标签，否则用根标题、文字或真实嵌套标题辨别', () => {
  const before = page(), after = structuredClone(before);
  after.content[0].props.nodeLabel = ' <b>采购入口</b>\u0000 ';
  after.content[0].props.title = 'Lower priority title';
  assert.equal(buildAiDesignSections('home', '首页', before, after).units[0].label, '采购入口');
  delete after.content[0].props.nodeLabel;
  assert.equal(buildAiDesignSections('home', '首页', before, after).units[0].label, '布局区块·Lower priority title');
  delete after.content[0].props.title; after.content[0].props.text = '  Company\n capabilities ';
  assert.equal(buildAiDesignSections('home', '首页', before, after).units[0].label, '布局区块·Company capabilities');
  delete after.content[0].props.text;
  after.content[0].props.businessJSON = { type: 'Heading', props: { id: 'fake', text: 'Not visible heading' } };
  after.content[0].props.content = [{ type: 'Tabs', props: { id: 'hero-tabs', items: [{ title: 'Panel', content: [{ type: 'Heading', props: { id: 'real-heading', text: '<em>采购与产品</em>\t指南' } }] }] } }];
  assert.equal(buildAiDesignSections('home', '首页', before, after).units[0].label, '布局区块·采购与产品 指南');
});
test('标签清理脚本与控制字符、保留短可见名称，无码文案时继续编号', () => {
  const before = page(), after = structuredClone(before);
  after.content[0] = { type: 'ProductList', props: { id: 'hero', title: '<script>alert(1)</script>Products\u0001' } };
  assert.equal(buildAiDesignSections('home', '首页', before, after).units[0].label, '产品列表·Products');
  after.content[0].props.title = '采购'.repeat(100);
  assert.equal(Array.from(buildAiDesignSections('home', '首页', before, after).units[0].label.split('·')[1]).length, 60);
  after.content[0].props.title = '<style>color:red</style>\u0000';
  assert.equal(buildAiDesignSections('home', '首页', before, after).units[0].label, '产品列表 1');
});

function roots(...ids: string[]): TestData { return { root: { props: { title: 'Sample page' } }, content: ids.map(id => container(id, [text(`${id}-copy`)])), zones: {} }; }
const rootIds = (data: Data) => data.content.map(node => node.props.id);
test('不同LCS空隙的新增与删除独立采用，未选锚点手改保持', () => {
  const before = roots('a', 'remove', 'b', 'c'), after = roots('new-first', 'a', 'b', 'new-middle', 'c', 'new-last');
  const units = buildAiDesignSections('home', '首页', before, after).units; assert.equal(units.length, 4);
  const current = structuredClone(before); current.content[2].props.content[0].props.text = 'MANUAL_B';
  const selected = units.filter(unit => unit.nodeIds.includes('remove') || unit.nodeIds.includes('new-middle')).flatMap(unit => unit.nodeIds);
  const merged = mergeAiDesignSections('home', current, before, after, selected);
  assert.deepEqual(rootIds(merged.data), ['a', 'b', 'new-middle', 'c']); assert.deepEqual(merged.data.content[1], current.content[2]);
  assert.deepEqual(rootIds(merged.beforeForest), ['remove']); assert.deepEqual(rootIds(merged.afterForest), ['new-middle']);
  assert.match(units.find(unit => unit.nodeIds.includes('remove'))!.label, /^删除区块/); assert.match(units.find(unit => unit.nodeIds.includes('new-middle'))!.label, /^新增区块/);
});
test('同一空隙的多根替换不可拆，新增/删除before及after森林准确', () => {
  const before = roots('a', 'old-one', 'old-two', 'b'), after = roots('a', 'new-one', 'new-two', 'b');
  const units = buildAiDesignSections('home', '首页', before, after).units; assert.equal(units.length, 1); assert.deepEqual(units[0].nodeIds, ['old-one', 'old-two', 'new-one', 'new-two']);
  assert.throws(() => mergeAiDesignSections('home', before, before, after, ['old-one']), /整组/);
  const merged = mergeAiDesignSections('home', before, before, after, units[0].nodeIds); assert.deepEqual(merged.data, after);
  assert.deepEqual(rootIds(merged.beforeForest), ['old-one', 'old-two']); assert.deepEqual(rootIds(merged.afterForest), ['new-one', 'new-two']);
});
test('根跨空隙移动自动关联原位置与目标位置，独立锚点改字仍可单选', () => {
  const before = roots('a', 'b', 'c', 'd'), after = roots('c', 'a', 'b', 'd'); after.content[2].props.content[0].props.text = 'AI_B';
  const units = buildAiDesignSections('home', '首页', before, after).units; assert.equal(units.length, 2);
  const moving = units.find(unit => unit.nodeIds.includes('c'))!, copy = units.find(unit => unit.nodeIds.includes('b'))!;
  assert.match(moving.id, /^section:g1:/); assert.match(copy.id, /^section:[a-f0-9]{32}$/);
  const current = structuredClone(before); current.content[1].props.content[0].props.text = 'MANUAL_B';
  const moved = mergeAiDesignSections('home', current, before, after, moving.nodeIds); assert.deepEqual(rootIds(moved.data), ['c', 'a', 'b', 'd']); assert.equal(moved.data.content[2].props.content[0].props.text, 'MANUAL_B');
  const copied = mergeAiDesignSections('home', before, before, after, copy.nodeIds); assert.deepEqual(rootIds(copied.data), ['a', 'b', 'c', 'd']); assert.equal(copied.data.content[1].props.content[0].props.text, 'AI_B');
});
test('复杂移动共享原空隙必须并组，新结构身份冻结位置并隔离旧单根ID', () => {
  const before = roots('a', 'b', 'c', 'd'), after = roots('c', 'd', 'a', 'b');
  const units = buildAiDesignSections('home', '首页', before, after).units; assert.equal(units.length, 1); assert.equal(units[0].nodeIds.length, 2);
  assert.throws(() => mergeAiDesignSections('home', before, before, after, units[0].nodeIds.slice(0, 1)), /整组/);
  assert.deepEqual(mergeAiDesignSections('home', before, before, after, units[0].nodeIds).data, after);
  const onlyBody = structuredClone(before); onlyBody.content[2].props.content[0].props.text = 'AI_C';
  assert.notEqual(units[0].id, buildAiDesignSections('home', '首页', before, onlyBody).units[0].id);
  const differentPosition = roots('a', 'c', 'b', 'd'), oneMove = buildAiDesignSections('home', '首页', before, differentPosition).units[0];
  assert.notEqual(oneMove.id, units[0].id);
});
test('跨根后代迁移把结构组与锚点正文关联，锚点仍是可用位置骨架', () => {
  const before = roots('a', 'b', 'c', 'd'), after = roots('new-first', 'c', 'a', 'b', 'd');
  after.content[3].props.content.push(after.content[1].props.content.pop());
  const units = buildAiDesignSections('home', '首页', before, after).units, coupled = units.find(unit => unit.nodeIds.includes('c'))!;
  // 起始空隙新增根和移动根共享目标位置，所以与c、b关联；a保持位置且可保留手改。
  assert.deepEqual(coupled.nodeIds, ['b', 'c', 'new-first']); const current = structuredClone(before); current.content[0].props.content[0].props.text = 'MANUAL_A';
  const merged = mergeAiDesignSections('home', current, before, after, coupled.nodeIds); assert.deepEqual(rootIds(merged.data), rootIds(after)); assert.deepEqual(merged.data.content[2], current.content[0]);
  assert.throws(() => mergeAiDesignSections('home', before, before, after, ['b']), /整组/);
});
test('原顶层根放入另一根、或原后代提升为根，都不会一边删除一边遗漏', () => {
  const before = roots('a', 'b'), wrapped = roots('b'); wrapped.content[0].props.content.push(structuredClone(before.content[0]));
  const wrappedUnit = buildAiDesignSections('home', '首页', before, wrapped).units; assert.equal(wrappedUnit.length, 1); assert.deepEqual(wrappedUnit[0].nodeIds, ['a', 'b']); assert.deepEqual(mergeAiDesignSections('home', before, before, wrapped, wrappedUnit[0].nodeIds).data, wrapped);
  const promoted = structuredClone(before), child = promoted.content[0].props.content.pop(); promoted.content.push(child);
  const promotedUnit = buildAiDesignSections('home', '首页', before, promoted).units; assert.equal(promotedUnit.length, 1); assert.deepEqual(promotedUnit[0].nodeIds, ['a', 'a-copy']); assert.deepEqual(mergeAiDesignSections('home', before, before, promoted, promotedUnit[0].nodeIds).data, promoted);
});
test('纯新增、纯删除及空页面转换均有真实可选组', () => {
  for (const [before, after] of [[roots(), roots('a', 'b')], [roots('a', 'b'), roots()], [roots('a'), roots('a', 'new')], [roots('a', 'old'), roots('a')]]) {
    const units = buildAiDesignSections('home', '首页', before, after).units; assert.equal(units.length, 1); assert.deepEqual(mergeAiDesignSections('home', before, before, after, units[0].nodeIds).data, after);
  }
});
test('删除组发现原树手改或锁变化即拒绝，新增组的ID占用仍由最终森林拒绝', () => {
  const before = roots('a', 'b'), after = roots('a', 'new'), units = buildAiDesignSections('home', '首页', before, after).units;
  const current = structuredClone(before); current.content[1].props.locked = true; assert.throws(() => mergeAiDesignSections('home', current, before, after, units[0].nodeIds), /所选区块已有修改/);
  const occupied = structuredClone(before); occupied.content[0].props.content.push(text('new'));
  assert.throws(() => mergeAiDesignSections('home', occupied, before, after, units[0].nodeIds), /重复节点/);
});
test('独立组混合后若超节点预算仍拒绝，不因完整候选合法而放过局部组合', () => {
  const before = roots('a', 'remove', 'b'); before.content[1].props.content = Array.from({ length: 200 }, (_, i) => text(`old-${i}`));
  const after = roots('a', 'b', 'new'); after.content[2].props.content = Array.from({ length: 200 }, (_, i) => text(`new-${i}`));
  const units = buildAiDesignSections('home', '首页', before, after).units, add = units.find(unit => unit.nodeIds.includes('new'))!;
  assert.equal(units.length, 2); assert.throws(() => mergeAiDesignSections('home', before, before, after, add.nodeIds), /预算/);
});
test('有界组合回归：所有新增/删除/重排组混合均保留未选根，全部采用精确等于候选', () => {
  const before = roots('a', 'b', 'c', 'd'), arrangements = [[], ['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'], ['x', 'a', 'b', 'y', 'c', 'z'], ['b', 'x', 'd', 'a'], ['a', 'x', 'b', 'c', 'y', 'd'], ['c', 'd', 'a', 'b'], ['d', 'x', 'a', 'y', 'c']];
  for (const ids of arrangements) {
    const after = roots(...ids); for (const node of after.content) node.props.content[0].props.text = `AI_${node.props.id}`;
    const units = buildAiDesignSections('home', '首页', before, after).units; assert.ok(units.length > 0); assert.ok(units.length <= 8);
    const current = structuredClone(before); for (const node of current.content) node.props.extraManualInformation = true;
    for (let mask = 1; mask < 2 ** units.length; mask++) {
      const nodeIds = units.filter((_, index) => mask & 2 ** index).flatMap(unit => unit.nodeIds), selected = new Set(nodeIds), compatible = structuredClone(current);
      for (let index = 0; index < compatible.content.length; index++) if (selected.has(compatible.content[index].props.id)) compatible.content[index] = structuredClone(before.content[index]);
      const merged = mergeAiDesignSections('home', compatible, before, after, nodeIds), seen = new Set(rootIds(merged.data)); assert.equal(seen.size, merged.data.content.length);
      for (const node of merged.data.content) assert.deepEqual(node, selected.has(node.props.id) ? after.content.find(candidate => candidate.props.id === node.props.id) : compatible.content.find(candidate => candidate.props.id === node.props.id));
      if (mask === 2 ** units.length - 1) assert.deepEqual(merged.data, after);
    }
  }
});
test('候选生成后未选根新加锁，其前新增或删除均不能间接移动锁', () => {
  for (const [before, after, affected] of [[roots('a', 'b'), roots('new', 'a', 'b'), 'new'], [roots('old', 'a', 'b'), roots('a', 'b'), 'old']] as const) {
    const current = structuredClone(before); current.content.find(node => node.props.id === 'b')!.props.locked = true;
    const unit = buildAiDesignSections('home', '首页', before, after).units.find(item => item.nodeIds.includes(affected))!;
    assert.throws(() => mergeAiDesignSections('home', current, before, after, unit.nodeIds), /移动或影响锁定区块/);
  }
});
test('完整方案增删抵消锁的位置，局部单选仍拒绝，组合抵消后允许', () => {
  const before = roots('old', 'a', 'locked', 'z'), after = roots('a', 'new', 'locked', 'z');
  before.content[2].props.locked = true; after.content[2].props.locked = true; after.content[3].props.content[0].props.text = 'AI_Z';
  const units = buildAiDesignSections('home', '首页', before, after).units, remove = units.find(unit => unit.nodeIds.includes('old'))!, add = units.find(unit => unit.nodeIds.includes('new'))!, copy = units.find(unit => unit.nodeIds.includes('z'))!;
  assert.throws(() => mergeAiDesignSections('home', before, before, after, remove.nodeIds), /锁定区块/);
  assert.throws(() => mergeAiDesignSections('home', before, before, after, add.nodeIds), /锁定区块/);
  const balanced = mergeAiDesignSections('home', before, before, after, [...remove.nodeIds, ...add.nodeIds]); assert.deepEqual(rootIds(balanced.data), rootIds(after)); assert.deepEqual(balanced.data.content[2], before.content[2]);
  const independent = mergeAiDesignSections('home', before, before, after, copy.nodeIds); assert.deepEqual(rootIds(independent.data), rootIds(before)); assert.equal(independent.data.content[3].props.content[0].props.text, 'AI_Z'); assert.deepEqual(independent.data.content[2], before.content[2]);
});
test('未选嵌套锁也保护所在根的位置，锁后面的独立新增可通过', () => {
  const before = roots('a', 'b'), current = structuredClone(before); current.content[0].props.content[0].props.locked = true;
  const earlier = roots('new', 'a', 'b'), blocked = buildAiDesignSections('home', '首页', before, earlier).units[0];
  assert.throws(() => mergeAiDesignSections('home', current, before, earlier, blocked.nodeIds), /锁定区块/);
  const later = roots('a', 'b', 'new'), allowed = buildAiDesignSections('home', '首页', before, later).units[0];
  const merged = mergeAiDesignSections('home', current, before, later, allowed.nodeIds); assert.deepEqual(merged.data.content[0], current.content[0]); assert.deepEqual(rootIds(merged.data), ['a', 'b', 'new']);
});
test('锁保护整个祖先路径和属性，不能只比所属根和叶子下标', () => {
  const before = roots('a'); before.content[0].props.content = [container('panel-one', [text('locked-leaf')]), container('panel-two', [text('other')])]; before.content[0].props.content[0].props.content[0].props.locked = true;
  const moved = structuredClone(before); moved.content[0].props.content.reverse();
  assert.throws(() => mergeAiDesignSections('home', before, before, moved, ['a']), /锁定区块/);
  const restyled = structuredClone(before); restyled.content[0].props.content[0].props.design = { desktop: { paddingTop: 40 } };
  assert.throws(() => mergeAiDesignSections('home', before, before, restyled, ['a']), /锁定区块/);
});
