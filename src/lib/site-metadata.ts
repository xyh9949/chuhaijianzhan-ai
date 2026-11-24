import type { Metadata } from 'next';
import type { SiteSnapshot } from '@/server/types';
import type { ResolvedSitePage } from './site-routing';
import { publicSiteOrigin } from './site-seo';
import { getContentEntryPath, getProductPath } from './content-routes';
import type { QueryParams } from './content-query';
import { readLoopUrlState } from './loop-pages';
import {localeOf} from './localization';
import {translationLinks} from './translation-links';

// SEO 与正文使用同一个已读取快照，不再访问实时产品或网站设置。
export function siteMetadata(snapshot: SiteSnapshot | null, resolved: ResolvedSitePage | null, preview = false, params: QueryParams = {}): Metadata {
  if (!snapshot) return { title: '网站尚未发布', robots: { index: false, follow: false } };
  if (!resolved) return { title: 'Page not found', robots: { index: false, follow: false } };
  const loop = preview ? undefined : readLoopUrlState(snapshot, resolved, params);
  if (loop?.invalid) return { title: 'Page not found', robots: { index: false, follow: false } };
  const title = resolved.entry?.seoTitle || resolved.entry?.title || resolved.product?.seoTitle || resolved.product?.name || resolved.page.seoTitle || resolved.page.title;
  const description = resolved.entry?.seoDescription || resolved.product?.seoDescription || resolved.product?.description || resolved.page.seoDescription || snapshot.settings.description;
  const origin = publicSiteOrigin(snapshot.settings.publicUrl);
  const path = resolved.entry ? getContentEntryPath(snapshot, resolved.entry) : resolved.product ? getProductPath(snapshot, resolved.product) : resolved.page.slug;
  // 纯分页自指；有实际搜索/筛选时回到原始目录网址，不暴露任意筛选组合。
  const pagination = loop?.filtered ? undefined : loop?.pagination;
  const canonical = !preview && origin && path ? `${origin}${path}${pagination?.size ? `?${pagination}` : ''}` : undefined;
  const noindex = preview || loop?.filtered || resolved.page.noindex || resolved.entry?.noindex || resolved.product?.noindex;
  const image = resolved.entry?.seoImage || resolved.product?.seoImage || resolved.page.seoImage || resolved.product?.image;
  const images = origin && image ? [new URL(image, origin).href] : undefined;
  // 只有显式配置地区时才输出 OG locale，不把 en 擅自推断成 en_US。
  const language=localeOf(snapshot.settings,resolved.entry||resolved.product||resolved.page),locale = /^[a-z]{2,3}-[A-Z]{2}$/.test(language) ? language.replace('-', '_') : undefined;
  // 不猜测不同语言列表的页码对应关系，分页/筛选页不生成可能失真的互译标记。
  const languages=!preview&&!noindex&&!pagination?.size&&origin&&snapshot.settings.locales?Object.fromEntries(translationLinks(snapshot,resolved.entry?'entry':resolved.product?'product':'page',resolved.entry||resolved.product||resolved.page).filter(l=>l.indexable).map(l=>[l.locale,`${origin}${l.href}`])):undefined;
  return { title: `${title} · ${snapshot.settings.name}`, description, ...(origin ? { metadataBase: new URL(origin) } : {}), ...(canonical ? { alternates: { canonical,...(languages?{languages}:{}) } } : {}), openGraph: { title, description, locale, type: 'website', images, url: canonical }, twitter: { card: images ? 'summary_large_image' : 'summary', title, description, images }, ...(preview ? { robots: { index: false, follow: false, nocache: true } } : noindex ? { robots: { index: false, follow: true } } : {}) };
}
