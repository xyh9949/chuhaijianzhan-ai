import test from 'node:test';
import assert from 'node:assert/strict';
import type { Data } from '@puckeditor/core';
import { buildAiDesignTreeRanges, aiDesignTreeMask, mergeAiDesignTreeRanges } from '../src/lib/ai-design-asset-details';

function source(): Data { return { root: { props: {} }, zones: {}, content: [{ type: 'Container', props: { id: 'frame', content: [{ type: 'Heading', props: { id: 'headline', text: 'Original title', design: { desktop: { fontSize: 40, color: '#111111' }, mobile: { fontSize: 24 } } } }, { type: 'Text', props: { id: 'copy', text: 'Original copy' } }] } }] }; }
function proposal() { const before = source(), after = structuredClone(before); after.content[0].props.content[0].props.text = 'Candidate title'; after.content[0].props.content[0].props.design.mobile.fontSize = 30; after.content[0].props.content[0].props.design.desktop.color = '#3355ff'; after.content[0].props.content[1].props.text = 'Candidate copy'; return { before, after }; }
test('同组件文字、三端分组样式提供不同opaque属性ID，不改旧section/detail身份', () => {
  const { before, after } = proposal(), ranges = buildAiDesignTreeRanges('header', '页眉', before, after), properties = ranges.units.filter(unit => unit.kind === 'property');
  assert.equal(properties.length, 4); assert.equal(new Set(properties.map(unit => unit.id)).size, 4); properties.forEach(unit => assert.match(unit.id, /^property:p1:[a-f0-9]{32}$/));
  assert.equal(properties.find(unit => unit.viewport === 'mobile')?.group, 'typography'); assert.deepEqual(properties.find(unit => unit.viewport === 'mobile')?.propertyNames, ['fontSize']);
  assert.deepEqual(ranges, buildAiDesignTreeRanges('header', '页眉', before, after)); assert.notEqual(properties[0].id, buildAiDesignTreeRanges('footer', '页脚', before, after).units.find(unit => unit.kind === 'property')?.id);
});
test('选中文字保留同节点未选样式及同根其他内容的手改，真实逆向mask也保留', () => {
  const { before, after } = proposal(), ranges = buildAiDesignTreeRanges('header', '页眉', before, after), text = ranges.units.find(unit => unit.kind === 'property' && unit.group === 'text' && unit.nodeIds[0] === 'headline')!, mask = aiDesignTreeMask(ranges, [text.id]);
  const current = structuredClone(before); current.content[0].props.content[0].props.design.mobile.fontSize = 28; current.content[0].props.content[1].props.text = 'Manual copy';
  const selected = mergeAiDesignTreeRanges('header', current, before, after, mask).data;
  assert.equal(selected.content[0].props.content[0].props.text, 'Candidate title'); assert.equal(selected.content[0].props.content[0].props.design.mobile.fontSize, 28); assert.equal(selected.content[0].props.content[1].props.text, 'Manual copy');
  const later = structuredClone(selected); later.content[0].props.content[0].props.design.desktop.color = '#ff8800'; later.content[0].props.content[1].props.text = 'Later manual copy';
  const undo = mergeAiDesignTreeRanges('header', later, selected, current, mask).data;
  assert.equal(undo.content[0].props.content[0].props.text, 'Original title'); assert.equal(undo.content[0].props.content[0].props.design.desktop.color, '#ff8800'); assert.equal(undo.content[0].props.content[1].props.text, 'Later manual copy');
});
test('只选手机字体不带入电脑颜色或候选文案，后改选中字段拒绝覆盖', () => {
  const { before, after } = proposal(), ranges = buildAiDesignTreeRanges('template:chair', '产品模板', before, after), unit = ranges.units.find(item => item.kind === 'property' && item.viewport === 'mobile')!, mask = aiDesignTreeMask(ranges, [unit.id]);
  const selected = mergeAiDesignTreeRanges('template:chair', before, before, after, mask).data;
  assert.equal(selected.content[0].props.content[0].props.design.mobile.fontSize, 30); assert.equal(selected.content[0].props.content[0].props.design.desktop.color, '#111111'); assert.equal(selected.content[0].props.content[0].props.text, 'Original title');
  const later = structuredClone(selected); later.content[0].props.content[0].props.design.mobile.fontSize = 32;
  assert.throws(() => mergeAiDesignTreeRanges('template:chair', later, selected, before, mask), /后续修改/);
});
test('动态绑定、资源换图、结构依赖不提供可脱离原生树的伪属性，锁定后不能逆合并', () => {
  const { before, after } = proposal(); after.content[0].props.content[0].props.bindings = { text: { source: 'current', field: 'builtin:name' } };
  let ranges = buildAiDesignTreeRanges('page', '首页', before, after); assert.equal(ranges.units.filter(unit => unit.kind === 'property' && unit.nodeIds[0] === 'headline').length, 0);
  delete after.content[0].props.content[0].props.bindings; after.content[0].props.content[0].props.design.desktop.backgroundImage = '/uploads/new.jpg';
  ranges = buildAiDesignTreeRanges('page', '首页', before, after); assert.equal(ranges.units.filter(unit => unit.kind === 'property' && unit.nodeIds[0] === 'headline').length, 0);
  delete after.content[0].props.content[0].props.design.desktop.backgroundImage; const unit = buildAiDesignTreeRanges('page', '首页', before, after).units.find(unit => unit.kind === 'property')!, mask = aiDesignTreeMask(buildAiDesignTreeRanges('page', '首页', before, after), [unit.id]);
  const locked = structuredClone(before); locked.content[0].props.locked = true; assert.throws(() => mergeAiDesignTreeRanges('page', locked, before, after, mask), /锁定|绑定|结构/);
  after.content[0].props.content.reverse(); assert.equal(buildAiDesignTreeRanges('page', '首页', before, after).units.filter(unit => unit.kind === 'property').length, 0);
});
test('整块/内部/属性不可重复选择，未知ID拒绝，撤销恢复缺省样式容器', () => {
  const before = source(), after = structuredClone(before); delete before.content[0].props.content[1].props.design; after.content[0].props.content[1].props.design = { mobile: { color: '#3355ff' } };
  const ranges = buildAiDesignTreeRanges('footer', '页脚', before, after), property = ranges.units.find(unit => unit.kind === 'property')!, parent = ranges.units.find(unit => unit.id === property.parentId)!;
  assert.throws(() => aiDesignTreeMask(ranges, [property.id, parent.id]), /重复/); assert.throws(() => aiDesignTreeMask(ranges, ['property:invented']), /本方案/);
  const mask = aiDesignTreeMask(ranges, [property.id]), selected = mergeAiDesignTreeRanges('footer', before, before, after, mask).data, reversed = mergeAiDesignTreeRanges('footer', selected, selected, before, mask).data;
  assert.deepEqual(reversed, before); assert.equal(Object.hasOwn(reversed.content[0].props.content[1].props, 'design'), false);
});
