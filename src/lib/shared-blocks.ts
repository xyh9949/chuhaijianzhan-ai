import { effectiveLayoutBlockId, layoutBlockIds } from './site-layout-locales';
import { localeOf, siteLocales } from './localization';
import type { Data } from '@puckeditor/core';
import type { PageItem, SharedBlock, SiteLayout } from './types';

export const SHARED_BLOCK_MAX_DEPTH = 8;
export const SHARED_BLOCK_MAX_NODES = 10000;
export const CONTENT_LOOP_MAX_ITEMS = 50;

/** 图缓存只计算展开成本，不生成节点副本；同一块重复引用按次数累计，阻止指数放大。 */
export function createSharedBlockNodeCounter(sharedBlocks: SharedBlock[] = []) {
  const blocks = new Map(sharedBlocks.map((block) => [block.id, block]));
  const costs = new Map<string, number>(); const visiting = new Set<string>();
  const blockCost = (id: string): number => {
    if (visiting.has(id) || visiting.size >= SHARED_BLOCK_MAX_DEPTH) return SHARED_BLOCK_MAX_NODES + 1;
    if (!costs.has(id)) {
      visiting.add(id); costs.set(id, count(blocks.get(id)?.data)); visiting.delete(id);
    }
    return costs.get(id)!;
  };
  const count = (value: unknown): number => {
    if (!value || typeof value !== 'object') return 0;
    if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum > SHARED_BLOCK_MAX_NODES ? sum : sum + count(item), 0);
    const node = value as Record<string, unknown>;
    const props = node.props as Record<string, unknown> | undefined;
    let sum = typeof node.type === 'string' ? 1 : 0;
    if (node.type === 'SharedBlock' && typeof props?.blockId === 'string') sum += blockCost(props.blockId);
    // 按配置上限预估重复卡片，内容记录以后增加也不能让已通过的布局指数展开。
    if (node.type === 'ContentLoop' && typeof props?.itemBlockId === 'string') {
      const size = (props.query as { pageSize?: number } | undefined)?.pageSize ?? props.count;
      const repeat = Number.isInteger(size) ? Math.max(1, Math.min(CONTENT_LOOP_MAX_ITEMS, Number(size))) : CONTENT_LOOP_MAX_ITEMS;
      sum += repeat * blockCost(props.itemBlockId);
    }
    for (const item of Object.values(node)) { if (sum > SHARED_BLOCK_MAX_NODES) break; sum += count(item); }
    return Math.min(SHARED_BLOCK_MAX_NODES + 1, sum);
  };
  return count;
}

/** 只识别实际的同步引用与循环卡片；普通文案中的同名字段不是依赖。 */
export function getSharedBlockReferences(data: unknown): string[] {
  const references = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    const props = node.props as Record<string, unknown> | undefined;
    if (node.type === 'SharedBlock' && typeof props?.blockId === 'string' && props.blockId) references.add(props.blockId);
    if (node.type === 'ContentLoop' && typeof props?.itemBlockId === 'string' && props.itemBlockId) references.add(props.itemBlockId);
    Object.values(node).forEach(visit);
  };
  visit(data);
  return [...references];
}

/** 卡片可嵌套同步区块，但闭包内禁止再次循环，保存和公开渲染共用此边界。 */
export function sharedBlockContainsLoop(blockId: string, sharedBlocks: SharedBlock[] = []): boolean {
  const blocks = new Map(sharedBlocks.map(block => [block.id, block])), seen = new Set<string>();
  const contains = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(contains);
    const node = value as Record<string, unknown>;
    return node.type === 'ContentLoop' || Object.values(node).some(contains);
  };
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const data = blocks.get(id)?.data;
    return contains(data) || getSharedBlockReferences(data).some(visit);
  };
  return visit(blockId);
}

export type SharedBlockUsageSource = {
  pages: PageItem[]; editorData: Record<string, unknown>; sharedBlocks?: SharedBlock[]; siteLayout?: SiteLayout; settings?: Pick<import('./types').SiteSettings,'language'|'locales'>;
};

/** 删除提示和发布影响清单共用传递依赖；页面主动隐藏的页眉/页脚不算使用。 */
export function getSharedBlockUsage(blockId: string, source: SharedBlockUsageSource) {
  const blocks = new Map((source.sharedBlocks || []).map((block) => [block.id, block]));
  const references = (ids: string[], seen = new Set<string>()): boolean => ids.some((id) => {
    if (id === blockId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return references(getSharedBlockReferences(blocks.get(id)?.data), seen);
  });
  const layoutSlots = (['header', 'footer'] as const).filter((slot) => references(layoutBlockIds(source.siteLayout?.[slot])));
  return {
    pageIds: source.pages.filter((page) => {
      const data = source.editorData[page.id] as Data | undefined;
      const root = (data?.root as { props?: Record<string, unknown> })?.props || {};
      return references(getSharedBlockReferences(data)) || root.showChrome !== 'no' && layoutSlots.some((slot) => root[`${slot}Mode`] !== 'hidden' && (page.slug.includes(':')?siteLocales(source.settings).map(item=>item.code):[localeOf(source.settings,page)]).some(locale=>{const id=effectiveLayoutBlockId(source.siteLayout?.[slot],source.settings,locale);return !!id&&references([id]);}));
    }).map((page) => page.id),
    blockIds: (source.sharedBlocks || []).filter((block) => block.id !== blockId && references(getSharedBlockReferences(block.data))).map((block) => block.id),
    layoutSlots,
  };
}

/** 每个引用实例拥有独立节点 ID，避免复用同一区块时响应式 CSS 覆盖彼此。也可用于复制区块。 */
export function namespaceBlockData(data: Data, namespace: string, sourceIds?: Map<string, string>): Data {
  const ids = new Map<string, string>();
  const mapId = (id: string) => {
    // 重新编号而非累加旧 ID，反复复制也不会突破保存端的 100 字符限制。
    if (!ids.has(id)) {
      const renderedId = `${namespace}--${ids.size + 1}`;
      ids.set(id, renderedId);
      sourceIds?.set(renderedId, id);
    }
    return ids.get(id)!;
  };
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    const copy = Object.fromEntries(Object.entries(node).map(([key, item]) => [key, visit(item)]));
    if (typeof node.type === 'string' && node.props && typeof node.props === 'object') {
      const props = copy.props as Record<string, unknown>;
      if (typeof props.id === 'string') props.id = mapId(props.id);
    }
    return copy;
  };
  const result = visit(data) as Data;
  // 兼容旧版 Puck zones；当前 slot 数据递归在 props 内，不需要特殊处理。
  if (result.zones) result.zones = Object.fromEntries(Object.entries(result.zones).map(([key, value]) => {
    const separator = key.indexOf(':');
    return [separator > 0 ? `${mapId(key.slice(0, separator))}${key.slice(separator)}` : key, value];
  }));
  return result;
}
