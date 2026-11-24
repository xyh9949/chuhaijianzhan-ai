import type { AiSiteBrief } from './ai-builder-types';
export type AiSourceMergeField = Exclude<keyof AiSiteBrief, 'language'>;
export interface AiSourceMergeEvidence { id: string; sourceId: string; fileName: string; kind: 'pdf' | 'xlsx'; location: string; text: string; ocrNeedsReview: boolean; }
export interface AiSourceMergePrepared { evidenceSetId: string; expiresAt: string; items: AiSourceMergeEvidence[]; warnings: string[]; }
export interface AiSourceMergeChoice { field: AiSourceMergeField; mode: 'keep' | 'replace' | 'append' | 'ignore'; items: { evidenceId: string; value: string }[]; }
export interface AiSourceMergeChange { field: AiSourceMergeField; before: string; after: string; mode: AiSourceMergeChoice['mode']; evidence: AiSourceMergeEvidence[]; edited: boolean; }
export interface AiSourceMergePreview { previewId: string; baseBrief: AiSiteBrief; afterBrief: AiSiteBrief; changes: AiSourceMergeChange[]; warnings: string[]; expiresAt: string; }
export interface AiSourceMergeReceipt { previewId: string; patch: Partial<AiSiteBrief>; afterBrief: AiSiteBrief; confirmed?: true; undone?: true; canUndo?: boolean; }
