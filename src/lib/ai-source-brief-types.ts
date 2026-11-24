import type { AiSiteBrief } from './ai-builder-types';

export type AiImportedBrief = Partial<Omit<AiSiteBrief, 'language'>>;
export interface AiSourceBriefFact {
  field: keyof AiImportedBrief;
  value: string;
  pageNumbers: number[];
  evidence: { pageNumber: number; quote: string }[];
}
/** 引文只是原文出处，整理结果仍需用户逐项核对，不构成企业资质验证。 */
export interface AiSourceBriefResult {
  briefId: string;
  brief: AiImportedBrief;
  warnings: string[];
  sources: { pageNumber: number }[];
  facts: AiSourceBriefFact[];
}
