'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Select, Space, Timeline, Typography } from 'antd';
import type { Inquiry, InquiryFollowUp } from '@/lib/types';
import { request } from '@/lib/studio-client';
import { formatDate } from '@/lib/date-format';
import { INQUIRY_PRIORITY_LABELS, INQUIRY_QUALIFICATION_LABELS, parseInquiryInstant } from '@/lib/inquiry-tracking';
import type { InquiryFollowUpDraft } from '@/lib/inquiry-recovery';
export type { InquiryFollowUpDraft } from '@/lib/inquiry-recovery';

/** 旧询盘仅在界面补缺省值；打开详情不会写回或自动判定线索有效性。 */
export function inquiryFollowUpDraft(inquiry: Inquiry): InquiryFollowUpDraft {
  return { notes: inquiry.notes || '', assigneeId: inquiry.assignee?.id || null, priority: inquiry.priority || 'normal', nextFollowUpAt: inquiry.nextFollowUpAt || null, qualification: inquiry.qualification || 'unreviewed', followUpNote: '' };
}

/** 新增记录是待追加文本，不参与已保存字段的并发比较，也不会覆盖服务器历史。 */
export function inquiryDraftKey(draft: InquiryFollowUpDraft) {
  return JSON.stringify([draft.notes, draft.assigneeId, draft.priority, draft.nextFollowUpAt, draft.qualification]);
}

