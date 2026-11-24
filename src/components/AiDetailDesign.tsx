'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Collapse, Empty, Flex, Form, Input, List, Modal, Select, Space, Tabs, Tag, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, ReloadOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import type { AiDetailDesignPreview, AiDetailDesignRequest } from '@/lib/ai-detail-design-types';
import { readLocalRecovery } from '@/lib/local-recovery';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { focusTemplateLibrary, rememberTemplateEditor } from '@/lib/template-editor-client';
import { editorNodes } from '@/lib/editor-layout';
import type { Screen, StudioState } from '@/lib/types';
import { useAiSettings } from './AiProviderSettings';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import AiDesignPreview from './AiDesignPreview';
import AiDesignRangeTree from './AiDesignRangeTree';
import { normalizeAiRangeChoices, toggleAiRangeChoice } from '@/lib/ai-design-selection-client';
import { DesignGuidanceSummary } from './DesignGuidanceProvider';
import './ai-detail-design.css';

type Options = Omit<AiDetailDesignRequest, 'expectedRevision' | 'baseDesignId'>;
type SelectionDraft = { designId: string; unitIds: string[] };
type Recovery = { options: Options; followup: string; designId?: string; baseline?: string; selectionDraft?: SelectionDraft };
type Props = {
  open: boolean; state: StudioState; templateId?: string; targetId?: string; reviewDesignId?: string;
  onClose: () => void; onOpen?: () => void; onReviewHandled?: (id: string) => void;
  navigate: (screen: Screen) => void; originScreen?: 'templates' | 'editor';
  onSaveCanvas?: () => Promise<void>; onPauseCanvas?: (paused: boolean) => void; onReloadCanvas?: () => void;
};
const scope = 'ai-detail-design';
const staleMessage = '这版方案基于旧草稿，请从最新草稿重新设计。';
const initial = (templateId = ''): Options => ({ templateId, instruction: '', preserveText: true, viewport: 'all' });
function validRecovery(value: unknown): value is Recovery {
  const item = value as Recovery | undefined, options = item?.options;
  return !!options && typeof options.templateId === 'string' && options.templateId.length <= 100 && typeof options.instruction === 'string' && options.instruction.length <= 2000 && typeof options.preserveText === 'boolean' && (options.recordId === undefined || typeof options.recordId === 'string' && options.recordId.length <= 100) && (options.targetId === undefined || typeof options.targetId === 'string' && options.targetId.length <= 100) && (options.viewport === undefined || ['all', 'desktop', 'tablet', 'mobile'].includes(options.viewport)) && typeof item.followup === 'string' && item.followup.length <= 2000 && (item.designId === undefined || typeof item.designId === 'string' && item.designId.length <= 100) && (item.baseline === undefined || typeof item.baseline === 'string' && item.baseline.length <= 5000) && (!item.selectionDraft || typeof item.selectionDraft.designId === 'string' && item.selectionDraft.designId.length <= 100 && Array.isArray(item.selectionDraft.unitIds) && item.selectionDraft.unitIds.length <= 103 && item.selectionDraft.unitIds.every(id => typeof id === 'string' && id.length <= 110));
}
export function readDetailDesignRecovery(actorId: string, templateId?: string) {
  const entry = readLocalRecovery<Recovery>(actorId, scope, validRecovery);
  return !templateId || entry?.snapshot.options.templateId === templateId ? entry : undefined;
}

