import type { ContentRouteSource } from './content-routes';
import { getContentEntryPath, getProductPath } from './content-routes';
import { isLinkTarget, resolveLinkTarget } from './site-links';
import type { LinkTarget, PublishedRedirect, RedirectRule } from './types';

export function actualSiteRoutes(source: ContentRouteSource): { path: string; target: LinkTarget }[] {
  return [
    ...source.pages.filter(page => !page.slug.includes(':')).map(page => ({ path: page.slug, target: { kind: 'page' as const, id: page.id } })),
    ...(source.products || []).flatMap(product => { const path = getProductPath(source, product); return path ? [{ path, target: { kind: 'product' as const, id: product.id } }] : []; }),
    ...(source.contentEntries || []).flatMap(entry => { const path = getContentEntryPath(source, entry); return path ? [{ path, target: { kind: 'entry' as const, id: entry.id } }] : []; }),
  ];
}

/** 目标只能是当前可访问对象，直接编译成一步站内跳转，不允许外域、链或占用真实页面。 */
export function redirectErrors(source: ContentRouteSource & { redirects?: RedirectRule[] }): string[] {
  const rules = source.redirects || [], errors: string[] = [], ids = new Set<string>(), paths = new Set<string>();
  if (!Array.isArray(rules) || rules.length > 1000) return ['重定向最多1000条'];
  const actual = new Set(actualSiteRoutes(source).map(route => route.path));
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(rule.id) || ids.has(rule.id)) { errors.push('重定向ID无效或重复'); continue; }
    ids.add(rule.id);
    if (typeof rule.from !== 'string' || !/^\/[a-zA-Z0-9][a-zA-Z0-9/_-]{0,198}$/.test(rule.from) || rule.from.includes('//') || rule.from.endsWith('/') || /^\/(admin|api|preview|_next|images|fonts)(\/|$)/.test(rule.from)) errors.push(`重定向旧路径 ${rule.from} 无效或属于保留地址`);
    if (paths.has(rule.from)) errors.push(`重定向旧路径 ${rule.from} 重复`);
    paths.add(rule.from);
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') errors.push('重定向启用状态必须为是/否');
    if (!isLinkTarget(rule.target)) errors.push('重定向目标格式无效');
    if (rule.enabled === false) continue;
    const target = resolveLinkTarget(source, rule.target);
    if (!target) errors.push(`重定向 ${rule.from} 的目标不存在或未发布`);
    if (actual.has(rule.from) || target === rule.from) errors.push(`重定向 ${rule.from} 占用了真实页面或指向自身`);
    if (![301, 302].includes(rule.status)) errors.push('重定向状态只能为301或302');
  }
  return errors;
}

export function compileRedirects(source: ContentRouteSource & { redirects?: RedirectRule[] }): PublishedRedirect[] {
  return (source.redirects || []).filter(rule => rule.enabled !== false).flatMap(rule => { const to = resolveLinkTarget(source, rule.target); return to && to !== rule.from ? [{ from: rule.from, to, status: rule.status }] : []; });
}

/** 只根据最终候选版本提出建议，调用者需显式采用并发布，保存草稿不会自动改线上跳转。 */
export function suggestedRedirects(previous: ContentRouteSource | null, next: ContentRouteSource & { redirects?: RedirectRule[] }): RedirectRule[] {
  if (!previous) return [];
  const occupied = new Set([...actualSiteRoutes(next).map(route => route.path), ...(next.redirects || []).map(rule => rule.from)]);
  return actualSiteRoutes(previous).flatMap((route, index) => {
    const target = resolveLinkTarget(next, route.target);
    return target && target !== route.path && !occupied.has(route.path) ? [{ id: `redirect-suggestion-${route.target.kind}-${index}`, from: route.path, target: route.target, status: 301 as const }] : [];
  });
}
