import { createHash } from 'node:crypto';
import type { ComponentData, Data } from '@puckeditor/core';
import type { AiSiteDesignDetailUnit, AiSiteDesignSectionUnit } from './ai-site-design-types';
import { sameAiPageData } from './ai-page-edit';
import { isComponentNodeId } from './component-contract';
import { componentSlots, mapComponentSlots } from './editor-slots';

export const MAX_AI_DESIGN_SECTION_ROOTS = 100;
export const MAX_AI_DESIGN_SECTION_UNITS = 200;
export interface AiDesignSections { units: AiSiteDesignSectionUnit[]; unavailableReason?: string; }
export interface AiDesignDetails { units: AiSiteDesignDetailUnit[]; unavailableReasons?: Record<string, string>; }
export interface AiDesignSectionMerge { data: Data; beforeForest: Data; afterForest: Data; }
type NodePosition = { ancestors: string[]; steps: { slot: string; index: number }[] };
type Forest = { roots: string[]; owners: Map<string, string>; nodes: Map<string, ComponentData>; positions: Map<string, NodePosition> };
type Gap = { before: string[]; after: string[] };
type SectionGroup = { nodeIds: string[]; structural: boolean };
type SectionPlan = { old: Forest; next: Forest; anchors: string[]; gaps: Gap[]; groups: SectionGroup[] };
type DetailTarget = { rootId: string; nodeId: string; parentId: string };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** 只沿编辑器声明的插槽识别节点；不把业务JSON内的id误当图层，也不执行任意路径。 */
function forest(data: Data): Forest {
  if (!object(data) || !Array.isArray(data.content)) throw Error('页面布局格式不完整，请整页采用');
  if (data.content.length > MAX_AI_DESIGN_SECTION_ROOTS) throw Error('页面顶层区块超过100个，请整页采用');
  if (data.zones !== undefined && (!object(data.zones) || Object.keys(data.zones).length > 0)) throw Error('页面包含旧版独立插槽，请整页采用');
  const owners = new Map<string, string>(), nodes = new Map<string, ComponentData>(), positions = new Map<string, NodePosition>(), roots: string[] = [];
  const visit = (node: ComponentData, rootId: string, depth: number, position: NodePosition) => {
    if (depth > 16 || nodes.size >= 300) throw Error('页面区块超过可分选的嵌套或节点预算，请整页采用');
    if (!object(node) || typeof node.type !== 'string' || !object(node.props) || !isComponentNodeId(node.props.id)) throw Error('页面节点缺少稳定标识，请整页采用');
    if (nodes.has(node.props.id)) throw Error('页面包含重复节点标识，请整页采用');
    owners.set(node.props.id, rootId); nodes.set(node.props.id, node); positions.set(node.props.id, position);
    for (const slot of componentSlots(node)) for (const [index, child] of slot.content.entries()) visit(child, rootId, depth + 1, { ancestors: [...position.ancestors, node.props.id], steps: [...position.steps, { slot: slot.path, index }] });
  };
  for (const [index, node] of data.content.entries()) {
    if (!object(node) || !object(node.props) || !isComponentNodeId(node.props.id)) throw Error('页面节点缺少稳定标识，请整页采用');
    roots.push(node.props.id); visit(node, node.props.id, 0, { ancestors: [], steps: [{ slot: '$page', index }] });
  }
  return { roots, owners, nodes, positions };
}