/** 原生与外部AI使用相同私有候选：先核对真实记录和三端效果，再单独确认写入模板草稿。 */
export default function AiDetailDesign({ open, state, templateId, targetId, reviewDesignId, onClose, onOpen, onReviewHandled, navigate, originScreen = 'templates', onSaveCanvas, onPauseCanvas, onReloadCanvas }: Props) {
  const runtime = useStudioRuntime(), settings = useAiSettings(), { message } = App.useApp();
  const [recovered] = useState(() => readDetailDesignRecovery(runtime.actor.id, templateId));
  const [options, setOptions] = useState<Options>(() => recovered?.snapshot.options || { ...initial(templateId), ...(targetId ? { targetId } : {}) });
  const [followup, setFollowup] = useState(recovered?.snapshot.followup || '');
  const [preview, setPreview] = useState<AiDetailDesignPreview>(), [history, setHistory] = useState<AiDetailDesignPreview[]>([]);
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | undefined>(recovered?.snapshot.selectionDraft);
  const [provider, setProvider] = useState<{ enabled: boolean; hasApiKey: boolean }>();
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const [tab, setTab] = useState('describe'), [dirty, setDirty] = useState(!!recovered);
  const lock = useRef(false), baseline = useRef(recovered?.snapshot.baseline || ''), reviewed = useRef('');
  const admin = runtime.actor.role === 'admin', currentTemplate = state.pageTemplates?.find(item => item.id === options.templateId);
  const templates = (state.pageTemplates || []).filter(item => item.kind !== 'page');
  const productModelId = currentTemplate?.detailRule?.modelId;
  const records = currentTemplate?.kind === 'product' ? state.products.filter(item => !productModelId || item.modelId === productModelId).map(item => ({ value: item.id, label: item.name })) : (state.contentEntries || []).filter(item => item.modelId === currentTemplate?.modelId).map(item => ({ value: item.id, label: item.title }));
  const changed = !!preview && baseline.current !== JSON.stringify(options), followupDirty = !!followup.trim();
  const units = preview?.selectionUnits || [], defaultIds = units.filter(unit => unit.kind === 'section').map(unit => unit.id), selectedIds = normalizeAiRangeChoices(units, selectionDraft?.designId === preview?.designId ? selectionDraft?.unitIds || [] : defaultIds);
  const selectionDirty = !!preview && (selectedIds.length !== defaultIds.length || selectedIds.some(id => !defaultIds.includes(id)));
  const expired = !!preview && Date.parse(preview.expiresAt) <= Date.now();
  const stalePending = !!preview && preview.appliedRevision === null && preview.baseRevision !== runtime.envelope.revision;
  const canApply = !!preview && !changed && !followupDirty && !selectionDirty && !expired && !stalePending && preview.previewAvailable && preview.appliedRevision === null && preview.undoneRevision === null;
  const scopeQuery = templateId ? `?templateId=${encodeURIComponent(templateId)}` : '';
  const designPath = (id: string) => `/api/ai/detail-designs/${encodeURIComponent(id)}${scopeQuery}`;
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope, screen: originScreen, title: 'AI详情布局要求', dirty: open && dirty, busy: !!busy, snapshot: { options, followup, designId: preview?.designId || recovered?.snapshot.designId, baseline: baseline.current, ...(selectionDraft ? { selectionDraft } : {}) }, discard: () => { setDirty(false); setFollowup(''); setSelectionDraft(preview ? { designId: preview.designId, unitIds: defaultIds } : undefined); if (preview) { const { expectedRevision: _revision, baseDesignId: _base, ...next } = preview.request; setOptions(next); baseline.current = JSON.stringify(next); } else setOptions(initial(templateId)); } });

  async function run(name: string, work: () => Promise<void>) {
    if (!admin || lock.current) return;
    lock.current = true; setBusy(name); setError(''); setSuccess('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，要求和原方案仍保留。'); }
    finally { lock.current = false; setBusy(''); }
  }
  async function refreshHistory() { const value = await request<{ items: AiDetailDesignPreview[] }>(`/api/ai/detail-designs${scopeQuery}`); setHistory(value.items); }
  function choose(value: AiDetailDesignPreview, preserveInput = false) {
    // 定向打开的面板只处理该模板；保留输入、历史记录和外部链接也必须满足范围。
    if (templateId && value.templateId !== templateId) throw Error('这条详情方案不属于当前模板');
    setPreview(value); setTab('review');
    setSelectionDraft(current => preserveInput && current?.designId === value.designId ? current : { designId: value.designId, unitIds: (value.selectionUnits || []).filter(unit => unit.kind === 'section').map(unit => unit.id) });
    if (!preserveInput) {
      const { expectedRevision: _revision, baseDesignId: _base, ...next } = value.request;
      setOptions(next); baseline.current = JSON.stringify(next); setFollowup(''); setDirty(false);
      if (readDetailDesignRecovery(runtime.actor.id, templateId)) guard.clear();
    }
  }
  function openReview(id: string, external = false) {
    if (lock.current) return;
    guard.ask(() => { void run('读取详情方案', async () => {
      if (external) reviewed.current = id;
      // 审核外部候选只读本人数据，不依赖站内AI密钥，也不从链接执行采用动作。
      choose(await request<AiDetailDesignPreview>(designPath(id)));
      if (external) onReviewHandled?.(id);
    }); });
  }
  useEffect(() => {
    if (!open || !admin) return;
    void run('读取详情设计', async () => {
      const [providerState] = await Promise.all([request<{ enabled: boolean; hasApiKey: boolean }>('/api/ai/provider'), refreshHistory()]);
      setProvider(providerState);
      const id = preview?.designId || recovered?.snapshot.designId;
      if (id) choose(await request<AiDetailDesignPreview>(designPath(id)), true);
    });
    // 打开不调用模型；本地输入的基线只有生成或显式读取方案后才改变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open || !reviewDesignId || busy || dirty || reviewed.current === reviewDesignId || !admin) return;
    openReview(reviewDesignId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reviewDesignId, busy, dirty, admin]);
  useEffect(() => {
    if (!open || !admin) return;
    let live = true;
    void request<{ enabled: boolean; hasApiKey: boolean }>('/api/ai/provider').then(value => { if (live) setProvider(value); }).catch(() => {});
    return () => { live = false; };
  }, [settings.changeVersion, open, admin]);
  useEffect(() => {
    const restore = (event: Event) => {
      if ((event as CustomEvent).detail?.scope !== scope) return;
      const saved = readDetailDesignRecovery(runtime.actor.id, templateId); if (!saved) return;
      setOptions(saved.snapshot.options); setFollowup(saved.snapshot.followup); setSelectionDraft(saved.snapshot.selectionDraft); baseline.current = saved.snapshot.baseline || ''; setDirty(true); onOpen?.();
      if (saved.snapshot.designId) void run('恢复详情方案', async () => { choose(await request<AiDetailDesignPreview>(designPath(saved.snapshot.designId!)), true); });
    };
    window.addEventListener('form-studio:recover-local', restore); return () => window.removeEventListener('form-studio:recover-local', restore);
  }, [runtime.actor.id, templateId, onOpen]);
  function change(patch: Partial<Options>) { setOptions(value => ({ ...value, ...patch })); setDirty(true); setError(''); setSuccess(''); }
  async function generate(refine = false) {
    if (refine && (!preview || stalePending)) return;
    const instruction = (refine ? followup : options.instruction).trim();
    if (instruction.length < 2) { setError('请说明希望如何调整详情页。'); return; }
    if (!provider?.enabled || !provider.hasApiKey) { setError('请先在站点设置的“AI服务”中配置并启用自己的模型。'); return; }
    await run(refine ? '继续调整详情布局' : '生成详情布局', async () => {
      await onSaveCanvas?.(); await runtime.flush();
      const latestRevision = runtime.getEnvelope().revision;
      if (refine && preview && preview.baseRevision !== latestRevision) throw Error(staleMessage);
      const requestBody = refine && preview ? { ...preview.request, instruction, expectedRevision: preview.baseRevision, baseDesignId: preview.designId } : { ...options, templateId: templateId || options.templateId, instruction, expectedRevision: latestRevision };
      choose(await request<AiDetailDesignPreview>('/api/ai/detail-designs', { method: 'POST', body: JSON.stringify(requestBody) }));
      await refreshHistory(); setSuccess('详情布局已生成，尚未改动模板草稿。请核对真实内容和三端效果。');
    });
  }
  async function applyOrUndo(kind: 'apply' | 'undo') {
    if (!preview) return;
    if (kind === 'apply' ? !canApply : !preview.canUndo) return;
    await run(kind === 'apply' ? '保存详情布局草稿' : '撤销详情布局', async () => {
      await onSaveCanvas?.(); await runtime.flush(); onPauseCanvas?.(true);
      let mutated = false;
      try {
        await runtime.mutate(env => {
          // 保存队列可能刚推进版本；已知过期的确认在发请求前提示，不将工作区置为冲突。
          if (kind === 'apply' && env.revision !== preview.baseRevision) throw new RequestError(422, staleMessage);
          return request<StudioEnvelope>(`/api/ai/detail-designs/${kind}`, { method: 'POST', body: JSON.stringify({ designId: preview.designId, templateId: templateId || preview.templateId, expectedRevision: env.revision }) });
        });
        // 事务已完成就立即重挂画布；后续只读失败也不能让旧Puck回写覆盖已保存的结果。
        mutated = true; onReloadCanvas?.();
        choose(await request<AiDetailDesignPreview>(designPath(preview.designId)), kind === 'undo' && dirty);
        await refreshHistory();
        setSuccess(kind === 'apply' ? '已保存为详情模板草稿。适用内容规则保持原设置，发布后才会更新网站。' : '已撤销本次详情布局修改。');
        message.success(kind === 'apply' ? '详情布局草稿已保存' : '详情布局已撤销');
      } finally { if (!mutated || !onReloadCanvas) onPauseCanvas?.(false); }
    });
  }
  function toggleSelection(id: string, checked: boolean) {
    if (!preview) return;
    const ids = toggleAiRangeChoice(units, selectedIds, id, checked);
    if (ids.length > 103) { setError('最多选择103项，请减少选择；不要为压缩数量自动扩大范围。'); return; }
    setSelectionDraft({ designId: preview.designId, unitIds: ids }); setDirty(true); setError(''); setSuccess('');
  }
  async function previewSelection() {
    if (!preview || !selectionDirty || !selectedIds.length || changed || followupDirty) return;
    await run('预览选中详情修改', async () => {
      await onSaveCanvas?.(); await runtime.flush();
      choose(await request<AiDetailDesignPreview>('/api/ai/detail-designs/select', { method: 'POST', body: JSON.stringify({ designId: preview.designId, templateId: templateId || preview.templateId, expectedRevision: runtime.getEnvelope().revision, unitIds: selectedIds }) }));
      await refreshHistory(); setSuccess('已生成只包含选中范围的真实预览，尚未更新模板。');
    });
  }
  function continueEditing() {
    const id = templateId || preview?.templateId || options.templateId;
    guard.ask(() => { rememberTemplateEditor(runtime.actor.id, id); focusTemplateLibrary(); window.dispatchEvent(new CustomEvent('form-studio:open-template', { detail: { templateId: id } })); onClose(); navigate('editor'); });
  }
  async function refresh() {
    await run('读取最新草稿', async () => {
      // 在编辑器里读取服务器模板时重挂旧画布，避免旧布局以新的版本号再次保存。
      onPauseCanvas?.(true);
      let reloaded = false;
      try {
        await runtime.refresh();
        onReloadCanvas?.(); reloaded = Boolean(onReloadCanvas);
        if (preview) choose(await request<AiDetailDesignPreview>(designPath(preview.designId)), true);
        await refreshHistory();
        setSuccess('已读取最新状态，输入仍保留。');
      } finally { if (!reloaded) onPauseCanvas?.(false); }
    });
  }
  const description = <Space orientation="vertical" size={18} className="ai-detail-design-content">
    <Alert type="info" showIcon title="告诉AI详情页该怎么展示" description="例如：产品大图在左、参数与询价在右，手机改成单栏；案例突出成果、过程和图集。生成的是可拖拽布局，产品及案例资料继续动态展示。" />
    <Form layout="vertical"><Form.Item label="调整哪个详情模板" required><Select aria-label="AI详情模板" value={options.templateId || undefined} disabled={!!templateId} options={templates.map(item => ({ value: item.id, label: item.name }))} onChange={value => change({ templateId: value, recordId: undefined, targetId: undefined })} /></Form.Item>
      <Form.Item label="用哪条真实内容查看效果" extra="默认优先选择真正适用此模板的记录。指定记录仅用于查看布局，不修改适用内容规则。"><Select aria-label="详情预览内容" allowClear showSearch optionFilterProp="label" value={options.recordId} placeholder="自动选择适用的真实内容" options={records} onChange={value => change({ recordId: value })} /></Form.Item>
      <Form.Item label="调整范围"><Select aria-label="详情调整范围" value={options.targetId || ''} options={[{ value: '', label: '整个详情布局' }, ...(currentTemplate ? editorNodes(currentTemplate.data).map(node => ({ value: node.id, label: node.label })) : [])]} onChange={value => change({ targetId: value || undefined })} /></Form.Item>
      <Form.Item label="希望怎么调整" required><Input.TextArea aria-label="详情布局要求" value={options.instruction} rows={5} maxLength={2000} showCount placeholder="描述视觉风格、内容顺序、图片和参数布局，以及手机上希望怎样展示。" onChange={event => change({ instruction: event.target.value })} /></Form.Item>
      <Form.Item label="调整设备"><Select aria-label="详情调整设备" value={options.viewport || 'all'} options={[{ value: 'all', label: '电脑、平板与手机' }, { value: 'desktop', label: '只调整电脑' }, { value: 'tablet', label: '只调整平板' }, { value: 'mobile', label: '只调整手机' }]} onChange={value => change({ viewport: value })} /></Form.Item>
      <Checkbox checked={options.preserveText} onChange={event => change({ preserveText: event.target.checked })}>保留现有文字，优先调整布局和样式</Checkbox>
    </Form>
    {!records.length && <Alert type="warning" showIcon title="还没有可用于预览的真实内容" description="先添加产品，或添加此模板对应栏目的内容，并创建默认详情页；完整预览需要真实记录。" />}
    <Flex gap={12} wrap><Button type="primary" icon={<ThunderboltOutlined />} loading={busy === '生成详情布局'} disabled={!!busy || !records.length || !options.templateId || options.instruction.trim().length < 2 || !provider?.enabled || !provider.hasApiKey} onClick={() => void generate()}>生成详情布局预览</Button><Button onClick={() => settings.open()}>配置自己的AI</Button></Flex>
  </Space>;
  const review = preview ? <Space orientation="vertical" size={18} className="ai-detail-design-content">
    <Flex gap={8} align="center" wrap><Typography.Text strong>{preview.template.name}</Typography.Text><Tag>{preview.template.kind === 'product' ? '产品详情' : '栏目详情'}</Tag>{preview.refinement && <Tag color="blue">第 {preview.refinement.round + 1} 版</Tag>}<Tag color={preview.undoneRevision !== null ? 'default' : preview.appliedRevision !== null ? 'green' : 'blue'}>{preview.undoneRevision !== null ? '已撤销' : preview.appliedRevision !== null ? '已保存草稿' : '待确认'}</Tag></Flex>
    <Alert showIcon type={preview.sample?.matched ? 'info' : 'warning'} title={preview.sample?.matched ? `真实生效样本：${preview.sample.label}` : `仅模板布局预览：${preview.sample?.label || '未找到内容'}`} description={<Space orientation="vertical" size={4}><span>{preview.sample?.reason || preview.unavailableReason}</span><Typography.Text type="secondary">{preview.sample?.url} · 保存只更新此模板的布局，适用内容规则需要单独设置。</Typography.Text></Space>} />
    <Typography.Paragraph style={{ margin: 0 }}>{preview.summary}</Typography.Paragraph>
    {preview.intent && <Alert type="info" showIcon title="AI对需求的理解" description={<Space orientation="vertical" size={4}><span>{preview.intent.goal}</span>{preview.intent.decisions.map((value, index) => <Typography.Text key={index}>{value}</Typography.Text>)}{!!preview.intent.assumptions.length && <Typography.Text type="secondary">待你核对：{preview.intent.assumptions.join('；')}</Typography.Text>}</Space>} />}
    {!!preview.warnings.length && <Alert type="warning" showIcon title="请核对" description={preview.warnings.join('；')} />}
    {preview.selection && <Alert type="info" showIcon title="当前预览只包含选中详情修改" description="未选设计与后来的无关编辑保持。确认保存会采用当前这份真实预览。" action={<Button disabled={!!busy} onClick={() => openReview(preview.selection!.sourceDesignId)}>查看来源方案</Button>} />}
    {selectionDirty && <Alert type="warning" showIcon title="选择已改变，当前仍显示上一版效果" description="勾选不会修改模板。先预览选中修改，核对新的真实效果后再确认保存。" />}
    {preview.appliedRevision === null && !expired && units.length > 0 && <Collapse size="small" items={[{ key: 'detail-selection', label: `只采用部分详情修改 · 已选 ${selectedIds.length} 项`, children: <Space orientation="vertical" size={12} className="ai-detail-design-content"><Typography.Text type="secondary">可挑选完整区块、内部内容、文字或分端样式组。选择内部项会取消其整体范围；资源、绑定及结构依赖保持完整，不会自动扩大选择。</Typography.Text><Space><Button size="small" disabled={!!busy} onClick={() => { setSelectionDraft({ designId: preview.designId, unitIds: defaultIds }); setDirty(changed || followupDirty); }}>选择全部修改</Button><Button size="small" disabled={!!busy} onClick={() => { setSelectionDraft({ designId: preview.designId, unitIds: [] }); setDirty(true); }}>清空选择</Button></Space><AiDesignRangeTree units={units} selectedIds={selectedIds} disabled={!!busy} onToggle={toggleSelection} /><Button disabled={!!busy || !selectionDirty || !selectedIds.length || changed || followupDirty} loading={busy === '预览选中详情修改'} onClick={() => void previewSelection()}>预览选中详情修改</Button></Space> }]} />}
    {preview.selectionUnavailableReason && <Typography.Text type="secondary">{preview.selectionUnavailableReason}</Typography.Text>}
    {preview.previewAvailable ? <AiDesignPreview key={preview.designId} beforeUrl={preview.beforeUrl} afterUrl={preview.afterUrl} editId={preview.designId} visualTarget={{kind:"detail-design",id:preview.designId}} visualDisabled={!!busy || expired || changed || selectionDirty || stalePending || preview.appliedRevision !== null} onVisualInstruction={preview.appliedRevision === null && !expired && !selectionDirty && !stalePending ? instruction => {setFollowup(instruction);setDirty(true);setError("");} : undefined} onVisualBusyChange={active => setBusy(current => active ? "视觉检查中" : current === "视觉检查中" ? "" : current)} /> : <Alert type="warning" title={preview.unavailableReason || '当前预览不可用，请重新读取状态。'} />}
    <List size="small" bordered dataSource={preview.changes} locale={{ emptyText: '没有结构改动' }} renderItem={item => <List.Item><Typography.Text>{item.description}</Typography.Text></List.Item>} />
    {changed && <Alert type="warning" title="描述或样本已修改，请重新生成预览后再确认。" />}
    {followupDirty && <Alert type="info" title="还有未生成的继续调整要求，请先生成下一版或清空要求，再采用当前版本。" />}
    {stalePending && <Alert type="warning" showIcon title="这版方案基于旧草稿" description="你可以查看原对比，或从最新草稿生成新方案。仍需要采用其中一部分时，先预览所选修改。" action={<Button size="small" disabled={!!busy} onClick={() => setTab('describe')}>从最新草稿重新设计</Button>} />}
    <Space wrap><Button type="primary" disabled={!!busy || !canApply} onClick={() => void applyOrUndo('apply')}>确认保存为模板草稿</Button><Button icon={<EditOutlined />} disabled={!!busy || preview.appliedRevision === null || preview.undoneRevision !== null} onClick={continueEditing}>继续拖拽编辑</Button><Button icon={<UndoOutlined />} disabled={!!busy || !preview.canUndo} onClick={() => void applyOrUndo('undo')}>撤销本次修改</Button><Button icon={<ReloadOutlined />} disabled={!!busy} onClick={() => void refresh()}>读取最新状态</Button></Space>
    {preview.undoReason && <Typography.Text type="secondary">{preview.undoReason}</Typography.Text>}
    <Form layout="vertical"><Form.Item label="继续调整这版布局"><Input.TextArea aria-label="继续调整详情布局" value={followup} maxLength={2000} showCount rows={3} disabled={!!busy} onChange={event => { setFollowup(event.target.value); setDirty(true); }} placeholder="例如：首屏再紧凑一些，手机图片改成4:3，参数移到按钮下面。" /></Form.Item><Button icon={<ThunderboltOutlined />} disabled={!!busy || changed || selectionDirty || stalePending || !provider?.enabled || !provider.hasApiKey || followup.trim().length < 2 || preview.appliedRevision !== null || expired} onClick={() => void generate(true)}>在这版上继续调整</Button></Form>
    <Typography.Text type="secondary">候选保留至 {new Date(preview.expiresAt).toLocaleString()}。确认保存前不会改变网站，公开更新需要另行发布。</Typography.Text>
  </Space> : <Empty description="生成方案或选择历史方案后，查看修改前后效果。" />;
  return <>{guard.dialog}<Modal title="AI详情布局设计" open={open} width={1380} className="ai-detail-design-modal" onCancel={() => guard.ask(onClose)} footer={<Button disabled={!!busy} onClick={() => guard.ask(onClose)}>关闭</Button>} destroyOnHidden={false}>
    <Space orientation="vertical" size={18} className="ai-detail-design-content">
      <DesignGuidanceSummary visible={open} instruction={followup.trim() || options.instruction} stamp={preview?.designGuidance} />
      {recovered && dirty && <Alert type="info" showIcon title="已恢复上次未提交的详情布局要求" description="文字和继续调整要求仍保留；恢复不会调用AI，也不会自动应用旧方案。" />}
      {reviewDesignId && reviewed.current !== reviewDesignId && <Alert type="info" showIcon title="有一个外部AI详情方案等待核对" description="当前输入先保留，打开后只读取预览，不会自动应用。" action={<Button disabled={!!busy} onClick={() => openReview(reviewDesignId, true)}>打开外部方案</Button>} />}
      {error && <Alert type="warning" showIcon title={error} action={<Button disabled={!!busy} size="small" onClick={() => void refresh()}>读取最新状态</Button>} />}{success && <Alert type="success" showIcon title={success} />}
      {!provider?.enabled && <Alert type="info" showIcon title="生成和继续调整使用你在站点设置中配置的AI" description="未配置站内AI时，仍能审核外部AI提交的方案、确认保存和撤销。" />}
      <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'describe', label: '描述需求', children: description }, { key: 'review', label: '预览与确认', children: review }, { key: 'history', label: '历史方案', children: <List dataSource={history} locale={{ emptyText: templateId ? '此模板还没有详情设计方案' : '还没有详情设计方案' }} renderItem={item => <List.Item actions={[<Button key="open" disabled={!!busy} onClick={() => openReview(item.designId)}>查看方案</Button>, <Button key="delete" icon={<DeleteOutlined />} disabled={!!busy} onClick={() => guard.ask(() => { void run('删除私有候选', async () => { await request(designPath(item.designId), { method: 'DELETE' }); if (preview?.designId === item.designId) setPreview(undefined); await refreshHistory(); }); })}>删除</Button>]}><List.Item.Meta title={item.template.name} description={`${item.summary} · ${new Date(item.createdAt).toLocaleString()}`} /></List.Item>} /> }]} />
    </Space>
  </Modal></>;
}
