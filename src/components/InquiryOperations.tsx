'use client';
import MoreSettings from './MoreSettings';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import { clearLocalRecovery, requestLocalLeave } from '@/lib/local-recovery';
import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Flex, Form, InputNumber, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import type { Inquiry } from '@/lib/types';
import { RequestError, request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { formatDate } from '@/lib/date-format';
import InquiryFollowUpPanel, { inquiryDraftKey, inquiryFollowUpDraft, type InquiryFollowUpDraft } from './InquiryFollowUpPanel';
import { INQUIRY_PRIORITY_LABELS, INQUIRY_QUALIFICATION_LABELS, type InquiryFollowUpFilter } from '@/lib/inquiry-tracking';
import { ATTRIBUTION_UNVERIFIED_LABEL, attributionChannelLabel, inquirySourceLabel } from '@/lib/inquiry-attribution';
import { clearInquiryNoteRecovery, inquiryNoteRecoveryScope, readInquiryNoteRecovery } from '@/lib/inquiry-recovery';
export { readInquiryNoteRecovery } from '@/lib/inquiry-recovery';

type Job = { id: string; inquiryId: string; status: string; attempts: number; nextAttempt: number; errorCode: string; createdAt: string; updatedAt: string };
type JobData = { jobs: Job[]; total: number; configuration: { mode: string; configured: boolean } };
const statuses: Record<string, { label: string; color: string }> = { pending: { label: '等待通知', color: 'blue' }, processing: { label: '处理中', color: 'processing' }, sent: { label: '已交邮件服务', color: 'green' }, mock_sent: { label: '模拟完成', color: 'cyan' }, failed: { label: '待人工处理', color: 'red' }, unconfigured: { label: '未配置', color: 'orange' } };
const errorLabels: Record<string, string> = { EAUTH: '邮件账号验证失败', ECONNECTION: '无法连接邮件服务', ETIMEDOUT: '邮件连接超时', ESOCKET: '连接中断', EENVELOPE: '收件地址被服务拒绝，可能有部分已被接受', EMESSAGE: '邮件内容被拒绝', EDNS: '邮件服务器地址解析失败', ETLS: '安全连接失败', LEASE_EXPIRED: '处理进程中断，已达到重试上限', SEND_FAILED: '通知处理失败' };

/** 通知状态独立读取；后台只看到结果和安全错误码，不返回SMTP凭据或租约令牌。 */
export function NotificationStatusPanel({ inquiryId }: { inquiryId?: string }) {
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const [data, setData] = useState<JobData>(), [error, setError] = useState(''), [reload, setReload] = useState(0), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => {
      try { const result = await request<JobData>(`/api/notifications${inquiryId ? `?inquiryId=${encodeURIComponent(inquiryId)}` : ''}`, { signal: controller.signal }); if (!active) return; setData(result); setError(''); if (result.jobs.some(j => ['pending', 'processing'].includes(j.status))) timer = setTimeout(load, 5000); }
      catch (e) { if (active) setError((e as Error).message); }
    };
    void load(); return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [inquiryId, reload]);
  async function retry(id: string) { setBusy(true); try { await request(`/api/notifications/${id}/retry`, { method: 'POST' }); setReload(v => v + 1); message.success('任务已重新排队；接收线索的事实不受通知结果影响'); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); } }
  function openMailSettings() {
    // 先处理询盘备注等未保存输入，再定位邮件分区；只导航，不携带配置或执行发送。
    requestLocalLeave(() => {
      const url = new URL(location.href); url.searchParams.set('settings', 'mail'); url.hash = 'settings';
      history.pushState(history.state, '', url.href); window.dispatchEvent(new HashChangeEvent('hashchange'));
      window.dispatchEvent(new Event('form-studio:open-mail-settings'));
    }, 'mail-settings');
  }
  return <Card size="small" title="询盘通知" extra={<Button size="small" onClick={() => setReload(v => v + 1)}>刷新状态</Button>}>
    {error && <Alert type="error" title={error} />}
    {data && <><Alert type={data.configuration.configured ? 'info' : 'warning'} showIcon title={!data.configuration.configured ? '邮件通知未开启或未配置，询盘仍会真实保存' : data.configuration.mode === 'mock' ? '当前为本地模拟，不会向真实邮箱外发' : '通知通过服务器邮件服务处理'} description="提交成功表示已收到询盘。邮件服务接受后不等于对方收件箱已送达；失败重试采用至少一次投递，可能重复通知。" action={runtime.actor.role === 'admin' ? <Button size="small" onClick={openMailSettings}>配置邮件通知</Button> : undefined} />
    <Table<Job> size="small" rowKey="id" scroll={{ x: 620 }} dataSource={data.jobs} pagination={{ pageSize: 5, hideOnSinglePage: true }} columns={[
      ...(!inquiryId ? [{ title: '联系人', key: 'contact', render: (_: unknown, job: Job) => runtime.envelope.state.inquiries.find(i => i.id === job.inquiryId)?.name || '网站访客' }] : []),
      { title: '状态', dataIndex: 'status', render: value => <Tag color={statuses[value]?.color}>{statuses[value]?.label || value}</Tag> }, { title: '尝试', dataIndex: 'attempts', width: 60 },
      { title: '处理结果', render: (_, job) => job.errorCode ? errorLabels[job.errorCode] || '通知处理失败' : job.status === 'pending' && job.nextAttempt > Date.now() ? `下次尝试 ${formatDate(new Date(job.nextAttempt).toISOString(), runtime.envelope.state.settings.timezone)}` : job.status === 'mock_sent' ? '仅模拟生成，无真实发送' : job.status === 'sent' ? '邮件服务已接受' : '等待处理' },
      { title: '操作', render: (_, job) => runtime.actor.role === 'admin' && !['sent', 'mock_sent'].includes(job.status) ? <Button size="small" loading={busy} onClick={() => retry(job.id)}>重试</Button> : '—' },
    ]} locale={{ emptyText: inquiryId ? '人工录入的询盘没有自动通知任务' : '还没有通知任务' }} />{data.total > data.jobs.length && <Typography.Text type="secondary">显示最近{data.jobs.length}项，共{data.total}项通知任务。</Typography.Text>}</>}
  </Card>;
}
export function InquiryRecordOperations({ inquiry, onDeleted }: { inquiry: Inquiry; onDeleted: () => void }) {
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const scope = inquiryNoteRecoveryScope(inquiry.id);
  const [recovered] = useState(() => readInquiryNoteRecovery(runtime.actor.id, inquiry.id)?.snapshot);
  const [recoveredVisible, setRecoveredVisible] = useState(!!recovered);
  const [draft, setDraft] = useState<InquiryFollowUpDraft>(() => recovered?.draft || { ...inquiryFollowUpDraft(inquiry), notes: recovered?.notes ?? inquiry.notes ?? '' });
  const [baseline, setBaseline] = useState(() => ({ draft: recovered?.baseDraft || { ...inquiryFollowUpDraft(inquiry), notes: recovered?.baseNotes ?? inquiry.notes ?? '' }, revision: recovered?.baseRevision ?? inquiry.revision, followUpCount: recovered?.baseFollowUpCount ?? inquiry.followUpCount ?? 0 }));
  const [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [error, setError] = useState('');
  const serverDraft = inquiryFollowUpDraft(inquiry), serverKey = inquiryDraftKey(serverDraft), draftKey = inquiryDraftKey(draft), baselineKey = inquiryDraftKey(baseline.draft);
  const dirty = draftKey !== baselineKey || !!draft.followUpNote;
  useEffect(() => {
    // 新历史出现时先人工核对待追加文本，避免请求结果不明后重试造成同一记录重复追加。
    if (draft.followUpNote && baseline.followUpCount !== (inquiry.followUpCount || 0)) { setConflict(true); return; }
    // 状态的独立更新可推进版本；已保存字段冲突时保留整份输入，不用刷新覆盖本地草稿。
    const server = inquiryFollowUpDraft(inquiry);
    if (serverKey === draftKey) {
      if (baselineKey !== serverKey || baseline.revision !== inquiry.revision || baseline.followUpCount !== (inquiry.followUpCount || 0)) setBaseline({ draft: server, revision: inquiry.revision, followUpCount: inquiry.followUpCount || 0 });
      setConflict(false);
      if (!draft.followUpNote && readInquiryNoteRecovery(runtime.actor.id, inquiry.id)?.scope === scope) clearLocalRecovery(runtime.actor.id, scope);
    } else if (serverKey === baselineKey) {
      if (baseline.revision !== inquiry.revision || baseline.followUpCount !== (inquiry.followUpCount || 0)) setBaseline(value => ({ ...value, revision: inquiry.revision, followUpCount: inquiry.followUpCount || 0 }));
      setConflict(false);
    } else if (draftKey === baselineKey) {
      setBaseline({ draft: server, revision: inquiry.revision, followUpCount: inquiry.followUpCount || 0 }); setDraft({ ...server, followUpNote: draft.followUpNote }); setConflict(false);
    } else setConflict(true);
  }, [serverKey, draftKey, baselineKey, inquiry.revision, inquiry.followUpCount, baseline.revision, baseline.followUpCount, draft.followUpNote, runtime.actor.id]);
  const editable = runtime.actor.role !== 'viewer';
  async function refreshCurrent() {
    const result = await request<{ items: Inquiry[] }>('/api/inquiries');
    const envelope = runtime.getEnvelope(); runtime.accept({ ...envelope, state: { ...envelope.state, inquiries: result.items } });
  }
  async function save() {
    if (!editable || busy) return false;
    if (conflict) { setError('请先核对服务器更新，再保存本地修改'); return false; }
    if (draft.followUpNote && !draft.followUpNote.trim()) { setError('内部跟进记录不能只有空格'); return false; }
    setBusy(true); setError('');
    try {
      // 只提交本地实际修改的字段；新记录与这些字段在同一询盘版本内原子保存。
      const fields = ['notes', 'assigneeId', 'priority', 'nextFollowUpAt', 'qualification'] as const;
      const patch = Object.fromEntries(fields.filter(key => draft[key] !== baseline.draft[key]).map(key => [key, draft[key]]));
      const result = await request<{ item: Inquiry & { revision: number } }>(`/api/inquiries/${inquiry.id}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: baseline.revision, ...patch, ...(draft.followUpNote ? { followUpNote: draft.followUpNote } : {}) }) });
      const saved = inquiryFollowUpDraft(result.item); setBaseline({ draft: saved, revision: result.item.revision, followUpCount: result.item.followUpCount || 0 }); setDraft(saved); setConflict(false); setRecoveredVisible(false);
      const envelope = runtime.getEnvelope(); runtime.accept({ ...envelope, state: { ...envelope.state, inquiries: envelope.state.inquiries.map(item => item.id === result.item.id ? result.item : item) } });
      clearInquiryNoteRecovery(runtime.actor.id, inquiry.id); message.success('跟进信息已保存'); return true;
    } catch (caught) {
      setError((caught as Error).message);
      if (caught instanceof RequestError && caught.status === 409) try { await refreshCurrent(); } catch { /* 保留原冲突与全部输入，刷新失败不冒充已同步。 */ }
      return false;
    } finally { setBusy(false); }
  }
  async function remove() { setBusy(true); try { await runtime.mutate(() => request<StudioEnvelope>(`/api/inquiries/${inquiry.id}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: (runtime.getEnvelope().state.inquiries.find(i => i.id === inquiry.id) as Inquiry & { revision?: number })?.revision }) })); clearInquiryNoteRecovery(runtime.actor.id, inquiry.id);onDeleted(); message.success('询盘及关联通知记录已删除'); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); } }
  function adoptServer(keepLocal: boolean) {
    const server = inquiryFollowUpDraft(inquiry); setBaseline({ draft: server, revision: inquiry.revision, followUpCount: inquiry.followUpCount || 0 });
    if (!keepLocal) setDraft({ ...server, followUpNote: draft.followUpNote });
    setConflict(false); setError('');
  }
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope, screen: 'inquiries', title: `询盘跟进 · ${inquiry.name || '网站访客'}`, dirty, busy, snapshot: { inquiryId: inquiry.id, notes: draft.notes, baseNotes: baseline.draft.notes, baseRevision: baseline.revision, draft, baseDraft: baseline.draft, baseFollowUpCount: baseline.followUpCount }, save: editable ? save : undefined, discard: () => { clearInquiryNoteRecovery(runtime.actor.id, inquiry.id); setDraft(inquiryFollowUpDraft(inquiry)); setBaseline({ draft: inquiryFollowUpDraft(inquiry), revision: inquiry.revision, followUpCount: inquiry.followUpCount || 0 }); setConflict(false); setRecoveredVisible(false); } });
  const attribution = inquiry.attribution;
  return <Space orientation="vertical" size={16} style={{ width: '100%' }}>{guard.dialog}{recoveredVisible && <Alert type="warning" title="已恢复本账号未保存的跟进输入；保存前会核对原记录版本" />}{error && <Alert type="error" title={error} />}
    <Descriptions column={1} size="small" items={[{ key: 'source', label: '询盘来源', children: inquirySourceLabel(inquiry) }, { key: 'page', label: '来源页面', children: inquiry.sourcePath || '未记录' }, ...(attribution ? [{ key: 'channel', label: '来源方式', children: attributionChannelLabel(attribution.channel) }, { key: 'landing', label: '进入页面', children: attribution.landingPath || '未提供' }, { key: 'campaign', label: '活动名称', children: attribution.utmCampaign || '未提供' }, { key: 'medium', label: '活动媒介', children: attribution.utmMedium || '未提供' }] : []), { key: 'locale', label: '提交语言', children: inquiry.locale || '未记录' }, { key: 'form', label: '来源表单', children: inquiry.formName || '未记录' }, { key: 'phone', label: '联系电话', children: inquiry.phone || '未填写' }]} />
    {attribution && <Typography.Text type="secondary">{ATTRIBUTION_UNVERIFIED_LABEL}</Typography.Text>}
    {!!inquiry.answers?.length && <Card size="small" title="提交时的完整答案"><Descriptions column={1} size="small" items={inquiry.answers.map(a => ({ key: a.id, label: a.label, children: a.displayValue ?? (a.value === null ? '未提供' : a.value === false ? '否' : a.value === true ? '是' : a.value === '' ? '空白' : a.value) }))} /></Card>}
    {conflict && <Alert type="warning" showIcon title="服务器跟进信息或历史已变化，本地输入已保留" description={<Space orientation="vertical" size={12} style={{ width: '100%' }}><Typography.Text>请同时核对下方跟进历史，确认待新增记录是否已经保存。</Typography.Text><Descriptions column={1} size="small" items={[{ key: 'owner', label: '当前负责人', children: inquiry.assignee?.name || '未分配' }, { key: 'priority', label: '当前优先级', children: INQUIRY_PRIORITY_LABELS[inquiry.priority || 'normal'] }, { key: 'date', label: '当前排期', children: inquiry.nextFollowUpAt ? formatDate(inquiry.nextFollowUpAt, runtime.envelope.state.settings.timezone) : '未安排' }, { key: 'quality', label: '当前有效性', children: INQUIRY_QUALIFICATION_LABELS[inquiry.qualification || 'unreviewed'] }, { key: 'notes', label: '当前备注', children: <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }} ellipsis={{ rows: 3, expandable: true }}>{inquiry.notes || '空白'}</Typography.Paragraph> }]} /><Space wrap><Button size="small" onClick={() => adoptServer(false)}>采用服务器字段，保留新增记录</Button><Button size="small" disabled={!editable} onClick={() => adoptServer(true)}>已核对，保留本地修改</Button></Space></Space>} />}
    <InquiryFollowUpPanel inquiry={inquiry} draft={draft} onChange={setDraft} onSave={save} editable={editable} busy={busy} dirty={dirty} conflict={conflict} timezone={runtime.envelope.state.settings.timezone} />
    <NotificationStatusPanel inquiryId={inquiry.id} />
    {runtime.actor.role === 'admin' && <Popconfirm title="永久删除这条询盘及关联通知？" description="网站历史版本不含询盘，不能通过版本回退恢复。" onConfirm={remove} okText="确认删除" cancelText="取消"><Button danger loading={busy}>删除询盘记录</Button></Popconfirm>}
  </Space>;
}
type Policy = { revision: number; retentionDays: number; updatedAt: string; notification: { mode: string; configured: boolean } };
type CleanupPlan = { cutoff: string; count: number; total: number; policyRevision: number; confirmation: string };
export function InquiryNotificationSettings() {
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const [policy, setPolicy] = useState<Policy>(), [days, setDays] = useState(0), [plan, setPlan] = useState<CleanupPlan>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (runtime.actor.role !== 'admin') return; let active = true; void request<Policy>('/api/inquiries/policy').then(result => { if (active) { setPolicy(result); setDays(result.retentionDays); } }).catch(e => active && setError(e.message)); return () => { active = false; }; }, [runtime.actor.id, runtime.actor.role]);
  async function save() { if (!policy) return; setBusy(true); try { const result = await request<Policy>('/api/inquiries/policy', { method: 'PATCH', body: JSON.stringify({ expectedRevision: policy.revision, retentionDays: days }) }); setPolicy(result); setPlan(undefined); message.success('保留策略已保存；系统不会自动删除记录'); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); } }
  async function preview() { setBusy(true); try { setPlan(await request<CleanupPlan>('/api/inquiries/cleanup')); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); } }
  async function cleanup() { if (!plan) return; setBusy(true); try { const result = await request<{ removed: number }>('/api/inquiries/cleanup', { method: 'POST', body: JSON.stringify(plan) }); const list = await request<{ items: Inquiry[] }>('/api/inquiries'); const env = runtime.getEnvelope(); runtime.accept({ ...env, state: { ...env.state, inquiries: list.items } }); setPlan(undefined); message.success(`已删除本批${result.removed}条询盘及关联通知`); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); } }
  return <Space orientation="vertical" style={{ width: '100%' }}>{error && <Alert type="error" title={error} />}<NotificationStatusPanel />
    {runtime.actor.role === 'admin' && <MoreSettings title="旧询盘保留与清理（高级）"><Card title="询盘保留时间"><Alert type="info" showIcon title="期限由站点经营者决定，默认不清理" description="先保存策略，再预览符合范围的记录；确认后才会永久删除。每批最多1000条，处理中的通知会阻止删除。" /><Form layout="vertical"><Form.Item label="保留多少天的询盘（0表示一直保留）"><InputNumber aria-label="询盘保留天数" min={0} max={3650} precision={0} value={days} onChange={v => v !== null && setDays(v)} /></Form.Item><Space wrap><Button loading={busy} disabled={!policy || days === policy.retentionDays} onClick={save}>保存保留策略</Button><Button loading={busy} disabled={!policy?.retentionDays || days !== policy.retentionDays} onClick={preview}>预览待清理记录</Button></Space></Form>{plan && <Space orientation="vertical"><Alert type="warning" title={`本批${plan.count}条，全部符合${plan.total}条`} description={`清理截止：${formatDate(plan.cutoff, runtime.envelope.state.settings.timezone)}。备注或范围变化后须重新预览。`} /><Popconfirm title={`永久删除本批${plan.count}条询盘及关联通知？`} description="网站快照无法恢复这些运行数据；请确认已有所需备份。" onConfirm={cleanup} okText="确认永久删除" cancelText="取消"><Button danger loading={busy} disabled={!plan.count}>清理本批记录</Button></Popconfirm></Space>}</Card></MoreSettings>}
  </Space>;
}
/** CSV由鉴权接口按当前筛选生成；这里只处理文件下载，不通过邮箱或第三方发送。 */
export function InquiryCsvButton({ search, status, country, followUpFilter = 'all' }: { search: string; status: string; country: string; followUpFilter?: InquiryFollowUpFilter }) {
  const runtime = useStudioRuntime(), { message } = App.useApp(); const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try { const response = await fetch('/api/inquiries/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ search, status, country, followUpFilter }) }); if (!response.ok) { const result = await response.json(); throw new Error(result.error || '导出失败'); } const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = 'website-inquiries.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); message.success('CSV已导出，时间列使用UTC'); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); }
  }
  return <Button disabled={runtime.actor.role === 'viewer'} loading={busy} onClick={download}>导出当前询盘</Button>;
}
export function InquiryRefreshButton() {
  const runtime = useStudioRuntime(), { message } = App.useApp(), [busy, setBusy] = useState(false);
  const active = useRef(true);
  async function refresh(announce = false) {
    setBusy(true);
    try { const result = await request<{ items: Inquiry[] }>('/api/inquiries'); if (!active.current) return; const env = runtime.getEnvelope(); runtime.accept({ ...env, state: { ...env.state, inquiries: result.items } }); if (announce) message.success('询盘已刷新，当前备注输入保持不变'); }
    catch (e) { if (active.current && announce) message.error((e as Error).message); } finally { if (active.current) setBusy(false); }
  }
  // 进入列表重新读运行数据；不定时刷新编辑中的备注，也不重载其他页面草稿。
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; }; }, [runtime.actor.id]);
  return <Button loading={busy} onClick={() => refresh(true)}>刷新询盘</Button>;
}
