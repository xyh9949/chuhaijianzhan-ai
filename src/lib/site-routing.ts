import type { Data } from '@puckeditor/core';
import type { SiteSnapshot, ProductRecord } from '@/server/types';
import type { ContentEntry, PageItem } from './types';
import { safeLinkHref } from './site-safety';
import { getContentEntryPath,getProductPath } from './content-routes';
import {stripLocalePath} from './localization';
import {chooseDetailTemplate} from './detail-templates';

export interface ResolvedSitePage { page: PageItem; data: Data; product?: ProductRecord; entry?: ContentEntry; detailTemplateId?:string; }

export function siteLinkHref(input: unknown, previewPrefix = ''): string | undefined {
  const href = safeLinkHref(input);
  if (!href || !previewPrefix || !href.startsWith('/')) return href;
  // 真实草稿导航留在 /preview；素材/API/后台与既有预览地址保持原路径。
  if (/^\/(api|admin|preview|_next|images|fonts)(\/|[?#]|$)/.test(href)) return href;
  // 首页预览没有尾部斜线；查询或锚点也使用同一个地址，避免点击时再发生重定向。
  return `${previewPrefix}${/^\/(?:[?#]|$)/.test(href) ? href.slice(1) : href}`;
}

// 静态路径优先；产品按同快照的有效短路径或ID匹配，禁止查询实时草稿补缺。
export function resolveSitePage(snapshot: SiteSnapshot, segments: string[] = []): ResolvedSitePage | null {
  if (segments.some((segment) => !segment || /[\\/\u0000-\u001f\u007f]/.test(segment) || segment === '.' || segment === '..')) return null;
  const path = `/${segments.join('/')}`;
  let page = snapshot.pages.find((item) => item.slug === path && !item.slug.includes(':'));
  let product: ProductRecord | undefined;
  let entry: ContentEntry | undefined;
  const localSegments=stripLocalePath(snapshot.settings,path).slice(1).split('/');
  if (!page && localSegments.length === 2 && localSegments[0] === 'products') {
    product = snapshot.products.find((item) => getProductPath(snapshot,item)===path);
    if (!product) return null;
    page = snapshot.pages.find((item) => item.slug === '/products/:slug');
  }
  // 独立内容与模板来自同一快照；短路径或稳定 ID 只是地址段，不读取后台草稿补记录。
  if (!page) {
    entry = snapshot.contentEntries?.find(item => item.status === 'published' && getContentEntryPath(snapshot, item) === path);
    if (entry) page = snapshot.pages.find(item => item.contentModelId === entry!.modelId);
  }
  if (!page) return null;
  const data = snapshot.editorData[page.id];
  // 数据缺失属于坏版本，不能用演示模板悄悄替换正式页面。
  if (!data || typeof data !== 'object' || !Array.isArray((data as Data).content)) throw new Error(`Published page data is missing: ${page.id}`);
  // 默认页负责网址、SEO与页面代码；条件资产只提供布局，绝不隐式启用资产代码。
  const record=product||entry,selected=record?chooseDetailTemplate(snapshot,product?'product':'entry',record):undefined;
  if(selected?.ambiguous)throw new Error('Ambiguous published detail template');
  return { page, data: selected?.template?.data || data as Data, product, entry,...(selected?.template?{detailTemplateId:selected.template.id}:{}) };
}
