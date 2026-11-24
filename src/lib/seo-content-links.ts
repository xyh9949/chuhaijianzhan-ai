import type { RichNode } from './presentation-content';
import { getContentEntryPath, getProductPath } from './content-routes';
import { resolveSitePage } from './site-routing';
import { publicSiteOrigin } from './site-seo';
import protocol from './protocol.json';
import type { DraftContent, SiteSnapshot } from '../server/types';

type Source = DraftContent | SiteSnapshot;

/** 只归一化本站地址的查询和锚点；不解码路径、不折叠点段，不把相近地址猜成同一页面。 */
export function seoContentInternalPath(value: unknown, origin?: string): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return;
  let path: string;
  if (value.startsWith('/') && !value.startsWith('//')) path = value.split(/[?#]/, 1)[0];
  else {
    const match = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(value); if (!match || !origin) return;
    try { const url = new URL(match[1]); if (url.username || url.password || url.origin !== origin) return; } catch { return; }
    path = match[2] || '/';
  }
  if (!path.startsWith('/') || path.startsWith('//') || /%(?:2f|5c|2e)/i.test(path) || path.split('/').some(segment => segment === '.' || segment === '..') || /^\/(?:api|admin|preview|_next|images|fonts)(?:\/|$)/.test(path)) return;
  return path;
}
function snapshot(source: Source): SiteSnapshot { return { ...source, schemaVersion: protocol.snapshot, products: source.products.map(item => ({ ...item, status: 'published' })), contentEntries: source.contentEntries?.map(item => ({ ...item, status: 'published' })) }; }
/** 只登记来源数据中可由实际路由和真实模板渲染的地址，不用缺失模板的猜测路径形成依赖。 */
function realPaths(source: Source): Set<string> {
  const view = snapshot(source), values = [...view.pages.filter(page => !page.slug.includes(':')).map(page => page.slug), ...view.products.map(item => getProductPath(view, item)), ...(view.contentEntries || []).map(item => getContentEntryPath(view, item))], paths = new Set<string>();
  for (const value of values) {
    const path = seoContentInternalPath(value); if (!path) continue;
    try { if (resolveSitePage(view, path.split('/').filter(Boolean))) paths.add(path); } catch { /* 无法实际解析的源地址不伪装成可用依赖；原发布校验继续报告布局错误。 */ }
  }
  return paths;
}

/**
 * 图文literal href没有对象ID语义：发布时只校验地址实际可达，允许同一路径由另一条已发布记录合法承接。
 * 仅对draft/active已知的本站真实地址建立依赖；未知普通URL保留原规则，绝不联网探测或代发请求。
 */
export function seoContentLinkPublicationErrors(candidate: SiteSnapshot, draft: DraftContent, active?: SiteSnapshot | null): string[] {
  const known = new Set([...realPaths(draft), ...(active ? realPaths(active) : [])]), published = realPaths(candidate), origin = publicSiteOrigin(candidate.settings.publicUrl), errors = new Set<string>(); let visits = 0, bounded = false;
  function visit(value: unknown, label: string, depth = 0): void {
    if (bounded) return; if (++visits > 200_000 || depth > 40) { bounded = true; return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, label, depth + 1); return; }
    if (!value || typeof value !== 'object') return; const node = value as Partial<RichNode>;
    if (node.type === 'text' && typeof node.text === 'string' && Array.isArray(node.marks)) for (const mark of node.marks) if (mark?.type === 'link') { const path = seoContentInternalPath(mark.attrs?.href, origin); if (path && known.has(path) && !published.has(path)) errors.add(`${label}的图文内链 ${path} 尚未包含在本次公开内容中，请明确包含目标记录、对应详情模板及所需资料，或先移除该链接`); }
    for (const child of Object.values(value)) visit(child, label, depth + 1);
  }
  for (const page of candidate.pages) visit(candidate.editorData[page.id], `页面“${page.title}”`);
  for (const product of candidate.products) visit(product.detailContent, `产品“${product.name}”`);
  for (const entry of candidate.contentEntries || []) visit(entry.richTextFields, `内容“${entry.title}”`);
  for (const block of candidate.sharedBlocks || []) visit(block.data, `同步区块“${block.name}”`);
  for (const template of candidate.pageTemplates || []) visit(template.data, `模板“${template.name}”`);
  const result = [...errors].slice(0, 100); if (errors.size > 100) result.push('图文内链缺失较多，当前仅列前100项，请整理后再次预检'); if (bounded) result.push('图文内链检查超过安全预算，请拆分本次内容后重新预检；未将部分检查冒称全部通过'); return result;
}
