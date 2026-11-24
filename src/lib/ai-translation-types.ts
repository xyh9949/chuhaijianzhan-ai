import type { RichNode } from './presentation-content';

export type AiTranslationKind = 'product' | 'entry';
export type AiTranslationValue = string | RichNode | null;
export interface AiTranslationTarget { kind: AiTranslationKind; id: string; }
export interface AiTranslationTerm { source: string; target: string; }
/** 要求只控制措辞和语气，不能越过原文槽位、固定术语及品牌/数字保护。 */
export interface AiTranslationGenerateInput { kind: AiTranslationKind; sourceId: string; targetLocale: string; expectedRevision: number; fieldKeys?: string[]; terms?: AiTranslationTerm[]; instruction?: string; }
export interface AiTranslationField { key: string; label: string; kind: 'text' | 'richtext'; maxLength: number; source: AiTranslationValue; before: AiTranslationValue; }
export interface AiTranslationChange extends AiTranslationField { after: string | RichNode; }
export interface AiTranslationContext {
  target: AiTranslationTarget; sourceLabel: string; sourceLocale: string; currentRevision: number;
  locales: { code: string; label: string; existingId?: string; existingLabel?: string }[];
  fields: AiTranslationField[]; warnings: string[];
}
export interface AiTranslationPreview {
  id: string; target: AiTranslationTarget; sourceLabel: string; sourceLocale: string; targetLocale: string;
  targetId: string; targetLabel: string; isNew: boolean; targetSku?: string; fields: AiTranslationChange[];
  terms: AiTranslationTerm[]; warnings: string[]; baseRevision: number; currentRevision: number; stale: boolean;
  createdAt: string; expiresAt: string; appliedRevision: number | null; undoneRevision: number | null;
  appliedKeys?: string[];
  beforeUrl: string | null; afterUrl: string | null; canUndo: boolean; undoReason?: string; sourceChangedAfterApply: boolean;
}
