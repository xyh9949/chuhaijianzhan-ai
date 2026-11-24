'use client';

import { useAiSettings } from './AiProviderSettings';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Collapse, Flex, Form, Input, List, Modal, Select, Space, Tabs, Tag, Typography } from 'antd';
import { DeleteOutlined, EyeOutlined, HistoryOutlined, ReloadOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import type { ScreenProps } from '@/lib/types';
import type { SeoMetadata, SeoProposalPreview, SeoReportSummary, SeoTarget, SeoEvidence } from '@/lib/seo-types';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { readLocalRecovery } from '@/lib/local-recovery';
import { useLocalDraftGuard } from './useLocalDraftGuard';

const { Text, Paragraph } = Typography;
type Inputs = { target: { kind: SeoTarget['kind']; id: string }; seoTitle: string; seoDescription: string; instruction: string; reportIds: string[] };
type Props = { open: boolean; target: SeoTarget; initial: SeoMetadata; reports: SeoReportSummary[]; currentRevisions: { gsc?: number; dataforseo?: number }; initialReportIds?: string[]; initialProposalId?: string; aiEnabled: boolean; onClose: () => void; onSaved: () => Promise<void>; navigate: ScreenProps['navigate']; onOpenEditor: (target: SeoTarget) => void };
const stamp = (value: string) => new Date(value).toLocaleString();
const targetKey = (target: Pick<SeoTarget, 'kind' | 'id'>) => `${target.kind}:${target.id}`;
function validInputs(value: unknown): value is Inputs {
  const input = value as Inputs | undefined;
  return !!input && Object.keys(input).every(key => ['target','seoTitle','seoDescription','instruction','reportIds'].includes(key)) && ['page', 'product', 'entry'].includes(input.target?.kind) && typeof input.target.id === 'string' && typeof input.seoTitle === 'string' && input.seoTitle.length <= 200 && typeof input.seoDescription === 'string' && input.seoDescription.length <= 1000 && typeof input.instruction === 'string' && input.instruction.length <= 2000 && Array.isArray(input.reportIds) && input.reportIds.length <= 5 && input.reportIds.every(id => typeof id === 'string' && id.length <= 100);
}
export function SeoEvidenceList({ evidence }: { evidence: SeoEvidence[] }) {
  const names = { site: '本站内容', rule: '站内规则检查', gsc: 'Google搜索报告', dataforseo: 'DataForSEO关键词报告', csv: '人工导入报告' };
  return <ul className="seo-evidence-list">{evidence.map((item, index) => <li key={`${item.reportId || item.source}-${index}`}><span>{item.description}</span><Text type="secondary">{names[item.source]}{item.rowNumbers?.length ? ` · 记录${item.rowNumbers.join('、')}` : ''}{item.startDate || item.endDate ? ` · ${item.startDate || ''}～${item.endDate || ''}` : ''}{item.timeZone ? ` · ${item.timeZone}` : ''}{item.country ? ` · ${item.country}` : ''}{item.languageCode ? ` · ${item.languageCode}` : ''}{item.partial ? ' · 部分覆盖' : ''}</Text></li>)}</ul>;
}
function Snippet({ title, values, fallback, url }: { title: string; values: SeoMetadata; fallback?: SeoMetadata; url: string | null }) {
  // 服务端展示值包含品牌后缀及默认文案，必须优先于显式字段才能与真实预览一致。
  return <div className="seo-snippet"><Text strong>{title}</Text><div className="seo-snippet-url">{url || '此内容还没有可访问的独立网址'}</div><h3>{fallback?.seoTitle ?? (values.seoTitle || '留空时使用已有内容标题')}</h3><p>{fallback?.seoDescription ?? (values.seoDescription || '留空时使用既有内容或网站介绍。')}</p></div>;
}

/** 搜索字段的确认与撤销单独走服务器回执，不通过整站update覆盖页面正文。 */
export default function SeoProposalModal({ open, target, initial, reports, currentRevisions, initialReportIds = [], initialProposalId, aiEnabled, onClose, onSaved, navigate, onOpenEditor }: Props) {
  const aiSettings = useAiSettings();
  const runtime = useStudioRuntime(), { modal } = App.useApp();
  const scope = `seo-proposal:${targetKey(target)}`;
  const [recovered] = useState(() => readLocalRecovery<Inputs>(runtime.actor.id, scope, validInputs));
  const base = useMemo<Inputs>(() => ({ target: { kind: target.kind, id: target.id }, ...initial, instruction: '', reportIds: initialReportIds.slice(0, 5) }), [target.kind, target.id, initial.seoTitle, initial.seoDescription]);
  const [inputs, setInputs] = useState<Inputs>(() => recovered?.snapshot || base), [dirty, setDirty] = useState(!!recovered);
  const [preview, setPreview] = useState<SeoProposalPreview>(), [history, setHistory] = useState<SeoProposalPreview[]>([]), [tab, setTab] = useState('edit');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState(''), [showPages, setShowPages] = useState(false);
  const lock = useRef(false), generatedInput = useRef('');
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope, screen: 'seo', title: `${target.label} · 搜索优化输入`, dirty: open && dirty, busy: !!busy, snapshot: inputs, discard: () => { setInputs(base); setDirty(false); } });
  const changed = !!preview && preview.appliedRevision === null && !!generatedInput.current && generatedInput.current !== JSON.stringify(inputs);
  const availableReports = reports.filter(report => inputs.reportIds.includes(report.id));
  // 连接版本只与同一供应商比较；人工CSV没有当前接口账户，不能误标成旧连接。
  const historicalReport = (report: SeoReportSummary) => report.provider !== 'csv' && currentRevisions[report.provider] !== undefined && report.connectionRevision !== currentRevisions[report.provider];
  const reportScopeLabel = (report: SeoReportSummary) => [report.source.name, report.scope.property, `${report.scope.startDate}～${report.scope.endDate}`, report.scope.timeZone, report.scope.country && `国家${report.scope.country}`, report.scope.device && `设备${report.scope.device}`, report.scope.locationCode !== undefined && `地区代码${report.scope.locationCode}`, report.scope.languageCode && `语言${report.scope.languageCode}`, report.coverage.partial && '部分覆盖'].filter(Boolean).join(' · ');
  function change(patch: Partial<Inputs>) { setInputs(current => ({ ...current, ...patch })); setDirty(true); setError(''); setSuccess(''); }
  async function run(name: string, work: () => Promise<void>) { if (lock.current) return; lock.current = true; setBusy(name); setError(''); setSuccess(''); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，当前输入和建议仍保留。'); } finally { lock.current = false; setBusy(''); } }
  async function refreshHistory() { const value = await request<{ items: SeoProposalPreview[] }>('/api/seo/proposals'); setHistory(value.items.filter(item => targetKey(item.target) === targetKey(target))); }
  useEffect(() => {
    if (!open) return;
    if (!dirty) setInputs(current => ({ ...current, ...initial }));
    void run('读取优化记录', async () => {
      await refreshHistory();
      const id = initialProposalId || preview?.proposalId;
      if (!id) return;
      // 外部链接只读取本人候选；输入表单保持，模型和报告接口均不参与审核。
      const saved = await request<SeoProposalPreview>(`/api/seo/proposals/${encodeURIComponent(id)}`);
      if (targetKey(saved.target) !== targetKey(target)) throw new Error('这条建议不属于当前内容，请重新打开审核入口。');
      setPreview(saved);
      if (initialProposalId) { generatedInput.current = ''; setTab('compare'); }
    });
    // 重开只读取当前字段和回执，不能把上次AI应用前的表单当作当前值。
  }, [open, initialProposalId]);
  useEffect(() => { const resume = (event: Event) => { if ((event as CustomEvent).detail?.scope !== scope) return; const item = readLocalRecovery<Inputs>(runtime.actor.id, scope, validInputs); if (item && targetKey(item.snapshot.target) === targetKey(target)) { setInputs(item.snapshot); setDirty(true); setTab('edit'); } }; window.addEventListener('form-studio:recover-local', resume); return () => window.removeEventListener('form-studio:recover-local', resume); }, [runtime.actor.id, scope]);
  async function generate(useAi: boolean) {
    if (useAi && !aiEnabled) { setError('请先配置并启用自己的AI服务，手动预览仍可使用。'); return; }
    if (useAi && inputs.instruction.trim().length < 2) { setError('请简短说明希望改善什么，例如让标题更准确地对应这页产品。'); return; }
    if (inputs.reportIds.some(id => !reports.some(report => report.id === id))) { setError('所选报告已不存在，请重新选择数据来源。'); return; }
    await run(useAi ? '生成AI建议' : '准备手动预览', async () => {
      await runtime.flush();
      const result = await request<SeoProposalPreview>('/api/seo/proposals', { method: 'POST', body: JSON.stringify({ ...inputs, expectedRevision: runtime.getEnvelope().revision, useAi }) });
      generatedInput.current = JSON.stringify(inputs); setPreview(result); setShowPages(false); setTab('compare'); await refreshHistory(); setSuccess(useAi ? 'AI建议已生成，尚未采用到网站。' : '预览已准备，尚未写入网站，也没有调用AI。');
    });
  }
  async function act(kind: 'apply' | 'undo') {
    if (!preview) return;
    const keepInputs = dirty && (initialProposalId === preview.proposalId || !generatedInput.current || kind === 'undo');
    await run(kind === 'apply' ? '应用搜索字段' : '撤销搜索字段', async () => {
      await runtime.flush();
      await runtime.mutate(envelope => request<StudioEnvelope>(`/api/seo/proposals/${kind}`, { method: 'POST', body: JSON.stringify({ proposalId: preview.proposalId, expectedRevision: envelope.revision }) }));
      const saved = await request<SeoProposalPreview>(`/api/seo/proposals/${preview.proposalId}`);
      setPreview(saved);
      // 外部候选与之前未提交的手动输入是两份内容，采用/撤销不能顺带清空后者。
      if (!keepInputs) { setInputs(current => ({ ...current, ...(kind === 'apply' ? saved.after : saved.before) })); setDirty(false); guard.clear(); }
      await refreshHistory(); await onSaved(); setSuccess(`${kind === 'apply' ? '搜索字段已保存为草稿，正文和公开版本保持。' : '这次搜索字段修改已撤销，其他资料保持。'}${keepInputs ? '“准备修改”中的未提交输入仍保留，可继续编辑。' : ''}`);
    });
  }
  function remove(item: SeoProposalPreview) { modal.confirm({ title: '移除这条优化记录？', content: item.appliedRevision !== null && item.undoneRevision === null ? '网站内容不会删除，但移除后不能再从这条记录撤销。' : '只清理私有记录，不修改网站。', okText: '移除记录', cancelText: '保留', okButtonProps: { danger: true }, onOk: () => run('移除记录', async () => { await request(`/api/seo/proposals/${item.proposalId}`, { method: 'DELETE' }); if (preview?.proposalId === item.proposalId) { setPreview(undefined); setTab('history'); } await refreshHistory(); }) }); }
  const applied = preview?.appliedRevision !== null && preview?.appliedRevision !== undefined, undone = preview?.undoneRevision !== null && preview?.undoneRevision !== undefined;
  const fallback = preview as SeoProposalPreview & { beforeDisplay?: SeoMetadata; afterDisplay?: SeoMetadata } | undefined;
  const compare = preview ? <Space orientation="vertical" size={16} style={{ width: '100%' }}>
    <Flex justify="space-between" gap={16} wrap><div><Text strong>{preview.summary}</Text><Paragraph type="secondary" style={{ marginBottom: 0 }}>{preview.target.label} · {undone ? '已撤销' : applied ? '已应用，7天内可撤销' : `待确认 · 有效至${stamp(preview.expiresAt)}`}</Paragraph></div>{applied ? <Button icon={<UndoOutlined />} disabled={!!busy || undone || preview.canUndo === false || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void act('undo')}>撤销这次修改</Button> : <Button type="primary" disabled={!!busy || changed || Date.parse(preview.expiresAt) <= Date.now()} loading={busy === '应用搜索字段'} onClick={() => void act('apply')}>确认应用到草稿</Button>}</Flex>
    {preview.sourceMock && <Alert type="warning" showIcon title="此建议使用了模拟数据，只用于功能验证" />}
    {changed && <Alert type="info" showIcon title="输入已变化，请重新准备预览后再应用" />}
    <Alert type="info" showIcon title="搜索结果展示示意" description="Google可能重新生成标题和摘要，实际展示不由本系统保证。这里只调整标题和介绍，不改网址、收录开关、正文或动态绑定。" />
    <div className="seo-snippet-comparison"><Snippet title="修改前" values={preview.before} fallback={fallback?.beforeDisplay} url={preview.target.url} /><Snippet title="建议修改后" values={preview.after} fallback={fallback?.afterDisplay} url={preview.target.url} /></div>
    <Collapse size="small" items={[{ key: 'changes', label: `查看具体修改 · ${preview.changes.length}项`, children: <List dataSource={preview.changes} renderItem={item => <List.Item><Space orientation="vertical"><Text strong>{item.label}</Text><Text type="secondary">原来：{item.before || '使用默认值'}</Text><Text>改为：{item.after || '使用默认值'}</Text></Space></List.Item>} /> }, { key: 'evidence', label: '依据哪些数据？', children: preview.evidence.length ? <SeoEvidenceList evidence={preview.evidence} /> : <Text type="secondary">本次未引用外部搜索报告，请人工核对内容准确性。</Text> }]} />
    {!!preview.warnings.length && <Alert type="warning" showIcon title="发布前请核对" description={<ul className="seo-evidence-list">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>} />}
    {preview.beforeUrl && preview.afterUrl ? <><Button icon={<EyeOutlined />} onClick={() => setShowPages(!showPages)}>{showPages ? '收起实际页面' : '查看实际页面前后版本'}</Button>{showPages && <div className="seo-actual-pages"><iframe title="SEO修改前实际页面" src={preview.beforeUrl} /><iframe title="SEO修改后实际页面" src={preview.afterUrl} /></div>}</> : <Text type="secondary">此内容还没有可用的独立详情路由，当前提供搜索字段示意；先在原页面管理完成详情页。</Text>}
  </Space> : <Alert type="info" showIcon title="先准备一份预览" description="手动编辑后点击预览，或明确使用自己的AI生成建议；两种方式都不会直接采用。" />;
  return <>{guard.dialog}<Modal className="seo-proposal-modal" title={`优化搜索展示 · ${target.label}`} open={open} width={1200} style={{ top: 24, maxWidth: 'calc(100vw - 24px)' }} onCancel={() => { if (!busy) guard.ask(onClose); }} maskClosable={!busy} closable={!busy} footer={<Flex justify="space-between" align="center" gap={12} wrap><Text type="secondary">先预览，再确认；只保存草稿，不自动发布。</Text><Button disabled={!!busy} onClick={() => guard.ask(onClose)}>返回搜索优化</Button></Flex>}>
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>{error && <Alert type="error" showIcon title="操作未完成" description={error} action={<Button size="small" disabled={!!busy} onClick={() => void run('读取最新工作区', async () => { await runtime.refresh(); await onSaved(); await refreshHistory(); })}>读取最新工作区</Button>} />}{success && <Alert type="success" showIcon title={success} />}
      <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'edit', label: '准备修改', children: <Form layout="vertical"><Alert type="info" showIcon title={target.url || '此内容还没有可访问的独立网址'} description="可以先手动调整，查看预览无需AI。需要数据辅助时，选择你已读取的报告，再主动调用自己的模型。" /><div className="seo-form-space"><Form.Item label="搜索结果标题" extra={`${inputs.seoTitle.length}/200字；留空沿用原内容标题。`}><Input aria-label="优化搜索标题" disabled={!!busy} maxLength={200} value={inputs.seoTitle} onChange={event => change({ seoTitle: event.target.value })} /></Form.Item><Form.Item label="搜索结果介绍" extra={`${inputs.seoDescription.length}/1000字；留空使用既有内容或网站说明。`}><Input.TextArea aria-label="优化搜索介绍" disabled={!!busy} rows={4} maxLength={1000} value={inputs.seoDescription} onChange={event => change({ seoDescription: event.target.value })} /></Form.Item></div>
        <Flex gap={12} wrap><Button type="primary" icon={<EyeOutlined />} disabled={!!busy} loading={busy === '准备手动预览'} onClick={() => void generate(false)}>预览这次修改（不调用AI）</Button><Button disabled={!!busy} onClick={() => guard.ask(() => onOpenEditor(target))}>去原编辑器修改正文</Button></Flex>
        <Collapse className="seo-form-space" items={[{ key: 'ai', label: '需要AI帮助？按搜索数据给出建议', children: <><Form.Item label="参考哪些报告（最多5份）"><Select aria-label="优化参考报告" mode="multiple" maxCount={5} maxTagCount="responsive" disabled={!!busy} value={inputs.reportIds} options={reports.map(report => ({ value: report.id, label: `${report.source.sourceMock ? '模拟 · ' : ''}${historicalReport(report) ? '历史连接报告 · ' : ''}${report.source.name} · ${report.scope.startDate}～${report.scope.endDate}${report.coverage.partial ? ' · 部分数据' : ''}` }))} onChange={reportIds => change({ reportIds })} /></Form.Item>{availableReports.length > 0 && <div className="seo-selected-report-notes">{availableReports.map(report => <div key={report.id}><Text type="secondary">{reportScopeLabel(report)}</Text>{historicalReport(report) && <Tag color="orange">历史连接报告</Tag>}</div>)}</div>}{availableReports.some(historicalReport) && <Alert className="seo-form-space" type="warning" showIcon title="所选资料包含历史连接报告" description="请按上方原网站、日期、设备、地区和语言理解，不能与当前连接的数据混为同一批。需要最新数据时先回工作台主动同步或查询。" />}<Form.Item label="希望AI怎么改善" extra="仅发送所选内容的有限文字，以及每份报告最多20条匹配记录；不发送整站或完整报告。数据不足时不估算数字。"><Input.TextArea aria-label="搜索优化AI要求" disabled={!!busy} rows={3} maxLength={2000} value={inputs.instruction} onChange={event => change({ instruction: event.target.value })} placeholder="例如：依据这页已有产品事实和搜索词，让标题更准确，介绍更清楚；不要添加未经确认的认证或价格。" /></Form.Item><Flex gap={12} wrap align="center"><Button icon={<ThunderboltOutlined />} disabled={!!busy || !aiEnabled || !inputs.instruction.trim()} loading={busy === '生成AI建议'} onClick={() => void generate(true)}>用我的AI建议</Button>{!aiEnabled && <Button onClick={aiSettings.open}>AI服务设置</Button>}<Text type="secondary">点击才使用自己的模型额度，不自动重试。</Text></Flex></> }]} />
      </Form> }, { key: 'compare', label: '预览与确认', children: compare }, { key: 'history', label: <Space><HistoryOutlined />优化记录</Space>, children: <><Flex gap={12} align="center" justify="space-between" wrap><Text type="secondary">仅显示本人对当前内容的记录；后续人工改过搜索字段时，旧记录不会覆盖新内容。</Text><Button size="small" icon={<ReloadOutlined />} disabled={!!busy} onClick={() => void run('刷新优化记录', refreshHistory)}>刷新记录</Button></Flex><List dataSource={history} locale={{ emptyText: '还没有当前内容的优化记录' }} renderItem={item => <List.Item actions={[<Button key="view" size="small" disabled={!!busy} onClick={() => void run('读取优化记录', async () => { setPreview(await request<SeoProposalPreview>(`/api/seo/proposals/${item.proposalId}`)); generatedInput.current = ''; setTab('compare'); })}>查看对比</Button>, <Button key="remove" aria-label="移除优化记录" icon={<DeleteOutlined />} type="text" danger disabled={!!busy} onClick={() => remove(item)} />]}><List.Item.Meta title={<Space wrap><Text>{item.summary}</Text><Tag>{item.undoneRevision !== null ? '已撤销' : item.appliedRevision !== null ? '已应用' : '待确认'}</Tag></Space>} description={`有效至${stamp(item.expiresAt)}`} /></List.Item>} /></> }]} />
    </Space>
  </Modal></>;
}
