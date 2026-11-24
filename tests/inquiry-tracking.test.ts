import test from 'node:test';
import assert from 'node:assert/strict';
import type { Inquiry } from '../src/lib/types';
import { getInquiryFollowUpState, inquiriesInPeriod, matchesInquiryFollowUpFilter, parseInquiryInstant, summarizeInquiryFollowUps } from '../src/lib/inquiry-tracking';
const now = Date.parse('2026-11-10T04:00:00.000Z');
const inquiry = (patch: Partial<Inquiry> = {}): Inquiry => ({ id: 'qa', name: 'Synthetic', email: 'qa@example.invalid', company: '', country: '', product: '', message: 'Synthetic inquiry', date: new Date(now).toISOString(), status: 'new', ...patch });

test('跟进时间仅接受明确UTC，不猜地区格式、空值或非法日期', () => {
  assert.equal(parseInquiryInstant('2026-11-10T04:00:00Z'), now);
  assert.equal(parseInquiryInstant('2026-11-10T04:00:00.000Z'), now);
  for (const value of ['', null, undefined, '2026-11-10', '11/10/2026', '2026-02-30T04:00:00Z', '2026-11-10T04:00:00+08:00']) assert.equal(parseInquiryInstant(value), null);
});
test('已到期以具体时刻判断；已跟进仍可排下次，归档与无效不再提醒', () => {
  assert.equal(getInquiryFollowUpState(inquiry(), now), 'none');
  assert.equal(getInquiryFollowUpState(inquiry({ nextFollowUpAt: new Date(now).toISOString() }), now), 'overdue');
  assert.equal(getInquiryFollowUpState(inquiry({ status: 'contacted', nextFollowUpAt: new Date(now + 1).toISOString() }), now), 'scheduled');
  for (const patch of [{ status: 'archived' as const }, { qualification: 'invalid' as const }]) assert.equal(getInquiryFollowUpState(inquiry({ nextFollowUpAt: new Date(now - 1).toISOString(), ...patch }), now), 'none');
});
test('失效负责人仍保留姓名，筛选及工作台将其视为待重新分配，不改变数据', () => {
  const item = inquiry({ assignee: { id: 'old-editor', name: 'Historical name' }, assigneeAvailable: false, priority: 'urgent', nextFollowUpAt: new Date(now - 1).toISOString() });
  const copy = structuredClone(item);
  assert.equal(matchesInquiryFollowUpFilter(item, 'mine', 'old-editor', now), true);
  assert.equal(matchesInquiryFollowUpFilter(item, 'unassigned', 'current', now), true);
  assert.equal(matchesInquiryFollowUpFilter(item, 'priority', 'current', now), true);
  assert.deepEqual(summarizeInquiryFollowUps([item, inquiry({ status: 'archived' }), inquiry({ qualification: 'invalid' })], 'old-editor', now), { pending: 1, overdue: 1, scheduled: 0, mine: 1, unassigned: 1, highPriority: 1 });
  assert.deepEqual(item, copy);
});
test('期间统计只使用有效收到时间；全部保留日期未记录，时间边界与未来数据明确', () => {
  const items = [inquiry(), inquiry({ date: new Date(now - 7 * 86400000).toISOString() }), inquiry({ date: new Date(now - 7 * 86400000 - 1).toISOString() }), inquiry({ date: '旧版刚刚' }), inquiry({ date: new Date(now + 1).toISOString() })];
  const period = inquiriesInPeriod(items, 7, now);
  assert.equal(period.items.length, 2); assert.equal(period.undated, 1); assert.equal(period.excludedUndated, 1);
  assert.equal(inquiriesInPeriod(items, null, now).items.length, 5); assert.equal(inquiriesInPeriod(items, null, now).excludedUndated, 0);
});
