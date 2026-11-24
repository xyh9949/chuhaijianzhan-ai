import type { AiWritingChange, AiWritingFact, AiWritingTask, AiWritingTarget } from './ai-writing-types';

/** 外部模型只提交候选，原生草稿保存由负责人浏览器确认；创建资料不是任意记录补丁。 */
export interface ExternalAiWritingRequest {
  target: AiWritingTarget;
  expectedRevision: number;
  profileRevision: number;
  create?: { name?: string; sku?: string; category?: string; material?: string };
  task: AiWritingTask;
  fieldKeys: string[];
  instruction: string;
  sourceText: string;
  language: string;
  audience: string;
  tone: string;
  factIds: string[];
  referenceProductIds: string[];
  baseCandidateId?: string;
}
export interface ExternalAiWritingView {
  id: string;
  proposalId: string;
  request: ExternalAiWritingRequest;
  target: AiWritingTarget;
  task: AiWritingTask;
  fields: AiWritingChange[];
  evidence: Omit<AiWritingFact, 'sourceRef'>[];
  warnings: string[];
  missingFacts: string[];
  baseRevision: number;
  currentRevision: number;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'applied' | 'undone';
  stale: boolean;
  reviewUrl: string;
  requiresBrowserConfirmation: true;
  generatedContentEditable: true;
  siteModelCalls: false;
  isNew: boolean;
  recordLabel: string;
  creation?: ExternalAiWritingRequest['create'];
  appliedKeys?: string[];
  savedRevision: number | null;
  undoneRevision: number | null;
  canUndo: boolean;
  undoReason?: string;
}
