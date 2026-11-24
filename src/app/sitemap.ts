import type { MetadataRoute } from 'next';
import { readActiveSite } from '@/lib/site-request';
import { actualSiteRoutes } from '@/lib/site-redirects';
import { publicSiteOrigin } from '@/lib/site-seo';
import { resolveSitePage } from '@/lib/site-routing';
export const dynamic = 'force-dynamic';

/** 仅枚举当前发布版本真实地址；没有明确公开源地址时不生成假域名。 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const snapshot = await readActiveSite(), origin = publicSiteOrigin(snapshot?.settings.publicUrl);
  if (!snapshot || !origin) return [];
  return actualSiteRoutes(snapshot).flatMap(({ path }) => {
    const resolved = resolveSitePage(snapshot, path === '/' ? [] : path.slice(1).split('/'));
    if (!resolved || resolved.page.noindex || resolved.product?.noindex || resolved.entry?.noindex) return [];
    const updated = snapshot.urlState?.[path]?.modified || resolved.entry?.updated || resolved.product?.updated || resolved.page.updated;
    return [{ url: `${origin}${path}`, ...(Number.isFinite(Date.parse(updated)) ? { lastModified: new Date(updated) } : {}) }];
  });
}
