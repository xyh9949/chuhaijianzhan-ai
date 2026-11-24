'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, Flex, Form, Input, Space, Spin, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import type { AiDesignGuidance, AiDesignGuidanceInput } from '@/lib/ai-design-guidance-types';
import { AI_DESIGN_GUIDANCE_LIMITS as limits } from '@/lib/ai-design-guidance-types';
import { readLocalRecovery } from '@/lib/local-recovery';
import { request, useStudioRuntime } from '@/lib/studio-client';
import { useLocalDraftGuard } from './useLocalDraftGuard';

export const DESIGN_GUIDANCE_RECOVERY_SCOPE = 'ai-design-guidance';
const empty = (): AiDesignGuidanceInput => ({ expectedRevision: 0, enabled: true, preferredStyle: '', preserveNotes: '', avoidStyles: '', feedback: [] });
const inputOf = ({ revision, enabled, preferredStyle, preserveNotes, avoidStyles, feedback }: AiDesignGuidance): AiDesignGuidanceInput => ({ expectedRevision: revision, enabled, preferredStyle, preserveNotes, avoidStyles, feedback: structuredClone(feedback) });
function validInput(value: unknown): value is AiDesignGuidanceInput {
  const item = value as AiDesignGuidanceInput | undefined;
  return !!item && Number.isSafeInteger(item.expectedRevision) && item.expectedRevision >= 0 && typeof item.enabled === 'boolean'
    && ['preferredStyle', 'preserveNotes', 'avoidStyles'].every(key => typeof item[key as keyof AiDesignGuidanceInput] === 'string' && (item[key as keyof AiDesignGuidanceInput] as string).length <= limits.field)
    && Array.isArray(item.feedback) && item.feedback.length <= limits.feedbackCount
    && item.feedback.every(entry => entry && typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(entry.id) && typeof entry.text === 'string' && entry.text.length <= limits.feedbackText)
    && new Set(item.feedback.map(entry => entry.id)).size === item.feedback.length;
}
type Recovery = { input: AiDesignGuidanceInput; pendingText: string };
function validRecovery(value: unknown): value is Recovery { const item = value as Recovery | undefined; return !!item && validInput(item.input) && typeof item.pendingText === 'string' && item.pendingText.length <= limits.feedbackText; }
type Props = { rememberText?: string; onClose: () => void; onSaved: () => void; registerClose: (handler: (() => void) | undefined) => void; onBusyChange: (busy: boolean) => void };

