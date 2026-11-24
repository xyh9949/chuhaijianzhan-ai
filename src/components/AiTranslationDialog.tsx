'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Collapse, ConfigProvider, Empty, Flex, Input, List, Modal, Select, Space, Tabs, Tag, Typography } from 'antd';
import { EyeOutlined, ReloadOutlined, TranslationOutlined, UndoOutlined } from '@ant-design/icons';
import type { AiTranslationContext, AiTranslationPreview, AiTranslationTarget, AiTranslationTerm, AiTranslationValue } from '@/lib/ai-translation-types';
import { richTextPlainText } from '@/lib/presentation-content';
import { RichDocument } from '@/lib/presentation-components';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { readLocalRecovery } from '@/lib/local-recovery';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import { useAiSettings } from './AiProviderSettings';

type Inputs = { targetLocale: string; fieldKeys: string[]; termsText: string; proposalId?: string };
type Props = { target: AiTranslationTarget; onApplied?: () => void; disabled?: boolean; };
const validInputs = (value: unknown): value is Inputs => { const input = value as Inputs | undefined; return !!input && typeof input.targetLocale === 'string' && input.targetLocale.length <= 35 && Array.isArray(input.fieldKeys) && input.fieldKeys.length <= 30 && input.fieldKeys.every(key => typeof key === 'string' && key.length <= 120) && typeof input.termsText === 'string' && input.termsText.length <= 8000 && (input.proposalId === undefined || typeof input.proposalId === 'string' && /^ait-[a-f0-9-]{36}$/.test(input.proposalId)); };
const empty: Inputs = { targetLocale: '', fieldKeys: [], termsText: '' };
function content(value: AiTranslationValue) { return value === null ? <Typography.Text type="secondary">未填写</Typography.Text> : typeof value === 'string' ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{value}</Typography.Paragraph> : <div className="site-rich-text" style={{ overflowWrap: 'anywhere' }}><RichDocument doc={value} derived={false}/></div>; }
function parseTerms(text: string): AiTranslationTerm[] { return text.split('\n').filter(line => line.trim()).map(line => { const index = line.indexOf('='); if (index < 1 || !line.slice(index + 1).trim()) throw new Error('术语请每行填写“原术语 = 目标用词”'); return { source: line.slice(0, index).trim(), target: line.slice(index + 1).trim() }; }); }
const signature = ({ targetLocale, fieldKeys, termsText }: Inputs) => JSON.stringify({ targetLocale, fieldKeys, termsText });

