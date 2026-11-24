import type { Inquiry } from './types';
import { clearLocalRecovery, localRecoveries, readLocalRecovery } from './local-recovery';

export type InquiryFollowUpDraft = { notes: string; assigneeId: string | null; priority: NonNullable<Inquiry['priority']>; nextFollowUpAt: string | null; qualification: NonNullable<Inquiry['qualification']>; followUpNote: string };
export type InquiryNoteRecovery = { inquiryId: string; notes: string; baseNotes: string; baseRevision: number; draft?: InquiryFollowUpDraft; baseDraft?: InquiryFollowUpDraft; baseFollowUpCount?: number };
const legacyScope = 'inquiry-notes', scopePrefix = `${legacyScope}:`;

/** 每条询盘一个完整跟进副本，保存或放弃B不能清掉已保留的A；旧单键仅作只读回退。 */
export function inquiryNoteRecoveryScope(inquiryId: string) { return `${scopePrefix}${inquiryId}`; }
export function isInquiryNoteRecoveryScope(scope: unknown): scope is string { return typeof scope === 'string' && (scope === legacyScope || scope.startsWith(scopePrefix)); }
function validDraft(value: unknown) {
  const draft = value as InquiryFollowUpDraft;
  return !!draft && typeof draft.notes === 'string' && draft.notes.length <= 10000 && (draft.assigneeId === null || typeof draft.assigneeId === 'string' && draft.assigneeId.length <= 100) && ['normal', 'high', 'urgent'].includes(draft.priority) && (draft.nextFollowUpAt === null || typeof draft.nextFollowUpAt === 'string' && draft.nextFollowUpAt.length <= 40) && ['unreviewed', 'qualified', 'invalid'].includes(draft.qualification) && typeof draft.followUpNote === 'string' && draft.followUpNote.length <= 2000;
}
function validRecovery(value: unknown) {
  const saved = value as InquiryNoteRecovery;
  return !!saved && typeof saved.inquiryId === 'string' && saved.inquiryId.length > 0 && saved.inquiryId.length <= 100 && typeof saved.notes === 'string' && saved.notes.length <= 10000 && typeof saved.baseNotes === 'string' && saved.baseNotes.length <= 10000 && Number.isSafeInteger(saved.baseRevision) && (saved.draft === undefined || validDraft(saved.draft)) && (saved.baseDraft === undefined || validDraft(saved.baseDraft)) && (saved.baseFollowUpCount === undefined || Number.isSafeInteger(saved.baseFollowUpCount) && saved.baseFollowUpCount >= 0);
}
export function readInquiryNoteRecoveryFromScope(actorId: string, scope: string) {
  if (!isInquiryNoteRecoveryScope(scope)) return;
  const saved = readLocalRecovery<InquiryNoteRecovery>(actorId, scope, validRecovery);
  return saved && (scope === legacyScope || scope === inquiryNoteRecoveryScope(saved.snapshot.inquiryId)) ? saved : undefined;
}
export function readInquiryNoteRecovery(actorId: string, inquiryId?: string) {
  if (inquiryId) {
    for (const scope of [inquiryNoteRecoveryScope(inquiryId), legacyScope]) {
      const saved = readInquiryNoteRecoveryFromScope(actorId, scope);
      if (saved?.snapshot.inquiryId === inquiryId) return saved;
    }
    return;
  }
  for (const entry of localRecoveries(actorId)) {
    const saved = readInquiryNoteRecoveryFromScope(actorId, entry.scope);
    if (saved) return saved;
  }
}
/** 只有当前记录成功保存或明确放弃时，才同时清它自己的新键与对应旧键。 */
export function clearInquiryNoteRecovery(actorId: string, inquiryId: string) {
  clearLocalRecovery(actorId, inquiryNoteRecoveryScope(inquiryId));
  if (readInquiryNoteRecoveryFromScope(actorId, legacyScope)?.snapshot.inquiryId === inquiryId) clearLocalRecovery(actorId, legacyScope);
}
