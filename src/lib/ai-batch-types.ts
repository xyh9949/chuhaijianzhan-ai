import type { AiWritingProposal } from './ai-writing-types';
import type { AiTranslationPreview } from './ai-translation-types';
export type AiBatchKind='writing'|'translation';
export interface AiBatchChoice { kind:'product'|'entry';id:string;label:string;locale:string;modelId?:string;fields:{key:string;label:string;kind:'text'|'richtext'}[]; }
export interface AiBatchContext { records:AiBatchChoice[];total:number;locales:{code:string;label:string}[];profileRevision:number; }
export interface AiBatchItem { position:number;sourceKind:'product'|'entry';sourceId:string;label:string;status:'queued'|'running'|'generated'|'failed'|'unknown'|'skipped';error:string;canRetry:boolean;proposal?:AiWritingProposal|AiTranslationPreview;previewError?:string;beforeUrl?:string|null;afterUrl?:string|null;previewStale?:boolean;appliedRevision:number|null;undoneRevision:number|null;receiptId?:string;appliedKeys?:string[]; }
export interface AiBatchJob {id:string;revision:number;status:'draft'|'paused'|'running'|'completed'|'cancelled';kind:AiBatchKind;instruction:string;targetLocale?:string;sampleApproved:boolean;createdAt:string;expiresAt:string;items:AiBatchItem[];}
