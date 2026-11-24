import { effectiveLayoutBlockId } from './site-layout-locales';
import { CONTENT_LOOP_MAX_ITEMS, createSharedBlockNodeCounter, namespaceBlockData, SHARED_BLOCK_MAX_DEPTH, SHARED_BLOCK_MAX_NODES } from './shared-blocks';
import { loopParam, queryContent, type QueryParams } from './content-query';
import type { BindingContext, ContentQuery } from './types';
import type { SiteSnapshot } from '@/server/types';
import type { ResolvedSitePage } from './site-routing';
import { relationLoopIds } from './content-relations';
import { localeOf } from './localization';

/** 只用当前渲染布局拥有的查询参数生成 SEO 和越界结果，避免给无关查询创建可索引网址。 */
export function readLoopUrlState(snapshot: SiteSnapshot, resolved: ResolvedSitePage, params: QueryParams) {
  const state = { pagination: new URLSearchParams(), filtered: false, invalid: false };
  if (!Object.keys(params).some(key => /^(page|search|term)_/.test(key))) return state;

  const querySource = { ...snapshot, locale: localeOf(snapshot.settings, resolved.entry || resolved.product || resolved.page) };
  const root = (resolved.data.root?.props || {}) as { bindingContext?: BindingContext; showChrome?: string; headerMode?: string; footerMode?: string };
  const runtime = {
    productId: resolved.product?.id || (root.bindingContext?.source === 'product' ? root.bindingContext.recordId : undefined),
    bindingContext: resolved.entry ? { source: 'entry' as const, recordId: resolved.entry.id, modelId: resolved.entry.modelId } : root.bindingContext,
  };
  const blocks = new Map(snapshot.sharedBlocks?.map(block => [block.id, block]));
  const chrome = (['header', 'footer'] as const).flatMap(slot => {
    if (root.showChrome === 'no' || root[`${slot}Mode`] === 'hidden') return [];
    const id = effectiveLayoutBlockId(snapshot.siteLayout?.[slot], snapshot.settings, querySource.locale);
    return id ? [{ id, slot }] : [];
  });
  let visits = 0;
  // 同步区块的深度、展开预算和实例命名空间沿用渲染规则；未渲染的头尾不参与 SEO。
  const countNodes = createSharedBlockNodeCounter(snapshot.sharedBlocks);
  let withinBudget: boolean | undefined;
  function walkBlock(blockId: string, instanceId: string, path: string[]) {
    const block = blocks.get(blockId);
    if (!Array.isArray(block?.data?.content) || path.includes(blockId) || path.length >= SHARED_BLOCK_MAX_DEPTH) return;
    withinBudget ??= chrome.reduce((count, item) => count + countNodes(blocks.get(item.id)?.data), countNodes(resolved.data)) <= SHARED_BLOCK_MAX_NODES;
    if (withinBudget && countNodes(block.data) <= SHARED_BLOCK_MAX_NODES) {
      walk(namespaceBlockData(block.data, `shared-${instanceId}`).content, [...path, blockId]);
    }
  }
  function walk(value: unknown, path: string[] = []) {
    if (++visits > 50000 || state.invalid || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, path)); return; }
    const { type, props } = value as { type?: string; props?: { id: string; blockId?: string; query?: ContentQuery; source?: string; modelId?: string; count?: number; relation?: unknown } };
    if (type === 'ContentLoop' && props?.id && props.query) {
      const pageKey = loopParam(props.id, 'page');
      const hasPage = props.query.paginate && typeof params[pageKey] === 'string';
      const hasFilter = props.query.controls && (typeof params[loopParam(props.id, 'search')] === 'string' || typeof params[loopParam(props.id, 'term')] === 'string');
      if (hasPage || hasFilter) {
        const count = Math.max(1, Math.min(CONTENT_LOOP_MAX_ITEMS, Number(props.count) || 6));
        const result = queryContent(querySource, props.source === 'product' ? 'product' : 'entry', props.modelId, props.query, props.id, params, count, relationLoopIds(snapshot, props.relation, runtime));
        state.invalid = result.outOfRange;
        state.filtered ||= Boolean(result.search || result.term);
        if (!result.outOfRange && result.page > 1) state.pagination.set(pageKey, String(result.page));
      }
      return;
    }
    if (type === 'SharedBlock' && props?.blockId) {
      walkBlock(props.blockId, String(props.id || props.blockId), path);
      return;
    }
    Object.values(value).forEach(item => walk(item, path));
  }
  walk(resolved.data.content);
  for (const { id, slot } of chrome) walkBlock(id, `site-${slot}`, []);
  state.pagination.sort();
  return state;
}

/** 在发送 HTML 前拒绝实际列表的越界页码，避免流式响应先发出 200。 */
export function hasInvalidLoopPage(snapshot: SiteSnapshot, resolved: ResolvedSitePage, params: QueryParams): boolean {
  return Object.keys(params).some(key => key.startsWith('page_')) && readLoopUrlState(snapshot, resolved, params).invalid;
}