/** 翻译沿既有私有候选和明确保存流程；重开只读恢复，不自动调用用户模型。 */
export default function AiTranslationDialog({ target, onApplied, disabled = false }: Props) {
  const runtime = useStudioRuntime(), aiSettings = useAiSettings(), { modal } = App.useApp();
  const scope = `ai-translation:${target.kind}:${target.id}`;
  const [open, setOpen] = useState(false), [context, setContext] = useState<AiTranslationContext>(), [inputs, setInputs] = useState<Inputs>(empty), [dirty, setDirty] = useState(false);
  const [proposal, setProposal] = useState<AiTranslationPreview>(), [selected, setSelected] = useState<string[]>([]), [history, setHistory] = useState<AiTranslationPreview[]>([]), [tab, setTab] = useState('prepare'), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [showPages, setShowPages] = useState(false);
  const lock = useRef(false), sequence = useRef(0), generated = useRef(''), targetKey = `${target.kind}:${target.id}`;
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope, screen: target.kind === 'product' ? 'products' : 'content-models', title: 'AI翻译输入', dirty: open && dirty, busy: !!busy, snapshot: inputs, discard: () => { setInputs(empty); setDirty(false); } });
  const changed = !!proposal && proposal.appliedRevision === null && !!generated.current && signature(inputs) !== generated.current;
  async function run(name: string, work: () => Promise<void>) { if (lock.current) return; lock.current = true; setBusy(name); setError(''); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，当前输入保持'); } finally { lock.current = false; setBusy(''); } }
  function display(value: AiTranslationPreview, preserveInputs = false) {
    setProposal(value); setSelected(value.appliedRevision === null ? value.fields.map(field => field.key) : value.appliedKeys || []); setShowPages(false); setTab('review');
    const next = { targetLocale: value.targetLocale, fieldKeys: value.fields.map(field => field.key), termsText: value.terms.map(term => `${term.source} = ${term.target}`).join('\n'), proposalId: value.id };
    if (!preserveInputs) setInputs(next); generated.current = signature(preserveInputs ? inputs : next);
  }
  async function loadHistory() { const value = await request<{ items: AiTranslationPreview[] }>(`/api/ai/translations?kind=${target.kind}&id=${encodeURIComponent(target.id)}`); setHistory(value.items); }
  async function refreshContext() {
    // 明确重读只更新服务器基线与可选字段，用户的语言/术语/勾选及旧建议仍保留，不重放模型。
    await runtime.refresh(); const next = await request<AiTranslationContext>(`/api/ai/translations/context?kind=${target.kind}&id=${encodeURIComponent(target.id)}`); setContext(next); setNotice('已读取最新保存的原文；翻译要求与旧建议保持，请核对后再生成。');
  }
  useEffect(() => {
    if (!open || runtime.actor.role !== 'admin') return; const epoch = ++sequence.current;
    void run('读取翻译资料', async () => {
      const [next, records] = await Promise.all([request<AiTranslationContext>(`/api/ai/translations/context?kind=${target.kind}&id=${encodeURIComponent(target.id)}`), request<{ items: AiTranslationPreview[] }>(`/api/ai/translations?kind=${target.kind}&id=${encodeURIComponent(target.id)}`)]);
      if (sequence.current !== epoch) return; setContext(next); setHistory(records.items);
      const saved = readLocalRecovery<Inputs>(runtime.actor.id, scope, validInputs), values = saved?.snapshot || { targetLocale: next.locales[0]?.code || '', fieldKeys: next.fields.length <= 30 ? next.fields.map(field => field.key) : [], termsText: '' };
      setInputs(values); setDirty(!!saved); setProposal(undefined); setNotice(''); setTab('prepare'); setShowPages(false); generated.current = '';
      if (values.proposalId) { const recovered = await request<AiTranslationPreview>(`/api/ai/translations/${values.proposalId}`); if (sequence.current === epoch) { setProposal(recovered); setSelected(recovered.appliedRevision === null ? recovered.fields.map(field => field.key) : recovered.appliedKeys || []); generated.current = signature(values); setTab('review'); } }
    });
    return () => { sequence.current++; };
    // 候选输入只在明确开窗时恢复，保存全站AI配置不会清空翻译输入或重放生成请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey, runtime.actor.id]);
  async function generate() {
    if (!context) return;
    const terms = parseTerms(inputs.termsText); await runtime.flush();
    const value = await request<AiTranslationPreview>('/api/ai/translations', { method: 'POST', body: JSON.stringify({ kind: target.kind, sourceId: target.id, targetLocale: inputs.targetLocale, expectedRevision: runtime.getEnvelope().revision, fieldKeys: inputs.fieldKeys, terms }) });
    setInputs(current => ({ ...current, proposalId: value.id })); display(value, true); setDirty(true); await loadHistory();
  }
  async function apply() {
    if (!proposal) return;
    await runtime.mutate(async env => { const result = await request<StudioEnvelope & { translation: AiTranslationPreview }>(`/api/ai/translations/${proposal.id}/apply`, { method: 'POST', body: JSON.stringify({ expectedRevision: env.revision, selectedKeys: selected }) }); setProposal(result.translation); return result; });
    setDirty(false); guard.clear(); setNotice('译文已保存到草稿，可在原编辑器继续修改；核对语言状态后再发布。'); await loadHistory(); onApplied?.();
  }
  async function undo() {
    if (!proposal) return;
    await runtime.mutate(async env => { const result = await request<StudioEnvelope & { translation: AiTranslationPreview }>(`/api/ai/translations/${proposal.id}/undo`, { method: 'POST', body: JSON.stringify({ expectedRevision: env.revision }) }); setProposal(result.translation); return result; });
    setDirty(false); guard.clear(); setNotice('本次翻译已撤销，网站公开版本保持。'); await loadHistory(); onApplied?.();
  }
  function change(patch: Partial<Inputs>) { setInputs(value => ({ ...value, ...patch, proposalId: undefined })); setDirty(true); }
  const state = proposal?.undoneRevision !== null && proposal?.undoneRevision !== undefined ? '已撤销' : proposal?.appliedRevision !== null && proposal?.appliedRevision !== undefined ? '已保存' : '待核对';
  return <><Button icon={<TranslationOutlined/>} disabled={disabled || runtime.actor.role !== 'admin'} onClick={() => setOpen(true)}>AI翻译</Button><Modal title="AI翻译产品与文章" open={open} width={1000} zIndex={1350} onCancel={() => guard.ask(() => setOpen(false))} closable={!busy} mask={{ closable: !busy }} footer={<Space wrap><Button disabled={!!busy} onClick={() => guard.ask(() => setOpen(false))}>返回编辑</Button>{tab === 'prepare' ? <Button type="primary" loading={busy === '生成翻译'} disabled={!!busy || !inputs.targetLocale || !inputs.fieldKeys.length || inputs.fieldKeys.length > 30} onClick={() => void run('生成翻译', generate)}>生成翻译预览</Button> : proposal?.appliedRevision === null ? <Button type="primary" loading={busy === '保存翻译'} disabled={!!busy || changed || proposal.stale || !selected.length} onClick={() => modal.confirm({ zIndex: 1450, title: '保存选中的译文到草稿？', content: proposal.isNew ? '将建立一条新的目标语言记录。未选字段仍保留源文，全部资料可在原编辑器继续核对和修改；网站不会自动发布。' : '只修改明确勾选的字段，其他译文保持；网站不会自动发布。', okText: '确认保存译文', cancelText: '继续核对', onOk: () => run('保存翻译', apply) })}>保存选中译文到草稿</Button> : <Button icon={<UndoOutlined/>} disabled={!!busy || !proposal?.canUndo} loading={busy === '撤销翻译'} onClick={() => modal.confirm({ zIndex: 1450, title: '撤销本次翻译？', content: '只恢复这次翻译影响的字段。新译文若被后续修改或引用，系统会拒绝删除并保留当前工作。', okText: '确认撤销翻译', onOk: () => run('撤销翻译', undo) })}>撤销本次翻译</Button>}</Space>}>
    <Space orientation="vertical" size={16} style={{ display: 'flex', minWidth: 0, width: '100%' }} styles={{ item: { minWidth: 0, maxWidth: '100%' } }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>使用你在站点设置中配置的AI服务。先看翻译，再决定保存；品牌、型号、数字和原图文结构由系统保护。<Button type="link" onClick={() => aiSettings.open()}>配置AI服务</Button></Typography.Paragraph>
      {error && <Alert type="error" showIcon title={error} description="当前输入与已有建议均保留，不会自动重试模型或覆盖网站。" action={<Button disabled={!!busy} onClick={() => void run('读取最新资料', refreshContext)}>读取最新资料</Button>}/>}{notice && <Alert type="success" showIcon title={notice}/>}
      <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'prepare', label: '选择翻译内容' }, { key: 'review', label: '核对译文', disabled: !proposal }, { key: 'history', label: `最近记录 ${history.length}` }]}/>
      {tab === 'prepare' && (context ? <Space orientation="vertical" size={16} style={{ display: 'flex', width: '100%', minWidth: 0 }} styles={{ item: { minWidth: 0, maxWidth: '100%' } }}>
        <Typography.Text strong style={{ overflowWrap: 'anywhere' }}>{context.sourceLabel} · 原语言 {context.sourceLocale}</Typography.Text>
        {!context.locales.length && <Alert type="info" title="请先在站点设置中启用其他网站语言" description="已支持的语言管理会处理独立网址和语言版本；这里不会偷偷改网站语言设置。"/>}
        <div><Typography.Paragraph style={{ marginBottom: 8 }}>翻译成哪种语言</Typography.Paragraph><Select aria-label="翻译目标语言" style={{ width: '100%' }} value={inputs.targetLocale || undefined} disabled={!!busy} options={context.locales.map(item => ({ value: item.code, label: `${item.label} · ${item.code}${item.existingId ? '（更新已有译文）' : '（新建译文）'}` }))} onChange={value => change({ targetLocale: value })}/></div>
        {context.fields.length > 30 && <Alert type="info" title="此记录文字字段较多，请明确选择本次最多30项"/>}<div><Typography.Paragraph style={{ marginBottom: 8 }}>本次发送哪些文字</Typography.Paragraph><Checkbox.Group value={inputs.fieldKeys} onChange={value => change({ fieldKeys: value as string[] })} disabled={!!busy}><Space orientation="vertical" size={10}>{context.fields.map(field => <Checkbox key={field.key} value={field.key}>{field.label} · {typeof field.source === 'string' ? field.source.length : field.source ? richTextPlainText(field.source).length : 0}字</Checkbox>)}</Space></Checkbox.Group></div>
        <Collapse items={[{ key: 'terms', label: '指定术语用词（选填）', children: <Input.TextArea aria-label="本次翻译术语" value={inputs.termsText} maxLength={8000} showCount rows={5} placeholder={'每行一条，例如：\nwooden chair = Holzstuhl\nHANSE = HANSE'} disabled={!!busy} onChange={event => change({ termsText: event.target.value })}/> }]}/>
        <Alert type="info" showIcon title="图片与链接不会发送给文字模型" description="正文排版、图片和链接保留在本机。站内链接只映射到已有目标语言页面；缺少译文目标会保留原链接并提示。一次最多24000字符和400段文字，不自动拆批收费。"/>
      </Space> : <Empty description={busy ? '正在读取可翻译内容…' : '暂时无法读取内容，请重新打开核对'}/>)}
      {tab === 'review' && proposal && <Space orientation="vertical" size={16} style={{ display: 'flex', width: '100%', minWidth: 0 }} styles={{ item: { minWidth: 0, maxWidth: '100%' } }}>
        <Flex gap={8} wrap><Tag color={state === '已保存' ? 'green' : state === '已撤销' ? 'default' : 'blue'}>{state}</Tag><Typography.Text>{proposal.sourceLocale} → {proposal.targetLocale}</Typography.Text><Typography.Text type="secondary">{proposal.isNew ? '建立新语言记录' : '更新已有译文'}{proposal.targetSku ? ` · 编号 ${proposal.targetSku}` : ''}</Typography.Text></Flex>
        {changed && <Alert type="warning" title="翻译要求已变化，请重新生成后再保存"/>}{proposal.stale && proposal.appliedRevision === null && <Alert type="warning" title="原文或目标译文已变化，这份旧建议不能覆盖新内容"/>}{proposal.sourceChangedAfterApply && <Alert type="warning" title="原文已有后续修改，请核对译文是否仍适用"/>}
        {proposal.warnings.map((warning, index) => <Typography.Paragraph key={index} type="secondary" style={{ margin: 0 }}>{warning}</Typography.Paragraph>)}
        {proposal.fields.map(field => <div key={field.key} style={{ border: '1px solid var(--border, #e2e8f0)', borderRadius: 6, padding: 16, minWidth: 0 }}><Checkbox checked={selected.includes(field.key)} disabled={!!busy || proposal.appliedRevision !== null} onChange={event => setSelected(value => event.target.checked ? [...value, field.key] : value.filter(key => key !== field.key))}><Typography.Text strong>{field.label}</Typography.Text></Checkbox><Collapse style={{ marginTop: 12 }} items={[{ key: 'source', label: '原文', children: content(field.source) }, ...(proposal.isNew ? [] : [{ key: 'before', label: '当前目标语言内容', children: content(field.before) }])]} /><div style={{ marginTop: 12, minWidth: 0 }}>{content(field.after)}</div></div>)}
        {proposal.beforeUrl && proposal.afterUrl ? <><Button icon={<EyeOutlined/>} onClick={() => setShowPages(value => !value)}>{showPages ? '收起实际页面对比' : '查看实际页面前后版本'}</Button>{showPages && <Flex gap={12} vertical><iframe title="翻译前实际页面" src={proposal.beforeUrl} style={{ width: '100%', height: 420, border: '1px solid #e2e8f0', borderRadius: 6 }}/><iframe title="翻译后实际页面" src={proposal.afterUrl} style={{ width: '100%', height: 420, border: '1px solid #e2e8f0', borderRadius: 6 }}/></Flex>}</> : <Alert type="info" title="此内容尚未配置独立详情入口" description="仍可逐字段核对译文；配置详情模板后可使用真实页面预览。"/>}
        {proposal.undoReason && <Alert type="warning" title={proposal.undoReason}/>}
      </Space>}
      {tab === 'history' && <><Button icon={<ReloadOutlined/>} disabled={!!busy} onClick={() => void run('读取记录', loadHistory)}>刷新翻译记录</Button><List dataSource={history} locale={{ emptyText: '还没有本人翻译记录' }} renderItem={item => <List.Item actions={[<Button key="read" disabled={!!busy} onClick={() => void run('读取建议', async () => { const value = await request<AiTranslationPreview>(`/api/ai/translations/${item.id}`); display(value); setDirty(value.appliedRevision === null); })}>查看译文</Button>]}><List.Item.Meta title={`${item.sourceLabel} → ${item.targetLocale}`} description={`${item.undoneRevision !== null ? '已撤销' : item.appliedRevision !== null ? '已保存' : '待核对'} · ${new Date(item.createdAt).toLocaleString()}`}/></List.Item>}/></>}
    </Space>
  </Modal><ConfigProvider theme={{token:{zIndexPopupBase:1500}}}>{guard.dialog}</ConfigProvider></>;
}
