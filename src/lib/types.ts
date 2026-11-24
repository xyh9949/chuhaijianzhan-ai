import type { Data } from '@puckeditor/core';
import type { RichNode } from './presentation-content';
import type { SiteJourneyBridge } from './site-journey';

export type Screen = 'overview' | 'site-journey' | 'pages' | 'products' | 'media' | 'inquiries' | 'templates' | 'theme' | 'global-design' | 'content-models' | 'ai-content-review' | 'releases' | 'settings' | 'seo' | 'editor' | 'preview' | 'login' | 'setup';
/** 内容详情模板通过页面绑定模型；模型不保存反向指针，避免两份配置互相覆盖。 */
export interface SeoMeta { seoTitle?: string; seoDescription?: string; seoImage?: string; noindex?: boolean; }
/** 旧记录缺省语言沿用站点默认；复制译文始终为待核对草稿。 */
export interface LocalizedContent { locale?:string; translationGroupId?:string; translationState?:'source'|'needs-review'|'reviewed'; }
export interface PageItem extends SeoMeta,LocalizedContent { id: string; title: string; slug: string; status: 'published' | 'draft'; type: string; updated: string; contentModelId?: string; }
export interface Product extends SeoMeta,LocalizedContent { updated?:string; id: string; name: string; sku: string; category: string; status: 'published' | 'draft'; image: string; images?: string[]; description: string; /** 可选原生图文详情；短介绍保持原语义，不接收HTML。 */ detailContent?: RichNode; material: string; modelId?: string; customFields?: Record<string, FieldValue>; slug?: string; termIds?: string[]; sortOrder?: number; }
/** 内部链接只保存稳定ID，实际网址由当前草稿或发布快照解析。 */
export type LinkTarget = { kind: 'page' | 'product' | 'entry'; id: string };
export interface RedirectRule { id: string; from: string; target: LinkTarget; status: 301 | 302; enabled?: boolean; }
export interface PublishedRedirect { from: string; to: string; status: 301 | 302; }
export interface TaxonomyTerm { id: string; label: string; slug: string; parentId?: string; }
export interface Taxonomy { id: string; name: string; source: 'product' | 'entry'; modelId?: string; terms: TaxonomyTerm[]; }
export interface QueryFilter { field: string; op: 'eq' | 'contains' | 'gte' | 'lte' | 'in'; value: string | number | boolean | string[]; }
export type QueryLabelKey='search'|'category'|'all'|'apply'|'previous'|'next'|'results'|'content'|'pagination'|'empty';
export interface ContentQuery { filters?: QueryFilter[]; termIds?: string[]; sort?: string; direction?: 'asc' | 'desc'; paginate?: boolean; pageSize?: number; controls?: boolean; productCategories?: boolean; labels?:Record<string,Partial<Record<QueryLabelKey,string>>>; }
export interface MediaItem { id: string; name: string; url: string; kind: 'image' | 'document' | 'video'; folder: string; size: string; alt: string; width?: number; height?: number; bytes?: number; pages?: number; variants?: { width: number; height: number }[]; }
export interface InquiryFollowUp { id: string; note: string; createdAt: string; actorId: string; actorName: string; }
/** 型号和名称来自接收询盘时的公开版本；以后换型号或下架仍保留原采购清单。 */
export interface InquiryItem { productId: string; sku: string; name: string; quantity: number; requirements?: string; }
/** 询盘和跟进是运行资料；可选字段兼容旧记录，不随网站发布或整站模板分发。历史按需读取。 */
export interface Inquiry { id: string; name: string; company: string; email: string; country: string; product: string; message: string; date: string; status: 'new' | 'contacted' | 'archived'; revision?: number; origin?: 'manual' | 'website'; phone?: string; notes?: string; formId?: string; formName?: string; releaseId?: string; sourcePath?: string; locale?: string; productId?: string; items?: InquiryItem[]; attribution?: import('./inquiry-attribution').InquiryAttribution; assignee?: { id: string; name: string }; assigneeAvailable?: boolean; priority?: 'normal' | 'high' | 'urgent'; nextFollowUpAt?: string | null; qualification?: 'unreviewed' | 'qualified' | 'invalid'; followUpCount?: number; lastFollowUpAt?: string; answers?: { id: string; label: string; type: FormFieldType; value: string | boolean | null; displayValue?: string }[]; }
export type FormFieldType = 'text' | 'textarea' | 'email' | 'phone' | 'select' | 'checkbox' | 'country' | 'product';
export interface FormFieldDefinition { id: string; label: string; type: FormFieldType; required: boolean; placeholder?: string; maxLength?: number; options?: { id: string; label: string }[]; mapTo?: 'name' | 'company' | 'email' | 'phone' | 'country' | 'product' | 'message'; }
export interface FormDefinition { id: string; name: string; enabled: boolean; fields: FormFieldDefinition[]; submitLabel: string; successMessage: string; multiProduct?: boolean; }
export interface Release { id: string; title: string; date: string; author: string; status: 'current' | 'history'; changes: string[]; snapshot?: Record<string, unknown>; }
export interface DesignToken { id: string; name: string; value: string | number; }
export type TokenBindings = Partial<Record<import('./responsive-style').Device, Partial<Record<import('./responsive-style').DesignKey, string>>>>;
export type StateStyles = Partial<Record<'hover' | 'focus' | 'active', import('./responsive-style').ResponsiveDesign>>;
export interface StylePreset { id: string; name: string; design: import('./responsive-style').ResponsiveDesign; tokenBindings?: TokenBindings; stateStyles?: StateStyles; }
export interface SiteTheme { primary: string; background: string; text: string; radius: number; font: string; headingFont?: string; defaults?: import('./responsive-style').ResponsiveDesign; tokens?: DesignToken[]; presets?: StylePreset[]; }
export interface SiteSettings { discovery?: import('./discovery').DiscoverySettings; name: string; domain: string; description: string; email: string; language: string; timezone: string; publicUrl?: string; locales?:{code:string;label:string}[]; }
export interface SharedBlock { id: string; name: string; data: Data; updated: string; }
/** 页面模板复制后独立；详情模板应用到唯一默认详情页，不额外建立同模型的第二个默认入口。 */
export interface DetailTemplateRule { enabled:boolean; priority:number; modelId?:string; recordIds?:string[]; termIds?:string[]; locale?:string; }
export interface PageTemplate { id: string; name: string; description: string; kind: 'page' | 'product' | 'entry'; modelId?: string; sourcePath?: string; data: Data; code?: CodeSnippet; updated: string; detailRule?:DetailTemplateRule; }
export interface MenuItem { id: string; label: string; target?: LinkTarget | null; href?: string; newTab?: boolean; children?: MenuItem[]; }
export interface SiteMenu { id: string; name: string; items: MenuItem[]; }
/** 语言区块沿原生SharedBlock复用；默认语言的保留映射供将来换默认语言使用，不抢占default外观。 */
export interface SiteLayoutSlot { mode: 'default' | 'block' | 'hidden'; blockId: string; menuId?: string; localeMenuIds?: Record<string,string>; localeBlockIds?: Record<string,string>; }
export interface SiteLayout { header: SiteLayoutSlot; footer: SiteLayoutSlot; menus?: SiteMenu[]; }
export interface CodeSnippet { css: string; js: string; cssEnabled: boolean; jsEnabled: boolean; }
export interface SiteCustomCode { global: CodeSnippet; pages: Record<string, CodeSnippet>; }
export type FieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect' | 'image' | 'gallery' | 'url' | 'relation';
export type FieldValue = string | number | boolean | string[] | null;
/** 产品可选择内置基础来源或具体模型；独立内容必须明确目标模型，首版只允许强引用。 */
export interface RelationDefinition { source:'product'|'entry'; modelId?:string; multiple:boolean; onDelete:'restrict'; }
/** 循环关系明确所属模型；只读取当前记录的一跳字段。 */
export interface RelationLoop { source:'product'|'entry'; modelId:string; fieldId:string; }
export interface ContentField { id: string; key: string; label: string; type: FieldType; required: boolean; description?: string; unit?: string; min?: number; max?: number; options?: { label: string; value: string }[]; relation?:RelationDefinition; }
export interface ContentModel { id: string; name: string; description: string; target: 'product' | 'content'; fields: ContentField[]; updated: string; }
/** slug 留空时使用稳定 ID；详情地址、SEO 与字段值一起进入不可变发布快照。 */
/** 排版正文仅覆盖既有多行文本字段；纯文本仍保留在customFields供搜索、SEO和旧绑定使用。 */
export interface ContentEntry extends SeoMeta,LocalizedContent { id: string; modelId: string; title: string; status: 'draft' | 'published'; updated: string; customFields: Record<string, FieldValue>; richTextFields?: Record<string, RichNode>; slug?: string; termIds?: string[]; sortOrder?: number; }
/** 绑定保存稳定字段 ID；字段名称修改不会使页面引用失效。 */
export interface FieldBinding { source: 'product' | 'entry'; mode: 'current' | 'fixed'; modelId?: string; recordId?: string; field: string; fallback?: string; }
export interface BindingContext { source: 'product' | 'entry'; recordId: string; modelId?: string; }
export interface StudioState { pages: PageItem[]; products: Product[]; media: MediaItem[]; inquiries: Inquiry[]; releases: Release[]; theme: SiteTheme; settings: SiteSettings; editorData: Record<string, unknown>; activePageId: string; pageTemplates?: PageTemplate[]; sharedBlocks?: SharedBlock[]; forms?: FormDefinition[]; siteLayout?: SiteLayout; taxonomies?: Taxonomy[]; redirects?: RedirectRule[]; customCode?: SiteCustomCode; contentModels?: ContentModel[]; contentEntries?: ContentEntry[]; }
export interface ScreenProps { state: StudioState; update: (patch: Partial<StudioState>) => Promise<void>; navigate: (screen: Screen) => void; journey?: SiteJourneyBridge; }
