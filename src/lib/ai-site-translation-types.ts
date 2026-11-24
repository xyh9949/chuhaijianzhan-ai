import type { AiTranslationTerm, AiTranslationValue } from './ai-translation-types';
export type SiteTranslationAssetKind = 'page' | 'block' | 'menu' | 'form';
export interface TranslationGlossaryEntry extends AiTranslationTerm { id: string; sourceLocale: string; targetLocale: string; }
export interface TranslationGlossary { revision: number; entries: TranslationGlossaryEntry[]; updatedAt: string | null; }
export interface SiteTranslationSelection { pageIds: string[]; includeChrome: boolean; }
export interface SiteTranslationRequest extends SiteTranslationSelection { expectedRevision: number; sourceLocale: string; targetLocale: string; terms?: AiTranslationTerm[]; useGlossary?: boolean; glossaryRevision?: number; }
export interface SiteTranslationSourcePage { id: string; title: string; slug: string; locale: string; targetId?: string; targetTitle?: string; sourceChanged?: boolean; targetChanged?: boolean; }
export interface SiteTranslationImpact { kind: SiteTranslationAssetKind; sourceId: string; targetId: string; locale: string; label: string; sourceChanged: boolean; targetChanged: boolean; missingSource: boolean; missingTarget: boolean; }
export interface SiteTranslationContext { currentRevision: number; locales: { code: string; label: string }[]; defaultLocale: string; pages: SiteTranslationSourcePage[]; glossary: TranslationGlossary; impacts: SiteTranslationImpact[]; warnings: string[]; }
export interface SiteTranslationFieldChange { id: string; label: string; source: AiTranslationValue; before: AiTranslationValue; after: AiTranslationValue; }
export interface SiteTranslationPagePreview { sourceId: string; targetId: string; sourceTitle: string; targetTitle: string; isNew: boolean; beforeUrl: string; afterUrl: string; }
export interface SiteTranslationPreview { id: string; parentId?: string; sourceLocale: string; targetLocale: string; baseRevision: number; currentRevision: number; allPageIds: string[]; selectedPageIds: string[]; includesChrome: boolean; availableChrome: boolean; pages: SiteTranslationPagePreview[]; fields: SiteTranslationFieldChange[]; warnings: string[]; stale: boolean; staleReason?: string; createdAt: string; expiresAt: string; appliedRevision: number | null; undoneRevision: number | null; canUndo: boolean; undoReason?: string; }
