import { createHash } from 'node:crypto';
import type { Inquiry } from '../lib/types';
import { csvDocument } from '../lib/form-content';
import { getDatabase } from './database';
import { ApiError } from './http';
import { getStudioEnvelope, listInquiries } from './studio';
import { object, revision, text } from './validation';
import { notificationStatus } from './notification-jobs';
import { ATTRIBUTION_UNVERIFIED_LABEL, attributionChannelLabel, inquirySourceLabel } from '../lib/inquiry-attribution';
import { formatInquiryItems, inquirySearchText } from '../lib/inquiry-items';
import { INQUIRY_PRIORITY_LABELS, INQUIRY_QUALIFICATION_LABELS, matchesInquiryFollowUpFilter, type InquiryFollowUpFilter } from '../lib/inquiry-tracking';

type Policy = { revision: number; retention_days: number; updated_at: string };
export function getInquiryPolicy() {
  const row = getDatabase().prepare('SELECT revision,retention_days,updated_at FROM cms_inquiry_policy WHERE id=1').get() as Policy;
  return { revision: row.revision, retentionDays: row.retention_days, updatedAt: row.updated_at, notification: notificationStatus() };
}
export function saveInquiryPolicy(value: unknown) {
  const input = object(value, '询盘保留策略'), expected = revision(input.expectedRevision);
  if (Object.keys(input).some(k => !['expectedRevision', 'retentionDays'].includes(k)) || !Number.isInteger(input.retentionDays) || Number(input.retentionDays) < 0 || Number(input.retentionDays) > 3650) throw new ApiError(422, '保留天数须为0–3650的整数；0表示未设置清理期限');
  const result = getDatabase().prepare('UPDATE cms_inquiry_policy SET revision=revision+1,retention_days=?,updated_at=? WHERE id=1 AND revision=?').run(Number(input.retentionDays), new Date().toISOString(), expected);
  if (result.changes !== 1) throw new ApiError(409, '保留策略已变化，请刷新后重试');
  return getInquiryPolicy();
}
function cleanupRows(cutoff: string) { return getDatabase().prepare("SELECT id,revision FROM cms_inquiry WHERE created_at>='2000-01-01T00:00:00.000Z' AND created_at<? ORDER BY id LIMIT 1000").all(cutoff) as { id: string; revision: number }[]; }
function cleanupHash(cutoff: string, rows: { id: string; revision: number }[], policyRevision: number) { return createHash('sha256').update(JSON.stringify([cutoff, policyRevision, rows])).digest('hex'); }
/** 仅预览，不自动删除。清理范围、批次覆盖和并发版本都由随后明确提交核对。 */
export function previewInquiryCleanup(now = Date.now()) {
  const policy = getInquiryPolicy(); if (!policy.retentionDays) throw new ApiError(422, '请先明确设置保留天数，系统不会替经营者决定期限');
  const cutoff = new Date(now - policy.retentionDays * 86400000).toISOString(), rows = cleanupRows(cutoff);
  const total = (getDatabase().prepare("SELECT count(*) AS count FROM cms_inquiry WHERE created_at>='2000-01-01T00:00:00.000Z' AND created_at<?").get(cutoff) as { count: number }).count;
  return { cutoff, count: rows.length, total, policyRevision: policy.revision, confirmation: cleanupHash(cutoff, rows, policy.revision) };
}
function assertNotSending(ids: string[], now: number) {
  const query = getDatabase().prepare("SELECT 1 FROM cms_notification_job WHERE inquiry_id=? AND status='processing' AND lease_until>? LIMIT 1");
  if (ids.some(id => !!query.get(id, now))) throw new ApiError(409, '通知正在处理中，请待处理结束后再删除相关询盘');
}
export function applyInquiryCleanup(value: unknown, now = Date.now()) {
  const input = object(value, '清理确认'), policy = getInquiryPolicy();
  if (!policy.retentionDays || typeof input.cutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.cutoff)) throw new ApiError(422, '请先预览清理范围');
  const cutoff = Date.parse(input.cutoff), expectedCutoff = now - policy.retentionDays * 86400000;
  if (!Number.isFinite(cutoff) || cutoff > expectedCutoff || expectedCutoff - cutoff > 300000 || input.policyRevision !== policy.revision) throw new ApiError(409, '清理预览或策略已过期，请重新预览');
  return getDatabase().transaction(() => {
    if (getInquiryPolicy().revision !== policy.revision) throw new ApiError(409, '保留策略已变化，请重新预览');
    const rows = cleanupRows(input.cutoff as string);
    if (input.confirmation !== cleanupHash(input.cutoff as string, rows, policy.revision)) throw new ApiError(409, '询盘范围或备注已变化，未删除任何记录，请重新预览');
    assertNotSending(rows.map(r => r.id), now);
    const remove = getDatabase().prepare('DELETE FROM cms_inquiry WHERE id=? AND revision=?');
    // 外键级联移除对应通知和幂等回执；网站发布历史从未包含这些运行数据。
    rows.forEach(row => remove.run(row.id, row.revision));
    return { removed: rows.length, ...getInquiryPolicy() };
  }).immediate();
}
export function deleteInquiryRecord(id: string, value: unknown, now = Date.now()) {
  const input = object(value, '删除询盘'), expected = revision(input.expectedRevision);
  getDatabase().transaction(() => {
    const row = getDatabase().prepare('SELECT revision FROM cms_inquiry WHERE id=?').get(id) as { revision: number } | undefined;
    if (!row) throw new ApiError(404, '询盘不存在'); if (row.revision !== expected) throw new ApiError(409, '询盘已变化，请刷新后重新删除');
    assertNotSending([id], now); getDatabase().prepare('DELETE FROM cms_inquiry WHERE id=?').run(id);
  }).immediate();
  return getStudioEnvelope();
}
export function inquiriesCsv(value: unknown, actorId?: string, now = Date.now()) {
  const input = object(value, '导出范围');
  if (Object.keys(input).some(k => !['search', 'status', 'country', 'followUpFilter'].includes(k))) throw new ApiError(422, '导出筛选无效');
  const search = text(input.search ?? '', '搜索', 200).trim().toLowerCase(), country = text(input.country ?? 'all', '国家或地区', 100), status = text(input.status ?? 'all', '导出状态', 20);
  if (!['all', 'new', 'contacted', 'archived'].includes(status)) throw new ApiError(422, '导出状态无效');
  const followUpFilter = input.followUpFilter ?? 'all';
  if (typeof followUpFilter !== 'string' || !['all', 'mine', 'unassigned', 'overdue', 'priority'].includes(followUpFilter) || followUpFilter === 'mine' && !actorId) throw new ApiError(422, '跟进导出筛选无效');
  // “我的询盘”只用已鉴权服务端身份；与列表共用筛选规则和逾期口径。
  const items = listInquiries().filter(item => (status === 'all' || item.status === status) && (country === 'all' || item.country === country) && inquirySearchText(item).includes(search) && matchesInquiryFollowUpFilter(item, followUpFilter as InquiryFollowUpFilter, actorId || '', now));
  if (items.length > 10000) throw new ApiError(413, '单次导出最多10000条，请缩小筛选范围');
  const answerText = (i: Inquiry) => i.answers?.map(a => `${a.label}: ${a.displayValue ?? (a.value === null ? '(未填写)' : a.value === false ? '否' : a.value === true ? '是' : a.value)}`).join('\n') || '';
  // 保留原有列顺序，在末尾追加询价清单；所有文本统一经过CSV公式防护。
  return csvDocument([['联系人', '公司', '邮箱', '电话', '国家/地区', '产品', '留言', '收到时间(UTC)', '状态', '来源页面', '表单', '自定义答案', '处理备注', '提交语言', '询盘来源', '来源线索类型', '链接来源(utm_source)', '链接媒介(utm_medium)', '链接活动(utm_campaign)', '外部引荐主机', '首次来源页面', '来源记录时间(UTC)', '来源可信度', '负责人', '优先级', '质量判断', '下次跟进(UTC)', '内部跟进次数', '最近内部跟进(UTC)', '询价产品清单'], ...items.map(i => [i.name, i.company, i.email, i.phone, i.country, i.product, i.message, i.date, i.status, i.sourcePath, i.formName, answerText(i), i.notes, i.locale || '未记录', inquirySourceLabel(i), i.attribution ? attributionChannelLabel(i.attribution.channel) : '未采集', i.attribution?.utmSource, i.attribution?.utmMedium, i.attribution?.utmCampaign, i.attribution?.referrerHost, i.attribution?.landingPath, i.attribution?.capturedAt, i.attribution ? ATTRIBUTION_UNVERIFIED_LABEL : '未记录', i.assignee?.name || '未分配', INQUIRY_PRIORITY_LABELS[i.priority || 'normal'], INQUIRY_QUALIFICATION_LABELS[i.qualification || 'unreviewed'], i.nextFollowUpAt || '', i.followUpCount || 0, i.lastFollowUpAt || '', formatInquiryItems(i.items)])]);
}