/** 根样式/显隐等共同属性不能偷偷跟随一个区块采用；空zones兼容旧快照缺省值。 */
function common(data: Data): unknown { const { content: _content, zones: _zones, ...rest } = data; return rest; }
/** LCS只确定始终存在的骨架；同一空隙的替换不可拆，跨空隙移动和跨根后代迁移自动并组。 */
function plan(before: Data, after: Data): SectionPlan {
  const old = forest(before), next = forest(after);
  if (!sameAiPageData(common(before), common(after))) throw Error('本次包含页面共同样式或显隐变化，请整页采用');
  const lengths = Array.from({ length: old.roots.length + 1 }, () => Array<number>(next.roots.length + 1).fill(0));
  for (let i = old.roots.length - 1; i >= 0; i--) for (let j = next.roots.length - 1; j >= 0; j--) lengths[i][j] = old.roots[i] === next.roots[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const anchors: string[] = [];
  for (let i = 0, j = 0; i < old.roots.length && j < next.roots.length;) {
    if (old.roots[i] === next.roots[j]) { anchors.push(old.roots[i]); i++; j++; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++; else j++;
  }
  const gaps: Gap[] = []; let oldIndex = 0, nextIndex = 0;
  for (const anchor of [...anchors, undefined]) {
    const oldEnd = anchor === undefined ? old.roots.length : old.roots.indexOf(anchor, oldIndex), nextEnd = anchor === undefined ? next.roots.length : next.roots.indexOf(anchor, nextIndex);
    gaps.push({ before: old.roots.slice(oldIndex, oldEnd), after: next.roots.slice(nextIndex, nextEnd) }); oldIndex = oldEnd + 1; nextIndex = nextEnd + 1;
  }
  const order = [...old.roots, ...next.roots.filter(id => !old.roots.includes(id))], parent = new Map(order.map(id => [id, id])), active = new Set<string>(), structural = new Set<string>();
  const find = (id: string): string => { const owner = parent.get(id)!; if (owner === id) return id; const root = find(owner); parent.set(id, root); return root; };
  const join = (ids: string[]) => { if (!ids.length) return; const root = find(ids[0]); for (const id of ids) { active.add(id); parent.set(find(id), root); } };
  for (const gap of gaps) { const ids = [...new Set([...gap.before, ...gap.after])]; join(ids); ids.forEach(id => structural.add(id)); }
  for (const id of anchors) if (!sameAiPageData(old.nodes.get(id), next.nodes.get(id))) active.add(id);
  for (const [id, owner] of old.owners) { const nextOwner = next.owners.get(id); if (nextOwner !== undefined && owner !== nextOwner) join([owner, nextOwner]); }
  const members = new Map<string, string[]>();
  for (const id of order) if (active.has(id)) { const root = find(id); members.set(root, [...(members.get(root) || []), id]); }
  const groups = [...members.values()].map(nodeIds => ({ nodeIds, structural: nodeIds.some(id => structural.has(id)) }));
  return { old, next, anchors, gaps, groups };
}
function label(node: ComponentData, index: number): string {
  const names: Record<string, string> = { Container: '布局区块', Heading: '标题区块', Text: '文字区块', RichText: '正文区块', Image: '图片区块', ProductList: '产品列表', ContentList: '内容列表', ContentLoop: '动态列表', Tabs: '标签页', Accordion: '折叠面板', Carousel: '轮播区块', SharedBlock: '同步区块', Gallery: '图集' };
  const plain = (value: unknown) => typeof value === 'string' ? value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const shorten = (value: string, length: number) => Array.from(value).slice(0, length).join('');
  const custom = plain(node.props.nodeLabel);
  if (custom) return shorten(custom, 80);
  // 按可见内容辨认区块，标题只从真实插槽有界查找，绝不扫描业务JSON或生成额外AI文案。
  let scanned = 0;
  const firstHeading = (entry: ComponentData, depth: number): string => {
    if (++scanned > 300 || depth > 16) return '';
    if (entry.type === 'Heading') { const heading = plain(entry.props.text) || plain(entry.props.title); if (heading) return heading; }
    for (const slot of componentSlots(entry)) for (const child of slot.content) { const heading = firstHeading(child, depth + 1); if (heading) return heading; }
    return '';
  };
  const detail = plain(node.props.title) || plain(node.props.text) || (node.type === 'Image' ? plain(node.props.alt) : '') || firstHeading(node, 0), name = names[node.type] || '页面区块';
  return detail ? `${name}·${shorten(detail, 60)}` : `${name} ${index + 1}`;
}

function unitsOf(pageId: string, pageLabel: string, source: SectionPlan): AiSiteDesignSectionUnit[] {
  return source.groups.map(group => {
    const { nodeIds, structural } = group;
    // 新结构语义独立命名并冻结根列表签名，绝不让旧单根选择记录被解释成移动/删除组。
    const legacy = !structural && nodeIds.length === 1, identity = legacy ? [pageId, nodeIds] : ['g1', pageId, source.old.roots, source.next.roots, nodeIds];
    const id = `${legacy ? 'section:' : 'section:g1:'}${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
    const names = nodeIds.map(rootId => label(source.next.nodes.get(rootId) || source.old.nodes.get(rootId)!, Math.max(0, source.next.roots.indexOf(rootId))));
    const added = nodeIds.some(rootId => !source.old.roots.includes(rootId)), deleted = nodeIds.some(rootId => !source.next.roots.includes(rootId));
    const action = structural ? added && deleted ? '替换区块' : added ? '新增区块' : deleted ? '删除区块' : '移动区块' : '关联区块';
    const groupLabel = legacy ? names[0] : `${action}·${names.join('、')}`.slice(0, 80);
    return { id, label: groupLabel, area: 'page', pageIds: [pageId], parentId: `page:${pageId}`, nodeIds, kind: 'section', description: legacy ? `只采用“${pageLabel}”中此顶层区块的完整内容、嵌套布局和样式；所需动态卡片与素材一起核对。` : `将“${pageLabel}”中这组顶层区块的${structural ? '增删、位置及关联内容' : '跨区块关联内容'}一起采用，避免遗漏或重复；所需动态卡片与素材一起核对。` };
  });
}

const nonSlots = (node: ComponentData) => mapComponentSlots(node, () => []);
const slotSignature = (node: ComponentData) => componentSlots(node).map(slot => ({ path: slot.path, children: slot.content.map(child => child.props.id) }));

/** 稳定骨架才下钻；跨分支迁移停在共同父树，避免把同一节点的移出/移入分成两项。 */
function detailTargets(pageId: string, source: SectionPlan): { targets: DetailTarget[]; unavailableReasons: Record<string, string> } {
  const targets: DetailTarget[] = [], unavailableReasons: Record<string, string> = {};
  const branches = (node: ComponentData) => {
    const result = new Map<string, string>();
    const visit = (entry: ComponentData, branchId: string) => { result.set(entry.props.id, branchId); for (const slot of componentSlots(entry)) for (const child of slot.content) visit(child, branchId); };
    for (const slot of componentSlots(node)) for (const child of slot.content) visit(child, child.props.id);
    return result;
  };
  const frontier = (before: ComponentData, after: ComponentData): string[] => {
    if (sameAiPageData(before, after)) return [];
    if (!sameAiPageData(nonSlots(before), nonSlots(after)) || !sameAiPageData(slotSignature(before), slotSignature(after))) return [before.props.id];
    const oldBranches = branches(before), nextBranches = branches(after);
    for (const [id, branch] of oldBranches) if (nextBranches.has(id) && nextBranches.get(id) !== branch) return [before.props.id];
    const nextSlots = componentSlots(after);
    return componentSlots(before).flatMap((slot, slotIndex) => slot.content.flatMap((child, childIndex) => frontier(child, nextSlots[slotIndex].content[childIndex])));
  };
  for (const section of unitsOf(pageId, pageId, source)) {
    if (section.nodeIds.length !== 1 || section.id.startsWith('section:g1:')) { unavailableReasons[section.id] = '这组区块包含关联结构，请整体采用。'; continue; }
    const rootId = section.nodeIds[0], ids = frontier(source.old.nodes.get(rootId)!, source.next.nodes.get(rootId)!);
    if (ids.length === 1 && ids[0] === rootId) { unavailableReasons[section.id] = '此区块的共同样式、配置或结构需要一起采用。'; continue; }
    targets.push(...ids.map(nodeId => ({ rootId, nodeId, parentId: section.id })));
  }
  return { targets, unavailableReasons };
}

/** 精细单位是覆盖全部变化的不重叠子树前沿，既不拆属性，也不拆关联结构组。 */
export function buildAiDesignDetails(pageId: string, pageLabel: string, before: Data, after: Data): AiDesignDetails {
  try {
    const source = plan(before, after), { targets, unavailableReasons } = detailTargets(pageId, source);
    const units: AiSiteDesignDetailUnit[] = targets.map(({ rootId, nodeId, parentId }) => ({
      id: `detail:d1:${createHash('sha256').update(JSON.stringify(['d1', pageId, rootId, nodeId, source.old.positions.get(nodeId), source.next.positions.get(nodeId)])).digest('hex').slice(0, 32)}`,
      label: label(source.next.nodes.get(nodeId)!, source.next.positions.get(nodeId)!.steps.at(-1)!.index), area: 'page', pageIds: [pageId], parentId, rootId, nodeIds: [nodeId], kind: 'detail',
      description: `只采用“${pageLabel}”中此项完整内容、嵌套布局及样式；共同父级配置保持，所需卡片和素材一起核对。`,
    }));
    return { units, ...(Object.keys(unavailableReasons).length ? { unavailableReasons } : {}) };
  } catch { return { units: [] }; }
}

/** 单位根据冻结前后快照重算，哈希只用于无歧义身份；部分采用从不裁剪模型操作日志。 */
export function buildAiDesignSections(pageId: string, pageLabel: string, before: Data, after: Data): AiDesignSections {
  try {
    return { units: unitsOf(pageId, pageLabel, plan(before, after)) };
  } catch (error) { return { units: [], unavailableReason: error instanceof Error ? error.message : '此布局无法安全拆分，请整页采用' }; }
}

/** 当前草稿只替换选中完整子树，保留同页未选区块的手改；派生候选仍按完整页面安全采用/撤销。 */
export function mergeAiDesignSections(pageId: string, current: Data, before: Data, after: Data, nodeIds: string[], detailNodeIds: string[] = [], reverse = false): AiDesignSectionMerge {
  const forward = plan(before, after);
  // 撤销沿用正向冻结骨架和依赖组，只交换各空隙的来源/目标；重跑反向LCS会在同长骨架中换组选中身份。
  const source: SectionPlan = reverse ? { ...forward, old: forward.next, next: forward.old, gaps: forward.gaps.map(gap => ({ before: gap.after, after: gap.before })) } : forward;
  const known = new Set(source.groups.flatMap(group => group.nodeIds));
  if (!Array.isArray(nodeIds) || !Array.isArray(detailNodeIds) || !nodeIds.length && !detailNodeIds.length || new Set(nodeIds).size !== nodeIds.length || nodeIds.some(id => !known.has(id))) throw Error('所选区块已失效，请重新选择服务器提供的区块');
  const targets = detailTargets(pageId, source).targets, knownDetails = new Map(targets.map(target => [target.nodeId, target])), selectedDetails = new Set(detailNodeIds);
  if (selectedDetails.size !== detailNodeIds.length || detailNodeIds.some(id => !knownDetails.has(id))) throw Error('所选内容已失效，请重新选择服务器提供的细分内容');
  const selected = new Set(nodeIds), { old, next } = source, now = forest(current);
  if (detailNodeIds.some(id => selected.has(knownDetails.get(id)!.rootId))) throw Error('同一区块请选择整体或其中内容，不能重复选择');
  for (const group of source.groups) if (group.nodeIds.some(id => selected.has(id)) && !group.nodeIds.every(id => selected.has(id))) throw Error('关联区块必须整组采用，请重新选择服务器提供的区块组');
  if (!sameAiPageData(now.roots, old.roots) || !sameAiPageData(common(current), common(reverse ? after : before))) throw Error('页面结构或共同样式已有修改，请保留工作后重新设计');
  for (const id of selected) if (old.roots.includes(id) && !sameAiPageData(now.nodes.get(id), old.nodes.get(id))) throw Error('所选区块已有修改或锁定变化，请保留工作后重新设计');
  for (const id of selectedDetails) {
    if (!sameAiPageData(now.nodes.get(id), old.nodes.get(id)) || !sameAiPageData(now.positions.get(id), old.positions.get(id))) throw Error('所选内容已有修改或位置变化，请保留工作后重新设计');
    for (const ancestor of old.positions.get(id)!.ancestors) if (!now.nodes.has(ancestor) || !sameAiPageData(nonSlots(now.nodes.get(ancestor)!), nonSlots(old.nodes.get(ancestor)!)) || !sameAiPageData(slotSignature(now.nodes.get(ancestor)!), slotSignature(old.nodes.get(ancestor)!))) throw Error('所选内容的共同父级配置或结构已有变化，请保留工作后重新设计');
  }
  const content: ComponentData[] = [];
  for (let index = 0; index < source.gaps.length; index++) {
    const gap = source.gaps[index], useAfter = [...gap.before, ...gap.after].some(id => selected.has(id));
    for (const id of useAfter ? gap.after : gap.before) content.push(structuredClone((useAfter ? next : now).nodes.get(id)!));
    const anchor = source.anchors[index];
    if (anchor !== undefined) content.push(structuredClone((selected.has(anchor) ? next : now).nodes.get(anchor)!));
  }
  const detailTree = (node: ComponentData): ComponentData => selectedDetails.has(node.props.id) ? structuredClone(next.nodes.get(node.props.id)!) : mapComponentSlots(node, slot => slot.content.map(detailTree));
  const data = { ...structuredClone(current), content: selectedDetails.size ? content.map(detailTree) : content };
  // 未选区块后来可能占用了候选的新节点ID，合并后再查一遍，禁止悄悄制造重复身份。
  const merged = forest(data);
  // 完整候选的增删可能抵消位置，部分选择后必须再次保护当前锁，包含新加锁和全部祖先插槽位置。
  for (const [id, node] of now.nodes) if (node.props.locked === true) {
    const position = now.positions.get(id)!;
    if (!sameAiPageData(node, merged.nodes.get(id)) || now.owners.get(id) !== merged.owners.get(id) || !sameAiPageData(position, merged.positions.get(id)) || position.ancestors.some(ancestor => !merged.nodes.has(ancestor) || !sameAiPageData(nonSlots(now.nodes.get(ancestor)!), nonSlots(merged.nodes.get(ancestor)!)))) throw Error('此次组合会移动或影响锁定区块，请一起选择相关变动，或保留锁定范围重新设计');
  }
  const fragment = (source: Forest): Data => ({ root: { props: {} }, content: [...source.roots.filter(id => selected.has(id)), ...detailNodeIds].map(id => source.nodes.get(id)).filter((node): node is ComponentData => node !== undefined).map(node => structuredClone(node)), zones: {} });
  return { data, beforeForest: fragment(old), afterForest: fragment(next) };
}
