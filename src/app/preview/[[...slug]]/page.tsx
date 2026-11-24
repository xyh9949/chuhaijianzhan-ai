import { hasInvalidLoopPage } from '@/lib/loop-pages';
import type { QueryParams } from '@/lib/content-query';
import { notFound, redirect } from 'next/navigation';
import { Alert, Button, Space } from 'antd';
import { readPreviewSite } from '@/lib/site-request';
import { resolveSitePage } from '@/lib/site-routing';
import { SiteRenderer, siteMetadata } from '@/lib/site-renderer';
import { resolveStarterPreview } from '@/lib/starter-preview';
import { readSharedBlockPreview, readTemplatePreview } from '@/server/template-preview';
import { requireActor } from '@/server/permissions';
import { resolveAiSitePreview } from '@/server/ai-builder';
import { resolveAiPageEditPreview } from '@/server/ai-page-edit';
import { resolveAiSiteDesignPreview } from '@/server/ai-site-design';
import { resolveAiDetailDesignPreview } from '@/server/ai-detail-design';
import { resolveSeoProposalPreview } from '@/server/seo-proposals';
import { resolveAiTranslationPreview } from '@/server/ai-translation';
import { resolveAiSiteTranslationPreview } from '@/server/ai-site-translation';
import { resolveSeoContentPreview } from '@/server/seo-content';
import { resolveAiBatchPreview } from '@/server/ai-batch';
import { resolveDraftBuildCheckPreview } from '@/server/ai-build-site-check';
import { resolvePublicationPreview } from '@/server/publication';
import { resolveContentEntryPreview } from '@/server/content-entry-preview';
import { ApiError } from '@/server/http';

