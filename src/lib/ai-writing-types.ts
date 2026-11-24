import type { RichNode } from './presentation-content';
import type { StudioState } from './types';
import type { AiWritingSourceRef } from './ai-writing-reuse-types';

export type AiWritingValue = string | RichNode | null;
export type AiWritingTask = 'product' | 'outline' | 'article' | 'rewrite' | 'summary';
export interface AiWritingTarget { kind: 'product' | 'entry'; id: string; modelId?: string; }
/** customFields:<字段ID>定位既有文字项；正文值用RichNode，文字镜像由服务端统一投影。 */
export interface AiWritingField { key: string; label: string; kind: 'text' | 'richtext'; maxLength: number; before: AiWritingValue; }
export interface AiWritingFact { id: string; label: string; text: string; source: string; confirmed: boolean; confirmedAt?: string; scope: 'company' | 'product'; productId?: string; sourceRef?: AiWritingSourceRef; }
export interface AiWritingProfile { revision: number; brandName: string; audience: string; market: string; tone: string; terminology: string; avoidedClaims: string; facts: AiWritingFact[]; updatedAt: string; }
export interface AiWritingProfileInput extends Omit<AiWritingProfile, 'revision' | 'updatedAt'> { expectedRevision: number; }
export interface AiWritingGenerateInput {
  target: AiWritingTarget; fields: AiWritingField[]; outputKeys: string[]; task: AiWritingTask;
  sourceText: string; instruction: string; language: string; audience: string; tone: string;
  factIds: string[]; profileRevision: number; referenceProductIds?: string[];
}
export interface AiWritingChange extends AiWritingField { after: string | RichNode; }
export interface AiWritingProposal {
  id: string; target: AiWritingTarget; task: AiWritingTask; createdAt: string; expiresAt: string;
  profileRevision: number; sourceText: string; stale: boolean; fields: AiWritingChange[]; evidence: AiWritingFact[];
  warnings: string[]; missingFacts: string[]; savedRevision: number | null; undoneRevision: number | null; referenceProductIds?: string[];
}
/** 采用前后是实际编辑区快照，可包含选段/追加转换；保存只登记仍等于after的字段。 */
export interface AiWritingReceiptInput { proposalId: string; selectedKeys: string[]; before: Record<string, AiWritingValue>; after: Record<string, AiWritingValue>; beforePresent?: Record<string, boolean>; }
export interface AiWritingSaveInput { expectedRevision: number; patch: Partial<StudioState>; receipts: AiWritingReceiptInput[]; saveAttemptId?: string; }
/** 保存完成标记独立于可撤销字段；即使没有合法撤销值，也能核对同一次请求已提交。 */
export interface AiWritingSaveAttempt { id: string; status: 'saved'; expectedRevision: number; savedRevision: number; targets: AiWritingTarget[]; proposalIds: string[]; receiptIds: string[]; warnings: string[]; createdAt: string; expiresAt: string; }
export interface AiWritingReceipt { id: string; proposalId: string; target: AiWritingTarget; createdAt: string; expiresAt: string; fields: string[]; savedRevision: number; undoneRevision: number | null; }
