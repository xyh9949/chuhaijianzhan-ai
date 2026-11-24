import type { AiSiteBrief, AiSitePlan, AiSiteSeoIssue, AiBuildLayoutInspection } from './ai-builder-types';
import type { AiDesignGuidanceStamp } from './ai-design-guidance-types';

/** 恢复列表仅给运行摘要；完整资料必须本人主动读取单条，不外泄冻结站点快照。 */
export interface AiBuildPage { id: string; title: string; slug: string; }
/** 长期保存的是方案及生成选项，页面预览仍各自短期冻结。 */
export interface AiBuildSavedPlan { savedAt: string; prefix: string; directionId: string; }
/** 采用后的撤销状态按当前原生字段和引用实时计算，不把过期/旧格式记录伪装成可撤销。 */
export interface AiBuildUndoStatus { canUndo: boolean; undoneRevision: number | null; undoReason?: string; }
export interface AiBuildRunSummary {
  designGuidance?: AiDesignGuidanceStamp;
  operation?: 'shared-chrome';
  manuallyEdited?: boolean;
  savedPlan?: AiBuildSavedPlan;
  companyName?: string;
  id: string; kind: 'plan' | 'preview'; baseRevision: number; expiresAt: string;
  appliedRevision: number | null; pages?: AiBuildPage[];
  canUndo?: boolean; undoneRevision?: number | null; undoReason?: string;
}
export interface AiBuildRunsResponse { items: AiBuildRunSummary[]; currentRevision: number; }
export interface AiBuildPlanRun {
  designGuidance?: AiDesignGuidanceStamp;
  kind: 'plan'; planId: string; baseRevision: number; currentRevision: number;
  expiresAt: string; appliedRevision: null; plan: AiSitePlan; brief: AiSiteBrief; selectedProductIds?: string[];
  manuallyEdited?: boolean;
  savedPlan?: AiBuildSavedPlan;
  superseded?: boolean;
}
export interface AiBuildPreviewRun {
  /** 由本人冻结原生页面派生；旧payload不需要补写或重新编译。 */
  inspection?: AiBuildLayoutInspection;
  designGuidance?: AiDesignGuidanceStamp;
  operation?: 'shared-chrome'; beforePrefix?: string; afterPrefix?: string;
  kind: 'preview'; previewId: string; baseRevision: number; currentRevision: number;
  expiresAt: string; appliedRevision: number | null; pages: AiBuildPage[]; warnings: string[];
  seoIssues: AiSiteSeoIssue[]; planId: string; directionId: string; prefix: string;
  /** 父方案过期时不回传其资料；预览本身仍按自己的期限及采用规则处理。 */
  plan?: AiBuildPlanRun;
  canUndo?: boolean; undoneRevision?: number | null; undoReason?: string;
}
export type AiBuildRun = AiBuildPlanRun | AiBuildPreviewRun;
