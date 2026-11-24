import ProductGallery from './product-gallery';
import {productImages} from './product-images';
import {reviewedFacts} from './discovery';
import {usesAdvancedLayout} from './advanced-layout';
import {extensionRenderComponents} from '../extensions/render';
import SiteForm from '@/components/SiteForm';
import { SiteInquiryAdd, SiteInquiryReviewLink } from '@/components/SiteInquiryItems';
import { imageAttributes, type ImageSize } from './media-images';
import type { FormDefinition } from './types';
import { presentationComponents,RichDocument } from './presentation-components';
import { composeDesign, themeNodeCss, type ThemeNodeProps } from './theme-design';
import {queryLabels} from './query-labels';
import { queryContent, loopParam, type QueryParams } from './content-query';
import type { ContentQuery, Taxonomy } from './types';
import SiteNavigation, { type NavigationItem } from '@/components/SiteNavigation';
import { Breadcrumb as AntBreadcrumb,Button as AntButton,Space as AntSpace } from 'antd';
import {menuAtLocale, navigationHomePath} from './site-navigation';
import { effectiveLayoutBlockId } from './site-layout-locales';
import { menuItemHref } from './site-navigation';
import type { MenuItem } from './types';
import { getProductPath } from './content-routes';
import { resolveLinkTarget } from './site-links';
import React from 'react';
import type { Config } from '@puckeditor/core';
import { Render } from '@puckeditor/core/rsc';
import type { BindingContext, ContentEntry, ContentModel, FieldBinding, PageItem, SharedBlock, SiteLayout, SiteSettings, SiteTheme } from './types';
import type { ProductRecord } from '@/server/types';
import { getPageKind } from './page-data';
import { safeBackgroundImage, safeEmailHref, safeImageSrc, safeLinkHref } from './site-safety';
import { SiteArrow, SiteButton, SiteProvider } from './site-controls';
import { productDetailActionColors, productDetailDefaultAction } from './product-detail-presentation';
import { siteLinkHref } from './site-routing';
import { compileDesignCss, designClassName, type ResponsiveDesign } from './responsive-style';
import { CONTENT_LOOP_MAX_ITEMS, createSharedBlockNodeCounter, namespaceBlockData, sharedBlockContainsLoop, SHARED_BLOCK_MAX_DEPTH, SHARED_BLOCK_MAX_NODES } from './shared-blocks';
import { BOUND_COMPONENT_TARGETS, recordsForSource, resolveBindingValue, resolveGalleryBinding, resolveRichTextBinding } from './content-binding';
import { formatFieldValue, isContentImage, isEmptyFieldValue } from './content-models';
import {isRelationDefinition,relatedRecords,relatedTitle,relatedUrl,relationLoopIds} from './content-relations';
import {localeOf,stripLocalePath} from './localization';
import {translationLinks} from './translation-links';
import { componentTranslatableLabels } from './component-translatable-labels';
import { comparisonTableView } from './comparison-table';
import { createImageComparisonView } from './image-comparison';
import { projectTimelineView } from './project-timeline';

export interface SiteRenderContext {
  pages: PageItem[];
  media?: import('./types').MediaItem[];
  forms?: FormDefinition[];
  queryParams?: QueryParams;
  currentPath?: string;
  inquiryPath?: string;
  taxonomies?: Taxonomy[];
  products: ProductRecord[];
  theme: SiteTheme;
  settings: Pick<SiteSettings, 'name' | 'description' | 'email' | 'language' | 'locales' | 'discovery'>;
  locale?:string;
  editorData: Record<string, unknown>;
  previewProductId?: string;
  previewEntryId?: string;
  contentModels?: ContentModel[];
  contentEntries?: ContentEntry[];
  bindingContext?: BindingContext;
  previewPrefix?: string;
  editorCanvas?: boolean;
  sharedBlocks?: SharedBlock[];
  siteLayout?: SiteLayout;
  pageId?: string;
  editingBlockId?: string;
  /** 内部递归上下文不进入页面数据；引用体不注册成可编辑 slot。 */
  sharedBlockPath?: string[];
  sharedBlockNamespace?: string;
  sharedBlockSourceIds?: ReadonlyMap<string, string>;
  sharedBlockNodeCounter?: (value: unknown) => number;
  sharedBlockBudgetExceeded?: boolean;
  loopItem?: boolean;
  onNavigate?: (kind: string, productId?: string) => void;
}

