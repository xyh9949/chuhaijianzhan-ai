import type { DraftContent } from '../server/types';

/** AI只规划声明式内容；输入中没有源码、任意链接或全局配置覆盖入口。 */
export interface AiSiteBrief {
  companyName: string;
  description: string;
  industry: string;
  audience: string;
  market: string;
  language: string;
  styleNotes: string;
}

/** 产品范围只携带当前草稿ID，模型上下文由服务端读取，不能从客户端注入产品正文。 */
export interface AiSitePlanRequest {
  brief: AiSiteBrief;
  expectedRevision: number;
  selectedProductIds?: string[];
}

export type AiSiteSectionKind = 'hero' | 'text' | 'features' | 'products' | 'contact';
/** 布局仅选择原生组件编排，不引入任意HTML/CSS或不可编辑的截图。 */
export const AI_SITE_LAYOUTS = ['editorial', 'catalog', 'showcase', 'split', 'bento', 'minimal'] as const;
export type AiSiteLayout = typeof AI_SITE_LAYOUTS[number];
export const AI_SITE_LAYOUT_LABELS: Record<AiSiteLayout, string> = { editorial: '叙事与留白', catalog: '产品与目录', showcase: '视觉与展示', split: '交错与对比', bento: '模块与层次', minimal: '大字与编号' };
export const AI_SECTION_LAYOUTS = ['auto', 'split-left', 'split-right', 'stacked', 'cards', 'steps'] as const;
export type AiSectionLayout = typeof AI_SECTION_LAYOUTS[number];
export interface AiSiteSection {
  kind: AiSiteSectionKind;
  heading: string;
  body: string;
  /** split-left/right表示图片位置；缺图退为文字布局，旧方案不填时保持原编排。 */
  layout?: AiSectionLayout;
  items?: { title: string; body: string }[];
  /** 只保存现有素材ID，编译时再从服务端当前草稿取真实地址。 */
  mediaId?: string;
  /** 缺省沿用布局的默认按钮，null表示明确隐藏；指定按钮只引用已规划普通页的稳定key。 */
  cta?: { label: string; pageKey: string } | null;
}
export interface AiSitePagePlan {
  key: string;
  title: string;
  path: string;
  purpose: string;
  seoTitle: string;
  seoDescription: string;
  sections: AiSiteSection[];
}
export interface AiSiteDirection {
  id: string;
  name: string;
  rationale: string;
  primary: string;
  background: string;
  text: string;
  headingFont: 'sans' | 'serif' | 'mono';
  layout: AiSiteLayout;
}
export interface AiSitePlan {
  summary: string;
  /** 新规划解释目标并驱动真实页面结构；旧方案缺省时继续原产品目录契约。 */
  intent?: { siteType: 'product-catalog' | 'professional-services' | 'brand-showcase'; primaryGoal: string; audienceTasks: string[]; constraints: string[]; missingFacts: string[] };
  pages: AiSitePagePlan[];
  directions: AiSiteDirection[];
}
export interface AiSiteSeoIssue {
  pageKey: string;
  pageId?: string;
  path: string;
  code: 'long-title' | 'long-description' | 'duplicate-title' | 'duplicate-description' | 'missing-products' | 'missing-contact' | 'missing-public-url' | 'low-contrast' | 'language-mismatch';
  severity: 'warning';
  message: string;
}
export interface AiSiteCompileResult {
  patch: Partial<DraftContent>;
  pageIds: string[];
  warnings: string[];
  seoIssues: AiSiteSeoIssue[];
}

/** 只描述原生组件及最终断点样式；不把模型的设计想法、首屏可见性或商业效果当事实。 */
export interface AiBuildDeviceLayout {
  visible: boolean;
  order: number;
  columns: number | null;
  innerGrids: { columns: number; spans: number[] }[];
  flow: string[];
  numberedItems: number;
  /** 组件配置模式，不保证当前记录一定有图片、型号或行动按钮。 */
  productIdentityFirst?: boolean;
  productDetailOrder?: 'specifications-first' | 'overview-first';
  actions: { label: string; path?: string; dynamic?: boolean }[];
  lists: { id: string; source: string; columns: number | null; fields: string[] }[];
}
export interface AiBuildSectionLayout {
  id: string; title: string; role: 'navigation' | 'content' | 'footer';
  desktop: AiBuildDeviceLayout; tablet: AiBuildDeviceLayout; mobile: AiBuildDeviceLayout;
}
export interface AiBuildPageLayout {
  id: string; title: string; path: string; kind: 'page' | 'template'; sections: AiBuildSectionLayout[];
}
export interface AiBuildLayoutInspection { source: 'native-components'; pages: AiBuildPageLayout[]; }
