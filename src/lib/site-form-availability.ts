import type { SiteSnapshot } from '../server/types';
import { queryContent } from './content-query';
import { relationLoopIds } from './content-relations';
import { componentSlots } from './editor-slots';
import { localeOf } from './localization';
import { CONTENT_LOOP_MAX_ITEMS, createSharedBlockNodeCounter, sharedBlockContainsLoop, SHARED_BLOCK_MAX_DEPTH, SHARED_BLOCK_MAX_NODES } from './shared-blocks';
import { effectiveLayoutBlockId } from './site-layout-locales';
import { actualSiteRoutes } from './site-redirects';
import { resolveSitePage, type ResolvedSitePage } from './site-routing';
import type { BindingContext, ContentQuery, Product } from './types';

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const formPageLocale = (snapshot: SiteSnapshot, page: ResolvedSitePage) => localeOf(snapshot.settings, page.product || page.entry || page.page);
export const formProductAvailable = (settings: SiteSnapshot['settings'], product: Product, locale: string) => product.status === 'published' && localeOf(settings, product) === locale;

function formReferences(snapshot: SiteSnapshot) {
  const blocks = new Map(snapshot.sharedBlocks?.map(block => [block.id, block]));
  const countNodes = createSharedBlockNodeCounter(snapshot.sharedBlocks);
  const blockedCards = new Map<string, boolean>();

  /** 与公开渲染共用语言头尾、区块预算和列表匹配；只检查可到达的内容插槽，不认任意数据里的表单 ID。 */
  return function onPage(resolved: ResolvedSitePage, locale: string): Set<string> {
    const ids = new Set<string>();
    const root = (resolved.data.root?.props || resolved.data.root || {}) as { bindingContext?: BindingContext; showChrome?: string; headerMode?: string; footerMode?: string };
    const chrome = (['header', 'footer'] as const).flatMap(slot => {
      if (root.showChrome === 'no' || root[`${slot}Mode`] === 'hidden') return [];
      const id = effectiveLayoutBlockId(snapshot.siteLayout?.[slot], snapshot.settings, locale);
      return id ? [id] : [];
    });
    const runtime = {
      productId: resolved.product?.id || (root.bindingContext?.source === 'product' ? root.bindingContext.recordId : undefined),
      bindingContext: resolved.entry ? { source: 'entry' as const, recordId: resolved.entry.id, modelId: resolved.entry.modelId } : root.bindingContext,
    };
    const overBudget = chrome.reduce((count, id) => count + countNodes(blocks.get(id)?.data), countNodes(resolved.data)) > SHARED_BLOCK_MAX_NODES;
    const querySource = { ...snapshot, locale };

    function walkBlock(id: string, path: string[], card = false) {
      const block = blocks.get(id);
      if (overBudget || path.includes(id) || path.length >= SHARED_BLOCK_MAX_DEPTH || !Array.isArray(block?.data?.content) || countNodes(block.data) > SHARED_BLOCK_MAX_NODES) return;
      walk(block.data.content, [...path, id], card);
    }
    function walk(content: unknown[], path: string[], card = false) {
      for (const node of content) {
        if (!isObject(node) || typeof node.type !== 'string' || !isObject(node.props)) continue;
        const props = node.props;
        if (node.type === 'Form' && typeof props.formId === 'string') ids.add(props.formId);
        if (node.type === 'SharedBlock' && typeof props.blockId === 'string') walkBlock(props.blockId, path, card);
        if (node.type === 'ContentLoop' && !card && !overBudget && typeof props.itemBlockId === 'string' && blocks.has(props.itemBlockId)) {
          const blockId = props.itemBlockId;
          if (!blockedCards.has(blockId)) blockedCards.set(blockId, sharedBlockContainsLoop(blockId, snapshot.sharedBlocks));
          if (!blockedCards.get(blockId)) {
            const kind = (props.source ?? 'entry') === 'entry' ? 'entry' : 'product';
            // 会话绑定纯路径。访客搜索和分页只会缩小/切分候选集合，不会让空集合出现卡片。
            const count = Math.max(1, Math.min(CONTENT_LOOP_MAX_ITEMS, Number(props.count) || 6));
            const { total } = queryContent(querySource, kind, typeof props.modelId === 'string' ? props.modelId : undefined, props.query as ContentQuery | undefined, String(props.id), {}, count, relationLoopIds(snapshot, props.relation, runtime));
            if (total > 0) walkBlock(blockId, path, true);
          }
        }
        if (!['Tabs', 'Accordion', 'Carousel'].includes(node.type) || props.panelMode === 'free') {
          for (const slot of componentSlots({ type: node.type, props })) walk(slot.content, path, card);
        }
      }
    }
    walk(resolved.data.content, []);
    for (const id of chrome) walkBlock(id, []);
    return ids;
  };
}