// 只把站点展示所需数据交给组件，账号、询盘和发布草稿记录不进入公开渲染。
export function createSiteConfig(context: SiteRenderContext): Config {
  const { theme, settings, onNavigate, previewProductId } = context;
  const controls = (context.editorData.__themeControls || {}) as { contentWidth?: number; buttonStyle?: string; buttonSize?: 'small' | 'middle' | 'large' };
  const siteFont = theme.font === 'system' ? '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' : theme.font === 'Inter' ? 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' : theme.font;
  const prefix = context.previewPrefix || '';
  const anchorId = (id: string) => context.sharedBlockNamespace ? `${context.sharedBlockNamespace}--${id}` : id;
  const internalHref = (path: string) => siteLinkHref(path, prefix) || '/';
  const pageHref = (kind: string) => {
    const choices=context.pages.filter(p=>localeOf(settings,p)===locale);
    const page = choices.find(item=>item.id===kind)||choices.find(item=>getPageKind({...item,slug:stripLocalePath(settings,item.slug)})===kind);
    return page && !page.slug.includes(':') ? internalHref(page.slug) : undefined;
  };
  const resolveHref = (input: unknown) => {
    const href = safeLinkHref(input);
    if (!href) return undefined;
    if (href === '#story') return pageHref('about') || href;
    if (href.startsWith('#')) return `#${anchorId(href.slice(1))}`;
    return siteLinkHref(href, prefix);
  };
  const renderMenu = (menuId: string, label = 'Website navigation', mobileMode:'collapse'|'inline'='collapse',openLabel?:string) => {
    const menu = context.siteLayout?.menus?.find(item => item.id === menuId);
    if (!menu) return context.editorCanvas ? <p>请选择菜单</p> : null;
    const convert = (items: MenuItem[]): NavigationItem[] => items.map(item => ({ key: item.id, label: item.label, href: siteLinkHref(menuItemHref(context, item), prefix), newTab: item.newTab, ...(item.children?.length ? { children: convert(item.children) } : {}) }));
    return <SiteNavigation items={convert(menu.items)} label={label} editing={Boolean(context.editorCanvas)} mobileMode={mobileMode} openLabel={openLabel} />;
  };
  const hasProductTemplate = context.pages.some((page) => page.slug === '/products/:slug');
  // 后台 iframe 不自行跳转离开画布；独立草稿/公开页面才使用真实浏览器导航。
  const interceptNavigation = Boolean(context.editorCanvas || onNavigate);
  const products = context.products.filter((item) => item.status === 'published');
  const contentEntries = (context.contentEntries || []).filter((item) => item.status === 'published');
  const currentData = (context.editingBlockId ? context.sharedBlocks?.find(block => block.id === context.editingBlockId)?.data : context.editorData[context.pageId || '']) as { root?: { props?: { bindingContext?: BindingContext } } } | undefined;
  const currentPage = context.pages.find(page => page.id === context.pageId);
  const actualEntry = contentEntries.find(entry => entry.id === context.previewEntryId);
  const savedContext = context.bindingContext || currentData?.root?.props?.bindingContext;
  const sampleEntry = context.editorCanvas && !context.editingBlockId && currentPage?.contentModelId ? contentEntries.find(entry => entry.modelId === currentPage.contentModelId && entry.id === savedContext?.recordId) || contentEntries.find(entry => entry.modelId === currentPage.contentModelId) : undefined;
  // URL 记录优先于模板样本；循环卡片由调用方显式清除 URL 并传入自己的当前记录。
  const activeEntry = actualEntry || (!context.loopItem ? sampleEntry : undefined);
  const bindingContext: BindingContext | undefined = activeEntry ? { source: 'entry', recordId: activeEntry.id, modelId: activeEntry.modelId } : savedContext;
  const isProductTemplate = context.pages.some(page => page.id === context.pageId && page.slug === '/products/:slug');
  // 编辑器可用首个产品作为空模板示例；正式动态路由明确传入产品 ID，绝不读取实时草稿补值。
  const currentProductId = previewProductId || (bindingContext?.source === 'product' ? bindingContext.recordId : undefined);
  const bindingRuntime = { bindingContext, productId: currentProductId || (context.editorCanvas && !bindingContext && (isProductTemplate || context.editingBlockId) ? products[0]?.id : undefined) };
  const localeRecord=products.find(p=>p.id===context.previewProductId)||contentEntries.find(e=>e.id===context.previewEntryId)||((context.loopItem||context.editingBlockId||isProductTemplate||currentPage?.contentModelId)?bindingContext?.source==='entry'?contentEntries.find(e=>e.id===bindingContext.recordId):products.find(p=>p.id===bindingRuntime.productId):currentPage);
  const locale=context.locale||localeOf(settings,localeRecord);
  const inquiryHref = context.inquiryPath && `${internalHref(context.inquiryPath)}?rfq=1`;
  // 仅在快照中找到同语言可用的询价表单时提供入口。草稿预览显示位置，禁止选品及提交正式询盘。
  const inquiryAdd = (item: Pick<ProductRecord, 'id' | 'name' | 'locale'>) => inquiryHref && localeOf(settings, item) === locale
    ? <SiteInquiryAdd id={item.id} name={item.name} locale={locale} demo={!!prefix} /> : null;
  const inquiryReview = inquiryHref ? <SiteInquiryReviewLink href={inquiryHref} locale={locale} demo={!!prefix} /> : null;
  const source = { ...context, products, contentEntries,locale };
  const homePath = navigationHomePath(source, locale);
  const homeHref = homePath ? internalHref(homePath) : undefined;
  const layoutBlock = (slot: 'header' | 'footer') => effectiveLayoutBlockId(context.siteLayout?.[slot], settings, locale);
  const advancedLayout=usesAdvancedLayout(currentData,theme,context.sharedBlocks)||(['header','footer'] as const).some(slot=>!!layoutBlock(slot)&&usesAdvancedLayout(context.sharedBlocks?.find(b=>b.id===layoutBlock(slot))?.data,theme,context.sharedBlocks));
  const countNodes = context.sharedBlockNodeCounter || createSharedBlockNodeCounter(context.sharedBlocks);
  let overBudget = context.sharedBlockBudgetExceeded;
  if (overBudget === undefined) {
    const pageData = context.editorData[context.pageId || ''] as { root?: { props?: Record<string, unknown> } } | undefined;
    const rootProps = pageData?.root?.props;
    let count = countNodes(context.editingBlockId ? currentData : pageData);
    if (!context.editingBlockId && rootProps?.showChrome !== 'no') for (const slot of ['header', 'footer'] as const) {
      const id = layoutBlock(slot);
      if (id && rootProps?.[`${slot}Mode`] !== 'hidden') count += countNodes(context.sharedBlocks?.find((block) => block.id === id)?.data);
    }
    overBudget = count > SHARED_BLOCK_MAX_NODES;
  }
  const renderBlock = (blockId: string, instanceId: string, itemContext?: BindingContext) => {
    const block = context.sharedBlocks?.find((item) => item.id === blockId);
    const path = context.sharedBlockPath || (context.editingBlockId ? [context.editingBlockId] : []);
    // 保存端会拒绝这些情况；旧快照损坏时也不能导致整页无限递归或白屏。
    if (!block || !Array.isArray(block.data?.content) || path.includes(blockId) || path.length >= SHARED_BLOCK_MAX_DEPTH || overBudget || countNodes(block.data) > SHARED_BLOCK_MAX_NODES) {
      return context.editorCanvas ? <div className="editor-shared-block-unavailable">{!blockId ? '请选择同步区块' : '同步区块不可用，请检查引用'}</div> : null;
    }
    const namespace = `shared-${instanceId}`;
    // 预览可由实例定位到同步块自身的原始节点，公开页面不额外暴露编辑标识。
    const sourceIds = prefix.startsWith('/preview/~draft-check/') ? new Map<string, string>() : undefined;
    const data = namespaceBlockData(block.data, namespace, sourceIds);
    const nestedConfig = createSiteConfig({ ...context, sharedBlockPath: [...path, blockId], sharedBlockNamespace: namespace, sharedBlockSourceIds: sourceIds, sharedBlockNodeCounter: countNodes, sharedBlockBudgetExceeded: overBudget, bindingContext: itemContext || bindingContext, ...(itemContext ? { previewProductId: undefined, previewEntryId: undefined, loopItem: true } : {}) });
    return <Render config={nestedConfig} data={data} />;
  };
  // 全站页脚声明contact锚点时在单例外层暴露兼容入口；内部节点仍命名隔离，保留原#contact按钮跳转。
  const footerContactAnchor = !!layoutBlock('footer') && context.sharedBlocks?.find(block => block.id === layoutBlock('footer'))?.data.content.some(node => node.props.anchor === 'contact');
  const layoutMode = (slot: 'header' | 'footer', override?: string, showChrome?: string) => context.editingBlockId || showChrome === 'no' || override === 'hidden' || context.siteLayout?.[slot].mode === 'hidden' ? 'hidden' : layoutBlock(slot) ? 'block' : 'default';
  const config: Config = {
    root: {
      render: ({ children, brand, showChrome, design, headerMode, footerMode }: { children?: React.ReactNode; brand?: string; showChrome?: string; design?: ResponsiveDesign; headerMode?: string; footerMode?: string }) => {
        if (context.sharedBlockNamespace) {
          const rootId = `${context.sharedBlockNamespace}--block-root`;
          // 区块根只承载自身样式，不重复站点容器、导航、页脚或全局 root 选择器。
          return <div className={`editor-shared-block-content ${designClassName(rootId)}`} data-shared-block-content="true" data-shared-block-id={context.sharedBlockPath?.at(-1)}>{children}{design && <style data-design-css={rootId}>{compileDesignCss(rootId, design, 'SharedBlock')}</style>}</div>;
        }
        return <SiteProvider theme={theme} font={siteFont}><div className={`editor-site${advancedLayout?' editor-site-advanced':''}${context.editorCanvas ? ' editor-site-editor-canvas' : ''}`} data-page-id={context.editingBlockId ? undefined : context.pageId} data-shared-block-id={context.editingBlockId} style={{ '--editor-site-primary': theme.primary, '--editor-site-text': theme.text, '--editor-site-bg': theme.background, '--editor-site-radius': `${theme.radius}px`, '--editor-site-width': `${controls.contentWidth || 1240}px`, fontFamily: siteFont } as React.CSSProperties}><div className="editor-site-page">
        {layoutMode('header', headerMode, showChrome) === 'block' && <header className="site-header editor-site-shared-header">{renderBlock(layoutBlock('header')!, 'site-header')}</header>}
        {layoutMode('header', headerMode, showChrome) === 'default' && <header className="site-header editor-site-nav"><a className="editor-site-brand" href={homeHref} onClick={interceptNavigation ? (event) => { event.preventDefault(); onNavigate?.('home'); } : undefined}>{brand || settings.name}</a>{menuAtLocale(context.siteLayout?.header.menuId,context.siteLayout?.header.localeMenuIds,settings,locale) ? renderMenu(menuAtLocale(context.siteLayout?.header.menuId,context.siteLayout?.header.localeMenuIds,settings,locale)!) : <nav aria-label="Website navigation">{[['products', 'Collection'], ['about', 'Our story'], ['contact', 'Contact']].map(([kind, label]) => {
          const href = pageHref(kind);
          return href ? <a key={kind} href={href} onClick={interceptNavigation ? (event) => { event.preventDefault(); onNavigate?.(kind); } : undefined}>{settings.locales?context.pages.find(p=>internalHref(p.slug)===href)?.title||label:label}</a> : null;
        })}</nav>}<span className="editor-site-nav-note">Objects for a slower life.</span></header>}
        <main>{children}</main>
        {layoutMode('footer', footerMode, showChrome) === 'block' && <footer id={footerContactAnchor ? "contact" : undefined} className="site-footer editor-site-shared-footer">{renderBlock(layoutBlock('footer')!, 'site-footer')}</footer>}
        {layoutMode('footer', footerMode, showChrome) === 'default' && <footer className="site-footer editor-site-footer" id="contact"><div><strong>{brand || settings.name}</strong><p>Considered objects. Everyday living.</p>{menuAtLocale(context.siteLayout?.footer.menuId,context.siteLayout?.footer.localeMenuIds,settings,locale) && renderMenu(menuAtLocale(context.siteLayout?.footer.menuId,context.siteLayout?.footer.localeMenuIds,settings,locale)!, 'Footer navigation')}</div><div><a href={safeEmailHref(settings.email)}>Let’s make something meaningful <SiteArrow /></a><small>© {new Date().getFullYear()} {brand || settings.name}</small></div></footer>}
      </div>{(design || theme.defaults) && <style data-design-css="root">{compileDesignCss('root', composeDesign(theme.defaults, design), 'Root')}</style>}</div></SiteProvider>;
      },
    },
    components: {
      ...extensionRenderComponents(context),
      ...presentationComponents(resolveHref, context.media, !prefix, context.editorCanvas),
      // 下方会包装渲染配置。为每次配置复制描述，拖拽 ref 才始终绑定真实 DOM。
      ComparisonTable: { ...comparisonTableView },
      ProjectTimeline: { ...projectTimelineView },
      ImageComparison: createImageComparisonView({ media: context.media, derived: !prefix, editorCanvas: context.editorCanvas }),
      LanguageSwitcher:{render:({label,missing='hide',labels})=>{
        const urlRecord=products.find(p=>p.id===context.previewProductId)||contentEntries.find(e=>e.id===context.previewEntryId);
        const boundRecord=(context.loopItem||context.editingBlockId||isProductTemplate||currentPage?.contentModelId)?bindingContext?.source==='entry'?contentEntries.find(e=>e.id===bindingContext.recordId):products.find(p=>p.id===bindingRuntime.productId):undefined;
        const record=urlRecord||boundRecord||currentPage;
        const kind=record&&'name'in record?'product':record&&'customFields'in record?'entry':'page';
        const links=record?translationLinks(source,kind,record,{preview:Boolean(context.editorCanvas||prefix)}):[];
        return <nav aria-label={label||componentTranslatableLabels('LanguageSwitcher',labels).languages}><AntSpace wrap>{links.filter(l=>l.href||missing==='disabled').map(l=><AntButton key={l.locale} type="link" href={l.href?internalHref(l.href):undefined} disabled={!l.href||context.editorCanvas} aria-current={l.current?'page':undefined} hrefLang={l.locale} style={{font:'inherit',color:'inherit'}}>{l.label}{!l.href?' · —':''}</AntButton>)}</AntSpace></nav>;
      }},
      Download: { render: ({ fileUrl, text, labels }) => <div className="editor-site-button"><SiteButton text={text || componentTranslatableLabels('Download',labels).download} href={context.media?.some(m => m.url === fileUrl && m.kind === 'document') ? fileUrl : undefined} editing={Boolean(context.editorCanvas || prefix)} /></div> },
      Form: { render: ({ id, formId, fieldDesign, submitDesign, buttonAlign, wideFields,labels }) => { const form = context.forms?.find(f => f.id === formId); return <div className={`site-form-container${form?.multiProduct ? ' site-form-container-rfq' : ''}`}>{form ? <SiteForm definition={form} instanceId={String(id)} sourcePath={context.currentPath || currentPage?.slug || '/'} products={products.filter(p=>localeOf(settings,p)===locale).map(({ id, name, sku }) => ({ id, name, ...(form.multiProduct ? { sku } : {}) }))} locale={locale} productId={bindingRuntime.productId} demo={Boolean(context.editorCanvas || prefix)} fieldDesign={fieldDesign} submitDesign={submitDesign} buttonAlign={buttonAlign} wideFields={wideFields} labels={labels} /> : context.editorCanvas ? <p>请选择或创建网站表单定义</p> : null}</div>; } },
      Navigation: { render: ({ menuId, localeMenuIds,label,mobileMode,labels }) => {const text=componentTranslatableLabels('Navigation',labels);return <div className="site-navigation-block">{renderMenu(menuAtLocale(menuId,localeMenuIds,settings,locale)||'', label || text.navigation,mobileMode==='inline'?'inline':'collapse',text.open)}</div>;} },
      Breadcrumb: { render: ({ homeLabel,labels }) => {
        const page = context.pages.find(page => page.id === context.pageId);
        const record = context.products.find(item => item.id === context.previewProductId) || context.contentEntries?.find(item => item.id === context.previewEntryId);
        const text=componentTranslatableLabels('Breadcrumb',labels);return <AntBreadcrumb aria-label={text.navigation} style={{ padding: 20 }} items={[{ title: homeHref ? <a href={homeHref}>{homeLabel || text.home}</a> : (homeLabel || text.home) }, { title: record ? ('name' in record ? record.name : record.title) : page?.title || '' }]} />;
      } },
      Container: {
        // slot 字段参与运行时转换，服务端配置也必须保留，不能仅保留 render。
        fields: { content: { type: 'slot' } },
        render: ({ content: Content, layout, columns, mobileColumns, gap, padding, inset, background, image, minHeight, align }) => <section className={`editor-site-section ${safeImageSrc(image) ? 'editor-site-section-image' : ''}`} style={{ backgroundColor: background, backgroundImage: safeBackgroundImage(image), minHeight, padding: `${padding}px ${inset}px`, justifyContent: align, '--editor-mobile-columns': mobileColumns } as React.CSSProperties}><Content className={`editor-site-slot ${layout === 'grid' ? 'editor-site-grid' : ''}`} minEmptyHeight={80} style={{ display: 'grid', gridTemplateColumns: layout === 'grid' ? `repeat(${columns}, minmax(0, 1fr))` : '1fr', gap, alignItems: 'center', width: '100%', maxWidth: 'var(--editor-site-width)', margin: '0 auto' }} /></section>,
      },
      // 这里只本地化说明标签，企业事实值和证据原文始终来自已保存设置，不交给组件文案覆盖。
      CompanyFacts: {render:({title,labels})=>{const o=settings.discovery?.organization,text=componentTranslatableLabels('CompanyFacts',labels);return <section className="editor-site-company-facts"><h2>{title||settings.name}</h2><dl>{[[text.company,o?.legalName||settings.name],[text.alternateName,o?.alternateName],[text.role,o?.role],[text.address,o?.address],[text.telephone,o?.telephone],[text.email,settings.email]].filter(([,v])=>v).map(([k,v],index)=><div key={index}><dt>{k}</dt><dd>{v}</dd></div>)}{reviewedFacts(settings.discovery).map(f=><div key={f.id}><dt>{f.title}</dt><dd><p>{f.value}</p>{f.scope&&<p>{f.scope}</p>}{f.sourceUrl&&<a href={f.sourceUrl} rel="noopener noreferrer">{text.source}</a>}<small style={{display:'block'}}>{text.reviewed}: {f.reviewedAt}{f.validUntil?` · ${text.validUntil}: ${f.validUntil}`:''}</small></dd></div>)}</dl>{o?.sameAs?.map((u,i)=><p key={u}><a href={u} rel="noopener noreferrer">{text.profile} {i+1}</a></p>)}</section>;}},
      Heading: { render: ({ text, size, mobileSize, color, align, style, spacing, level }) => {const Tag=(/^h[1-6]$/.test(String(level))?level:'h2') as 'h2';return <Tag className="editor-site-heading" style={{ '--editor-heading-size': `${size}px`, '--editor-heading-mobile': `${mobileSize}px`, color, textAlign: align, fontFamily: style === 'serif' ? 'Georgia, "Times New Roman", serif' : 'inherit', marginBottom: spacing } as React.CSSProperties}>{text}</Tag>; } },
      Text: { render: ({ text, size, color, align, maxWidth }) => <p className="editor-site-copy" style={{ fontSize: size, color, textAlign: align, maxWidth, marginLeft: align === 'center' ? 'auto' : undefined, marginRight: align === 'center' ? 'auto' : undefined }}>{text}</p> },
      Image: { render: ({ src, alt, height, fit, radius, imageSize }) => <img className="editor-site-image" {...imageAttributes(src, context.media, imageSize as ImageSize, !prefix)} alt={alt || ''} style={{ height, objectFit: fit, borderRadius: radius }} /> },
      ActionButton: { render: ({ text, href, kind, align, puck }) => <div style={{ textAlign: align }}><SiteButton text={text} href={context.editorCanvas && !onNavigate ? safeLinkHref(href) : resolveHref(href)} kind={kind} buttonStyle={controls.buttonStyle} size={controls.buttonSize} editing={puck.isEditing} onActivate={onNavigate && href === '#story' ? () => onNavigate('about') : undefined} /></div> },
      ProductList: { render: ({ eyebrow, title, columns, mobileColumns, count, category, padding,labels }) => {
        const items = products.filter(item=>localeOf(settings,item)===locale).filter((item) => !category || item.category.toLowerCase().includes(String(category).toLowerCase())).slice(0, count);
        const text=componentTranslatableLabels('ProductList',labels);
        return <section className="editor-site-products" id={anchorId('collection')} style={{ paddingTop: padding, paddingBottom: padding }}><div className="editor-site-eyebrow">{eyebrow}</div><div className="editor-site-collection-heading"><h2>{title}</h2><span>{items.length.toString().padStart(2, '0')} {text.countSuffix}</span></div>{inquiryReview}<div className="editor-site-product-grid" style={{ gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`, '--editor-mobile-columns': mobileColumns } as React.CSSProperties}>{items.map((item) => <article className="editor-site-product" key={item.id}>{safeImageSrc(item.image)&&<img {...imageAttributes(item.image, context.media, 'auto', !prefix)} alt={item.name} />}<div><h3>{hasProductTemplate ? <SiteButton text={item.name} href={internalHref(getProductPath(context, item) || '/')} productLink editing={Boolean(context.editorCanvas && !onNavigate)} onActivate={onNavigate ? () => onNavigate('product-detail', item.id) : undefined} /> : item.name}</h3><SiteArrow /></div><p>{item.category} · {item.material}</p>{inquiryAdd(item)}</article>)}</div>{items.length === 0 && <p className="editor-site-empty">{text.empty}</p>}</section>;
      } },
      // 自定义规格直接取当前快照；以文本节点输出，不能把产品文案当作 HTML。
      ProductDetail: { render: ({ id:instanceId, productId, layout, imageHeight, padding, cta, showCustomFields,labels, mobileOrder, ctaColor, ctaFallback, linkTarget, href: targetHref }) => {
        const text=componentTranslatableLabels('ProductDetail',labels);
        const id = currentProductId || productId;
        const product = id ? products.find((item) => item.id === id) : products[0];
        if (!product) return <div className="editor-site-empty">{text.unavailable}</div>;
        const photos=productImages(product).filter(url=>!!safeImageSrc(url));
        const model = context.contentModels?.find(item => item.id === product.modelId && item.target === 'product');
        const extraFields = showCustomFields === 'no' ? [] : (model?.fields || []).filter(field => !isEmptyFieldValue(product.customFields?.[field.id]));
        const photo = photos.length>1?<ProductGallery id={String(instanceId)} images={photos} name={product.name} height={imageHeight} media={context.media} derived={!prefix} labels={text}/>:photos[0]?<img {...imageAttributes(photos[0],context.media,'auto',!prefix)} alt={product.name} style={{height:imageHeight}}/>:null;
        const specifications = product.specifications?.map((spec, index) => <div key={`${spec.label}-${index}`}><dt>{spec.label}</dt><dd>{spec.value}</dd></div>);
        const customRows = extraFields.map(field => {
          const value = product.customFields?.[field.id];
          return <div key={field.id} data-product-field={field.id}><dt>{field.label}</dt><dd>{field.type==='relation'&&isRelationDefinition(field.relation)?relatedRecords(context,field,value).filter(r=>r.status==='published').map((r,index)=>{const href=relatedUrl(context,field.relation!,r);return <React.Fragment key={r.id}>{index>0?', ':''}{href?<a href={resolveHref(href)}>{relatedTitle(r)}</a>:relatedTitle(r)}</React.Fragment>}):field.type === 'image' || field.type === 'gallery' ? <span className="editor-custom-gallery">{(Array.isArray(value) ? value : [value]).filter(isContentImage).map((url,index) => <img key={`${url}-${index}`} src={url} alt={field.label} />)}</span> : field.type === 'url' ? <a href={resolveHref(value)}>{formatFieldValue(field, value)}</a> : formatFieldValue(field, value)}</dd></div>;
        });
        const longDetail = product.detailContent&&<div className="site-rich-text" style={{gridColumn:"1 / -1",minWidth:0}} data-product-detail-content={product.id}><RichDocument doc={product.detailContent} resolveHref={resolveHref} media={context.media} derived={!prefix}/></div>;
        const color = productDetailActionColors(ctaColor), colorStyle = color ? { '--product-detail-cta-background': color.background, '--product-detail-cta-text': color.foreground } as React.CSSProperties : {};
        const className = `editor-site-detail ${layout === 'stacked' ? 'editor-site-detail-stacked' : ''} ${!photos.length?'editor-site-detail-no-image':''}${color?' editor-site-detail-cta-custom':''}`;
        const specificationsFirst = mobileOrder === 'specifications-first';
        const overviewFirst = mobileOrder === 'overview-first';
        const newProfile = specificationsFirst || overviewFirst;
        const identityFirst = mobileOrder === 'identity-first' || newProfile;
        // AI只调顺序时可保留原隐式询盘去向；已有显式链接优先，失效不会静默改跳别处。
        const explicitTarget = linkTarget !== undefined && linkTarget !== null;
        const useContact = (ctaFallback ?? productDetailDefaultAction(mobileOrder)) === 'contact';
        const emailHref = safeEmailHref(settings.email, product.name);
        const actionHref = explicitTarget ? resolveHref(targetHref) : (useContact ? pageHref('contact') : undefined) || emailHref;
        const action = identityFirst || explicitTarget ? actionHref ? <SiteButton text={cta} href={actionHref} size={controls.buttonSize} buttonStyle={controls.buttonStyle} editing={Boolean(context.editorCanvas)} /> : <AntButton className="editor-site-action" disabled size={controls.buttonSize || 'large'} icon={<SiteArrow />} iconPlacement="end">{cta}</AntButton> : <SiteButton text={cta} href={actionHref} size={controls.buttonSize} />;
        const additionalInquiryAction = inquiryAdd(product);
        const actions = additionalInquiryAction ? <div className="site-rfq-actions">{action}{additionalInquiryAction}{inquiryReview}</div> : action;
        const identity = <div className="editor-site-detail-copy editor-site-detail-identity">
          <div className="editor-site-eyebrow">{text.collection}{(!newProfile || product.category) && ` · ${product.category}`}</div>
          <h1>{product.name}</h1>
          {(!newProfile || product.sku) && <dl className="editor-site-detail-reference"><div><dt>{text.reference}</dt><dd>{product.sku}</dd></div></dl>}
          {actions}
          <small>{text.contactNote}</small>
        </div>;
        if (newProfile) {
          // DOM顺序即手机阅读顺序。桌面通过通栏与相邻区域呈现同一份资料，空规格不占位。
          const summary = product.description && <div className="editor-site-detail-copy editor-site-detail-summary"><p>{product.description}</p></div>;
          const details = (product.material || specifications?.length || customRows.length) ? <div className="editor-site-detail-copy editor-site-detail-specifications">
            <dl>
              {product.material && <div><dt>{text.material}</dt><dd>{product.material}</dd></div>}
              {specifications}
              {customRows}
            </dl>
          </div> : null;
          const mode = specificationsFirst ? 'specifications-first' : 'overview-first';
          return <section className={`${className} editor-site-detail-profile editor-site-detail-${mode}`} style={{ paddingTop: padding, paddingBottom: padding, ...colorStyle }}>
            {identity}
            {overviewFirst && summary}
            {photo}
            {details}
            {specificationsFirst && summary}
            {longDetail}
          </section>;
        }
        // 只在显式启用时拆为一份动态身份/媒体/说明；旧页面保持原DOM、邮箱动作与图片优先。
        if (mobileOrder === 'identity-first') {
          return <section className={`${className} editor-site-detail-identity-first`} style={{ paddingTop: padding, paddingBottom: padding, ...colorStyle }}>{identity}{photo}<div className="editor-site-detail-copy editor-site-detail-body"><p>{product.description}</p><dl><div><dt>{text.material}</dt><dd>{product.material}</dd></div>{specifications}{customRows}</dl></div>{longDetail}</section>;
        }
        return <section className={className} style={{ paddingTop: padding, paddingBottom: padding, ...colorStyle }}>{photo}<div className="editor-site-detail-copy"><div className="editor-site-eyebrow">{text.collection} · {product.category}</div><h1>{product.name}</h1><p>{product.description}</p><dl><div><dt>{text.reference}</dt><dd>{product.sku}</dd></div><div><dt>{text.material}</dt><dd>{product.material}</dd></div>{specifications}{customRows}</dl>{actions}<small>{text.contactNote}</small></div>{longDetail}</section>;
      } },
      ContentList: { render: ({ id, source: kind = 'product', modelId, title, count = 6, columns = 3, mobileColumns = 1, titleField, descriptionField, imageField, linkField, emptyText, padding = 48,labels }) => {
        const recordKind = kind === 'entry' ? 'entry' : 'product';
        const records = recordKind === 'entry' && !modelId ? [] : recordsForSource(source, recordKind, modelId).filter(r=>localeOf(settings,r)===locale).slice(0, Math.max(1, Math.min(12, count)));
        const value = (record: typeof records[number], field: string, target: 'text'|'src'|'href') => resolveBindingValue({ source: recordKind, mode: 'fixed', recordId: record.id, modelId: modelId || undefined, field: field || '' }, target, source);
        return <section className="editor-site-products editor-site-content-list" data-content-model={modelId || ''} style={{ paddingTop: padding, paddingBottom: padding }}>
          {title && <div className="editor-site-collection-heading"><h2>{title}</h2></div>}
          {recordKind === 'product' && inquiryReview}
          <div className="editor-site-product-grid" style={{ gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`, '--editor-mobile-columns': mobileColumns } as React.CSSProperties}>{records.map(record => {
            const text = value(record, titleField, 'text'), description = value(record, descriptionField, 'text'), image = value(record, imageField, 'src'), href = resolveHref(value(record, linkField, 'href'));
            return <article className="editor-site-product" key={record.id} data-content-record={record.id}>{image && <img {...imageAttributes(image, context.media, 'auto', !prefix)} alt={text} />}<div><h3>{href ? <SiteButton text={text} href={href} productLink editing={Boolean(context.editorCanvas)} /> : text}</h3></div>{description && <p>{description}</p>}{recordKind === 'product' && 'name' in record && inquiryAdd(record)}</article>;
          })}</div>{!records.length && <p className="editor-site-empty">{emptyText || (context.editorCanvas && recordKind === 'entry' && !modelId ? '请先选择内容模型' : componentTranslatableLabels('ContentList',labels).empty)}</p>}
        </section>;
      } },
      ContentLoop: { render: ({ id, source: kind = 'entry', modelId, relation, itemBlockId, eyebrow, title, count = 6, columns = 3, mobileColumns = 1, gap = 24, padding = 48, emptyText, query }) => {
        const recordKind = kind === 'entry' ? 'entry' : 'product',labels=queryLabels(query,locale);
        const invalidCard = !itemBlockId || !context.sharedBlocks?.some(block => block.id === itemBlockId) || sharedBlockContainsLoop(itemBlockId, context.sharedBlocks);
        const unavailable = context.loopItem || overBudget || invalidCard;
        const queried = queryContent(source, recordKind, modelId, query as ContentQuery | undefined, id, context.queryParams, Math.max(1, Math.min(CONTENT_LOOP_MAX_ITEMS, Number(count) || 6)),relationLoopIds(source,relation,bindingRuntime));
        const records = unavailable || recordKind === 'entry' && !modelId ? [] : queried.records;
        const parameterEntries = Object.entries(context.queryParams || {}).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : Array.isArray(value) ? value.map(item => [key, item]) : []);
        const pageKey = loopParam(id, 'page'), searchKey = loopParam(id, 'search'), termKey = loopParam(id, 'term');
        const pagePath = internalHref(context.currentPath || context.pages.find(page => page.id === context.pageId)?.slug || '/');
        const pageHref = (number: number) => { const params = new URLSearchParams(parameterEntries); params.set(pageKey, String(number)); return `${pagePath}?${params}`; };
        const terms = (context.taxonomies || []).filter(tax => tax.source === recordKind && (!tax.modelId || tax.modelId === modelId)).flatMap(tax => tax.terms);
        // 分类标签沿用稳定ID，导入的产品分类使用独立的参数值，两类筛选不会混用。
        const categories = [...terms, ...queried.productCategories.filter(category => !terms.some(term => term.id === category.id))];

        return <section className="editor-site-products editor-site-loop" data-content-loop={id} data-content-model={modelId || ''} style={{ paddingTop: padding, paddingBottom: padding }}>
          {/* AI升级自由卡片时保留原产品列表的栏目说明，仍可在原编辑器修改。 */}
          {eyebrow && <div className="editor-site-eyebrow">{eyebrow}</div>}
          {title && <div className="editor-site-collection-heading"><h2>{title}</h2></div>}
          {(query as ContentQuery | undefined)?.controls && <form action={pagePath} method="get" className="site-loop-filters">
            {parameterEntries.filter(([key]) => ![pageKey, searchKey, termKey].includes(key)).map(([key, value], index) => <input key={`${key}-${index}`} type="hidden" name={key} value={value} />)}
            <label>{labels.search} <input aria-label={`${labels.search} ${title || labels.content}`} type="search" name={searchKey} maxLength={200} defaultValue={queried.search} /></label>
            {!!categories.length && <label>{labels.category} <select name={termKey} defaultValue={queried.term}><option value="">{labels.all}</option>{categories.map(term => <option key={term.id} value={term.id}>{term.label}</option>)}</select></label>}
            <button type="submit" disabled={context.editorCanvas}>{labels.apply}</button>
          </form>}
          {recordKind === 'product' && inquiryReview}
          <div className="editor-site-loop-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(4, Number(columns) || 3))},minmax(0,1fr))`, gap, '--editor-mobile-columns': Math.max(1, Math.min(2, Number(mobileColumns) || 1)) } as React.CSSProperties}>{records.map((record, index) => <article className="editor-site-loop-item" key={record.id} data-loop-record={record.id} data-content-record={record.id}>{renderBlock(itemBlockId, `${id}-item-${index + 1}`, { source: recordKind, recordId: record.id, modelId: record.modelId })}{recordKind === 'product' && 'name' in record && inquiryAdd(record)}</article>)}</div>
          {(query as ContentQuery | undefined)?.paginate && <nav className="site-loop-pagination" aria-label={`${labels.pagination} ${title || id}`}>
            {queried.page > 1 && <a href={pageHref(queried.page - 1)}>{labels.previous}</a>}<span aria-current="page">{queried.page} / {queried.pages} · {queried.total} {labels.results}</span>{queried.page < queried.pages && <a href={pageHref(queried.page + 1)}>{labels.next}</a>}
          </nav>}
          {!records.length && <p className="editor-site-empty">{context.editorCanvas && unavailable ? '请选择不包含循环列表的卡片模板，并检查引用数量' : context.editorCanvas && recordKind === 'entry' && !modelId ? '请先选择内容模型' : (query as ContentQuery|undefined)?.labels?.[locale]?.empty || emptyText || labels.empty}</p>}
        </section>;
      } },
      Spacer: { render: ({ height, line }) => <div style={{ height, display: 'flex', alignItems: 'center', padding: '0 40px' }}>{line === 'yes' && <hr style={{ width: '100%', border: 0, borderTop: '1px solid #dce1db' }} />}</div> },
      SharedBlock: { render: ({ id, blockId }) => <div className={`editor-shared-block${context.editorCanvas ? ' editor-shared-block-readonly' : ''}`} data-shared-block={blockId || ''}>{renderBlock(String(blockId || ''), String(id || blockId || 'empty'))}</div> },
    },
  };
  // inline + dragRef 使用 Puck 的公开接口，让实际 DOM 元素成为栅格子项；
  // 否则画布额外 div 会吞掉跨列、排序与尺寸，导致与发布页面显示不一致。
  for (const [type, component] of Object.entries(config.components)) {
    const render = component.render as (props: Record<string, any>) => React.ReactElement<{ id?: string; 'data-site-node-id'?: string; 'data-site-source-node-id'?: string; className?: string; style?: React.CSSProperties; ref?: React.Ref<HTMLElement> }>;
    component.inline = true;
    component.render = (props) => {
      const id = String(props.id || type);
      // 仅绑定支持的展示属性，不允许绑定任意 DOM 属性、HTML 或事件处理器。
      const resolved = { ...props };
      // 明确内部目标优先于旧静态地址；失效目标不退回可能错误的旧链接。
      if (type === 'ActionButton' && props.linkTarget || type === 'ProductDetail' && props.linkTarget !== undefined && props.linkTarget !== null) resolved.href = resolveLinkTarget(source, props.linkTarget) || '';
      for (const target of BOUND_COMPONENT_TARGETS[type] || []) {
        const binding = props.bindings?.[target] as FieldBinding | undefined;
        if (!binding) continue;
        resolved[target] = target === 'images' ? resolveGalleryBinding(binding, source, bindingRuntime) : resolveBindingValue(binding, target, source, bindingRuntime);
      }
      // 案例等记录可能没有封面。画布保留可拖拽节点，访客页面省略无图的图片元素。
      if (type === 'Image' && props.bindings?.src && !resolved.src && !context.editorCanvas) return <></>;
      const emptyBoundGallery = type === 'Gallery' && props.bindings?.images && resolved.images.length === 0;
      if (emptyBoundGallery && !context.editorCanvas) return <></>;
      // 标题字体只在显式配置时启用；元素字体覆盖仍由高优先级design处理。
      const plainElement = emptyBoundGallery
        ? <div className="editor-site-empty">画廊已绑定。给预览记录添加图片后可查看效果。</div>
        : render(resolved);
      const richDoc=type==='Text'&&props.bindings?.text?resolveRichTextBinding(props.bindings.text as FieldBinding,source,bindingRuntime):undefined;
      // 保留旧Text的三端样式和稳定ID，但不能在<p>里再嵌入段落、列表或图片。
      const element=richDoc?React.createElement('div',{...plainElement.props,className:[plainElement.props.className,'site-rich-text'].filter(Boolean).join(' '),style:{...plainElement.props.style,whiteSpace:'normal'}},<RichDocument doc={richDoc} resolveHref={resolveHref} media={context.media} derived={!prefix}/>):plainElement;
      const css = themeNodeCss(theme, id, props as ThemeNodeProps, type);
      // 独立节点标识供预览几何定位使用，不把绑定值或素材地址写入检查报告。
      const styled = React.cloneElement(element, { 'data-site-node-id': id, 'data-site-source-node-id': context.sharedBlockSourceIds?.get(id), id: props.anchor ? anchorId(String(props.anchor)) : (element.props as { id?: string }).id || anchorId(id), style: type === 'Heading' && theme.headingFont ? { ...(element.props as { style?: React.CSSProperties }).style, fontFamily: theme.headingFont === 'system' ? 'system-ui,sans-serif' : theme.headingFont } : (element.props as { style?: React.CSSProperties }).style, className: [element.props.className, 'editor-design-node', designClassName(id)].filter(Boolean).join(' '), ref: props.puck?.dragRef || undefined });
      return <>{styled}{css && <style data-design-css={id}>{css}</style>}</>;
    };
  }
  return config;
}
