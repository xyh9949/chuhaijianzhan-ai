import type { RichNode } from './presentation-content';
import type { SeoEvidence, SeoTarget, SeoReportCoverage } from './seo-types';

export type SeoContentGroup = 'body' | 'faq' | 'links' | 'seoTitle' | 'seoDescription';
export interface SeoContentReportRows { reportId: string; rowNumbers: number[]; }
export interface SeoContentLink { key: string; target: Pick<SeoTarget, 'kind' | 'id'>; label: string; url: string; language: string; }
export interface SeoContentField { key: string; label: string; text: string; }
export interface SeoContentContext {
  target: SeoTarget; language: string; currentRevision: number; fields: SeoContentField[];
  links: SeoContentLink[]; warnings: string[];
}
export interface SeoContentChange {
  key: SeoContentGroup; label: string; explanation: string; doc?: RichNode; text?: string;
}
export interface SeoContentEvidence extends SeoEvidence { device?: string; property?: string; sourceUrl: string; sourceMock: boolean; coverage: SeoReportCoverage; connectionRevision: number; }
export interface SeoContentPreview {
  id: string; target: SeoTarget; language: string; fieldKey: string; summary: string;
  changes: SeoContentChange[]; evidence: SeoContentEvidence[]; warnings: string[]; missingFacts: string[];
  baseRevision: number; currentRevision: number; stale: boolean;
  createdAt: string; expiresAt: string; beforeUrl: string | null; afterUrl: string | null;
  selectedGroups?: SeoContentGroup[]; appliedRevision: number | null; undoneRevision: number | null;
  request: Pick<SeoContentRequest, 'instruction' | 'reportRows' | 'linkTargetKeys'>;
  canUndo: boolean; undoReason?: string;
}
export interface SeoContentRequest {
  target: Pick<SeoTarget, 'kind' | 'id'>; fieldKey?: string; expectedRevision: number;
  instruction: string; reportRows: SeoContentReportRows[]; linkTargetKeys: string[];
}
