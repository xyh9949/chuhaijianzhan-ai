import { getContentEntryPath, getProductPath } from './content-routes';
import { chooseDetailTemplate } from './detail-templates';
import { localeOf } from './localization';
import { getSharedBlockUsage } from './shared-blocks';
import { readTemplateEditor } from './template-editor-client';
import type { ContentEntry, PageItem, Product, StudioState } from './types';

export type LoopCardOrigin = { target: string; nodeId: string; cardId: string };
export type EditorTarget = { kind: 'page' | 'block' | 'template'; id: string; cardOrigin?: LoopCardOrigin };
export type EditorPreviewOrigin = EditorTarget & { width: number; referencePath?: string };
export const EDITOR_MIN_WIDTH = 320;
export const EDITOR_MAX_WIDTH = 1920;
const editorId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);

/** 历史条目只保存对象标识，不把画布内容或另一个账号的选择写进浏览历史。 */
export function readEditorTarget(value: unknown): EditorTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { kind, id, cardOrigin } = value as Partial<EditorTarget>;
  if (!(kind === 'page' || kind === 'block' || kind === 'template') || !editorId(id)) return undefined;
  const card = kind === 'block' && cardOrigin?.cardId === id && editorId(cardOrigin.nodeId) && /^(page|block|template):[\w-]{1,100}$/.test(cardOrigin.target)
    ? { target: cardOrigin.target, nodeId: cardOrigin.nodeId, cardId: id } : undefined;
  return { kind, id, ...(card ? { cardOrigin: card } : {}) };
}

export function readEditorPreviewOrigin(value: unknown): EditorPreviewOrigin | undefined {
  const target = readEditorTarget(value);
  if (!target) return undefined;
  const { width, referencePath } = value as Partial<EditorPreviewOrigin>;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < EDITOR_MIN_WIDTH || width > EDITOR_MAX_WIDTH) return;
  // 引用路径只存进所属区块的历史条目；打开画布前还须存在于当前引用列表。
  const validReference = target.kind === 'block' && typeof referencePath === 'string' && referencePath.length <= 2048
    && referencePath.startsWith('/') && !referencePath.startsWith('//') && !/[\\?#\s]/u.test(referencePath);
  return { ...target, width, ...(validReference ? { referencePath } : {}) };
}

/** 旧入口只在一次导航获准后消费；刷新与浏览器回退优先使用当前历史条目。 */
export function consumeEditorEntryTarget(state: StudioState, actorId: string): EditorTarget {
  try {
    const blockId = sessionStorage.getItem('form-studio:editing-shared-block');
    sessionStorage.removeItem('form-studio:editing-shared-block');
    const templateId = readTemplateEditor(state, actorId);
    sessionStorage.removeItem('form-studio:editing-template');
    const previousCard = sessionStorage.getItem('form-studio:loop-card-origin');
    sessionStorage.removeItem('form-studio:loop-card-origin');
    if (editorId(blockId)) return { kind: 'block', id: blockId };
    if (templateId) return { kind: 'template', id: templateId };
    // 老版本已消费区块入口时，只可迁移同一账号仍存在的循环卡片。
    const card = previousCard ? JSON.parse(previousCard) : undefined;
    if (card?.active && card.actorId === actorId && state.sharedBlocks?.some(block => block.id === card.cardId)) {
      const target = readEditorTarget({ kind: 'block', id: card.cardId, cardOrigin: card });
      if (target?.cardOrigin) return target;
    }
  } catch { /* 存储不可用时使用当前普通页面。 */ }
  return { kind: 'page', id: state.activePageId };
}

/** 页面的引用来自实际可预览布局；详情按生效模板和语言选一个真实样本，避免下拉列出全部产品。 */
export function sharedBlockPreviewPages(state: StudioState, blockId: string): { value: string; label: string }[] {
  const { pageIds } = getSharedBlockUsage(blockId, state), used = new Set(pageIds);
  const staticPages = state.pages.filter(page => !page.slug.includes(':'));
  const options = staticPages.filter(page => used.has(page.id)).map(page => ({ value: page.slug, label: page.title }));
  const staticPaths = new Set(staticPages.map(page => page.slug));
  const previews = new Set<string>();
  const add = (page: PageItem | undefined, record: Product | ContentEntry, kind: 'product' | 'entry', path: string | undefined) => {
    if (!page || !path || staticPaths.has(path)) return;
    const { template, ambiguous } = chooseDetailTemplate(state, kind, record);
    if (ambiguous) return;
    const locale = localeOf(state.settings, record), key = `${page.id}:${template?.id || ''}:${locale}`;
    if (previews.has(key)) return;
    previews.add(key);
    const sample = { ...page, slug: path, locale };
    if (getSharedBlockUsage(blockId, { ...state, pages: [sample], editorData: { [page.id]: template?.data || state.editorData[page.id] } }).pageIds.length) {
      options.push({ value: path, label: `${page.title} · ${'name' in record ? record.name : record.title}` });
    }
  };
  const productDetail = state.pages.find(page => page.slug === '/products/:slug');
  if (productDetail) for (const product of state.products) add(productDetail, product, 'product', getProductPath(state, product));
  const entryPages = new Map(state.pages.filter(page => page.contentModelId).map(page => [page.contentModelId!, page]));
  for (const entry of state.contentEntries || []) add(entryPages.get(entry.modelId), entry, 'entry', getContentEntryPath(state, entry));
  return options;
}