function localDateTime(value: string | null) {
  if (parseInquiryInstant(value) === null) return '';
  const date = new Date(value!);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type Assignee = { id: string; name: string; role: 'admin' | 'editor' };
type Props = { inquiry: Inquiry; draft: InquiryFollowUpDraft; onChange: (draft: InquiryFollowUpDraft) => void; onSave: () => Promise<boolean>; editable: boolean; busy: boolean; dirty: boolean; conflict: boolean; timezone: string };

export default function InquiryFollowUpPanel({ inquiry, draft, onChange, onSave, editable, busy, dirty, conflict, timezone }: Props) {
  const [assignees, setAssignees] = useState<Assignee[]>([]), [assigneeError, setAssigneeError] = useState(''), [assigneeReload, setAssigneeReload] = useState(0);
  const [history, setHistory] = useState<InquiryFollowUp[]>([]), [historyLoading, setHistoryLoading] = useState(true), [historyError, setHistoryError] = useState(''), [historyReload, setHistoryReload] = useState(0);
  const [deviceTimezone, setDeviceTimezone] = useState('');
  const [dateError, setDateError] = useState('');
  useEffect(() => { setDeviceTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || '设备当前时区'); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ items: Assignee[] }>('/api/inquiries/assignees', { signal: controller.signal }).then(result => { setAssignees(result.items); setAssigneeError(''); }).catch(error => { if (!controller.signal.aborted) setAssigneeError(error.message); });
    return () => controller.abort();
  }, [assigneeReload]);
  useEffect(() => {
    const controller = new AbortController(); setHistoryLoading(true);
    void request<{ items: InquiryFollowUp[]; revision: number }>(`/api/inquiries/${inquiry.id}/follow-ups`, { signal: controller.signal }).then(result => { setHistory(result.items); setHistoryError(''); }).catch(error => { if (!controller.signal.aborted) setHistoryError(error.message); }).finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [inquiry.id, inquiry.revision, historyReload]);

  const unavailable = inquiry.assignee && !assignees.some(item => item.id === inquiry.assignee?.id);
  const options: { value: string; label: string; disabled?: boolean }[] = assignees.map(item => ({ value: item.id, label: item.name }));
  if (unavailable && inquiry.assignee) options.push({ value: inquiry.assignee.id, label: `${inquiry.assignee.name}${inquiry.assigneeAvailable === false ? '（当前不可分配）' : ''}`, disabled: inquiry.assigneeAvailable === false });
  function changeDate(value: string) {
    if (!value) { setDateError(''); onChange({ ...draft, nextFollowUpAt: null }); return; }
    // 原生时间输入明确使用设备时区；统一转UTC保存，详情摘要再按站点时区展示。
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || localDateTime(date.toISOString()) !== value.slice(0, 16)) { setDateError('这个时间在设备时区中无效，请重新选择'); return; }
    setDateError(''); onChange({ ...draft, nextFollowUpAt: date.toISOString() });
  }

  return <Space orientation="vertical" size={16} style={{ width: '100%' }}>
    <Card size="small" title="销售跟进" className="cs-follow-up-card">
      <Form layout="vertical" disabled={!editable || busy}>
        {assigneeError && <Alert type="warning" showIcon title="负责人列表暂时无法读取" description={<Space wrap><Typography.Text>{assigneeError}</Typography.Text><Button size="small" disabled={busy} onClick={() => setAssigneeReload(value => value + 1)}>重试</Button></Space>} style={{ marginBottom: 16 }} />}
        <div className="cs-follow-up-fields">
          <Form.Item label="负责人" extra={inquiry.assigneeAvailable === false ? '原负责人已不可用，请重新分配。' : undefined}>
            <Select aria-label="询盘负责人" allowClear placeholder="未分配" value={draft.assigneeId ?? undefined} options={options} onChange={value => onChange({ ...draft, assigneeId: value || null })} />
          </Form.Item>
          <Form.Item label="优先级"><Select aria-label="询盘优先级" value={draft.priority} options={Object.entries(INQUIRY_PRIORITY_LABELS).map(([value, label]) => ({ value, label }))} onChange={value => onChange({ ...draft, priority: value })} /></Form.Item>
        </div>
        <Form.Item label="下次跟进" validateStatus={dateError ? 'error' : undefined} help={dateError || undefined} extra={`按设备时区 ${deviceTimezone || '读取中'} 输入；留空表示暂不安排。`}>
          <Input aria-label="下次跟进时间" type="datetime-local" step={60} value={deviceTimezone ? localDateTime(draft.nextFollowUpAt) : ''} disabled={!editable || busy || !deviceTimezone} onChange={event => changeDate(event.target.value)} />
          {draft.nextFollowUpAt && <Typography.Text type="secondary" className="cs-follow-up-date">站点时间：{formatDate(draft.nextFollowUpAt, timezone)}（{timezone}）</Typography.Text>}
        </Form.Item>
        <Form.Item label="询盘有效性" extra="根据实际需求与沟通人工判断。判为无效或归档后不再提醒跟进。"><Select aria-label="询盘有效性" value={draft.qualification} options={Object.entries(INQUIRY_QUALIFICATION_LABELS).map(([value, label]) => ({ value, label }))} onChange={value => onChange({ ...draft, qualification: value })} /></Form.Item>
        <Form.Item label="处理备注"><Input.TextArea aria-label="询盘处理备注" value={draft.notes} maxLength={10000} autoSize={{ minRows: 3, maxRows: 8 }} onChange={event => onChange({ ...draft, notes: event.target.value })} /></Form.Item>
        <Form.Item label="新增内部跟进记录" extra="保存后追加到历史，仅供内部查看。"><Input.TextArea aria-label="新增内部跟进记录" value={draft.followUpNote} maxLength={2000} showCount autoSize={{ minRows: 3, maxRows: 8 }} placeholder="例如：已确认采购数量，约定下周发送选型建议。" onChange={event => onChange({ ...draft, followUpNote: event.target.value })} /></Form.Item>
        <Button type="primary" loading={busy} disabled={!editable || !dirty || conflict || !!dateError} onClick={() => { void onSave(); }}>保存跟进</Button>
      </Form>
    </Card>
    <Card size="small" title={`内部跟进历史${history.length ? ` · ${history.length}` : ''}`} extra={<Button size="small" loading={historyLoading} onClick={() => setHistoryReload(value => value + 1)}>刷新记录</Button>}>
      {historyError && <Alert type="error" title={historyError} style={{ marginBottom: 16 }} />}
      {history.length ? <div className="cs-follow-up-history" tabIndex={0} aria-label="内部跟进历史"><Timeline items={history.slice().reverse().map(item => ({ key: item.id, content: <Space orientation="vertical" size={4} style={{ width: '100%' }}><Typography.Text strong>{item.actorName || '原成员'} <Typography.Text type="secondary">{formatDate(item.createdAt, timezone)}</Typography.Text></Typography.Text><div className="cs-follow-up-note">{item.note}</div></Space> }))} /></div> : historyLoading ? <Typography.Text type="secondary">正在读取跟进记录…</Typography.Text> : !historyError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有内部跟进记录" /> : null}
    </Card>
  </Space>;
}
