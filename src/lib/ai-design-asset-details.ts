import { createHash } from 'node:crypto';
import type { ComponentData, Data } from '@puckeditor/core';
import { sameAiPageData as same } from './ai-page-edit';
import { componentSlots, mapComponentSlots } from './editor-slots';
import { isComponentNodeId } from './component-contract';
import { DESIGN_FIELDS, validateDesign } from './responsive-style';
import { buildAiDesignSections, buildAiDesignDetails, mergeAiDesignSections } from './ai-design-sections';
import { withEditorRootDefaults } from './editor-root-defaults';

export type AiDesignRangeKind = 'section' | 'detail' | 'property';
/** 路径不由客户端提交；公开单位只描述服务器冻结快照中实际可分选的范围。 */
export interface AiDesignTreeUnit {
  id: string; label: string; description: string; kind: AiDesignRangeKind;
  parentId: string; nodeIds: string[]; rootId: string;
  group?: 'text' | 'layout' | 'typography' | 'appearance' | 'image';
  viewport?: 'desktop' | 'tablet' | 'mobile'; propertyNames?: string[];
  unavailableReason?: string;
}
export interface AiDesignTreeRanges { units: AiDesignTreeUnit[]; unavailableReason?: string; }
/** 私有mask仅保存服务器已核验的opaque ID；撤销时由原前后快照重新推导属性路径。 */
export interface AiDesignTreeMask { rootIds: string[]; detailIds: string[]; propertyIds: string[]; }
export interface AiDesignTreeMerge { data: Data; beforeForest: Data; afterForest: Data; }

