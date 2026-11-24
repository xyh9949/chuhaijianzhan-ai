import type { LinkTarget } from './types';
import { getContentEntryPath, getProductPath, type ContentRouteSource } from './content-routes';

/** 不读取实时数据库；同一份来源数据决定链接和详情页，标题变更不影响引用。 */
export function isLinkTarget(input: unknown): input is LinkTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const target = input as LinkTarget;
  return ['page', 'product', 'entry'].includes(target.kind) && typeof target.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(target.id) && Object.keys(input).every(key => ['kind', 'id'].includes(key));
}
export function resolveLinkTarget(source: ContentRouteSource, input: unknown): string | undefined {
  if (!isLinkTarget(input)) return undefined;
  const target = input;
  if (target.kind === 'page') return source.pages.find(page => page.id === target.id && !page.slug.includes(':'))?.slug;
  if (target.kind === 'product') {
    const product = source.products?.find(item => item.id === target.id);
    return product ? getProductPath(source, product) : undefined;
  }
  if (target.kind === 'entry') {
    const entry = source.contentEntries?.find(item => item.id === target.id);
    return entry ? getContentEntryPath(source, entry) : undefined;
  }
  return undefined;
}

/** 保存即保护明确内部引用；发布再次检查最终组合，防止部分发布留下悬空链接。 */
export function siteLinkErrors(source: ContentRouteSource & { sharedBlocks?: { name: string; data: unknown }[] }): string[] {
  const errors: string[] = [];
  function visit(value: unknown, label: string) {
    if (Array.isArray(value)) { value.forEach(item => visit(item, label)); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as { type?: string; props?: { linkTarget?: unknown; bindings?: { href?: unknown } } };
    if (node.props?.linkTarget !== undefined && node.props.linkTarget !== null) {
      if (!['ActionButton','ProductDetail'].includes(String(node.type)) || !resolveLinkTarget(source, node.props.linkTarget)) errors.push(`${label}：内部链接目标不存在、未发布、缺少详情模板或格式无效`);
      if (node.props.bindings?.href) errors.push(`${label}：内部链接与动态链接绑定不能同时使用`);
    }
    Object.values(value).forEach(child => visit(child, label));
  }
  source.pages.forEach(page => visit(source.editorData?.[page.id], `页面“${page.title}”`));
  source.sharedBlocks?.forEach(block => visit(block.data, `同步区块“${block.name}”`));
  return [...new Set(errors)];
}
