import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearLocalRecovery, clearOtherLocalRecoveries, localRecoveries, storeLocalRecovery } from '../src/lib/local-recovery';
import { clearInquiryNoteRecovery, inquiryNoteRecoveryScope, readInquiryNoteRecovery, readInquiryNoteRecoveryFromScope, type InquiryNoteRecovery } from '../src/lib/inquiry-recovery';

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] || null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
let previous: PropertyDescriptor | undefined, storage: MemoryStorage;
const actor = 'inquiry-recovery-test';
const snapshot = (inquiryId: string): InquiryNoteRecovery => ({ inquiryId, notes: `Unsaved ${inquiryId}`, baseNotes: '', baseRevision: 3, draft: { notes: `Unsaved ${inquiryId}`, assigneeId: 'editor', priority: 'urgent', nextFollowUpAt: '2026-12-01T04:00:00.000Z', qualification: 'qualified', followUpNote: `Pending ${inquiryId}` }, baseDraft: { notes: '', assigneeId: null, priority: 'normal', nextFollowUpAt: null, qualification: 'unreviewed', followUpNote: '' }, baseFollowUpCount: 2 });
beforeEach(() => { previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'); storage = new MemoryStorage(); Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage }); clearOtherLocalRecoveries(actor); });
afterEach(() => { for (const entry of localRecoveries(actor)) clearLocalRecovery(actor, entry.scope); if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });

test('保存或放弃B只清B，A完整跟进字段和待追加记录仍可恢复', () => {
  const retained = snapshot('A');
  storeLocalRecovery(actor, inquiryNoteRecoveryScope('A'), 'inquiries', '询盘跟进 · A', retained);
  storeLocalRecovery(actor, inquiryNoteRecoveryScope('B'), 'inquiries', '询盘跟进 · B', snapshot('B'));
  clearInquiryNoteRecovery(actor, 'B');
  assert.deepEqual(readInquiryNoteRecovery(actor, 'A')?.snapshot, retained);
  assert.equal(readInquiryNoteRecovery(actor, 'B'), undefined);
  assert.equal(readInquiryNoteRecovery(actor)?.snapshot.inquiryId, 'A');
});

test('旧单键只读回退，不因查看或保存另一询盘被迁移/删除；明确处理本条才清除', () => {
  const legacy = { inquiryId: 'A', notes: 'Legacy notes', baseNotes: '', baseRevision: 1 };
  storeLocalRecovery(actor, 'inquiry-notes', 'inquiries', '询盘处理备注', legacy);
  const diskBefore = [...storage.data];
  assert.deepEqual(readInquiryNoteRecovery(actor, 'A')?.snapshot, legacy);
  assert.deepEqual([...storage.data], diskBefore);
  clearInquiryNoteRecovery(actor, 'B');
  assert.deepEqual(readInquiryNoteRecovery(actor, 'A')?.snapshot, legacy);
  clearInquiryNoteRecovery(actor, 'A');
  assert.equal(readInquiryNoteRecovery(actor), undefined);
});

test('冷读取验证完整结构与scope所属记录，损坏或串记录副本不进入详情', () => {
  const scope = inquiryNoteRecoveryScope('cold'), value = snapshot('cold');
  storage.setItem(`form-studio:local-recovery:v1:${actor}:${scope}`, JSON.stringify({ version: 1, actorId: actor, scope, screen: 'inquiries', title: '询盘跟进 · cold', updatedAt: Date.now(), snapshot: value, persisted: true, requiresFile: false }));
  assert.deepEqual(readInquiryNoteRecovery(actor, 'cold')?.snapshot, value);
  storeLocalRecovery(actor, inquiryNoteRecoveryScope('wrong'), 'inquiries', 'Wrong', snapshot('different'));
  assert.equal(readInquiryNoteRecoveryFromScope(actor, inquiryNoteRecoveryScope('wrong')), undefined);
  storeLocalRecovery(actor, inquiryNoteRecoveryScope('broken'), 'inquiries', 'Broken', { ...snapshot('broken'), draft: { ...snapshot('broken').draft, followUpNote: 'x'.repeat(2001) } });
  assert.equal(readInquiryNoteRecovery(actor, 'broken'), undefined);
});

test('相同询盘ID的恢复副本按账号隔离，读取不会返回另一成员的私人跟进输入', () => {
  storeLocalRecovery(actor, inquiryNoteRecoveryScope('same'), 'inquiries', 'Mine', snapshot('same'));
  assert.equal(readInquiryNoteRecovery('other-inquiry-owner', 'same'), undefined);
  assert.deepEqual(readInquiryNoteRecovery(actor, 'same')?.snapshot, snapshot('same'));
});
