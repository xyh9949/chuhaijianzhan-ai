import type { Data } from '@puckeditor/core';
import type { PageItem, PageTemplate, StudioState } from './types';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 仅供模板资产的依赖检查，不用于真实URL路由/发布页面校验，避免虚拟模板替代实际详情入口。 */
export function templateValidationView<T extends Pick<StudioState, 'pages' | 'editorData'> & { pageTemplates?: PageTemplate[] }>(source: T) {
  const extra: PageItem[] = (source.pageTemplates || []).map(t => ({ id: t.id, title: `页面模板“${t.name}”`, slug: t.kind === 'product' ? '/products/:slug' : t.kind === 'entry' ? `/template-${t.id}/:slug` : `/template-${t.id}`, ...(t.kind === 'entry' ? { contentModelId: t.modelId } : {}), type: '模板资产检查', status: 'draft', updated: t.updated }));
  return { ...source, pages: [...source.pages, ...extra], editorData: { ...source.editorData, ...Object.fromEntries((source.pageTemplates || []).map(t => [t.id, t.data])) } };
}

/** 克隆声明式节点及局部集合ID；业务记录/表单/区块仍保持引用，模板和实例不会共享可变对象。 */
export function cloneTemplateData(data: unknown, options: { fromPageId?: string; toPageId?: string; fromPath?: string; toPath?: string; preserveNodeIds?: boolean } = {}) {
  const result = structuredClone(data), ids = new Map<string, string>();
  const nextId = (id: string) => { if (!ids.has(id)) ids.set(id, `node-${crypto.randomUUID()}`); return ids.get(id)!; };
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(visit); return; } if (!record(v)) return;
    if (typeof v.type === 'string' && record(v.props)) {
      if (!options.preserveNodeIds && typeof v.props.id === 'string') v.props.id = nextId(v.props.id);
      if (record(v.props.linkTarget) && v.props.linkTarget.kind === 'page' && v.props.linkTarget.id === options.fromPageId && options.toPageId) v.props.linkTarget.id = options.toPageId;
      if (typeof v.props.href === 'string' && options.fromPath && options.toPath && (v.props.href === options.fromPath || v.props.href.startsWith(`${options.fromPath}#`) || v.props.href.startsWith(`${options.fromPath}?`))) v.props.href = options.toPath + v.props.href.slice(options.fromPath.length);
      if (!options.preserveNodeIds && ['Gallery', 'Carousel', 'Tabs', 'Accordion'].includes(v.type)) for (const key of ['images', 'items']) if (Array.isArray(v.props[key])) for (const item of v.props[key]) if (record(item) && typeof item.id === 'string') item.id = `item-${crypto.randomUUID()}`;
    }
    Object.values(v).forEach(visit);
  }; visit(result);
  return { data: result as Data, nodeIds: ids };
}
