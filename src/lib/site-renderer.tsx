import {siteStructuredData} from './discovery';
import {componentCompatibilityErrors} from './component-contract';
import { serializeStructuredData } from './site-seo';
import {localeOf} from './localization';
import type { QueryParams } from './content-query';
import { getContentEntryPath, getProductPath } from './content-routes';
import 'server-only';
import { Render } from '@puckeditor/core/rsc';
import type { SiteSnapshot } from '@/server/types';
import { createSiteConfig } from './site-render-config';
import type { ResolvedSitePage } from './site-routing';
import { enabledSiteCode, siteCodeAssetUrl } from './site-code-render';
import { SandboxedSitePreview } from '@/components/SandboxedSitePreview';
import { PublicSiteCode } from '@/components/PublicSiteCode';
import SiteAttributionCapture from '@/components/SiteAttributionCapture';
import { publicMultiProductInquiryPath } from './site-form-availability';
import './site.css';
export { siteMetadata } from './site-metadata';

export function SiteRenderer({ snapshot, resolved, preview = false, previewPrefix = '/preview', queryParams = {}, previewLabel }: { snapshot: SiteSnapshot; resolved: ResolvedSitePage; preview?: boolean; previewPrefix?: string; queryParams?: QueryParams; previewLabel?: string }) {
  const compatibility=componentCompatibilityErrors(resolved.data);if(compatibility.length)return <section role="alert" style={{padding:32}}><h1>需要兼容的本地组件</h1>{compatibility.map(e=><p key={e}>{e}</p>)}</section>;
  const language=localeOf(snapshot.settings,resolved.entry||resolved.product||resolved.page);
  const currentPath = resolved.product ? getProductPath(snapshot, resolved.product) : resolved.entry ? getContentEntryPath(snapshot, resolved.entry) : resolved.page.slug;
  // 案例提供独立前缀，普通草稿沿用 /preview；公开端始终使用正式网址。
  const inquiryPath = publicMultiProductInquiryPath(snapshot, language, currentPath);
  const config = createSiteConfig({ ...snapshot,locale:language, editorData:{...snapshot.editorData,[resolved.page.id]:resolved.data}, queryParams, currentPath, inquiryPath, pageId: resolved.page.id, previewProductId: resolved.product?.id, previewEntryId: resolved.entry?.id, previewPrefix: preview ? previewPrefix : '' });
  const snippets = enabledSiteCode(snapshot.customCode, resolved.page.id);
  // 结构化资料只使用当前快照中存在的事实，不生成价格、评分或认证声明。
  const structured = siteStructuredData(snapshot,resolved);
  const structuredJson = serializeStructuredData(structured);
  // 详情候选与整站候选共用真实设备视口及原生排版检查，不能因独立预览前缀漏掉检查脚本。
  const canLocate = ['/preview/~ai/', '/preview/~draft-check/'].some(prefix => previewPrefix.startsWith(prefix));
  const isPublication = previewPrefix.startsWith('/preview/~publication/');
  const inspectPreview = canLocate || ['/preview/~edit/','/preview/~site-design/','/preview/~detail-design/','/preview/~site-translation/','/preview/~seo-content/','/preview/~batch/'].some(prefix=>previewPrefix.startsWith(prefix));
  const caseViewport = preview && (previewPrefix.startsWith('/preview/~starter/') || previewPrefix.startsWith('/preview/~ai-before/') || inspectPreview || isPublication);
  // 检查及发布组合浏览只执行平台原生交互，保留客户样式供检查实际排版。
  const scripts = canLocate || isPublication ? [] : snippets.filter(({ snippet }) => snippet.jsEnabled).map(({ snippet }) => snippet.js);
  const content = <Render config={config} data={resolved.data} />;
  // 管理入口退出整个预览；从编辑器嵌入时不能把后台加载进设备画布。
  const backToAdmin = <a href="/admin" target="_top" style={{ color: 'inherit' }}>返回管理后台</a>;
  // 私有预览的父文档永不装载自定义资源；公开端只引用发布快照，不能读取实时草稿代码。
  return <div lang={language} data-site-release={snapshot.releaseId || 'draft'} style={caseViewport ? { height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' } : undefined}>{preview ? <><aside style={{ padding: '10px 20px', background: '#fff7db', color: '#55470c', font: '14px/1.5 system-ui,sans-serif', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, flexShrink: 0 }}><span>{previewLabel || (canLocate ? '建站预览 · 仅创建者可见' : '草稿预览 · 仅已登录成员可见 · 自定义代码隔离运行')}<br /><small>站内链接可继续预览；外链和邮件链接请在发布站点验证。</small></span>{backToAdmin}</aside><SandboxedSitePreview inspect={inspectPreview} focusFromAddress={canLocate} navigationPrefix={previewPrefix} viewport={caseViewport} language={language} css={snippets.filter(({ snippet }) => snippet.cssEnabled).map(({ snippet }) => snippet.css)} scripts={scripts}>{content}</SandboxedSitePreview></> : <>
    <SiteAttributionCapture pageKey={JSON.stringify([resolved.page.id, resolved.product?.id, resolved.entry?.id, queryParams.utm_source, queryParams.utm_medium, queryParams.utm_campaign])} />
    {snapshot.releaseId && snippets.filter(({ snippet }) => snippet.cssEnabled && snippet.css).map(({ target }) => <link key={target} rel="stylesheet" href={siteCodeAssetUrl(snapshot.releaseId!, target, 'css')} />)}
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredJson }} />{content}
    {snapshot.releaseId && <PublicSiteCode sources={snippets.filter(({ snippet }) => snippet.jsEnabled && snippet.js).map(({ target }) => siteCodeAssetUrl(snapshot.releaseId!, target, 'js'))} />}
  </>}</div>;
}

export function SiteUnpublished() {
  // 未发布占位页若被放入预览框，管理入口也需离开内框，在当前标签页打开后台。
  return <main style={{ minHeight: '100dvh', boxSizing: 'border-box', padding: '100px 24px', font: '16px/1.7 system-ui,sans-serif', color: '#243247', background: '#f8fafc', textAlign: 'center' }}><h1 style={{ fontSize: 28, fontWeight: 600 }}>网站尚未发布</h1><p>站点内容正在准备中，请稍后访问。</p><a href="/admin" target="_top" style={{ color: '#165dff' }}>管理登录</a></main>;
}
