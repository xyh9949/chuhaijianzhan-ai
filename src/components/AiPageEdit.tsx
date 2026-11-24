'use client';

import { useAiSettings } from './AiProviderSettings';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Data } from '@puckeditor/core';
import { Alert, App, Button, Checkbox, Collapse, Empty, Flex, Form, Input, List, Modal, Segmented, Select, Space, Tabs, Tag, Typography } from 'antd';
import { DeleteOutlined, HistoryOutlined, ReloadOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import { editorNodes } from '@/lib/editor-layout';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { readLocalRecovery } from '@/lib/local-recovery';
import type { Screen } from '@/lib/types';
import type { AiPageEditPreview, AiPageEditRequest } from '@/lib/ai-page-edit-types';
import type { AiPreviewFeedback } from '@/lib/ai-preview-inspection';
import AiDesignPreview from './AiDesignPreview';
import { DesignGuidanceSummary } from './DesignGuidanceProvider';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import './ai-page-edit.css';

const { Text, Paragraph } = Typography;
type Mode = AiPageEditRequest['mode'];
type Viewport = 'all' | 'desktop' | 'tablet' | 'mobile';
type EditOptions = Omit<AiPageEditRequest, 'expectedRevision' | 'baseEditId' | 'previewFeedback'>;
type FollowupDraft = { editId: string; instruction: string; viewport: Viewport };
type RecoveryOptions = EditOptions & { followup?: FollowupDraft };
type EditPreview = AiPageEditPreview & { request?: AiPageEditRequest; difference?: { structureChanged: boolean; layoutChanged: boolean; typographyChanged: boolean; colorsChanged: boolean; copyChanged: boolean; similarPages: { pageId: string; title: string; reason: string }[]; warnings: string[] } };
type Provider = { enabled: boolean; hasApiKey: boolean };
type Props = {
  open: boolean; pageId: string; pageTitle: string; data: Data; selectedId?: string;
  onClose: () => void; onSaveCanvas: () => Promise<void>; onPauseCanvas: (paused: boolean) => void; onReloadCanvas: () => void;
  navigate: (screen: Screen) => void;
};
const initialOptions = (pageId: string, targetId?: string): EditOptions => ({ pageId, ...(targetId ? { targetId } : {}), instruction: '', mode: 'mixed', preserveText: false, lockedIds: [], viewport: 'all' });
const viewports = [{ value: 'all', label: '整体效果' }, { value: 'desktop', label: '只调桌面' }, { value: 'tablet', label: '只调平板' }, { value: 'mobile', label: '只调手机' }];
const emptyFollowup = (editId = '', viewport: Viewport = 'all'): FollowupDraft => ({ editId, instruction: '', viewport });
function validOptions(value: unknown): value is RecoveryOptions {
  if (!value || typeof value !== 'object') return false;
  const item = value as RecoveryOptions;
  const validViewport = (viewport: unknown) => viewport === undefined || viewports.some(option => option.value === viewport);
  return typeof item.pageId === 'string' && item.pageId.length <= 100 && (item.targetId === undefined || typeof item.targetId === 'string' && item.targetId.length <= 100) && typeof item.instruction === 'string' && item.instruction.length <= 2000 && ['design', 'copy', 'mixed'].includes(item.mode) && typeof item.preserveText === 'boolean' && Array.isArray(item.lockedIds) && item.lockedIds.length <= 100 && item.lockedIds.every(id => typeof id === 'string' && id.length <= 100) && validViewport(item.viewport) && (!item.followup || typeof item.followup.editId === 'string' && item.followup.editId.length <= 100 && typeof item.followup.instruction === 'string' && item.followup.instruction.length <= 2000 && validViewport(item.followup.viewport));
}
const expiryText = (stamp: string) => new Date(stamp).toLocaleString();
const componentNames: Record<string, string> = { Container: '布局容器', Heading: '标题', Text: '正文', Image: '图片', ActionButton: '按钮', Spacer: '留白', Divider: '分隔线', RichText: '图文正文', ProductList: '产品列表', ProductDetail: '产品详情', ContentList: '内容列表', ContentLoop: '自由卡片列表', SharedBlock: '同步区块', Form: '询盘表单', Navigation: '导航', Breadcrumb: '面包屑', LanguageSwitcher: '语言切换', CompanyFacts: '企业资料', Download: '文件下载', Icon: '图标', Gallery: '画廊', Accordion: '折叠面板', Tabs: '标签页', Video: '视频', Carousel: '轮播' };
function nodeLabel(node: ReturnType<typeof editorNodes>[number]) { const kind = componentNames[node.type] || '自定义控件'; return node.label === node.type ? kind : `${node.label} · ${kind}`; }

export default function AiPageEdit({ open, pageId, pageTitle, data, selectedId, onClose, onSaveCanvas, onPauseCanvas, onReloadCanvas, navigate }: Props) {
  const aiSettings = useAiSettings();
  const runtime = useStudioRuntime(), { message, modal } = App.useApp();
  const admin = runtime.actor.role === 'admin';
  const [recovered] = useState(() => readLocalRecovery<RecoveryOptions>(runtime.actor.id, `ai-page-edit:${pageId}`, value => validOptions(value) && value.pageId === pageId));
  const [options, setOptions] = useState<EditOptions>(() => { if (!recovered?.snapshot) return initialOptions(pageId, selectedId); const { followup: _followup, ...saved } = recovered.snapshot; return saved; });
  const [followup, setFollowup] = useState<FollowupDraft>(() => recovered?.snapshot.followup || emptyFollowup());
  const [provider, setProvider] = useState<Provider>();
  const [preview, setPreview] = useState<EditPreview>(), [history, setHistory] = useState<EditPreview[]>([]);
  const [tab, setTab] = useState('adjust'), [advanced, setAdvanced] = useState<string[]>([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState(''), [dirty, setDirty] = useState(!!recovered);
  const lock = useRef(false), generatedOptions = useRef(''), previewFeedback = useRef<{ editId: string; items: AiPreviewFeedback[] }>({ editId: '', items: [] });
  const nodes = useMemo(() => editorNodes(data), [data]);
  const scope = `ai-page-edit:${pageId}`;
  const changedSincePreview = !!preview && !!generatedOptions.current && generatedOptions.current !== JSON.stringify(options);
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope, screen: 'editor', title: 'AI设计要求', dirty: open && dirty, busy: !!busy, snapshot: { ...options, ...(followup.editId && followup.instruction ? { followup } : {}) }, discard: () => { setOptions(initialOptions(pageId, selectedId)); setFollowup(emptyFollowup(preview?.editId, preview?.request?.viewport)); setDirty(false); } });
  /** 每个候选独立记录实测结果，防止把另一版页面的布局反馈带入新方案。 */
  function choosePreview(value: EditPreview, keepDraft = false) { setPreview(value); previewFeedback.current = { editId: value.editId, items: [] }; setFollowup(current => keepDraft && current.editId === value.editId ? current : emptyFollowup(value.editId, value.request?.viewport)); }
  const recordPreviewFeedback = useCallback((feedback: AiPreviewFeedback[]) => { previewFeedback.current = { editId: preview?.editId || '', items: feedback }; }, [preview?.editId]);

  async function refreshHistory() { const value = await request<{ items: EditPreview[] }>(`/api/ai/edits?pageId=${encodeURIComponent(pageId)}`); setHistory(value.items); }
  async function run(name: string, work: () => Promise<void>) {
    if (!admin || lock.current) return;
    lock.current = true; setBusy(name); setError(''); setSuccess('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，指令和原方案仍保留。'); }
    finally { lock.current = false; setBusy(''); onPauseCanvas(false); }
  }
  useEffect(() => {
    if (!open || !admin) return;
    setOptions(current => current.pageId !== pageId ? initialOptions(pageId, selectedId) : dirty || preview ? current : { ...current, targetId: selectedId, lockedIds: [] });
    void run('读取AI状态', async () => { const value = await request<Provider>('/api/ai/provider'); setProvider(value); await refreshHistory(); const editId = preview?.editId || followup.editId; if (editId) { choosePreview(await request<EditPreview>(`/api/ai/edits/${editId}`), true); if (followup.instruction) setTab('compare'); } });
    // 每次打开只读状态，不自动保存画布、生成方案或采用历史记录。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageId]);
  const settingsRead = useRef(aiSettings.changeVersion);
  useEffect(() => {
    if (settingsRead.current === aiSettings.changeVersion) return;
    settingsRead.current = aiSettings.changeVersion;
    if (!open || !admin) return;
    let live = true;
    // 配置保存只更新可用状态，不重设范围、锁定区块、指令或已生成的比较结果。
    void request<Provider>('/api/ai/provider').then(value => { if (live) setProvider(value); }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : 'AI服务状态读取失败'); });
    return () => { live = false; };
  }, [open, admin, aiSettings.changeVersion]);
  useEffect(() => {
    const resume = (event: Event) => {
      if ((event as CustomEvent).detail?.scope !== scope) return;
      const saved = readLocalRecovery<RecoveryOptions>(runtime.actor.id, scope, validOptions);
      if (saved?.snapshot.pageId === pageId) { const { followup: savedFollowup, ...current } = saved.snapshot; setOptions(current); setFollowup(savedFollowup || emptyFollowup()); setDirty(true); setTab(savedFollowup ? 'compare' : 'adjust'); if (savedFollowup) void run('恢复调整方案', async () => choosePreview(await request<EditPreview>(`/api/ai/edits/${savedFollowup.editId}`), true)); }
    };
    window.addEventListener('form-studio:recover-local', resume); return () => window.removeEventListener('form-studio:recover-local', resume);
  }, [runtime.actor.id, scope, pageId]);
  function change(patch: Partial<EditOptions>) { setOptions(current => ({ ...current, ...patch })); setDirty(true); setError(''); setSuccess(''); }
  function changeFollowup(patch: Partial<FollowupDraft>) { setFollowup(current => ({ ...current, ...patch })); setDirty(true); setError(''); setSuccess(''); }
  function dismissFollowup() { setFollowup(emptyFollowup(preview?.editId, preview?.request?.viewport)); setDirty(changedSincePreview); if (!changedSincePreview) guard.clear(); }
  function changeViewport(viewport: Viewport) { change({ viewport, ...(viewport !== 'all' ? { mode: 'design' as const, preserveText: true } : {}) }); }
  async function generate() {
    if (options.instruction.trim().length < 2) { setError('请用一句话说明想怎么调整。'); setTab('adjust'); return; }
    if (!provider?.enabled) { setError('请先在站点设置的“AI服务”中配置并启用自己的模型。'); return; }
    await run('生成调整方案', async () => {
      // 显式生成前先保存用户画布，模型仅处理服务器已核对的当前版本。
      await onSaveCanvas(); await runtime.flush();
      const envelope = runtime.getEnvelope(), result = await request<EditPreview>('/api/ai/edits', { method: 'POST', body: JSON.stringify({ ...options, instruction: options.instruction.trim(), expectedRevision: envelope.revision }) });
      generatedOptions.current = JSON.stringify(options); choosePreview(result); setTab('compare'); setDirty(false); guard.clear(); await refreshHistory(); setSuccess('设计方案已生成。先看看真实效果，再决定是否采用。');
    });
  }
  async function refine() {
    if (!preview?.request || followup.editId !== preview.editId) return;
    if (followup.instruction.trim().length < 2) { setError('请说说这版哪里还想调整。'); return; }
    if (!provider?.enabled) { setError('请先在站点设置的“AI服务”中配置并启用自己的模型。'); return; }
    await run('继续调整方案', async () => {
      await runtime.flush();
      const feedback = previewFeedback.current.editId === preview.editId ? previewFeedback.current.items : [];
      // 从当前候选继续，范围与锁定沿用原请求；不重新保存旧画布，最终采用累积设计结果。
      const result = await request<EditPreview>('/api/ai/edits', { method: 'POST', body: JSON.stringify({ ...preview.request, expectedRevision: preview.baseRevision, baseEditId: preview.editId, instruction: followup.instruction.trim(), viewport: followup.viewport, ...(followup.viewport !== 'all' ? { mode: 'design', preserveText: true } : {}), previewFeedback: feedback }) });
      choosePreview(result); generatedOptions.current = JSON.stringify(options); setDirty(false); guard.clear(); await refreshHistory(); setSuccess('已根据这版方案继续调整，页面草稿尚未采用修改。');
    });
  }
  async function applyOrUndo(kind: 'apply' | 'undo') {
    if (!preview) return;
    await run(kind === 'apply' ? '应用到草稿' : '撤销这次AI修改', async () => {
      // 只等待已有保存，不把打开弹窗时的旧画布重新提交，撤销校验由服务器保护后续修改。
      await runtime.flush(); onPauseCanvas(true);
      const current = preview;
      await runtime.mutate(envelope => request<StudioEnvelope>(`/api/ai/edits/${kind}`, { method: 'POST', body: JSON.stringify({ editId: current.editId, expectedRevision: envelope.revision }) }));
      // 外部事务返回后重新挂载画布，避免旧Puck数据再次自动覆盖新版本。
      onReloadCanvas(); choosePreview(await request<EditPreview>(`/api/ai/edits/${current.editId}`)); await refreshHistory();
      setDirty(false); guard.clear(); setSuccess(kind === 'apply' ? '已应用到草稿。仍可自由拖拽，发布前不会更新公开网站。' : '已撤销这次AI修改，其他页面和资料保留。'); message.success(kind === 'apply' ? 'AI修改已保存为草稿' : '已撤销这次AI修改');
    });
  }
  async function openHistory(item: EditPreview) {
    await run('读取调整记录', async () => { choosePreview(await request<EditPreview>(`/api/ai/edits/${item.editId}`)); generatedOptions.current = ''; setTab('compare'); setDirty(false); guard.clear(); });
  }
  async function refreshWorkspace() {
    await run('读取最新工作区', async () => {
      // 冲突后只读取一次最新草稿，重建画布；保留指令和方案，不自动重发模型或写入。
      onPauseCanvas(true); await runtime.refresh(); onReloadCanvas();
      if (preview) choosePreview(await request<EditPreview>(`/api/ai/edits/${preview.editId}`), true);
      await refreshHistory(); setSuccess('已读取最新草稿，请核对变化后继续；没有自动生成或应用。');
    });
  }
  function removeHistory(item: EditPreview) {
    modal.confirm({ title: '移除这条调整记录？', content: item.appliedRevision !== null && item.undoneRevision === null ? '已保存的页面不变，但移除后无法再从这条记录撤销。' : '移除暂存记录不会改动页面。', okText: '移除记录', cancelText: '保留', okButtonProps: { danger: true }, onOk: () => run('移除调整记录', async () => { await request(`/api/ai/edits/${item.editId}`, { method: 'DELETE' }); if (preview?.editId === item.editId) { setPreview(undefined); setTab('history'); } await refreshHistory(); }) });
  }
  const isApplied = preview?.appliedRevision !== null && preview?.appliedRevision !== undefined, isUndone = preview?.undoneRevision !== null && preview?.undoneRevision !== undefined;
  const expired = !!preview && Date.parse(preview.expiresAt) <= Date.now();
  const canRefine = !!preview && !isApplied && !expired && !!preview.request;
  const hasFollowup = !!preview && followup.editId === preview.editId && !!followup.instruction.trim();
  const selectedScope = nodes.find(node => node.id === options.targetId);
  const viewport = options.viewport || 'all';
  const choices = [{ value: '', label: `整个页面 · ${pageTitle}` }, ...nodes.map(node => ({ value: node.id, label: `${'　'.repeat(Math.min(node.ancestors.length, 3))}${nodeLabel(node)}` }))];
  const previewPane = preview ? <Space orientation="vertical" size={16} style={{ width: '100%' }}>
    <div className="ai-page-edit-result-head"><div><Text strong>{preview.summary}</Text><Paragraph type="secondary" style={{ marginBottom: 0 }}>{preview.scope?.label || pageTitle} · {preview.refinement ? `第${preview.refinement.round}轮调整 · ` : ''}{isUndone ? '已撤销' : isApplied ? '已应用，可在7天内撤销' : `待确认 · ${expiryText(preview.expiresAt)}前可用`}</Paragraph>{preview.request && <Paragraph type="secondary" style={{ margin: '8px 0 0' }}>本次要求：{preview.request.instruction}</Paragraph>}</div><Space wrap>{isApplied ? <Button icon={<UndoOutlined />} disabled={!!busy || isUndone || expired || preview.canUndo === false} onClick={() => void applyOrUndo('undo')}>撤销这次AI修改</Button> : <Button type="primary" disabled={!!busy || expired || changedSincePreview || hasFollowup} loading={busy === '应用到草稿'} onClick={() => void applyOrUndo('apply')}>确认应用到草稿</Button>}</Space></div>
    {preview.intent && <div className="ai-page-edit-understanding"><Text strong>我对你想法的理解</Text><Paragraph>{preview.intent.goal}</Paragraph><div className="ai-page-edit-intent-grid"><div><Text type="secondary">这版怎么设计</Text><ul className="ai-page-edit-notes">{preview.intent.decisions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>{preview.intent.preserve.length > 0 && <div><Text type="secondary">保持的内容</Text><ul className="ai-page-edit-notes">{preview.intent.preserve.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</div>{preview.intent.assumptions.length > 0 && <Paragraph type="secondary" className="ai-page-edit-assumptions">请核对：{preview.intent.assumptions.join('；')}</Paragraph>}</div>}
    {changedSincePreview && <Alert type="info" showIcon title="指令或范围已调整，当前预览仍是上一次方案" description="请重新生成后再应用，已有方案可从历史记录查看。" />}
    {expired && <Alert type="warning" showIcon title="这条记录已过期，请重新生成调整方案。" />}
    {isApplied && !isUndone && preview.canUndo === false && !expired && <Alert type="info" showIcon title="页面在这次AI调整后已有其他修改" description="为了保留后续人工内容，当前记录不能直接撤销。你仍可在原编辑器继续调整。" />}
    {preview.difference && <Space wrap size={[8, 8]}>{([['结构', preview.difference.structureChanged], ['布局', preview.difference.layoutChanged], ['字体', preview.difference.typographyChanged], ['颜色', preview.difference.colorsChanged], ['文字', preview.difference.copyChanged]] as const).map(([label, changed]) => <Tag key={label} color={changed ? 'blue' : undefined}>{label}{changed ? '已调整' : '保持'}</Tag>)}</Space>}
    {preview.difference && (preview.difference.similarPages.length > 0 || preview.difference.warnings.length > 0) && <Alert type="info" showIcon title="本站设计核对" description={<ul className="ai-page-edit-notes">{preview.difference.similarPages.map(item => <li key={item.pageId}>{item.title}：{item.reason}</li>)}{preview.difference.warnings.map((warning, index) => <li key={`warning-${index}`}>{warning}</li>)}</ul>} />}
    {preview.warnings.length > 0 && <Alert type="warning" showIcon title="请核对" description={<ul className="ai-page-edit-notes">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>} />}
    <Collapse size="small" items={[{ key: 'changes', label: `查看变更清单 · ${preview.changes.length}项`, children: <List size="small" dataSource={preview.changes} renderItem={(item, index) => <List.Item><Space orientation="vertical" size={0}><Text strong>{item.label || item.nodeId || `修改${index + 1}`}</Text><Text type="secondary">{item.description || item.kind || '调整所选内容'}</Text></Space></List.Item>} /> }]} />
    <AiDesignPreview beforeUrl={preview.beforeUrl} afterUrl={preview.afterUrl} editId={preview.editId} onFeedback={recordPreviewFeedback} visualTarget={{kind:"page-edit",id:preview.editId,pageId:preview.pageId}} visualDisabled={!!busy || expired || isApplied || changedSincePreview} onVisualInstruction={canRefine ? instruction => changeFollowup({editId:preview.editId,instruction}) : undefined} onVisualBusyChange={active => setBusy(current => active ? "视觉检查中" : current === "视觉检查中" ? "" : current)} />
    {canRefine && <div className="ai-page-edit-followup"><Form layout="vertical"><Form.Item label={<Text strong>还想怎么调整？</Text>} extra="在这版方案上继续设计，满意的地方可以说明保留。生成会使用你配置的AI服务。"><Input.TextArea aria-label="继续调整要求" rows={3} value={followup.editId === preview.editId ? followup.instruction : ''} maxLength={2000} showCount styles={{ root: { marginBottom: 24 } }} disabled={!!busy} placeholder="例如：保留这个布局，产品图片再突出一些；手机上卡片之间更紧凑。" onChange={event => changeFollowup({ editId: preview.editId, instruction: event.target.value })} /></Form.Item><Flex align="center" gap={12} wrap><Select aria-label="继续调整屏幕" value={followup.viewport} options={viewports} disabled={!!busy} onChange={(value: Viewport) => changeFollowup({ viewport: value })} style={{ minWidth: 140 }} /><Button type="primary" icon={<ThunderboltOutlined />} loading={busy === '继续调整方案'} disabled={!!busy || !provider?.enabled || !hasFollowup || changedSincePreview} onClick={() => void refine()}>继续调整这版</Button>{hasFollowup && <Button disabled={!!busy} onClick={dismissFollowup}>保留当前方案</Button>}</Flex>{hasFollowup && <Paragraph type="secondary" className="ai-page-edit-followup-note">你填写了新想法，请先生成调整；也可以点击“保留当前方案”放下这条要求，再采用当前设计。</Paragraph>}</Form></div>}
    {isApplied && !isUndone && <Alert type="success" showIcon title="这版设计已保存，可以继续自由修改" description="返回编辑器可以拖拽修改；要再用AI设计，可从当前草稿提出新要求。" action={<Button onClick={() => setTab('adjust')}>从当前草稿继续设计</Button>} />}
  </Space> : <Empty description="填写调整要求并生成后，即可查看修改前后效果。"><Button onClick={() => setTab('adjust')}>填写调整要求</Button></Empty>;
  return <>{guard.dialog}<Modal className="ai-page-edit-modal" title={<Space wrap><ThunderboltOutlined aria-hidden="true" /><span>AI设计助手 · {pageTitle}</span></Space>} open={open} width={1440} style={{ top: 20, maxWidth: 'calc(100vw - 24px)' }} onCancel={() => !busy && guard.ask(onClose)} closable={!busy} maskClosable={!busy} footer={<Flex justify="space-between" align="center" gap={12} wrap><Text type="secondary">先看真实效果，满意后采用；保存后仍可自由拖拽修改。</Text><Button disabled={!!busy} onClick={() => guard.ask(onClose)}>返回编辑器</Button></Flex>}>
    {!admin ? <Alert type="info" showIcon title="AI调整仅管理员可用" /> : <>
      <DesignGuidanceSummary visible={open} instruction={followup.instruction.trim() || options.instruction} stamp={preview?.designGuidance} />
      {error && <Alert className="ai-page-edit-feedback" type="error" showIcon title={error} action={<Button size="small" disabled={!!busy} onClick={() => void refreshWorkspace()}>读取最新工作区</Button>} />}{success && <Alert className="ai-page-edit-feedback" type="success" showIcon title={success} />}
      {provider && !provider.enabled && <Alert className="ai-page-edit-feedback" type="info" showIcon title="使用你自己配置的AI服务" description="在“站点设置 → AI服务”统一配置，建站、资料整理、局部修改和SEO共用。手工拖拽无需AI。" action={<Button size="small" disabled={!!busy} onClick={aiSettings.open}>AI服务设置</Button>} />}
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'adjust', label: '描述想法', children: <Form layout="vertical" className="ai-page-edit-form">
          <div className="ai-page-edit-intro"><Typography.Title level={4}>你说想法，AI帮你设计排版</Typography.Title><Paragraph type="secondary">告诉AI你做什么、客户是谁，以及希望网站给人怎样的感觉。先看看一个方向，再继续调整。</Paragraph></div>
          <div className="ai-page-edit-goals">{[
            { title: '让首页更专业', description: '突出业务、优势和采购路径', instruction: '让这个页面更适合海外采购客户，突出业务定位、产品分类和真实合作优势，设计更专业、有辨识度，方便客户找到产品并联系我们。', mobile: false },
            { title: '做好产品展示', description: '图片、参数和卡片一起设计', instruction: '优化产品展示卡片，让图片更突出、关键参数更清楚，排版有层次，方便采购客户浏览；保留产品数据自动更新。', mobile: false },
            { title: '手机上更好看', description: '改善阅读、图片和产品浏览', instruction: '优化手机上的阅读和产品浏览，标题清楚、图片比例合适、间距舒适；产品卡片更好找、更好读，保持桌面和平板效果。', mobile: true },
          ].map(example => <Button key={example.title} className="ai-page-edit-goal" disabled={!!busy} onClick={() => change({ instruction: example.instruction, viewport: example.mobile ? 'mobile' : 'all', mode: example.mobile ? 'design' : 'mixed', preserveText: example.mobile })}><span className="ai-page-edit-goal-title">{example.title}</span><span className="ai-page-edit-goal-description">{example.description}</span></Button>)}</div>
          <Flex align="center" gap={8} wrap className="ai-page-edit-scope"><Text type="secondary">正在设计</Text><Tag>{options.targetId ? selectedScope ? nodeLabel(selectedScope) : '选中的区块' : `整个页面 · ${pageTitle}`}</Tag><Button type="link" size="small" disabled={!!busy} onClick={() => setAdvanced(['options'])}>更换范围</Button></Flex>
          <Form.Item label="你想把它做成什么样？" extra="会按要求调整文字与排版，真实企业资料保持。生成前先保存画布，先预览再采用；使用你配置的AI服务。"><Input.TextArea aria-label="AI调整要求" value={options.instruction} rows={5} maxLength={2000} showCount styles={{ root: { marginBottom: 24 } }} disabled={!!busy} placeholder="例如：我们做定制家具，客户是海外工程商。首页想更有商业感，突出产品和项目经验，客户在手机上也能快速找到产品并联系我们。" onChange={event => change({ instruction: event.target.value })} /></Form.Item>
          <Form.Item label="这次主要调整"><Segmented aria-label="AI调整屏幕" block value={viewport} disabled={!!busy} options={viewports} onChange={value => changeViewport(value as Viewport)} /></Form.Item>
          {viewport !== 'all' && <Paragraph type="secondary">只调整所选屏幕的排版样式，文字和页面结构保持。</Paragraph>}
          <Collapse size="small" activeKey={advanced} onChange={keys => setAdvanced(Array.isArray(keys) ? keys : [keys])} className="ai-page-edit-locks" items={[{ key: 'options', label: '范围与保留选项（可选）', children: <><div className="ai-page-edit-options"><Form.Item label="想修改哪里"><Select aria-label="AI调整范围" showSearch optionFilterProp="label" value={options.targetId || ''} disabled={!!busy} options={choices} onChange={targetId => change({ targetId: targetId || undefined, lockedIds: [] })} /></Form.Item><Form.Item label="修改内容"><Select aria-label="AI调整方式" value={options.mode} disabled={!!busy || viewport !== 'all'} options={[{ value: 'mixed', label: '排版和内容一起优化' }, { value: 'design', label: '只设计排版' }, { value: 'copy', label: '只润色文字' }]} onChange={(mode: Mode) => change({ mode, preserveText: mode === 'design' })} /></Form.Item></div><Form.Item><Checkbox checked={options.preserveText} disabled={!!busy || options.mode !== 'mixed'} onChange={event => change({ preserveText: event.target.checked })}>保留已有文字</Checkbox></Form.Item><Form.Item label="这些区块保持原样" extra="编辑器中已经锁定的内容会自动保留。"><Select aria-label="AI额外锁定区块" mode="multiple" maxTagCount="responsive" allowClear value={options.lockedIds} disabled={!!busy} options={nodes.filter(node => !options.targetId || node.id === options.targetId || node.ancestors.includes(options.targetId)).map(node => ({ value: node.id, label: nodeLabel(node) }))} onChange={lockedIds => change({ lockedIds })} /></Form.Item><Text type="secondary">AI按本次范围读取必要的页面、产品和素材信息，缺少的企业事实会提示你补充。</Text></> }]} />
          <Flex align="center" gap={12} wrap><Button type="primary" icon={<ThunderboltOutlined />} loading={busy === '生成调整方案'} disabled={!!busy || !provider?.enabled || !options.instruction.trim()} onClick={() => void generate()}>生成调整方案</Button><Text type="secondary">生成和预览不会直接采用AI修改。</Text></Flex>
        </Form> },
        { key: 'compare', label: '看效果与继续调整', children: previewPane },
        { key: 'history', label: <Space><HistoryOutlined />调整记录</Space>, children: <><Flex justify="space-between" gap={12} wrap className="ai-page-edit-history-head"><Text type="secondary">仅显示你在此页面的记录；应用后7天内可撤销，已有人继续修改此页时会先阻止覆盖。</Text><Button size="small" icon={<ReloadOutlined />} disabled={!!busy} onClick={() => void run('刷新记录', refreshHistory)}>刷新记录</Button></Flex><List dataSource={history} locale={{ emptyText: '此页面还没有AI调整记录' }} renderItem={item => <List.Item actions={[<Button key="view" size="small" disabled={!!busy} onClick={() => guard.ask(() => void openHistory(item))}>查看对比</Button>, <Button key="delete" type="text" aria-label="移除调整记录" icon={<DeleteOutlined />} danger disabled={!!busy} onClick={() => removeHistory(item)} />]}><List.Item.Meta title={<Space wrap><Text>{item.summary}</Text><Tag>{item.undoneRevision !== null ? '已撤销' : item.appliedRevision !== null ? '已应用' : '待确认'}</Tag></Space>} description={`${item.scope?.label || pageTitle} · 有效至 ${expiryText(item.expiresAt)}`} /></List.Item>} /></> },
      ]} />
    </>}
  </Modal></>;
}
