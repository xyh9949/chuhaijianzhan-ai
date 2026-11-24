import test from 'node:test';
import assert from 'node:assert/strict';
import type { Data } from '@puckeditor/core';
import { analyzeAiDesignDifference } from '../src/lib/ai-design-difference';

const paragraph = 'This synthetic company prepares furniture information for project buyers. Product materials, drawings and application requirements are reviewed together before discussing a proposal. The sample describes an information workflow only and provides no certification, production capacity, delivery date or actual customer claim. Buyers can review the available furniture categories and contact the team with their own technical requirements.';
function page(prefix = 'old'): Data {
  return { root: { props: {} }, content: [{ type: 'Container', props: { id: `${prefix}-section`, content: [{ type: 'Heading', props: { id: `${prefix}-h1`, text: 'Furniture information', level: 'h1', color: '#112233' } }, { type: 'Text', props: { id: `${prefix}-body`, text: paragraph, color: '#334455' } }, { type: 'Heading', props: { id: `${prefix}-h2`, text: 'Discuss requirements', level: 'h2', color: '#112233' } }] } }], zones: {} } as Data;
}
function nodes(data: Data) { return (data.content[0].props as any).content as any[]; }

test('随机节点ID和对象键序不算差异，比较保持纯函数且不会修改输入', () => {
  const before = page(), after = page('new'), snapshot = structuredClone({ before, after });
  const result = analyzeAiDesignDifference(before, after);
  assert.equal(result.structureChanged, false); assert.equal(result.layoutChanged, false); assert.equal(result.typographyChanged, false); assert.equal(result.colorsChanged, false); assert.equal(result.copyChanged, false);
  assert.deepEqual({ before, after }, snapshot);
});
test('同父级同类型节点重排独立于文案变化，纯改字不冒充结构调整', () => {
  const before = page(), reordered = page('new'); nodes(reordered).reverse();
  const moving = analyzeAiDesignDifference(before, reordered); assert.equal(moving.structureChanged, true); assert.equal(moving.copyChanged, false);
  const copy = page(); nodes(copy)[1].props.text += ' Additional reviewed information.';
  const edited = analyzeAiDesignDifference(before, copy); assert.equal(edited.copyChanged, true); assert.equal(edited.structureChanged, false); assert.equal(edited.layoutChanged, false); assert.equal(edited.typographyChanged, false); assert.equal(edited.colorsChanged, false);
});
test('同形容器也能按内容锚点发现顺序调整，不依赖随机ID', () => {
  const before = page(), second = structuredClone(before.content[0]); second.props.id = 'second'; second.props.content[0].props.text = 'Another topic'; before.content.push(second);
  const after = structuredClone(before); after.content.reverse();
  const result = analyzeAiDesignDifference(before, after); assert.equal(result.structureChanged, true); assert.equal(result.copyChanged, false);
});
test('分别识别三端几何/字体/配色，只有换色时明确提示结构保持', () => {
  const before = page(), geometry = page(); geometry.content[0].props.design = { mobile: { paddingLeft: 16, columns: 1 } };
  assert.equal(analyzeAiDesignDifference(before, geometry).layoutChanged, true);
  const font = page(); nodes(font)[0].props.design = { desktop: { fontFamily: 'mono', fontWeight: 700 } };
  const typo = analyzeAiDesignDifference(before, font); assert.equal(typo.typographyChanged, true); assert.equal(typo.structureChanged, false); assert.equal(typo.colorsChanged, false);
  const color = page(); nodes(color)[0].props.color = '#775533';
  const painted = analyzeAiDesignDifference(before, color); assert.equal(painted.colorsChanged, true); assert.equal(painted.layoutChanged, false); assert.equal(painted.typographyChanged, false); assert.equal(painted.copyChanged, false); assert.ok(painted.warnings.some(warning => warning.includes('主要调整了配色')));
});
test('仅长静态正文+标题顺序+结构同时接近才提示当前实例其他页，结果不含唯一性分数', () => {
  const before = page(), exact = page('peer'), different = page('different'); nodes(different)[0].props.text = 'Different business purpose';
  const result = analyzeAiDesignDifference(before, before, [{ pageId: 'exact', title: 'Similar page', data: exact }, { pageId: 'different', title: 'Different page', data: different }, { pageId: 'exact', title: 'Duplicate input', data: exact }]);
  assert.deepEqual(result.similarPages.map(item => item.pageId), ['exact']); assert.match(result.similarPages[0].reason, /当前实例/); assert.equal(Object.hasOwn(result, 'score'), false);
  const short = page(); nodes(short)[1].props.text = 'A short shared introduction.'; assert.equal(analyzeAiDesignDifference(short, short, [{ pageId: 'short', title: 'Short', data: structuredClone(short) }]).similarPages.length, 0);
});
test('共同页眉页脚、产品详情和动态绑定占位文字不产生重复误报', () => {
  const a = page(), b = page('peer'); nodes(a)[1].props.text = 'Unique A'; nodes(b)[1].props.text = 'Unique B';
  for (const data of [a, b]) data.content.push({ type: 'Container', props: { id: 'shared-footer', nodeLabel: 'AI生成页面页脚', content: [{ type: 'Text', props: { id: 'shared-long-copy', text: paragraph.repeat(3) } }] } });
  assert.equal(analyzeAiDesignDifference(a, a, [{ pageId: 'b', title: 'B', data: b }]).similarPages.length, 0);
  const product = page(); product.content.push({ type: 'ProductDetail', props: { id: 'dynamic-product', productId: '' } });
  assert.equal(analyzeAiDesignDifference(product, product, [{ pageId: 'product-peer', title: 'Same template', data: structuredClone(product) }]).similarPages.length, 0);
  const bound = page(); nodes(bound)[1].props.bindings = { text: { source: 'product', field: 'description' } };
  assert.equal(analyzeAiDesignDifference(bound, bound, [{ pageId: 'bound', title: 'Bound template', data: structuredClone(bound) }]).similarPages.length, 0);
});
