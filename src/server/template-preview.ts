import type { PageItem } from '../lib/types';
import type { ResolvedSitePage } from '../lib/site-routing';
import type { SiteSnapshot } from './types';
import { assertKnownPageComponents } from './validation';
import { EMPTY_CODE } from './site-code';

/** 调用方必须先readPreviewSite鉴权；模板预览始终关闭客户JS，不改变源站代码的启用状态。 */
export function readTemplatePreview(source: SiteSnapshot, id: string): { snapshot: SiteSnapshot; resolved: ResolvedSitePage } | { error: string } | null {
  const template = source.pageTemplates?.find(t => t.id === id); if (!template) return null;
  try { assertKnownPageComponents(template.data); } catch (e) { return { error: (e as Error).message }; }
  const page: PageItem = { id: template.id, title: template.name, slug: `/~template/${template.id}`, status: 'draft', type: '模板预览', updated: template.updated, ...(template.kind === 'entry' ? { contentModelId: template.modelId } : {}) };
  const root = template.data.root?.props as { bindingContext?: { source?: string; recordId?: string } } | undefined;
  const product = template.kind === 'product' ? source.products.find(p => p.id === root?.bindingContext?.recordId) || source.products[0] : undefined;
  const choices = source.contentEntries?.filter(e => e.modelId === template.modelId), entry = template.kind === 'entry' ? choices?.find(e => e.id === root?.bindingContext?.recordId) || choices?.[0] : undefined;
  const snapshot: SiteSnapshot = { ...source, pages: [...source.pages, page], editorData: { ...source.editorData, [page.id]: template.data }, customCode: { global: { ...source.customCode?.global || EMPTY_CODE, jsEnabled: false }, pages: { [page.id]: { ...template.code || EMPTY_CODE, jsEnabled: false } } } };
  return { snapshot, resolved: { page, data: template.data, ...(product ? { product } : {}), ...(entry ? { entry } : {}) } };
}

/** 只在已有草稿鉴权后打开单个未使用的同步区块，不为它创建页面或启用客户脚本。 */
export function readSharedBlockPreview(source: SiteSnapshot, id: string): { snapshot: SiteSnapshot; resolved: ResolvedSitePage } | { error: string } | null {
  const block = source.sharedBlocks?.find(item => item.id === id);
  if (!block) return null;
  try { assertKnownPageComponents(block.data); } catch (error) { return { error: (error as Error).message }; }
  const page: PageItem = { id: `block-preview:${block.id}`, title: block.name, slug: `/~block/${block.id}`, status: 'draft', type: '区块预览', updated: block.updated };
  const data = { ...block.data, root: { ...block.data.root, props: { ...block.data.root?.props, showChrome: 'no' } } };
  const snapshot: SiteSnapshot = { ...source, pages: [...source.pages, page], editorData: { ...source.editorData, [page.id]: data }, customCode: { global: { ...source.customCode?.global || EMPTY_CODE, js: '', jsEnabled: false }, pages: {} } };
  return { snapshot, resolved: { page, data } };
}
