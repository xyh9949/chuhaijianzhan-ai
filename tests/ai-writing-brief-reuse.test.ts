import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiWritingFact, AiWritingProfile } from '../src/lib/ai-writing-types';
import { briefReuseSelectionError, briefReuseSourceGate } from '../src/lib/ai-writing-brief-reuse';
const fact: AiWritingFact = { id: 'company-fact', label: '工艺说明', text: 'Confirmed process', source: 'PDF第1页', scope: 'company', confirmed: true, sourceRef: { kind: 'pdf', recordId: 'aib-example', sourceId: 'ais-example', fingerprint: 'a'.repeat(64), locator: 'description', snapshot: 'Confirmed process', capturedAt: '2026-01-01T00:00:00Z' } };
const profile = (facts: AiWritingFact[]): AiWritingProfile => ({ revision: 1, brandName: '', audience: '', market: '', tone: '', terminology: '', avoidedClaims: '', facts, updatedAt: '' });
test('建站采用复核拒绝来源变化，包括此前已选事实', () => {
  const changed = { status: 'changed' as const, message: '来源已变化，请重新确认' };
  assert.equal(briefReuseSourceGate(fact, changed).blocked, true); assert.match(briefReuseSelectionError(profile([fact]), [fact.id], { [fact.id]: changed }), /来源已变化/);
});
test('来源读取失败不能被误当作无变化，人工事实仍可单独核对', () => {
  assert.equal(briefReuseSourceGate(fact).blocked, true); assert.match(briefReuseSelectionError(profile([fact]), [fact.id]), /无法判断/); assert.equal(briefReuseSelectionError(profile([{ ...fact, sourceRef: undefined }]), [fact.id]), '');
});
test('已确认摘录原件失效时保留不可回查警示，允许明确使用摘录', () => {
  const unavailable = { status: 'unavailable' as const, message: '原件不可回查' }, gate = briefReuseSourceGate(fact, unavailable);
  assert.equal(gate.blocked, false); assert.match(gate.message, /只.*保留/); assert.equal(briefReuseSelectionError(profile([fact]), [fact.id], { [fact.id]: unavailable }), '');
});
test('采用前拒绝已经删除、取消确认或改为产品范围的事实', () => {
  for (const facts of [[], [{ ...fact, confirmed: false }], [{ ...fact, scope: 'product' as const, productId: 'other-product' }]]) assert.match(briefReuseSelectionError(profile(facts), [fact.id], { [fact.id]: { status: 'available', message: '可回查' } }), /删除|取消确认|适用范围/);
});
