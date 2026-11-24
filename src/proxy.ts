import { NextResponse, type NextRequest } from 'next/server';
import { getDatabase, getDataDirectory } from './server/database';
import type { PublishedRedirect } from './lib/types';

let key = '', redirects = new Map<string, PublishedRedirect>();
/** Node Proxy只读活动版本的编译跳转；每请求核对版本指针，回滚立即切换，不读取草稿。 */
export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const db = getDatabase();
  const active = db.prepare('SELECT active_release_id AS id FROM cms_runtime WHERE id = 1').get() as { id: string | null } | undefined;
  const nextKey = `${getDataDirectory()}:${active?.id || ''}`;
  if (key !== nextKey) {
    const row = active?.id ? db.prepare("SELECT json_extract(manifest_json, '$.publicRedirects') AS value FROM cms_release WHERE id = ?").get(active.id) as { value: string | null } | undefined : undefined;
    const items: PublishedRedirect[] = row?.value ? JSON.parse(row.value) : [];
    redirects = new Map(items.map(item => [item.from, item])); key = nextKey;
  }
  const rule = redirects.get(pathname);
  if (!rule || typeof rule.to !== 'string' || !/^\/[a-zA-Z0-9/_-]*$/.test(rule.to) || rule.to.startsWith('//') || ![301, 302].includes(rule.status)) {
    const headers = new Headers(request.headers);
    // 根布局未收到子路由参数；显式转交 Next 已解析的真实公开路径，服务端据此选 lang。
    headers.set('x-form-studio-pathname', pathname);
    return NextResponse.next({ request: { headers } });
  }
  const url = new URL(rule.to, request.url); url.search = request.nextUrl.search;
  const response = NextResponse.redirect(url, rule.status);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = { matcher: ['/((?!admin(?:/|$)|api(?:/|$)|preview(?:/|$)|_next(?:/|$)|images(?:/|$)|fonts(?:/|$)|icon.svg|robots.txt|sitemap.xml).*)'] };
