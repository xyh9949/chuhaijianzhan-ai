import type { AiPageEditChange, AiPageEditIntent, AiPageEditOperation } from './ai-page-edit-types';
import type { ResponsiveDesign } from './responsive-style';
import type { SiteTheme } from './types';
import type { AiPreviewFeedback } from './ai-preview-inspection';
import type { AiDesignGuidanceStamp } from './ai-design-guidance-types';
import type { AiDesignTreeUnit } from './ai-design-asset-details';

/** 内容页范围与全站区域分开授权；部分页面任务不能暗中改全站默认。 */
export interface AiSiteDesignTargets { pageIds: string[]; header: boolean; footer: boolean; navigation: boolean; style: boolean; }
export interface AiSiteDesignRequest { expectedRevision: number; instruction: string; targets: AiSiteDesignTargets; preserveText: boolean; baseDesignId?: string; previewFeedback?: { pageId: string; reports: AiPreviewFeedback[] }[]; }
export interface AiSiteDesignAffectedPage { pageId: string; title: string; slug: string; reasons: string[]; }
export interface AiSiteDesignScope { targets: AiSiteDesignTargets; selectedPageIds: string[]; affectedPageIds: string[]; warnings: string[]; }
export type AiSiteDesignChange = AiPageEditChange & { area: 'page' | 'header' | 'footer' | 'navigation' | 'style'; pageId?: string; };
export type AiSiteDesignMenuItemInput = { existingId: string } | { label: string; pageId: string; children?: AiSiteDesignMenuItemInput[] };
export type AiSiteDesignOperation =
  | { kind: 'page'; pageId: string; operations: AiPageEditOperation[] }
  | { kind: 'pageChrome'; pageId: string; header?: 'inherit' | 'hidden'; footer?: 'inherit' | 'hidden' }
  | { kind: 'chrome'; slot: 'header' | 'footer'; operations: AiPageEditOperation[] }
  | { kind: 'navigation'; slot: 'header' | 'footer'; locale?: string; items: AiSiteDesignMenuItemInput[] }
  | { kind: 'theme'; theme: Partial<Pick<SiteTheme, 'primary' | 'background' | 'text' | 'radius' | 'font' | 'headingFont'>> & { defaults?: ResponsiveDesign } };
export interface AiSiteDesignPreviewPage { pageId: string; title: string; slug: string; available: boolean; beforeUrl?: string; afterUrl?: string; unavailableReason?: string; }
/** 采用单位按最终资源差异分组，导航与实际承载它的头尾及资产一起处理。 */
export interface AiSiteDesignSelectionUnit { id: string; label: string; area: 'page' | 'header' | 'footer' | 'style'; pageIds: string[]; description: string; sectionSelectionUnavailableReason?: string; }
/** 区块包含完整子树；相互依赖的结构合成一个单位，ID只由服务器生成。 */
export interface AiSiteDesignSectionUnit extends AiSiteDesignSelectionUnit { area: 'page'; parentId: string; nodeIds: string[]; kind: 'section'; detailSelectionUnavailableReason?: string; }
/** 内部项是互不重叠的完整子树；所属根与父区块由服务器核对，不能拆出单独属性。 */
export interface AiSiteDesignDetailUnit extends AiSiteDesignSelectionUnit { area: 'page'; parentId: string; rootId: string; nodeIds: string[]; kind: 'detail'; }
export interface AiSiteDesignSelection { sourceDesignId: string; unitIds: string[]; }
/** 新细分范围仍只接受服务器opaque ID；不会开放原始props或任意JSON路径。 */
export type AiSiteDesignPropertyUnit = AiDesignTreeUnit & { area: 'page'; pageIds: string[]; kind: 'property' };
export type AiSiteDesignAssetUnit = AiDesignTreeUnit & { area: 'header' | 'footer'; pageIds: string[] };
export interface AiSiteDesignPreview {
  designGuidance?: AiDesignGuidanceStamp;
  designId: string; baseRevision: number; createdAt: string; expiresAt: string;
  appliedRevision: number | null; undoneRevision: number | null;
  request: AiSiteDesignRequest; scope: AiSiteDesignScope;
  summary: string; intent?: AiPageEditIntent; changes: AiSiteDesignChange[]; warnings: string[];
  affectedPages: AiSiteDesignAffectedPage[]; previewPages: AiSiteDesignPreviewPage[];
  beforeUrl: string; afterUrl: string; refinement?: { baseDesignId: string; round: number };
  selectionUnits: AiSiteDesignSelectionUnit[];
  sectionUnits?: AiSiteDesignSectionUnit[];
  detailUnits?: AiSiteDesignDetailUnit[];
  propertyUnits?: AiSiteDesignPropertyUnit[];
  assetUnits?: AiSiteDesignAssetUnit[];
  selection?: AiSiteDesignSelection;
}
