import { discoveryErrors } from './discovery';
import type { ContentRouteSource } from './content-routes';
import { isContentImage } from './content-models';
import type { SeoMeta } from './types';

/** 只接受规范源地址，不从域名展示字段或请求Host猜测客户的正式网址。 */
export function publicSiteOrigin(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input || input.length > 2048) return undefined;
  try { const url = new URL(input); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : undefined; } catch { return undefined; }
}
/** JSON-LD仅编码数据，阻止正文中的闭合script标签逃出节点且保持JSON值不变。 */
export function serializeStructuredData(value: Record<string, unknown>): string { return JSON.stringify(value).replace(/</g, '\\u003c'); }
export function seoErrors(source: ContentRouteSource & { settings: { publicUrl?: string; discovery?:import('./discovery').DiscoverySettings };contentModels?:import('./types').ContentModel[] }): string[] {
  const errors: string[] = discoveryErrors(source.settings.discovery,source.contentModels||[]);
  if (source.settings.publicUrl !== undefined && source.settings.publicUrl !== '' && !publicSiteOrigin(source.settings.publicUrl)) errors.push('公开规范地址必须为不带路径、查询或认证信息的http/https源地址');
  for (const item of [...source.pages, ...(source.products || []), ...(source.contentEntries || [])] as (SeoMeta & { id: string })[]) {
    if (item.seoTitle !== undefined && (typeof item.seoTitle !== 'string' || item.seoTitle.length > 200)) errors.push(`${item.id} SEO标题无效`);
    if (item.seoDescription !== undefined && (typeof item.seoDescription !== 'string' || item.seoDescription.length > 1000)) errors.push(`${item.id} SEO描述无效`);
    if (item.seoImage !== undefined && item.seoImage !== '' && !isContentImage(item.seoImage)) errors.push(`${item.id} 分享图必须从素材中选择`);
    if (item.noindex !== undefined && typeof item.noindex !== 'boolean') errors.push(`${item.id} 收录设置必须为是/否`);
  }
  return errors;
}
