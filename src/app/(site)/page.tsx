import {headers} from 'next/headers';
import {recordCrawl} from '@/server/discovery-runtime';
import { hasInvalidLoopPage } from '@/lib/loop-pages';
import type { QueryParams } from '@/lib/content-query';
import { readActiveSite } from '@/lib/site-request';
import { resolveSitePage } from '@/lib/site-routing';
import { SiteRenderer, SiteUnpublished, siteMetadata } from '@/lib/site-renderer';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';
export async function generateMetadata({ searchParams }: { searchParams: Promise<QueryParams> }) {
  const snapshot = await readActiveSite();
  return siteMetadata(snapshot, snapshot ? resolveSitePage(snapshot) : null, false, await searchParams);
}
export default async function PublicHome({ searchParams }: { searchParams: Promise<QueryParams> }) {
  const snapshot = await readActiveSite();
  if (!snapshot) return <SiteUnpublished />;
  const resolved = resolveSitePage(snapshot);
  if (!resolved) notFound();
  const queryParams = await searchParams;
  if (hasInvalidLoopPage(snapshot, resolved, queryParams)) notFound();
  // 仅在显式启用时记录成功公开页面的最小UA计数；统计失败不能影响网站访问。
  try{recordCrawl('/',await headers());}catch{console.error('crawl_counter_failed');}
  return <SiteRenderer snapshot={snapshot} queryParams={queryParams} resolved={resolved} />;
}
