'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Spin, Typography } from 'antd';
import type { AiWritingProfile } from '@/lib/ai-writing-types';
import type { AiSiteBrief } from '@/lib/ai-builder-types';
import type { AiWritingReuseResponse, AiWritingSourceState } from '@/lib/ai-writing-reuse-types';
import { briefReuseSelectionError, briefReuseSourceGate } from '@/lib/ai-writing-brief-reuse';
import { request } from '@/lib/studio-client';
const { Text } = Typography;

/** 共用写作资料仅显式投影为本次建站输入；不调用模型、不自动保存或覆盖用户偏好。 */
export default function AiWritingBriefReuse({ open, onClose, onApply, brief }: { open: boolean; onClose: () => void; onApply: (patch: Partial<AiSiteBrief>) => void; brief: AiSiteBrief }) {
  const [profile, setProfile] = useState<AiWritingProfile>(), [selected, setSelected] = useState<string[]>([]), [fields, setFields] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [states, setStates] = useState<Record<string, AiWritingSourceState>>(), [sourceError, setSourceError] = useState('');
  const live = useRef(false), sequence = useRef(0), lock = useRef(false);
  async function read() {
    if (lock.current) return; lock.current = true; const current = ++sequence.current; setBusy(true); setError(''); setSourceError('');
    const results = await Promise.allSettled([request<AiWritingProfile>('/api/ai/writing/profile'), request<AiWritingReuseResponse>('/api/ai/writing/reuse')]);
    if (!live.current || current !== sequence.current) return;
    if (results[0].status === 'fulfilled') setProfile(results[0].value); else setError(results[0].reason instanceof Error ? results[0].reason.message : '共用资料读取失败，当前选择和建站表单保持。');
    if (results[1].status === 'fulfilled') setStates(results[1].value.states); else { setStates(undefined); setSourceError('来源状态未读取成功，当前不能判断原来源是否变化；选择和建站表单保持，请重新读取。'); }
    lock.current = false; setBusy(false);
  }
  useEffect(() => { if (!open) return; live.current = true; setProfile(undefined); setStates(undefined); setSelected([]); setFields([]); void read(); return () => { live.current = false; sequence.current++; lock.current = false; }; }, [open]);
  const facts = profile?.facts.filter(item => item.confirmed && item.scope === 'company') || [];
  const description = [brief.description, ...facts.filter(item => selected.includes(item.id)).map(item => `${item.label}：${item.text}`)].filter(Boolean).join('\n\n');
  const values = profile ? [{ key: 'companyName', label: '公司或品牌称谓', value: profile.brandName, max: 120 }, { key: 'audience', label: '主要买家', value: profile.audience, max: 300 }, { key: 'market', label: '重点市场', value: profile.market, max: 300 }] : [];
  const selectionError = profile ? briefReuseSelectionError(profile, selected, states) : '';
  async function apply() {
    if (!profile || lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      // 开窗后来源仍可能变化；采用前只读复核，不改变当前选择或建站输入。
      const latest = await request<AiWritingProfile>('/api/ai/writing/profile'); if (!live.current) return;
      if (latest.revision !== profile.revision) throw new Error('共用资料已更新，请读取最新资料并核对后再填入；当前选择和建站表单保持。');
      let currentStates = states;
      if (latest.facts.some(item => selected.includes(item.id) && item.sourceRef)) {
        try { currentStates = (await request<AiWritingReuseResponse>('/api/ai/writing/reuse')).states; if (!live.current) return; setStates(currentStates); setSourceError(''); }
        catch (cause) { if (!live.current) return; setStates(undefined); setSourceError('来源复核未完成，当前不能判断原来源是否变化；选择和建站表单保持。'); throw cause; }
      }
      const issue = briefReuseSelectionError(latest, selected, currentStates); if (issue) throw new Error(issue);
      const patch: Partial<AiSiteBrief> = {}; for (const item of values) if (fields.includes(item.key)) patch[item.key as 'companyName' | 'audience' | 'market'] = item.value; if (selected.length) patch.description = description; onApply(patch); onClose();
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : '核对未完成，当前选择和建站表单保持。'); }
    finally { if (live.current) { lock.current = false; setBusy(false); } }
  }
  return <Modal title="使用共用企业资料" open={open} onCancel={() => { if (!busy) onClose(); }} closable={!busy} keyboard={!busy} mask={{ closable: !busy }} width={850} style={{ top: 24, maxWidth: 'calc(100vw - 32px)' }} destroyOnHidden footer={<Space wrap><Button disabled={busy} onClick={() => void read()}>读取最新资料</Button><Button disabled={busy} onClick={onClose}>返回</Button><Button type="primary" loading={busy} disabled={busy || !profile || !!selectionError || !selected.length && !fields.length || description.length > 6000 || values.some(item => fields.includes(item.key) && item.value.length > item.max)} onClick={() => void apply()}>填入本次建站表单</Button></Space>}>
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Alert type="info" showIcon title="只使用你勾选的资料" description="公司事实追加到现有说明；称谓、买家和市场分别勾选后才替换。填入前只读复核所选来源，此处不调用AI或发布。" />
      {busy && <Spin />}{error && <Alert type="error" showIcon title={error} />}{sourceError && <Alert type="warning" showIcon title={sourceError} />}
      {selectionError && <Alert type="warning" showIcon title={selectionError} description="可以取消这项选择，或到写作资料中核对更新；当前建站表单未改动。" />}
      <Form layout="vertical" disabled={busy}>{values.filter(item => item.value.trim()).map(item => <Form.Item key={item.key} label={<Checkbox disabled={busy} checked={fields.includes(item.key)} onChange={event => setFields(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))}>{item.label}{brief[item.key as keyof AiSiteBrief]?.trim() ? ' · 已有内容，勾选后替换' : ''}</Checkbox>} extra={item.value.length > item.max ? `超过建站字段${item.max}字限制，请先在写作资料中精简；不会截断。` : undefined}><Input value={item.value} readOnly /></Form.Item>)}</Form>
      <Text strong>已确认的公司事实</Text>
      {!busy && !facts.length && <Text type="secondary">暂无已确认公司事实；可在站点设置 → AI服务 → 写作资料中维护。</Text>}
      <Checkbox.Group value={selected} onChange={ids => setSelected(ids as string[])}><Space orientation="vertical" size={12}>{facts.map(item => { const gate = briefReuseSourceGate(item, states?.[item.id]); return <Checkbox key={item.id} value={item.id} disabled={busy || gate.blocked && !selected.includes(item.id)}><Space orientation="vertical" size={2}><Text strong>{item.label}</Text><Text>{item.text}</Text><Text type="secondary">来源：{item.source}</Text>{gate.message && <Text type={gate.blocked || states?.[item.id]?.status === 'unavailable' ? 'warning' : 'secondary'}>{gate.message}</Text>}</Space></Checkbox>; })}</Space></Checkbox.Group>
      {!!selected.length && <Form layout="vertical"><Form.Item label="填入后的公司说明预览" validateStatus={description.length > 6000 ? 'error' : undefined} help={description.length > 6000 ? '合并后超过6000字，请减少勾选或先精简原说明。' : '原说明保留，所选事实追加在后。'}><Input.TextArea value={description} readOnly rows={7} /></Form.Item></Form>}
    </Space>
  </Modal>;
}