/** 表单只从当前公开位置和快照查找，来源语言不能由访问者指定。 */
export function resolvePublicForm(snapshot: SiteSnapshot, formId: string, path: string) {
  const form = snapshot.forms?.find(item => item.id === formId && item.enabled);
  if (!form) return undefined;
  const page = resolveSitePage(snapshot, path === '/' ? [] : path.slice(1).split('/'));
  if (!page) return undefined;
  const locale = formPageLocale(snapshot, page);
  return formReferences(snapshot)(page, locale).has(formId) ? { form, page, locale } : undefined;
}

/** 询价按钮只跳至同语言且确实可到达询价表单的站内地址，优先选常见的询盘或联系页。 */
export function publicMultiProductInquiryPath(snapshot: SiteSnapshot, locale: string, currentPath?: string): string | undefined {
  const forms = new Set(snapshot.forms?.filter(form => form.enabled && form.multiProduct).map(form => form.id));
  if (!forms.size || !snapshot.products.some(product => formProductAvailable(snapshot.settings, product, locale))) return undefined;
  const onPage = formReferences(snapshot);
  const matches = (path: string) => {
    const page = resolveSitePage(snapshot, path === '/' ? [] : path.slice(1).split('/'));
    return page && formPageLocale(snapshot, page) === locale && [...onPage(page, locale)].some(id => forms.has(id));
  };
  const normal = snapshot.pages.filter(page => !page.slug.includes(':') && localeOf(snapshot.settings, page) === locale);
  const priority = /\/(?:contact|contact-us|rfq|quote|request-a-quote)$/i;
  return normal.find(page => priority.test(page.slug) && matches(page.slug))?.slug
    ?? normal.find(page => !priority.test(page.slug) && matches(page.slug))?.slug
    ?? (currentPath && matches(currentPath) ? currentPath : undefined)
    ?? actualSiteRoutes(snapshot).find(route => route.target.kind !== 'page' && matches(route.path))?.path;
}

/** 发布才检查必填选择能否完成；历史版本不可变，草稿允许先搭表单再整理产品。 */
export function requiredProductFormErrors(snapshot: SiteSnapshot): string[] {
  const required = new Map(snapshot.forms?.filter(form => form.enabled && (form.multiProduct || form.fields.some(field => field.type === 'product' && field.required))).map(form => [form.id, form]));
  if (!required.size) return [];
  const productLocales = new Set(snapshot.products.filter(product => product.status === 'published').map(product => localeOf(snapshot.settings, product)));
  const onPage = formReferences(snapshot);
  const issues = new Map<string, string>();
  for (const { path } of actualSiteRoutes(snapshot)) {
    const page = resolveSitePage(snapshot, path === '/' ? [] : path.slice(1).split('/'));
    if (!page) continue;
    const locale = formPageLocale(snapshot, page);
    if (productLocales.has(locale)) continue;
    for (const formId of onPage(page, locale)) {
      const form = required.get(formId);
      if (!form) continue;
      // 动态详情共用模板；同一模板及表单只报告一个实际可检查的样本地址。
      const key = JSON.stringify([page.detailTemplateId || page.page.id, locale, formId]);
      const action = form.multiProduct ? '或关闭该表单的多产品询价' : '或将该字段改为选填';
      if (!issues.has(key)) issues.set(key, `页面“${page.page.title}”（${path}，${locale}）的表单“${form.name}”要求选择产品，但本次发布后该语言没有可选产品。请纳入该语言的产品，${action}。`);
    }
  }
  return [...issues.values()];
}
