/** 已确认摘录保留来源快照；引用不是对原件真实性的系统认证。 */
export interface AiWritingSourceRef {
  kind: 'pdf' | 'xlsx' | 'product'; recordId: string; sourceId?: string;
  fingerprint: string; locator: string; snapshot: string; capturedAt: string;
  quotes?: { pageNumber: number; quote: string }[];
}
export interface AiWritingSourceState { status: 'available' | 'changed' | 'unavailable'; message: string; }
export interface AiWritingReuseCandidate {
  id: string; label: string; text: string; source: string; scope: 'company' | 'product'; productId?: string;
  sourceRef: AiWritingSourceRef;
}
export interface AiWritingReuseResponse {
  sources: { id: string; fileName: string; kind: 'pdf' | 'xlsx'; expiresAt: string }[];
  candidates: AiWritingReuseCandidate[]; warnings: string[];
  states: Record<string, AiWritingSourceState>;
}