/** 私有设计参考显式保存；记住一条要求只预填待确认内容，不修改原画布、模型或候选。 */
export default function AiDesignGuidance({ rememberText, onClose, onSaved, registerClose, onBusyChange }: Props) {
  const runtime = useStudioRuntime(), admin = runtime.actor.role === 'admin';
  const formId = useId();
  const [recovered] = useState(() => readLocalRecovery<Recovery>(runtime.actor.id, DESIGN_GUIDANCE_RECOVERY_SCOPE, validRecovery));
  const [draft, setDraft] = useState<AiDesignGuidanceInput>(recovered?.snapshot.input || empty()), [saved, setSaved] = useState<AiDesignGuidance>();
  const [busy, setBusy] = useState<'load' | 'save' | 'reload' | ''>('load'), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState(!!rememberText || !!recovered?.snapshot.pendingText), [pendingText, setPendingText] = useState(recovered?.snapshot.pendingText || ''), [showSaved, setShowSaved] = useState(false);
  const live = useRef(false), lock = useRef(false), operation = useRef(0), prefilled = useRef(false), draftRef = useRef(draft); draftRef.current = draft;
  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(inputOf(saved)) || !!pendingText;
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope: DESIGN_GUIDANCE_RECOVERY_SCOPE, screen: 'global-design', title: 'AI设计约定', dirty: admin && dirty, busy: !!busy, snapshot: { input: draft, pendingText }, discard: () => { setDraft(saved ? inputOf(saved) : empty()); setPendingText(''); }, save });
  useEffect(() => { registerClose(() => guard.ask(onClose)); return () => registerClose(undefined); }, [registerClose, guard.ask, onClose]);
  useEffect(() => { onBusyChange(!!busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  async function load(preserve = false) {
    if (!admin || lock.current) return;
    lock.current = true; const epoch = ++operation.current; setBusy(preserve ? 'reload' : 'load'); setError(''); setSuccess('');
    const keepInput = preserve && !!(saved || recovered);
    try {
      const value = await request<AiDesignGuidance>('/api/ai/design-guidance'); if (!live.current || epoch !== operation.current) return;
      setSaved(value);
      if (keepInput) { setDraft(current => ({ ...current, expectedRevision: value.revision })); setShowSaved(true); setSuccess('已读取最新版本，当前输入仍保留。请对照已保存内容，核对后再保存。'); }
      else if (!recovered) setDraft(inputOf(value));
    } catch (cause) { if (live.current && epoch === operation.current) setError(cause instanceof Error ? cause.message : '设计约定暂未读到，当前输入仍保留。'); }
    finally { if (live.current && epoch === operation.current) { lock.current = false; setBusy(''); } }
  }
  useEffect(() => { live.current = true; if (admin) void load(); else setBusy(''); return () => { live.current = false; operation.current++; lock.current = false; }; }, [admin]);
  useEffect(() => {
    if (!saved || prefilled.current || !rememberText) return;
    prefilled.current = true; setFeedbackOpen(true);
    if (draftRef.current.feedback.some(item => item.text.trim() === rememberText.trim())) { setSuccess('这条要求已经在当前意见中，请核对现有内容。'); return; }
    if (draftRef.current.feedback.length >= limits.feedbackCount) { setPendingText(rememberText); return; }
    setDraft(current => ({ ...current, feedback: [...current.feedback, { id: `feedback-${crypto.randomUUID()}`, text: rememberText }] }));
    setSuccess('这次要求已填入一条待确认意见。你可以修改，点击“保存设计约定”后才会用于以后的生成。');
  }, [saved, rememberText]);
  function change(patch: Partial<AiDesignGuidanceInput>) { setDraft(current => ({ ...current, ...patch })); setSuccess(''); }
  async function save(): Promise<boolean> {
    if (!admin || lock.current || !saved) return false;
    if (pendingText) { setError('请先移除不需要的旧意见，再加入这次要求，或明确放弃本次输入。'); return false; }
    const value = draftRef.current;
    if (value.feedback.some(item => !item.text.trim())) { setError('请填写每条意见，或移除不需要的空白意见。'); return false; }
    lock.current = true; setBusy('save'); setError(''); setSuccess('');
    try {
      const next = await request<AiDesignGuidance>('/api/ai/design-guidance', { method: 'PATCH', body: JSON.stringify(value) });
      if (!live.current) return false;
      setSaved(next); setDraft(inputOf(next)); setShowSaved(false); guard.clear(); onSaved();
      setSuccess('设计约定已保存，下一次生成会读取当前保存的内容。没有调用AI，也没有修改网站草稿或发布网站。'); return true;
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : '保存未完成，当前输入仍保留。'); return false; }
    finally { if (live.current) { lock.current = false; setBusy(''); } }
  }
  if (!admin) return <Alert type="info" showIcon title="AI设计约定由管理员维护" />;
  return <>{guard.dialog}<Space orientation="vertical" size={20} style={{ width: '100%', minWidth: 0 }}>
    <Alert type="info" showIcon title="让AI逐渐了解你希望的网站风格" description="这些是设计参考，可以被本次明确要求覆盖。组件锁定、保留文字和授权范围仍按原规则执行；公司与产品事实继续使用已有资料。" />
    {recovered && dirty && <Alert type="warning" showIcon title="已恢复上次未保存的设计约定" description="恢复只回到表单，不会自动保存或生成；服务器版本变化时请先读取最新内容再核对。" />}
    {busy === 'load' && <Space><Spin size="small" /><Typography.Text type="secondary">正在读取已保存约定…</Typography.Text></Space>}
    <Form layout="vertical" disabled={!!busy || !saved}>
      <Form.Item><Checkbox aria-label="生成时参考设计约定" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })}>生成设计时参考这些约定</Checkbox></Form.Item>
      <Form.Item label="希望的网站风格" htmlFor={`${formId}-style`} extra="说说希望网站呈现什么感觉，不必再填写企业资料。"><Input.TextArea id={`${formId}-style`} aria-label="希望的网站风格" rows={3} maxLength={limits.field} showCount styles={{ root: { marginBottom: 24 } }} value={draft.preferredStyle} onChange={event => change({ preferredStyle: event.target.value })} placeholder="例如：专业、采购导向，产品图片突出，信息清楚，手机阅读舒服。" /></Form.Item>
      <Form.Item label="希望保持的设计" htmlFor={`${formId}-preserve`} extra="这里是参考说明；必须保持原样的区块，请仍在编辑器中锁定。"><Input.TextArea id={`${formId}-preserve`} aria-label="希望保持的设计" rows={3} maxLength={limits.field} showCount styles={{ root: { marginBottom: 24 } }} value={draft.preserveNotes} onChange={event => change({ preserveNotes: event.target.value })} placeholder="例如：延续现有品牌绿，产品图片完整展示，联系方式方便找到。" /></Form.Item>
      <Form.Item label="希望避免的设计" htmlFor={`${formId}-avoid`}><Input.TextArea id={`${formId}-avoid`} aria-label="希望避免的设计" rows={3} maxLength={limits.field} showCount styles={{ root: { marginBottom: 24 } }} value={draft.avoidStyles} onChange={event => change({ avoidStyles: event.target.value })} placeholder="例如：避免拥挤首屏、夸张动效、大面积装饰渐变。" /></Form.Item>
    </Form>
    <Collapse activeKey={feedbackOpen ? ['feedback'] : []} onChange={keys => setFeedbackOpen((Array.isArray(keys) ? keys : [keys]).includes('feedback'))} items={[{ key: 'feedback', label: `以后希望记住的意见（${draft.feedback.length}/${limits.feedbackCount}）`, children: <Space orientation="vertical" size={16} style={{ width: '100%', minWidth: 0 }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>从这次要求带入的文字需要你核对并保存。采用设计不会自动把意见记成长期约定。</Typography.Paragraph>
      {pendingText && <Alert type="warning" showIcon title="已达到8条意见，请先移除不需要的内容" description={<Space orientation="vertical" style={{ width: '100%' }}><Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, overflowWrap: 'anywhere' }}>{pendingText}</Typography.Paragraph><Button disabled={!!busy || draft.feedback.length >= limits.feedbackCount} onClick={() => { change({ feedback: [...draft.feedback, { id: `feedback-${crypto.randomUUID()}`, text: pendingText }] }); setPendingText(''); }}>加入这次要求</Button></Space>} />}
      {draft.feedback.map((item, index) => <Card size="small" key={item.id} title={`意见${index + 1}`} extra={<Button type="text" danger icon={<DeleteOutlined />} aria-label={`移除设计意见${index + 1}`} disabled={!!busy} onClick={() => change({ feedback: draft.feedback.filter(value => value.id !== item.id) })} />}><Input.TextArea aria-label={`设计意见${index + 1}`} disabled={!!busy} rows={3} maxLength={limits.feedbackText} showCount styles={{ root: { marginBottom: 24 } }} value={item.text} onChange={event => change({ feedback: draft.feedback.map(value => value.id === item.id ? { ...value, text: event.target.value } : value) })} /></Card>)}
      <Button icon={<PlusOutlined />} disabled={!!busy || !saved || draft.feedback.length >= limits.feedbackCount} onClick={() => change({ feedback: [...draft.feedback, { id: `feedback-${crypto.randomUUID()}`, text: '' }] })}>添加一条意见</Button>
    </Space> }]} />
    {showSaved && saved && <Collapse items={[{ key: 'saved', label: `对照服务器已保存的内容 · 版本${saved.revision}`, children: <Space orientation="vertical" size={12} style={{ width: '100%' }}>{[['网站感觉', saved.preferredStyle], ['希望保持', saved.preserveNotes], ['尽量避免', saved.avoidStyles], ...saved.feedback.map((item, index) => [`意见${index + 1}`, item.text])].map(([label, value]) => <div key={label}><Typography.Text strong>{label}</Typography.Text><Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value || '尚未填写'}</Typography.Paragraph></div>)}</Space> }]} />}
    {error && <Alert type="error" showIcon title="设计约定操作未完成" description={error} action={<Button size="small" icon={<ReloadOutlined />} disabled={!!busy} onClick={() => void load(true)}>读取最新版本</Button>} />}
    {success && <Alert type="success" showIcon title={success} />}
    <Typography.Text type="secondary">保存在本实例私有设置中，不进入公开页面或整站案例包。旧方案继续保留生成时的版本；继续调整会使用最新已保存约定。</Typography.Text>
    <Flex gap={12} justify="space-between" align="center" wrap><Button disabled={!!busy} onClick={() => guard.ask(onClose)}>关闭</Button><Button type="primary" icon={<SaveOutlined />} loading={busy === 'save'} disabled={!!busy || !saved || !dirty || !!pendingText} onClick={() => void save()}>保存设计约定</Button></Flex>
  </Space></>;
}
