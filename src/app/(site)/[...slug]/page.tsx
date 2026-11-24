import {headers} from 'next/headers';
import {recordCrawl} from '@/server/discovery-runtime';
import { hasInvalidLoopPage } from '@/lib/loop-pages';
import type { QueryParams } from '@/lib/content-query';
import { notFound } from 'next/navigation';
import { readActiveSite } from '@/lib/site-request';
import { resolveSitePage } from '@/lib/site-routing';
import { SiteRenderer, SiteUnpublished, siteMetadata } from '@/lib/site-renderer';

type Props = { searchParams: Promise<QueryParams>; params: Promise<{ slug: string[] }> };
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params, searchParams }: Props) {
  const [{ slug }, snapshot] = await Promise.all([params, readActiveSite()]);
  return siteMetadata(snapshot, snapshot ? resolveSitePage(snapshot, slug) : null, false, await searchParams);
}
export default async function PublicPage({ params, searchParams }: Props) {
  const [{ slug }, snapshot] = await Promise.all([params, readActiveSite()]);
  if (!snapshot) return <SiteUnpublished />;
  const resolved = resolveSitePage(snapshot, slug);
  if (!resolved) notFound();
  const queryParams = await searchParams;
  if (hasInvalidLoopPage(snapshot, resolved, queryParams)) notFound();
  // 仅在显式启用时记录成功公开页面的最小UA计数；统计失败不能影响网站访问。
  try{recordCrawl('/'+slug.join('/'),await headers());}catch{console.error('crawl_counter_failed');}
  return <SiteRenderer snapshot={snapshot} queryParams={queryParams} resolved={resolved} />;
}
