import type { Inquiry } from './types';

export const INQUIRY_PRIORITY_LABELS = { normal: '普通', high: '较高', urgent: '紧急' } as const;
export const INQUIRY_QUALIFICATION_LABELS = { unreviewed: '待判断', qualified: '有效', invalid: '无效' } as const;
export type InquiryFollowUpFilter = 'all' | 'mine' | 'unassigned' | 'overdue' | 'priority';

/** 只读明确的UTC时间，不把缺失日期或地区格式猜成零值/当天；同时排除无效日历日期。 */
export function parseInquiryInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : null;
}

/** 排期是内部待办；归档或人工判无效后不提醒，已跟进但仍有下一次排期的记录继续提醒。 */
export function getInquiryFollowUpState(inquiry: Inquiry, now = Date.now()): 'none' | 'scheduled' | 'overdue' {
  if (inquiry.status === 'archived' || inquiry.qualification === 'invalid') return 'none';
  const time = parseInquiryInstant(inquiry.nextFollowUpAt);
  return time === null ? 'none' : time <= now ? 'overdue' : 'scheduled';
}

export function matchesInquiryFollowUpFilter(inquiry: Inquiry, filter: InquiryFollowUpFilter, actorId: string, now = Date.now()): boolean {
  switch (filter) {
    case 'mine': return inquiry.assignee?.id === actorId;
    case 'unassigned': return !inquiry.assignee || inquiry.assigneeAvailable === false;
    case 'overdue': return getInquiryFollowUpState(inquiry, now) === 'overdue';
    case 'priority': return inquiry.priority === 'high' || inquiry.priority === 'urgent';
    default: return true;
  }
}

export function summarizeInquiryFollowUps(inquiries: Inquiry[], actorId = '', now = Date.now()) {
  const active = inquiries.filter(item => item.status !== 'archived' && item.qualification !== 'invalid');
  return {
    pending: active.filter(item => item.status === 'new').length,
    overdue: active.filter(item => getInquiryFollowUpState(item, now) === 'overdue').length,
    scheduled: active.filter(item => getInquiryFollowUpState(item, now) === 'scheduled').length,
    mine: active.filter(item => item.assignee?.id === actorId).length,
    unassigned: active.filter(item => !item.assignee || item.assigneeAvailable === false).length,
    highPriority: active.filter(item => item.priority === 'high' || item.priority === 'urgent').length,
  };
}

/** 统计收到的询盘，近N天采用过去N×24小时；日期未记录的旧资料只在“全部”纳入总数。 */
export function inquiriesInPeriod(inquiries: Inquiry[], days: 7 | 30 | null, now = Date.now()) {
  const undated = inquiries.filter(item => parseInquiryInstant(item.date) === null).length;
  const items = days === null ? inquiries : inquiries.filter(item => {
    const time = parseInquiryInstant(item.date);
    return time !== null && time >= now - days * 86400000 && time <= now;
  });
  return { items, undated, excludedUndated: days === null ? 0 : undated };
}
