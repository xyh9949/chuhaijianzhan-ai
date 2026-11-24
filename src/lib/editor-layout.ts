import type { ComponentData, Data } from '@puckeditor/core';
import { namespaceBlockData } from './shared-blocks';
import {componentSlots,mapComponentSlots} from './editor-slots';

export interface EditorNode { id: string; type: string; label: string; zone: string; index: number; parentId?: string; ancestors: string[] }

// 同一份树用于图层按钮和移动目标；排除自身及后代，避免把容器移进自己的内容。
export function editorNodes(data: Data): EditorNode[] {
  const result: EditorNode[] = [];
  const walk = (nodes: ComponentData[], zone: string, ancestors: string[]) => nodes.forEach((node, index) => {
    result.push({ id: node.props.id, type: node.type, label: String(node.props.nodeLabel || node.props.text || node.props.title || node.type).slice(0, 36), zone, index, parentId: ancestors.at(-1), ancestors });
    componentSlots(node).forEach(slot=>walk(slot.content,`${node.props.id}:${slot.path}`,[...ancestors,node.props.id]));
  });
  walk(data.content, 'root:default-zone', []);
  return result;
}

export function moveTargets(data: Data, selectedId: string): EditorNode[] {
  return editorNodes(data).filter((node) => node.type === 'Container' && node.id !== selectedId && !node.ancestors.includes(selectedId));
}

/** 粘贴重建节点及锚点ID；内部链接指向副本，内容/样式的稳定资产引用继续复用。 */
export function cloneEditorNode(node: ComponentData, namespace = `paste-${crypto.randomUUID()}`): ComponentData {
  const data = namespaceBlockData({ root: { props: {} }, content: [structuredClone(node)] }, namespace);
  const anchors = new Map<string, string>();
  const visit = (value: unknown, update = false): void => {
    if (Array.isArray(value)) { value.forEach(v => visit(v, update)); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (!update && typeof item.anchor === 'string' && item.anchor) { const old = item.anchor; const next = `${namespace}-${anchors.size + 1}`; anchors.set(old, next); item.anchor = next; }
    if (update && typeof item.href === 'string' && item.href.startsWith('#') && anchors.has(item.href.slice(1))) item.href = `#${anchors.get(item.href.slice(1))}`;
    Object.values(item).forEach(v => visit(v, update));
  };
  visit(data); visit(data, true);
  return data.content[0];
}

// 快速布局只是可编辑容器和空插槽，不引入锁死的模板组件或额外的数据格式。
export function createLayoutPreset(kind: 'two' | 'three' | 'sidebar', makeId = () => `layout-${crypto.randomUUID()}`): ComponentData {
  const container = (content: ComponentData[], design: Record<string, unknown>): ComponentData => ({ type: 'Container', props: { id: makeId(), content, layout: 'column', columns: 2, mobileColumns: 1, gap: 24, padding: 24, inset: 24, background: '#ffffff', image: '', minHeight: 120, align: 'start', design } });
  const columns = kind === 'three' ? 3 : kind === 'sidebar' ? 3 : 2;
  const count = kind === 'three' ? 3 : 2;
  const children = Array.from({ length: count }, (_, index) => container([], { desktop: { backgroundColor: '#f3f5f8', borderRadius: 8, ...(kind === 'sidebar' && index === 1 ? { columnSpan: 2 } : {}) }, mobile: { columnSpan: 1, paddingTop: 20, paddingBottom: 20, paddingLeft: 20, paddingRight: 20 } }));
  return container(children, { desktop: { display: 'grid', columns, gap: 24, paddingTop: 40, paddingBottom: 40 }, tablet: { gap: 20 }, mobile: { columns: 1, gap: 16, paddingTop: 24, paddingBottom: 24, paddingLeft: 20, paddingRight: 20 } });
}

// 插入时不改动其他节点和旧 zones；通过 Puck setData 纳入同一撤销/自动保存链。
export function appendEditorNode(data: Data, node: ComponentData, parentId?: string): Data {
  return appendEditorNodeToZone(data,node,parentId?`${parentId}:content`:'root:default-zone');
}

/** 面板与容器共用 Puck zone 路径；插入只改目标 slot，其他项的顺序和内容保留。 */
export function appendEditorNodeToZone(data:Data,node:ComponentData,zone:string):Data{
  if(zone==='root:default-zone')return {...data,content:[...data.content,node]};
  let found = false;
  const walk = (nodes: ComponentData[]): ComponentData[] => nodes.map(item=>mapComponentSlots(item,slot=>{
    if(`${item.props.id}:${slot.path}`===zone){found=true;return [...slot.content,node];}
    return walk(slot.content);
  }));
  const content = walk(data.content);
  return found ? { ...data, content } : data;
}