type Position = { ancestors: string[]; steps: { slot: string; index: number }[] };
type Tree = { roots: string[]; nodes: Map<string, ComponentData>; positions: Map<string, Position> };
type PropertyPlan = { unit: AiDesignTreeUnit; paths: string[][] };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const nonSlots = (node: ComponentData) => mapComponentSlots(node, () => []);
const signature = (node: ComponentData) => componentSlots(node).map(slot => ({ path: slot.path, ids: slot.content.map(child => child.props.id) }));
const common = (data: Data) => { const { content: _content, zones: _zones, ...rest } = data; return rest; };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const devices = ['desktop', 'tablet', 'mobile'] as const;
const deviceNames = { desktop: '电脑', tablet: '平板', mobile: '手机' };
const typography = new Set(['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'fontFamily']);
const appearance = new Set(['color', 'backgroundColor', 'borderWidth', 'borderStyle', 'borderColor', 'borderRadius', 'opacity', 'shadow']);
const image = new Set(['objectFit', 'objectPosition', 'imageHeight', 'backgroundSize', 'backgroundPosition']);
const groupNames = { text: '文字', layout: '布局与间距', typography: '字体与排版', appearance: '颜色与外观', image: '图片裁切' };
const groupOf = (key: string): Exclude<AiDesignTreeUnit['group'], undefined | 'text'> => typography.has(key) ? 'typography' : appearance.has(key) ? 'appearance' : image.has(key) ? 'image' : 'layout';

/** 只识别原生插槽，节点/深度预算与旧section一致；业务JSON内的id不是可写图层。 */
function tree(data: Data): Tree {
  if (!object(data) || !Array.isArray(data.content) || data.content.length > 100 || data.zones !== undefined && (!object(data.zones) || Object.keys(data.zones).length)) throw Error('此布局无法安全分选，请采用完整区域');
  const nodes = new Map<string, ComponentData>(), positions = new Map<string, Position>();
  const visit = (node: ComponentData, position: Position) => {
    if (position.ancestors.length > 16 || nodes.size >= 300 || !object(node) || typeof node.type !== 'string' || !object(node.props) || !isComponentNodeId(node.props.id) || nodes.has(node.props.id)) throw Error('布局节点标识、嵌套或数量无法安全分选');
    nodes.set(node.props.id, node); positions.set(node.props.id, position);
    for (const slot of componentSlots(node)) slot.content.forEach((child, index) => visit(child, { ancestors: [...position.ancestors, node.props.id], steps: [...position.steps, { slot: slot.path, index }] }));
  };
  data.content.forEach((node, index) => visit(node, { ancestors: [], steps: [{ slot: '$page', index }] }));
  return { roots: data.content.map(node => node.props.id), nodes, positions };
}
function name(node: ComponentData): string {
  const plain = (value: unknown) => typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return Array.from(plain(node.props.nodeLabel) || plain(node.props.text) || ({ Heading: '标题', Text: '文字', ActionButton: '按钮', Container: '布局', Image: '图片', Navigation: '导航' } as Record<string, string>)[node.type] || '原生组件').slice(0, 50).join('');
}
/** 资源、绑定、业务配置及结构不得被属性mask绕过；text/design外的改变保持原子。 */
function guardProps(node: ComponentData) {
  const { text: _text, design: _design, nodeLabel: _label, ...props } = nonSlots(node).props;
  return { type: node.type, props };
}
function propertyPlans(key: string, label: string, before: Data, after: Data, parents: AiDesignTreeUnit[]): PropertyPlan[] {
  const old = tree(before), next = tree(after);
  if (!same(common(before), common(after)) || !same(old.roots, next.roots)) return [];
  const result: PropertyPlan[] = [];
  for (const [id, node] of old.nodes) {
    const newer = next.nodes.get(id), position = old.positions.get(id)!;
    if (!newer || node.type !== newer.type || !same(position, next.positions.get(id)) || !same(signature(node), signature(newer)) || !same(guardProps(node), guardProps(newer))) continue;
    if ([id, ...position.ancestors].some(owner => old.nodes.get(owner)?.props.locked === true || next.nodes.get(owner)?.props.locked === true)) continue;
    if ([...old.nodes].some(([child, entry]) => entry.props.locked === true && old.positions.get(child)!.ancestors.includes(id)) || [...next.nodes].some(([child, entry]) => entry.props.locked === true && next.positions.get(child)!.ancestors.includes(id))) continue;
    // 祖先结构变动及跨分支迁移不能拆出一个看似独立的属性。
    if (position.ancestors.some(owner => !next.nodes.has(owner) || !same(signature(old.nodes.get(owner)!), signature(next.nodes.get(owner)!)) || !same(old.positions.get(owner), next.positions.get(owner)))) continue;
    if (validateDesign(node.props.design).length || validateDesign(newer.props.design).length) continue;
    // 背景图片是资源依赖，不能从它的实际承载组件中拆出样式采用。
    if (devices.some(device => !same(node.props.design?.[device]?.backgroundImage, newer.props.design?.[device]?.backgroundImage))) continue;
    const containing = parents.filter(unit => unit.kind !== 'property' && unit.nodeIds.some(owner => owner === id || position.ancestors.includes(owner)));
    const parent = containing.sort((left, right) => (left.kind === 'detail' ? -1 : 1) - (right.kind === 'detail' ? -1 : 1))[0];
    if (!parent) continue;
    const add = (group: NonNullable<AiDesignTreeUnit['group']>, paths: string[][], viewport?: typeof devices[number]) => {
      if (!paths.length) return;
      result.push({ unit: { id: `property:p1:${hash(['p1', key, id, group, viewport, paths])}`, label: `${name(newer)} · ${viewport ? deviceNames[viewport] : ''}${groupNames[group]}`, description: `只采用“${label}”此组件的${viewport ? deviceNames[viewport] : ''}${groupNames[group]}；同组关联属性一起采用，其余文字、断点和样式保持。`, kind: 'property', parentId: parent.id, rootId: position.ancestors[0] || id, nodeIds: [id], group, ...(viewport ? { viewport } : {}), propertyNames: paths.map(path => path.at(-1)!) }, paths });
    };
    if (['Heading', 'Text', 'ActionButton'].includes(node.type) && !node.props.bindings?.text && !newer.props.bindings?.text && typeof node.props.text === 'string' && typeof newer.props.text === 'string' && node.props.text !== newer.props.text) add('text', [['text']]);
    for (const device of devices) {
      const groups = new Map<NonNullable<AiDesignTreeUnit['group']>, string[][]>();
      for (const field of Object.keys(DESIGN_FIELDS).filter(field => field !== 'backgroundImage')) if (!same(node.props.design?.[device]?.[field], newer.props.design?.[device]?.[field])) {
        const group = groupOf(field); groups.set(group, [...(groups.get(group) || []), ['design', device, field]]);
      }
      for (const [group, paths] of groups) add(group, paths, device);
    }
  }
  return result;
}

/** 同一套原生单位用于页面、头尾块和详情模板；旧page section/detail ID算法保持不变。 */
export function buildAiDesignTreeRanges(key: string, label: string, before: Data, after: Data): AiDesignTreeRanges {
  // 生成的头尾会补Puck根默认值；缺省与相同显式默认语义一致，不把补缺省误当共同风格变化。
  before = withEditorRootDefaults(before); after = withEditorRootDefaults(after);
  const sections = buildAiDesignSections(key, label, before, after);
  if (sections.unavailableReason) return { units: [], unavailableReason: sections.unavailableReason };
  const details = buildAiDesignDetails(key, label, before, after), units: AiDesignTreeUnit[] = [];
  for (const unit of sections.units) units.push({ ...unit, rootId: unit.nodeIds[0], ...(details.unavailableReasons?.[unit.id] ? { unavailableReason: details.unavailableReasons[unit.id] } : {}) });
  for (const unit of details.units) units.push({ ...unit });
  try {
    const properties = propertyPlans(key, label, before, after, units);
    // 一个承载区块的属性组完整提供；预算超限回退整块，不静默截断可选属性。
    if (units.length + properties.length <= 400) {
      units.push(...properties.map(item => item.unit));
      for (const unit of units) if (unit.unavailableReason && properties.some(item => item.unit.parentId === unit.id)) unit.unavailableReason = '完整子树在此保持整体；另外提供的文字或样式属性组可单独选择，其余配置不拆分。';
    }
    else for (const unit of units.filter(item => item.kind === 'section')) unit.unavailableReason = '细分属性超过预算，请先按完整区块选择。';
  } catch { /* 不安全历史布局沿用完整section，不将解析失败解释为零变化。 */ }
  return { units };
}
/** 只接受本候选服务器返回的ID；整体和后代、重叠子树均不能混选。 */
export function aiDesignTreeMask(ranges: AiDesignTreeRanges, ids: string[]): AiDesignTreeMask {
  const byId = new Map(ranges.units.map(unit => [unit.id, unit]));
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) throw Error('请选择本方案实际提供的范围');
  const chosen = ids.map(id => byId.get(id)!);
  for (const unit of chosen) {
    let parent = byId.get(unit.parentId);
    while (parent) { if (ids.includes(parent.id)) throw Error('整体与内部调整不能重复选择'); parent = byId.get(parent.parentId); }
    if (unit.kind === 'property' && chosen.some(other => other.kind === 'detail' && (other.nodeIds.includes(unit.nodeIds[0]) || other.rootId === unit.rootId && unit.parentId === other.id))) throw Error('完整内容与其中属性不能重复选择');
  }
  return { rootIds: chosen.filter(unit => unit.kind === 'section').flatMap(unit => unit.nodeIds), detailIds: chosen.filter(unit => unit.kind === 'detail').flatMap(unit => unit.nodeIds), propertyIds: chosen.filter(unit => unit.kind === 'property').map(unit => unit.id) };
}
const valueAt = (props: unknown, path: string[]) => { let cursor = props; for (const part of path) { if (!object(cursor) || !Object.hasOwn(cursor, part)) return undefined; cursor = cursor[part]; } return cursor; };
function setAt(props: Record<string, unknown>, path: string[], value: unknown, baseline: Record<string, unknown>) {
  let cursor = props; const parents: { value: Record<string, unknown>; part: string; path: string[] }[] = [];
  path.slice(0, -1).forEach((part, index) => { if (!object(cursor[part])) cursor[part] = {}; parents.push({ value: cursor, part, path: path.slice(0, index + 1) }); cursor = cursor[part] as Record<string, unknown>; });
  if (value === undefined) delete cursor[path.at(-1)!]; else cursor[path.at(-1)!] = structuredClone(value);
  // 撤销删除最后一个显式覆盖时恢复原缺省，不能留下伪造的空design/断点对象。
  for (const parent of parents.reverse()) if (object(parent.value[parent.part]) && !Object.keys(parent.value[parent.part] as object).length && valueAt(baseline, parent.path) === undefined) delete parent.value[parent.part];
}

/** 精确mask用于正向选择及反向撤销；只比较所选属性，保留同组件未选文字/样式的后来编辑。 */
export function mergeAiDesignTreeRanges(key: string, current: Data, before: Data, after: Data, mask: AiDesignTreeMask, reverse = false): AiDesignTreeMerge {
  const originalCurrent = current;
  current = withEditorRootDefaults(current); before = withEditorRootDefaults(before); after = withEditorRootDefaults(after);
  const preserveRoot = (result: AiDesignTreeMerge): AiDesignTreeMerge => ({ ...result, data: { ...structuredClone(originalCurrent), content: result.data.content } });
  const ranges = buildAiDesignTreeRanges(key, key, before, after), selection = ranges.units.filter(unit => unit.kind !== 'property' && (unit.kind === 'section' ? unit.nodeIds.some(id => mask.rootIds.includes(id)) : unit.nodeIds.some(id => mask.detailIds.includes(id)))).map(unit => unit.id);
  aiDesignTreeMask(ranges, [...selection, ...mask.propertyIds]);
  let merged: AiDesignTreeMerge = { data: structuredClone(current), beforeForest: { root: { props: {} }, content: [], zones: {} }, afterForest: { root: { props: {} }, content: [], zones: {} } };
  if (mask.rootIds.length || mask.detailIds.length) merged = mergeAiDesignSections(key, current, before, after, mask.rootIds, mask.detailIds, reverse);
  if (!mask.propertyIds.length) return preserveRoot(merged);
  // 属性路径身份由正向快照验证；逆向只交换值与比较基准，不重新解释服务器已冻结的选择范围。
  if (reverse) [before, after] = [after, before];
  const old = tree(before), next = tree(after), now = tree(current), plans = propertyPlans(key, key, before, after, ranges.units.filter(unit => unit.kind !== 'property')), chosen = plans.filter(plan => mask.propertyIds.includes(plan.unit.id));
  if (chosen.length !== mask.propertyIds.length || !same(now.roots, old.roots) || !same(common(current), common(before))) throw Error('所选属性的页面结构或共同配置已有变化');
  for (const { unit, paths } of chosen) {
    const id = unit.nodeIds[0], expected = old.nodes.get(id)!, actual = now.nodes.get(id), position = old.positions.get(id)!;
    if (!actual || !same(position, now.positions.get(id)) || !same(signature(expected), signature(actual)) || !same(guardProps(expected), guardProps(actual))) throw Error('所选属性的绑定、资源或结构已有变化');
    for (const owner of [id, ...position.ancestors]) {
      const node = now.nodes.get(owner), original = old.nodes.get(owner)!;
      if (!node || node.props.locked === true || !same(signature(original), signature(node)) || !same(guardProps(original), guardProps(node))) throw Error('所选属性或其共同父级已有锁定、绑定或结构变化');
    }
    if (paths.some(path => !same(valueAt(actual.props, path), valueAt(expected.props, path)))) throw Error('所选文字或样式已有后续修改，操作停止以保留工作');
    if ([...now.nodes].some(([child, entry]) => entry.props.locked === true && now.positions.get(child)!.ancestors.includes(id))) throw Error('所选共同样式会影响后来锁定的内部内容');
  }
  const byNode = new Map<string, PropertyPlan[]>(); for (const plan of chosen) byNode.set(plan.unit.nodeIds[0], [...(byNode.get(plan.unit.nodeIds[0]) || []), plan]);
  const visit = (node: ComponentData): ComponentData => {
    let result = mapComponentSlots(node, slot => slot.content.map(visit));
    if (byNode.has(node.props.id)) {
      const props = structuredClone(result.props); for (const plan of byNode.get(node.props.id)!) for (const path of plan.paths) setAt(props, path, valueAt(next.nodes.get(node.props.id)!.props, path), next.nodes.get(node.props.id)!.props);
      result = { ...result, props };
    }
    return result;
  };
  merged.data = { ...merged.data, content: merged.data.content.map(visit) }; tree(merged.data);
  // 属性不包含子树；依赖森林只核对该组件自身资源，不能把未选后代或重复节点夹进来。
  for (const id of byNode.keys()) { merged.beforeForest.content.push(structuredClone(nonSlots(old.nodes.get(id)!))); merged.afterForest.content.push(structuredClone(nonSlots(next.nodes.get(id)!))); }
  return preserveRoot(merged);
}