type Props = { searchParams: Promise<QueryParams>; params: Promise<{ slug?: string[] }> };
export const dynamic = 'force-dynamic';
/** 未保存文章预览只允许创建人读取，过期后不回退到已保存文章。 */
async function entryPreview(slug: string[]) {
  if (slug.length < 3) return null;
  try { return resolveContentEntryPreview(await requireActor(), slug[1], slug.slice(2)); }
  catch (error) { if (error instanceof ApiError && [401, 403].includes(error.status)) return null; throw error; }
}
// AI候选站有自己的有效期与操作者权限，不能回退到当前客户草稿。
async function aiPreview(slug: string[], query: QueryParams) {
  if (slug.length < 2) return null;
  try { return resolveAiSitePreview(slug[1], slug.slice(2), await requireActor(), query, slug[0] === '~ai-before' ? 'before' : 'after'); }
  catch (error) { if (error instanceof ApiError && [401,403,404,410,422].includes(error.status)) return null; throw error; }
}
// 局部对比只读取本人冻结的单页版本，不允许追加路径读取候选站其他页面。
async function editPreview(slug: string[], query: QueryParams) {
  if (slug.length !== 3 || !['before', 'after'].includes(slug[2])) return null;
  try { return resolveAiPageEditPreview(slug[1], slug[2] as 'before' | 'after', await requireActor(), query); }
  catch (error) { if (error instanceof ApiError && [401,403,404,410,422].includes(error.status)) return null; throw error; }
}
// 整站设计预览可在冻结候选内浏览；鉴权/过期失败不回退到实时草稿。
async function siteDesignPreview(slug: string[], query: QueryParams) {
  if (slug.length < 3 || !['before', 'after'].includes(slug[2])) return null;
  try { return resolveAiSiteDesignPreview(slug[1], slug[2] as 'before' | 'after', await requireActor(), slug.slice(3), query); }
  catch (error) { if (error instanceof ApiError && [401,403,404,410,422].includes(error.status)) return null; throw error; }
}
// 详情候选限定本人及同一冻结样本；未登录不读取草稿或重定向登录页。
async function detailDesignPreview(slug: string[], query: QueryParams) {
  if (slug.length !== 3 || !['before', 'after'].includes(slug[2])) return null;
  try { return resolveAiDetailDesignPreview(slug[1], slug[2] as 'before' | 'after', await requireActor(), query); }
  catch (error) { if (error instanceof ApiError && [401,403,404,410,422].includes(error.status)) return null; throw error; }
}
// SEO预览限定一条本人记录和同一目标，不借URL追加路径读取其他对象。
async function seoPreview(slug: string[], query: QueryParams) {
  if (slug.length !== 3 || !['before','after'].includes(slug[2])) return null;
  try { return resolveSeoProposalPreview(slug[1],slug[2] as 'before'|'after',await requireActor(),query); }
  catch(error){ if(error instanceof ApiError&&[401,403,404,410,422].includes(error.status))return null;throw error; }
}
// 译文URL包含真实详情路径；余段必须由服务精确核对冻结目标，不能借其浏览其他快照记录。
async function translationPreview(slug: string[], query: QueryParams) {
  if (slug.length < 3 || !['before', 'after'].includes(slug[2])) return null;
  try { return resolveAiTranslationPreview(slug[1], slug[2] as 'before' | 'after', await requireActor(), query, slug.slice(3)); }
  catch (error) { if (error instanceof ApiError && [401,403,404,410,422].includes(error.status)) return null; throw error; }
}
/** 新候选先检查本人权限和冻结的完整路径；不可回退实时草稿。 */
async function extendedPreview(slug: string[], query: QueryParams) {
  if(slug.length<3||!['before','after'].includes(slug[2]))return null;
  try{const actor=await requireActor(),side=slug[2] as 'before'|'after';return slug[0]==='~site-translation'?resolveAiSiteTranslationPreview(slug[1],side,actor,slug.slice(3),query):resolveSeoContentPreview(slug[1],side,actor,query,slug.slice(3));}
  catch(error){if(error instanceof ApiError&&[401,403,404,410,422].includes(error.status))return null;throw error;}
}
/** 批次预览必须带明确序号/side和冻结完整路径，不能读取同批的其他条目或实时草稿。 */
async function batchPreview(slug:string[],query:QueryParams){
 if(slug.length<4||!['before','after'].includes(slug[3]))return null;
 try{return resolveAiBatchPreview(slug[1],slug[2],slug[3] as 'before'|'after',await requireActor(),query,slug.slice(4));}
 catch(error){if(error instanceof ApiError&&[401,403,404,410,422].includes(error.status))return null;throw error;}
}
/** 发布组合和草稿复检均有独立的浏览范围；失效时不读取当前草稿兜底。 */
async function scopedPreview(slug: string[], query: QueryParams) {
  if (slug.length < 2) return null;
  try {
    const actor = await requireActor();
    return slug[0] === '~publication'
      ? resolvePublicationPreview(slug[1], slug.slice(2), actor, query)
      : resolveDraftBuildCheckPreview(slug[1], slug.slice(2), actor, query);
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 404, 409, 410, 422].includes(error.status)) return null;
    throw error;
  }
}

export async function generateMetadata({ params, searchParams }: Props) {
  const { slug } = await params;
  if (slug?.[0] === '~entry') {
    const candidate = await entryPreview(slug);
    return candidate ? siteMetadata(candidate.snapshot, candidate.resolved, true, await searchParams) : { title: '文章预览不可用', robots: { index: false, follow: false } };
  }
  if (slug && ['~publication', '~draft-check'].includes(slug[0])) {
    const query = await searchParams, candidate = await scopedPreview(slug, query);
    return candidate && !('redirectTo' in candidate) ? siteMetadata(candidate.snapshot, candidate.resolved, true, query)
      : { title: '网站私有预览', robots: { index: false, follow: false } };
  }
  if(slug?.[0]==='~batch'){const query=await searchParams,candidate=await batchPreview(slug,query);return candidate?siteMetadata(candidate.snapshot,candidate.resolved,true,query):{title:'批量内容预览不可用',robots:{index:false,follow:false}};}
  if(slug&&['~site-translation','~seo-content'].includes(slug[0])){const query=await searchParams,candidate=await extendedPreview(slug,query);return candidate?siteMetadata(candidate.snapshot,candidate.resolved,true,query):{title:'内容预览不可用',robots:{index:false,follow:false}};}
  if (slug?.[0] === '~translation') { const query = await searchParams, candidate = await translationPreview(slug, query); return candidate ? siteMetadata(candidate.snapshot, candidate.resolved, true, query) : { title: '翻译预览不可用', robots: { index: false, follow: false } }; }
  if (slug?.[0] === '~detail-design') {
    const query = await searchParams, candidate = await detailDesignPreview(slug, query);
    return candidate ? siteMetadata(candidate.snapshot, candidate.resolved, true, query) : { title: '详情设计预览不可用', robots: { index: false, follow: false } };
  }
  if (slug?.[0] === '~site-design') {
    const candidate = await siteDesignPreview(slug, await searchParams);
    return candidate ? siteMetadata(candidate.snapshot, candidate.resolved, true, await searchParams) : { title: '整站设计预览不可用', robots: { index: false, follow: false } };
  }
  // SEO私有候选先鉴权，匿名请求直接不可用，不读取实时草稿或重定向到登录页。
  if(slug?.[0]==='~seo'){const query=await searchParams,candidate=await seoPreview(slug,query);return candidate?siteMetadata(candidate.snapshot,candidate.resolved,true,query):{title:'SEO预览不可用',robots:{index:false,follow:false}};}
  // 私有整站候选先按创建者鉴权，不读取实时草稿或借其登录跳转代替候选权限检查。
  if (slug?.[0] === '~ai' || slug?.[0] === '~ai-before') {
    const query = await searchParams, candidate = await aiPreview(slug, query);
    return candidate ? siteMetadata(candidate.snapshot, candidate.resolved, true, query) : { title: 'AI建站预览不可用', robots: { index: false, follow: false } };
  }
  const snapshot = await readPreviewSite();
  if (!snapshot) return { title: '预览登录已过期', robots: { index: false, follow: false } };
  if (slug?.[0] === '~edit') {
    const query = await searchParams, candidate = await editPreview(slug, query);
    return candidate ? siteMetadata(candidate.snapshot, candidate.resolved, true, query) : { title: 'AI修改对比不可用', robots: { index: false, follow: false } };
  }
  if (slug?.[0] === '~starter') {
    const starter = resolveStarterPreview(slug, await searchParams);
    return starter ? siteMetadata(starter.snapshot, starter.resolved, true, await searchParams) : { title: '演示套件不存在', robots: { index: false, follow: false } };
  }
  // 使用URL非保留字符前缀，避免运行时把@编码为%40后与路由参数不一致。
  if (slug && ['~template', '~block'].includes(slug[0])) {
    const asset = slug.length === 2 ? (slug[0] === '~block' ? readSharedBlockPreview : readTemplatePreview)(snapshot, slug[1]) : null;
    return asset && !('error' in asset) ? siteMetadata(asset.snapshot, asset.resolved, true, await searchParams) : { title: '模板预览不可用', robots: { index: false, follow: false } };
  }
  return siteMetadata(snapshot, resolveSitePage(snapshot, slug), true, await searchParams);
}
export default async function DraftPreview({ params, searchParams }: Props) {
  const { slug } = await params;
  if (slug?.[0] === '~entry') {
    const candidate = await entryPreview(slug);
    if (!candidate) notFound();
    return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={await searchParams} previewLabel="文章预览 · 尚未保存" preview />;
  }
  if (slug && ['~publication', '~draft-check'].includes(slug[0])) {
    const query = await searchParams, candidate = await scopedPreview(slug, query);
    if (!candidate) notFound();
    if ('redirectTo' in candidate) redirect(candidate.redirectTo);
    return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={query} previewPrefix={candidate.previewPrefix} previewLabel={slug[0] === '~publication' ? '发布范围预览 · 仅创建者可见' : '草稿复检预览 · 仅管理员可见'} preview />;
  }
  if(slug?.[0]==='~batch'){const query=await searchParams,candidate=await batchPreview(slug,query);if(!candidate)notFound();return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={query} previewPrefix={candidate.previewPrefix} preview/>;}
  if(slug&&['~site-translation','~seo-content'].includes(slug[0])){const query=await searchParams,candidate=await extendedPreview(slug,query);if(!candidate)notFound();return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={query} previewPrefix={candidate.previewPrefix} preview/>;}
  if (slug?.[0] === '~translation') { const query = await searchParams, candidate = await translationPreview(slug, query); if (!candidate) notFound(); return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={query} previewPrefix={candidate.previewPrefix} preview />; }
  if (slug?.[0] === '~detail-design') {
    const query = await searchParams, candidate = await detailDesignPreview(slug, query); if (!candidate) notFound();
    return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={query} previewPrefix={candidate.previewPrefix} preview />;
  }
  if (slug?.[0] === '~site-design') {
    const query = await searchParams, candidate = await siteDesignPreview(slug, query); if (!candidate) notFound();
    return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={query} previewPrefix={candidate.previewPrefix} preview />;
  }
  // 与metadata同样先校验本人候选，不能通过登录跳转掩盖匿名或Bearer越权。
  if(slug?.[0]==='~seo'){const query=await searchParams,candidate=await seoPreview(slug,query);if(!candidate)notFound();return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={query} previewPrefix={candidate.previewPrefix} preview />;}
  if (slug?.[0] === '~ai' || slug?.[0] === '~ai-before') {
    const query = await searchParams, candidate = await aiPreview(slug, query); if (!candidate) notFound();
    return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={query} previewPrefix={candidate.previewPrefix} preview />;
  }
  const snapshot = await readPreviewSite();
  if (!snapshot) return <main style={{ padding: 'clamp(20px, 5vw, 40px)', maxWidth: 560 }}>
    <Alert showIcon type="warning" title={<h1 style={{ margin: 0, font: 'inherit', fontWeight: 600 }}>预览登录已过期</h1>}
      description={<Space orientation="vertical" size="middle">
        <span>请重新登录后打开草稿预览。</span>
        <Button type="primary" href="/admin" target="_top">前往管理后台登录</Button>
      </Space>} />
  </main>;
  if (slug?.[0] === '~edit') {
    const query = await searchParams, candidate = await editPreview(slug, query); if (!candidate) notFound();
    return <SiteRenderer snapshot={candidate.snapshot} resolved={candidate.resolved} queryParams={query} previewPrefix={candidate.previewPrefix} preview />;
  }
  if (slug?.[0] === '~starter') {
    const queryParams = await searchParams, starter = resolveStarterPreview(slug, queryParams); if (!starter) notFound();
    return <SiteRenderer snapshot={starter.snapshot} resolved={starter.resolved} queryParams={queryParams} previewPrefix={starter.previewPrefix} preview />;
  }
  // 使用URL非保留字符前缀，避免运行时把@编码为%40后与路由参数不一致。
  if (slug && ['~template', '~block'].includes(slug[0])) {
    const block = slug[0] === '~block';
    const asset = slug.length === 2 ? (block ? readSharedBlockPreview : readTemplatePreview)(snapshot, slug[1]) : null; if (!asset) notFound();
    // 资源预览失败时也应退出嵌入画布，在当前标签页返回原管理区域。
    if ('error' in asset) return <main style={{ padding: 40 }}><h1>{block ? '区块预览不可用' : '模板预览不可用'}</h1><p>{asset.error}</p><a href={block ? '/admin#global-design' : '/admin#templates'} target="_top">返回资源库</a></main>;
    return <SiteRenderer snapshot={asset.snapshot} resolved={asset.resolved} queryParams={await searchParams} previewLabel={block ? '同步区块独立预览 · 未套入页面' : undefined} preview />;
  }
  const resolved = resolveSitePage(snapshot, slug);
  if (!resolved) notFound();
  const queryParams = await searchParams;
  if (hasInvalidLoopPage(snapshot, resolved, queryParams)) notFound();
  return <SiteRenderer snapshot={snapshot} queryParams={queryParams} resolved={resolved} preview />;
}
