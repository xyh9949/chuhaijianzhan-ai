'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Collapse, Empty, Flex, Form, Input, List, Modal, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { DeleteOutlined, HistoryOutlined, ReloadOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import { readLocalRecovery } from '@/lib/local-recovery';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import type { Screen, StudioState } from '@/lib/types';
import type { AiSiteDesignPreview, AiSiteDesignRequest, AiSiteDesignTargets } from '@/lib/ai-site-design-types';
import type { AiPreviewFeedback } from '@/lib/ai-preview-inspection';
import { useAiSettings } from './AiProviderSettings';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import AiDesignPreview from './AiDesignPreview';
import AiDesignRangeTree from './AiDesignRangeTree';
import { normalizeAiRangeChoices, toggleAiRangeChoice } from '@/lib/ai-design-selection-client';
import { DesignGuidanceSummary } from './DesignGuidanceProvider';
import './ai-site-design.css';

const { Text, Paragraph } = Typography;
const recoveryScope = 'ai-site-design';
const maxSelectedUnits = 103;
type Targets = AiSiteDesignTargets;
type Options = Omit<AiSiteDesignRequest, 'expectedRevision' | 'baseDesignId' | 'previewFeedback'>;
type Followup = { designId: string; instruction: string };
type SelectionDraft = { designId: string; unitIds: string[] };
type Recovery = Options & { followup?: Followup; selectionDraft?: SelectionDraft; optionsBaseline?: string; externalDesignId?: string };
type DesignPreview = AiSiteDesignPreview & { canUndo?: boolean };
type Props = { open: boolean; onClose: () => void; onOpen?: () => void; state: StudioState; navigate: (screen: Screen) => void; originScreen: 'pages' | 'global-design'; reviewDesignId?: string; onReviewHandled?: (id: string) => void };
const initialOptions = (state: StudioState): Options => ({ instruction: '', targets: { pageIds: state.pages.map(page => page.id), header: true, footer: true, navigation: true, style: true }, preserveText: false });
const emptyFollowup = (designId = ''): Followup => ({ designId, instruction: '' });
function validRecovery(value: unknown): value is Recovery {
  if (!value || typeof value !== 'object') return false;
  const item = value as Recovery, t = item.targets;
  return typeof item.instruction === 'string' && item.instruction.length <= 2000 && typeof item.preserveText === 'boolean' && !!t && Array.isArray(t.pageIds) && t.pageIds.length <= 200 && new Set(t.pageIds).size === t.pageIds.length && t.pageIds.every(id => typeof id === 'string' && id.length <= 100) && ['header', 'footer', 'navigation', 'style'].every(key => typeof t[key as keyof Targets] === 'boolean') && (!item.followup || typeof item.followup.designId === 'string' && item.followup.designId.length <= 100 && typeof item.followup.instruction === 'string' && item.followup.instruction.length <= 2000) && (!item.selectionDraft || typeof item.selectionDraft.designId === 'string' && item.selectionDraft.designId.length <= 100 && Array.isArray(item.selectionDraft.unitIds) && item.selectionDraft.unitIds.length <= 200 && new Set(item.selectionDraft.unitIds).size === item.selectionDraft.unitIds.length && item.selectionDraft.unitIds.every(id => typeof id === 'string' && id.length <= 120)) && (item.optionsBaseline === undefined || typeof item.optionsBaseline === 'string' && item.optionsBaseline.length <= 40000) && (item.externalDesignId === undefined || typeof item.externalDesignId === 'string' && item.externalDesignId.length <= 100);
}
const expires = (value: string) => new Date(value).toLocaleString();
/** 祖先与后代互斥；区块或内部项目选满仍保留精度，只能显式勾选整页来扩大范围。 */
function normalizeSelection(preview: Pick<AiSiteDesignPreview, 'selectionUnits' | 'sectionUnits' | 'detailUnits' | 'propertyUnits' | 'assetUnits'> | undefined, ids: string[]) {
  if (!preview) return [...new Set(ids)];
  return normalizeAiRangeChoices([...preview.selectionUnits, ...(preview.sectionUnits || []), ...(preview.detailUnits || []), ...(preview.propertyUnits || []), ...(preview.assetUnits || [])], ids);
}

/** 整站任务只提交自然语言与有界目标，候选、真实影响范围和确认事务均由服务器计算。 */
export default function AiSiteDesign({ open, onClose, onOpen, state, navigate, originScreen, reviewDesignId, onReviewHandled }: Props) {
  const runtime = useStudioRuntime(), aiSettings = useAiSettings(), { message, modal } = App.useApp();
  const admin = runtime.actor.role === 'admin';
  const [recovered] = useState(() => readLocalRecovery<Recovery>(runtime.actor.id, recoveryScope, validRecovery));
  const [options, setOptions] = useState<Options>(() => recovered?.snapshot ? { instruction: recovered.snapshot.instruction, targets: recovered.snapshot.targets, preserveText: recovered.snapshot.preserveText } : initialOptions(state));
  const [followup, setFollowup] = useState<Followup>(() => recovered?.snapshot.followup || emptyFollowup());
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | undefined>(() => recovered?.snapshot.selectionDraft);
  const [provider, setProvider] = useState<{ enabled: boolean; hasApiKey: boolean }>();
  const [preview, setPreview] = useState<DesignPreview>(), [history, setHistory] = useState<DesignPreview[]>([]);
  const [selectedPageId, setSelectedPageId] = useState(''), [previewEpoch, setPreviewEpoch] = useState(0);
  const [externalDesignId, setExternalDesignId] = useState(recovered?.snapshot.externalDesignId || '');
  const [tab, setTab] = useState('describe'), [busy, setBusy] = useState(''), [dirty, setDirty] = useState(!!recovered);
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [navigationNote, setNavigationNote] = useState('');
  const optionsRef = useRef(options); optionsRef.current = options;
  const lock = useRef(false), generatedSignature = useRef(recovered?.snapshot.optionsBaseline || '');
  const reviewedLink = useRef('');
  const measurements = useRef<{ designId: string; pages: Map<string, AiPreviewFeedback[]> }>({ designId: '', pages: new Map() });
  const pageIds = useMemo(() => state.pages.map(page => page.id), [state.pages]);
  const previousPageIds = useRef(pageIds);
  const selectedAll = pageIds.length > 0 && options.targets.pageIds.length === pageIds.length && pageIds.every(id => options.targets.pageIds.includes(id));
  const changedSincePreview = !!preview && !!generatedSignature.current && generatedSignature.current !== JSON.stringify(options);
  const selectionUnits = preview?.selectionUnits || [], availableUnitIds = selectionUnits.map(unit => unit.id), sectionUnits = preview?.sectionUnits || [], detailUnits = preview?.detailUnits || [];
  const propertyUnits = preview?.propertyUnits || [], assetUnits = preview?.assetUnits || [], allRangeUnits = [...selectionUnits, ...sectionUnits, ...detailUnits, ...propertyUnits, ...assetUnits];
  const selectedUnitIds = normalizeSelection(preview, selectionDraft?.designId === preview?.designId ? selectionDraft?.unitIds || [] : availableUnitIds);
  const selectedAncestors = new Set(selectedUnitIds), rangeById = new Map(allRangeUnits.map(unit => [unit.id, unit]));
  for (const id of selectedUnitIds) { let unit = rangeById.get(id), count = 0; while (unit && 'parentId' in unit && count++ < 20) { selectedAncestors.add(unit.parentId); unit = rangeById.get(unit.parentId); } }
  const sectionHasSelection = (id: string) => selectedAncestors.has(id);
  const selectedRangeCount = selectionUnits.filter(unit => sectionHasSelection(unit.id)).length;
  const hasSelectedDetails = [...detailUnits, ...propertyUnits, ...assetUnits].some(unit => selectedUnitIds.includes(unit.id));
  const hasSelectedSections = sectionUnits.some(unit => sectionHasSelection(unit.id));
  const selectionLimitExceeded = selectedUnitIds.length > maxSelectedUnits;
  // 勾选只改变本地意图；必须取得只含所选范围的新候选，才能解锁确认保存。
  const selectionDirty = !!preview && (selectedUnitIds.length !== availableUnitIds.length || selectedUnitIds.some(id => !availableUnitIds.includes(id)));
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope: recoveryScope, screen: originScreen, title: 'AI整站设计要求', dirty: open && dirty, busy: !!busy,
    snapshot: { ...options, optionsBaseline: generatedSignature.current, ...(externalDesignId ? { externalDesignId } : {}), ...(followup.designId && followup.instruction ? { followup } : {}), ...(selectionDraft ? { selectionDraft } : {}) }, discard: () => { const value = initialOptions(runtime.getEnvelope().state); optionsRef.current = value; setOptions(value); setFollowup(emptyFollowup(preview?.designId)); setSelectionDraft(preview ? { designId: preview.designId, unitIds: preview.selectionUnits?.map(unit => unit.id) || [] } : undefined); setDirty(false); } });
  useEffect(() => {
    const old = previousPageIds.current;
    previousPageIds.current = pageIds;
    setOptions(current => {
      const wasAll = current.targets.pageIds.length === old.length && old.every(id => current.targets.pageIds.includes(id));
      const selected = wasAll && !dirty && !preview ? pageIds : current.targets.pageIds.filter(id => pageIds.includes(id));
      const all = selected.length === pageIds.length && pageIds.every(id => selected.includes(id));
      const targets = { ...current.targets, pageIds: selected, ...(!all ? { header: false, footer: false, navigation: false, style: false } : {}) };
      return JSON.stringify(targets) === JSON.stringify(current.targets) ? current : { ...current, targets };
    });
    // 页面新增/删除时只扩大未开始的默认任务；已有要求不自动扩大范围，全站权限随范围收窄。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIds]);

  function choosePreview(value: DesignPreview, keepDraft = false) {
    if (measurements.current.designId !== value.designId) measurements.current = { designId: value.designId, pages: new Map() };
    setPreview(value); setNavigationNote(''); setPreviewEpoch(current => current + 1);
    setSelectionDraft(current => keepDraft && current?.designId === value.designId ? current : { designId: value.designId, unitIds: value.selectionUnits?.map(unit => unit.id) || [] });
    setFollowup(current => keepDraft && current.designId === value.designId ? current : emptyFollowup(value.designId));
    setSelectedPageId(current => {
      // 新的局部任务优先展示真正修改的页面；已有有效目标页可继续查看。
      if (value.request.targets.pageIds.includes(current) && value.previewPages.some(page => page.pageId === current && page.available)) return current;
      return value.affectedPages.find(page => value.previewPages.some(candidate => candidate.pageId === page.pageId && candidate.available))?.pageId || value.previewPages.find(page => page.available)?.pageId || value.previewPages[0]?.pageId || '';
    });
  }
  const recordMeasurements = useCallback((reports: AiPreviewFeedback[]) => {
    const current = measurements.current;
    if (!preview || current.designId !== preview.designId || !selectedPageId) return;
    // 只保留这条候选最近查看的五页计数，不放进本地恢复；空回报撤掉该页旧测量。
    current.pages.delete(selectedPageId);
    if (reports.length) current.pages.set(selectedPageId, reports.slice(0, 3));
    while (current.pages.size > 5) current.pages.delete(current.pages.keys().next().value!);
  }, [preview?.designId, selectedPageId]);
  async function refreshHistory() { const result = await request<{ items: DesignPreview[] }>('/api/ai/site-designs'); setHistory(result.items); }
  async function run(name: string, work: () => Promise<void>) {
    if (!admin || lock.current) return;
    lock.current = true; setBusy(name); setError(''); setSuccess('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，输入和原方案仍保留。'); }
    finally { lock.current = false; setBusy(''); }
  }
  function openExternalReview() {
    if (!reviewDesignId || lock.current) return;
    const id = reviewDesignId;
    guard.ask(() => {
      reviewedLink.current = id;
      void run('读取外部AI方案', async () => {
        // 链接只指定需核对的本人候选；不发模型请求、不接受链接中的确认或自动采用字段。
        setPreview(undefined); setTab('review');
        const value = await request<DesignPreview>(`/api/ai/site-designs/${encodeURIComponent(id)}`);
        setExternalDesignId(value.designId);
        // 离开保护可能刚放弃旧输入；使用放行后的现值，不能把闭包里的旧要求当作新基线。
        choosePreview(value); generatedSignature.current = JSON.stringify(optionsRef.current); setTab('review'); setDirty(false); onReviewHandled?.(id);
        setSuccess('已打开外部AI方案。请查看真实效果，由你确认应用或撤销。');
      });
    });
  }
  useEffect(() => {
    if (!open || !admin) return;
    void run('读取整站设计', async () => {
      setProvider(await request<{ enabled: boolean; hasApiKey: boolean }>('/api/ai/provider')); await refreshHistory();
      const id = preview?.designId || selectionDraft?.designId || followup.designId;
      if (id) { const value = await request<DesignPreview>(`/api/ai/site-designs/${id}`); if (!generatedSignature.current) generatedSignature.current = JSON.stringify({ instruction: value.request.instruction, targets: value.request.targets, preserveText: value.request.preserveText }); choosePreview(value, true); if (followup.instruction || selectionDraft) setTab('review'); }
    });
    // 打开只读状态；不会保存网站、发起模型请求或自动采用候选。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open || !admin || !reviewDesignId || busy || dirty || reviewedLink.current === reviewDesignId) return;
    // 有未提交输入时保留当前编辑，通过显式按钮沿用原guard处理；失败不自动重试读取。
    openExternalReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reviewDesignId, busy, dirty, admin]);
  const settingsVersion = useRef(aiSettings.changeVersion);
  useEffect(() => {
    if (settingsVersion.current === aiSettings.changeVersion) return;
    settingsVersion.current = aiSettings.changeVersion;
    if (!open || !admin) return;
    let live = true;
    void request<{ enabled: boolean; hasApiKey: boolean }>('/api/ai/provider').then(value => { if (live) setProvider(value); }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : 'AI服务状态读取失败'); });
    return () => { live = false; };
  }, [aiSettings.changeVersion, open, admin]);
  useEffect(() => {
    const restore = (event: Event) => {
      if ((event as CustomEvent).detail?.scope !== recoveryScope) return;
      const saved = readLocalRecovery<Recovery>(runtime.actor.id, recoveryScope, validRecovery);
      if (!saved) return;
      setOptions({ instruction: saved.snapshot.instruction, targets: saved.snapshot.targets, preserveText: saved.snapshot.preserveText }); setFollowup(saved.snapshot.followup || emptyFollowup()); setSelectionDraft(saved.snapshot.selectionDraft); generatedSignature.current = saved.snapshot.optionsBaseline || ''; setExternalDesignId(saved.snapshot.externalDesignId || ''); setDirty(true); onOpen?.();
      const designId = saved.snapshot.selectionDraft?.designId || saved.snapshot.followup?.designId;
      if (designId) void run('恢复整站方案', async () => { choosePreview(await request<DesignPreview>(`/api/ai/site-designs/${designId}`), true); setTab('review'); });
    };
    window.addEventListener('form-studio:recover-local', restore); return () => window.removeEventListener('form-studio:recover-local', restore);
  }, [runtime.actor.id, onOpen]);
  function change(patch: Partial<Options>) { setOptions(current => ({ ...current, ...patch })); setDirty(true); setError(''); setSuccess(''); }
  function selectPages(ids: string[]) {
    const all = ids.length === pageIds.length && pageIds.every(id => ids.includes(id));
    // 选部分页时不允许偷偷影响未选页；全站区域/主题只能在完整站点范围中开启。
    change({ targets: { ...options.targets, pageIds: ids, ...(!all ? { header: false, footer: false, navigation: false, style: false } : {}) } });
  }
  function selectWholeSite() { change({ targets: { pageIds, header: true, footer: true, navigation: true, style: true } }); }
  function restoreFollowupText() {
    const combined = [options.instruction.trim(), `继续调整：${followup.instruction.trim()}`].filter(Boolean).join('\n\n');
    // 候选失效仍保留完整文字，不静默截断或覆盖已有要求，也不自动调用模型。
    if (combined.length > 2000) { setError('两段要求合并后超过2000字，请在下方保留文本中复制需要的部分并精简。原文仍保留。'); setTab('describe'); return; }
    change({ instruction: combined }); setFollowup(emptyFollowup()); setTab('describe');
  }
  async function generate() {
    if (options.instruction.trim().length < 2) { setError('请用一句话说明整个网站想怎么调整。'); return; }
    if (!options.targets.pageIds.length) { setError('请至少选择一个页面。'); return; }
    if (!provider?.enabled) { setError('请先在站点设置的“AI服务”中配置并启用自己的模型。'); return; }
    await run('生成整站方案', async () => {
      await runtime.flush();
      const current = runtime.getEnvelope(), result = await request<DesignPreview>('/api/ai/site-designs', { method: 'POST', body: JSON.stringify({ ...options, instruction: options.instruction.trim(), expectedRevision: current.revision }) });
      choosePreview(result); generatedSignature.current = JSON.stringify(options); setTab('review'); setDirty(false); guard.clear(); await refreshHistory(); setSuccess('整站方案已生成，网站草稿尚未采用修改。请逐页查看效果。');
    });
  }
  async function refine() {
    if (!preview || followup.designId !== preview.designId || followup.instruction.trim().length < 2) { setError('请说说这版整站设计还想怎么调整。'); return; }
    if (!provider?.enabled) { setError('请先配置并启用自己的AI服务。'); return; }
    await run('继续整站设计', async () => {
      await runtime.flush();
      const feedback: NonNullable<AiSiteDesignRequest['previewFeedback']> = [];
      if (measurements.current.designId === preview.designId) {
        const allowed = new Set(preview.request.targets.pageIds);
        for (const [pageId, reports] of [...measurements.current.pages].reverse()) {
          if (!allowed.has(pageId) || !reports.length) continue;
          const item = { pageId, reports: reports.slice(0, 3) };
          if (JSON.stringify([...feedback, item]).length <= 10000) feedback.push(item);
          if (feedback.length === 5) break;
        }
      }
      // 继续使用候选的原范围和基线，不重新保存旧页面，不把其他任务的私有候选混进本轮。
      const value = await request<DesignPreview>('/api/ai/site-designs', { method: 'POST', body: JSON.stringify({ ...preview.request, expectedRevision: preview.baseRevision, baseDesignId: preview.designId, instruction: followup.instruction.trim(), previewFeedback: feedback }) });
      choosePreview(value); setDirty(false); guard.clear(); await refreshHistory(); setSuccess('已在这版整站方案上继续调整，满意后再确认应用。');
    });
  }
  async function applyOrUndo(kind: 'apply' | 'undo') {
    if (!preview) return;
    if (kind === 'apply' && selectionDirty) { setError('采用范围已改变，请先预览选中修改，再确认保存。'); return; }
    await run(kind === 'apply' ? '应用整站方案' : '撤销整站方案', async () => {
      const designId = preview.designId; await runtime.flush();
      await runtime.mutate(current => request<StudioEnvelope>(`/api/ai/site-designs/${kind}`, { method: 'POST', body: JSON.stringify({ designId, expectedRevision: current.revision }) }));
      choosePreview(await request<DesignPreview>(`/api/ai/site-designs/${designId}`));
      // 撤销结果不抹掉描述页尚未生成的新想法；采用时按钮已要求输入与候选一致。
      if (kind === 'apply' || !dirty) { setDirty(false); guard.clear(); }
      await refreshHistory();
      setSuccess(kind === 'apply' ? '已应用到网站草稿，仍可继续拖拽编辑。公开网站需要另行发布。' : '已撤销本次整站设计，其他资料和已发布网站保持。'); message.success(kind === 'apply' ? '整站设计已保存为草稿' : '已撤销本次整站设计');
    });
  }
  function changeSelection(ids: string[]) {
    if (!preview) return;
    const normalized = normalizeSelection(preview, ids), changed = normalized.length !== availableUnitIds.length || normalized.some(id => !availableUnitIds.includes(id));
    // 保持现有采用接口上限；拒绝这次超限勾选，避免提交失败或写入无法恢复的本地选择。
    if (normalized.length > maxSelectedUnits) { setError(`最多选择${maxSelectedUnits}项修改，请减少选择。改为整块或整页采用会扩大范围，请重新核对预览。`); setSuccess(''); return; }
    const hasOtherInput = changedSincePreview || followup.designId === preview.designId && !!followup.instruction.trim();
    setSelectionDraft({ designId: preview.designId, unitIds: normalized }); setDirty(changed || hasOtherInput); if (!changed && !hasOtherInput) guard.clear(); setError(''); setSuccess('');
  }
  function changeWholeSelection(id: string, checked: boolean) {
    const children = new Set(sectionUnits.filter(unit => unit.parentId === id).map(unit => unit.id));
    const descendants = new Set(detailUnits.filter(unit => children.has(unit.parentId)).map(unit => unit.id));
    changeSelection([...selectedUnitIds.filter(value => value !== id && !children.has(value) && !descendants.has(value)), ...(checked ? [id] : [])]);
  }
  function changeSectionSelection(parentId: string, id: string, checked: boolean) {
    // 从整页取消一块时，先展开为该页真实区块，再只移除本次选择；其他页面/全站区域保持。
    const current = new Set(selectedUnitIds.filter(value => value !== parentId));
    if (selectedUnitIds.includes(parentId)) sectionUnits.filter(unit => unit.parentId === parentId).forEach(unit => current.add(unit.id));
    detailUnits.filter(unit => unit.parentId === id).forEach(unit => current.delete(unit.id));
    if (checked) current.add(id); else current.delete(id);
    changeSelection([...current]);
  }
  function changeDetailSelection(pageId: string, sectionId: string, id: string, checked: boolean) {
    // 只在操作内部项目时展开祖先；保留其他区块的原选择，所有内部项目选满也不扩大成整块。
    const current = new Set(selectedUnitIds);
    if (current.delete(pageId)) sectionUnits.filter(unit => unit.parentId === pageId).forEach(unit => current.add(unit.id));
    if (current.delete(sectionId)) detailUnits.filter(unit => unit.parentId === sectionId).forEach(unit => current.add(unit.id));
    if (checked) current.add(id); else current.delete(id);
    changeSelection([...current]);
  }
  async function previewSelection() {
    if (!preview || !selectedUnitIds.length || !selectionDirty || selectionLimitExceeded) return;
    const sourceId = preview.designId, preserveFollowup = followup.designId === sourceId && !!followup.instruction.trim();
    const wasExternal = preview.designId === externalDesignId;
    let baselineOptions = options;
    try { const saved = JSON.parse(generatedSignature.current); if (validRecovery(saved)) baselineOptions = { instruction: saved.instruction, targets: saved.targets, preserveText: saved.preserveText }; } catch { /* 旧恢复没有基线时保留当前输入，仍由服务端约束候选范围。 */ }
    const scopeEdited = JSON.stringify(options.targets) !== JSON.stringify(baselineOptions.targets), preservationEdited = options.preserveText !== baselineOptions.preserveText;
    await run('预览选中修改', async () => {
      await runtime.flush();
      const value = await request<DesignPreview>('/api/ai/site-designs/select', { method: 'POST', body: JSON.stringify({ designId: sourceId, expectedRevision: runtime.getEnvelope().revision, unitIds: selectedUnitIds }) });
      choosePreview(value);
      // 筛选本身不消耗模型；未提交的要求与追问继续留在原位置，不借筛选成功清掉输入。
      if (preserveFollowup) setFollowup({ designId: value.designId, instruction: followup.instruction });
      if (wasExternal) setExternalDesignId(value.designId);
      // 未手改的范围跟随派生候选收窄；新描述/新范围保持未提交状态，不能把它们误当已生成。
      const nextOptions = { ...options, targets: scopeEdited ? options.targets : value.request.targets, preserveText: preservationEdited ? options.preserveText : value.request.preserveText };
      const nextBaseline = { ...baselineOptions, targets: value.request.targets, preserveText: value.request.preserveText };
      setOptions(nextOptions); generatedSignature.current = JSON.stringify(nextBaseline);
      const keepOtherInput = preserveFollowup || JSON.stringify(nextOptions) !== JSON.stringify(nextBaseline);
      setDirty(keepOtherInput); if (!keepOtherInput) guard.clear();
      await refreshHistory(); setSuccess('已生成只包含所选范围的真实预览，网站草稿尚未修改。请核对后确认。'); setTab('review');
    });
  }
  function viewSelectionSource() {
    if (!preview?.selection?.sourceDesignId) return;
    const id = preview.selection.sourceDesignId, wasExternal = preview.designId === externalDesignId;
    guard.ask(() => { void run('读取来源方案', async () => {
      const value = await request<DesignPreview>(`/api/ai/site-designs/${encodeURIComponent(id)}`);
      choosePreview(value); if (wasExternal) setExternalDesignId(value.designId); generatedSignature.current = JSON.stringify(optionsRef.current); setDirty(false); setTab('review');
      setSuccess('已返回来源方案，可重新选择需要的部分；没有改动网站草稿。');
    }); });
  }
  async function refreshWorkspace() {
    await run('读取最新工作区', async () => { await runtime.refresh(); if (preview) choosePreview(await request<DesignPreview>(`/api/ai/site-designs/${preview.designId}`), true); await refreshHistory(); setSuccess('已读取最新草稿，请核对变化后继续。没有自动生成或应用。'); });
  }
  function removeRecord(item: DesignPreview) {
    modal.confirm({ title: '移除这条整站设计记录？', content: item.appliedRevision !== null && item.undoneRevision === null ? '已采用的网站保持，但移除后不能从这条记录撤销。' : '只清理私有记录，不改变网站。', okText: '移除记录', cancelText: '保留', okButtonProps: { danger: true }, onOk: () => run('移除设计记录', async () => { await request(`/api/ai/site-designs/${item.designId}`, { method: 'DELETE' }); if (preview?.designId === item.designId) { setPreview(undefined); setTab('history'); } await refreshHistory(); }) });
  }
  const navigatePreview = useCallback((url: string, side: 'before' | 'after') => {
    if (!preview) return;
    try {
      const target = new URL(url, location.href);
      const known = preview.previewPages.find(page => { const candidate = side === 'before' ? page.beforeUrl : page.afterUrl; return candidate && new URL(candidate, location.href).pathname === target.pathname; });
      if (known && target.origin === location.origin && !target.search) { setSelectedPageId(known.pageId); setNavigationNote(''); return; }
    } catch { /* 无法匹配时回到已核对的代表页面，不让标签和实测结果指向旧页。 */ }
    setNavigationNote('此处对比使用已列出的代表页面。浏览其他产品、筛选或分页，请打开完整预览。'); setPreviewEpoch(value => value + 1);
  }, [preview]);
  async function editGeneratedBlock(slot: 'header' | 'footer') {
    const blockId = runtime.getEnvelope().state.siteLayout?.[slot]?.blockId;
    if (!blockId || !admin || lock.current) return;
    guard.ask(() => {
      // 本地跳转不标成模型任务busy，否则自己的离开保护会阻止导航；flush和未提交输入保护仍保留。
      void (async () => {
        lock.current = true; setDirty(false);
        try { await runtime.flush(); sessionStorage.removeItem('form-studio:loop-card-origin'); sessionStorage.setItem('form-studio:editing-shared-block', blockId); onClose(); navigate('editor'); }
        catch (cause) { setError(cause instanceof Error ? cause.message : '未能打开拖拽编辑器，网站设计仍保留。'); }
        finally { lock.current = false; }
      })();
    });
  }

  const applied = preview?.appliedRevision !== null && preview?.appliedRevision !== undefined, undone = preview?.undoneRevision !== null && preview?.undoneRevision !== undefined;
  const expired = !!preview && Date.parse(preview.expiresAt) <= Date.now(), hasFollowup = !!preview && followup.designId === preview.designId && !!followup.instruction.trim();
  const selected = preview?.previewPages.find(page => page.pageId === selectedPageId), canRefine = !!preview && !applied && !expired;
  const externalReviewSource = !!preview && preview.designId === externalDesignId;
  const currentLayout = runtime.getEnvelope().state.siteLayout;
  const review = preview ? <Space orientation="vertical" size={18} className="ai-site-design-full">
    <Flex justify="space-between" align="flex-start" gap={16} wrap><div className="ai-site-design-result-heading"><Text strong>{preview.summary}</Text><Paragraph type="secondary">{preview.refinement ? `第${preview.refinement.round}次继续调整 · ` : ''}{undone ? '已撤销' : applied ? '已应用，可在七天内撤销' : `待确认 · ${expires(preview.expiresAt)}前可用`}</Paragraph><Paragraph type="secondary">本次要求：{preview.request.instruction}</Paragraph></div><Space wrap>{applied ? <Button icon={<UndoOutlined aria-hidden="true" />} disabled={!!busy || undone || expired || preview.canUndo === false} onClick={() => void applyOrUndo('undo')}>撤销本次整站设计</Button> : <Button type="primary" loading={busy === '应用整站方案'} disabled={!!busy || expired || changedSincePreview || hasFollowup || selectionDirty} onClick={() => void applyOrUndo('apply')}>确认应用到网站草稿</Button>}</Space></Flex>
    {preview.selection && <Alert type="info" showIcon title="当前预览只包含已选择的修改" description="未选部分保留原设计。需要重新加入其他修改时，可返回来源方案选择。" action={<Button disabled={!!busy} onClick={viewSelectionSource}>查看来源方案</Button>} />}
    {selectionDirty && <Alert type="warning" showIcon title="采用范围已改变，当前仍显示上一版预览" description="勾选不会修改网站。请先点击“预览选中修改”，核对新的真实效果后再确认保存。" />}
    {!applied && !expired && selectionUnits.length > 0 && <Collapse size="small" className="ai-site-design-selection" items={[{ key: 'selection', label: `只采用部分修改 · 已选 ${selectedRangeCount}/${selectionUnits.length} 个范围${hasSelectedDetails ? '（含区块内部调整）' : hasSelectedSections ? '（含页内区块）' : ''}`, children: <Space orientation="vertical" size={16} className="ai-site-design-full">
      <Paragraph type="secondary" style={{ margin: 0 }}>可以采用整页，也可展开挑选区块或区块内部的调整。所需动态卡片、导航与引用资源由服务器一起核对；这里不会重新调用AI。</Paragraph>
      <Checkbox checked={!selectionDirty} indeterminate={!!selectedUnitIds.length && selectionDirty} disabled={!!busy} onChange={event => changeSelection(event.target.checked ? availableUnitIds : [])}>选择全部修改</Checkbox>
      <Space role="group" aria-label="选择要采用的设计范围" orientation="vertical" size={12} className="ai-site-design-selection-units">{selectionUnits.map(unit => {
        const children = sectionUnits.filter(section => section.parentId === unit.id), whole = selectedUnitIds.includes(unit.id), childCount = whole ? children.length : children.filter(section => sectionHasSelection(section.id)).length;
        const hasInternalSelection = !whole && children.some(section => detailUnits.some(detail => detail.parentId === section.id && selectedUnitIds.includes(detail.id)));
        return <div key={unit.id} className="ai-site-design-selection-range">
          <Checkbox value={unit.id} checked={whole} indeterminate={!whole && sectionHasSelection(unit.id)} disabled={!!busy} onChange={event => changeWholeSelection(unit.id, event.target.checked)}><Space orientation="vertical" size={3}><Text strong>{unit.label}{unit.area === 'page' && <Text type="secondary"> · 整页采用</Text>}</Text><Text type="secondary">{unit.description}</Text>{!whole && sectionHasSelection(unit.id) && <Text type="secondary">{hasInternalSelection ? '已选区块内部调整' : '已选部分调整'}；未选或未变化的内容保留当前草稿。</Text>}</Space></Checkbox>
          {!!children.length && <Collapse size="small" className="ai-site-design-page-sections" items={[{ key: unit.id, label: `挑选页面内区块 · ${unit.label} · 已选 ${childCount}/${children.length}${hasInternalSelection ? '（含内部调整）' : ''}`, children: <Space role="group" aria-label={`${unit.label}内要采用的区块`} orientation="vertical" size={8} className="ai-site-design-section-choices">
            <Text type="secondary">勾选的是完整区块；选满也不会变成整页采用。未选或未变化区块保留当前草稿，先重新预览再确认。</Text>
            {children.map(section => {
              const details = detailUnits.filter(detail => detail.parentId === section.id), fullSection = whole || selectedUnitIds.includes(section.id), detailCount = fullSection ? details.length : details.filter(detail => selectedUnitIds.includes(detail.id)).length;
              return <div key={section.id} className="ai-site-design-section-range">
                <Checkbox value={section.id} checked={fullSection} indeterminate={!fullSection && detailCount > 0} disabled={!!busy} onChange={event => changeSectionSelection(unit.id, section.id, event.target.checked)}><Space orientation="vertical" size={3}><Text strong>{section.label}{details.length > 0 && <Text type="secondary"> · 整块采用</Text>}</Text><Text type="secondary">{section.description}</Text>{!fullSection && detailCount > 0 && <Text type="secondary">已选择内部调整；未变化的内容保留当前草稿。</Text>}</Space></Checkbox>
                {details.length > 0 && <Collapse size="small" className="ai-site-design-section-details" items={[{ key: section.id, label: `挑选区块内部 · ${section.label} · 已选 ${detailCount}/${details.length} 项`, children: <Space role="group" aria-label={`${section.label}内部要采用的调整`} orientation="vertical" size={8} className="ai-site-design-detail-choices">
                  <Text type="secondary">这里只采用发生变化的内容；即使全选，也不会改成整块采用。需要采用整个区块时，请勾选上方的“整块采用”。</Text>
                  {details.map(detail => <Checkbox key={detail.id} value={detail.id} checked={fullSection || selectedUnitIds.includes(detail.id)} disabled={!!busy} onChange={event => changeDetailSelection(unit.id, section.id, detail.id, event.target.checked)}><Space orientation="vertical" size={3}><Text strong>{detail.label}</Text><Text type="secondary">{detail.description}</Text></Space></Checkbox>)}
                </Space> }]} />}
                {!details.length && section.detailSelectionUnavailableReason && <Paragraph type="secondary" className="ai-site-design-detail-note">{section.detailSelectionUnavailableReason}</Paragraph>}
              </div>;
            })}
          </Space> }]} />}
          {!children.length && unit.sectionSelectionUnavailableReason && <Paragraph type="secondary" className="ai-site-design-section-note">{unit.sectionSelectionUnavailableReason}</Paragraph>}
        </div>;
      })}</Space>
      {(propertyUnits.length > 0 || assetUnits.length > 0) && <Collapse size="small" items={[{ key: 'fine-ranges', label: '细选文字、三端样式与头尾内部', children: <Space orientation="vertical" size={12} className="ai-site-design-full"><Text type="secondary">点击内部项会取消它的整体范围，仅保留明确选择的调整。文字、字体、颜色和布局按实际安全分组；资源、动态绑定及关联结构保持原子，不开放任意属性。</Text><AiDesignRangeTree units={allRangeUnits} selectableIds={[...propertyUnits, ...assetUnits].map(unit => unit.id)} selectedIds={selectedUnitIds} disabled={!!busy} onToggle={(id, checked) => changeSelection(toggleAiRangeChoice(allRangeUnits, selectedUnitIds, id, checked))} /></Space> }]} />}
      {!selectedUnitIds.length && <Text type="secondary">至少选择一项要采用的修改。</Text>}
      {selectionLimitExceeded && <Text type="warning">最多选择{maxSelectedUnits}项修改，请减少选择。改为整块或整页采用会扩大范围，请重新核对预览。</Text>}
      <Space wrap><Button loading={busy === '预览选中修改'} disabled={!!busy || !selectedUnitIds.length || !selectionDirty || selectionLimitExceeded} onClick={() => void previewSelection()}>预览选中修改</Button><Text type="secondary">先生成所选范围的预览，再确认保存。</Text></Space>
    </Space> }]} />}
    {preview.intent && <div className="ai-site-design-panel"><Text strong>我对你想法的理解</Text><Paragraph>{preview.intent.goal}</Paragraph><div className="ai-site-design-intent-grid"><div><Text type="secondary">整站怎么设计</Text><ul>{preview.intent.decisions.map((value, index) => <li key={index}>{value}</li>)}</ul></div>{preview.intent.preserve.length > 0 && <div><Text type="secondary">保持的内容</Text><ul>{preview.intent.preserve.map((value, index) => <li key={index}>{value}</li>)}</ul></div>}</div>{preview.intent.assumptions.length > 0 && <Paragraph type="secondary">请核对：{preview.intent.assumptions.join('；')}</Paragraph>}</div>}
    {changedSincePreview && <Alert type="warning" showIcon title="你修改了最初的要求或范围" description="请重新生成方案后再采用，原方案仍可查看。" />}
    <Collapse size="small" items={[{ key: 'impact', label: `本次实际影响 ${preview.affectedPages.length} 个页面`, children: <Table size="small" rowKey="pageId" pagination={false} dataSource={preview.affectedPages} columns={[{ title: '页面', key: 'page', render: (_, page) => <Space orientation="vertical" size={0}><Text strong>{page.title}</Text><Text type="secondary">{page.slug}</Text></Space> }, { title: '影响说明', key: 'reason', render: (_, page) => page.reasons.join('；') || '设计或全站区域更新' }]} /> }, { key: 'changes', label: `查看设计调整记录 · ${preview.changes.length} 项`, children: <><Paragraph type="secondary">包含连续调整过程；最终效果以当前前后预览和影响页面为准。</Paragraph><List size="small" dataSource={preview.changes} renderItem={item => <List.Item><List.Item.Meta title={item.label} description={item.description} /></List.Item>} /></> }]} />
    {!!preview.warnings.length && <Alert type="warning" showIcon title="采用前请核对" description={<ul className="ai-site-design-notes">{preview.warnings.map((value, index) => <li key={index}>{value}</li>)}</ul>} />}
    <Form layout="vertical"><Form.Item label="选择页面，查看同一版整站设计"><Select aria-label="整站设计预览页面" value={selectedPageId || undefined} onChange={id => { setSelectedPageId(id); setNavigationNote(''); }} options={preview.previewPages.map(page => ({ value: page.pageId, label: `${page.title} · ${page.slug}${page.available ? '' : '（缺少预览资料）'}` }))} /></Form.Item></Form>
    {navigationNote && <Alert type="info" showIcon title={navigationNote} />}
    {selected?.available && selected.beforeUrl && selected.afterUrl ? <AiDesignPreview key={`${preview.designId}-${selectedPageId}-${previewEpoch}`} editId={`${preview.designId}-${selectedPageId}`} beforeUrl={selected.beforeUrl} afterUrl={selected.afterUrl} onNavigate={navigatePreview} onFeedback={recordMeasurements} visualTarget={{kind:"site-design",id:preview.designId,pageId:selectedPageId}} visualDisabled={!!busy || expired || applied || changedSincePreview || selectionDirty} onVisualInstruction={canRefine ? instruction => {setFollowup({designId:preview.designId,instruction});setDirty(true);setError("");} : undefined} onVisualBusyChange={active => setBusy(current => active ? "视觉检查中" : current === "视觉检查中" ? "" : current)} /> : <Empty description={selected?.unavailableReason || '此页面暂时没有可用的真实预览样本。可以选择其他页面。'} />}
    {canRefine && <div className="ai-site-design-panel"><Form layout="vertical"><Form.Item label={<Text strong>整个网站还想怎么调整？</Text>} extra="在这版方案上继续。可以说明满意的地方保留，只改还不合适的部分；每次会使用你配置的AI服务。"><Input.TextArea aria-label="继续整站设计要求" rows={3} maxLength={2000} showCount styles={{ root: { marginBottom: 24 } }} disabled={!!busy} value={followup.designId === preview.designId ? followup.instruction : ''} placeholder="例如：保留页面布局，让导航更简洁，页脚联系方式更突出；手机上的页眉再紧凑一点。" onChange={event => { setFollowup({ designId: preview.designId, instruction: event.target.value }); setDirty(true); setError(''); }} /></Form.Item><Space wrap><Button type="primary" icon={<ThunderboltOutlined aria-hidden="true" />} loading={busy === '继续整站设计'} disabled={!!busy || !provider?.enabled || !hasFollowup || changedSincePreview || selectionDirty} onClick={() => void refine()}>继续调整整站方案</Button>{hasFollowup && <Button disabled={!!busy} onClick={() => { setFollowup(emptyFollowup(preview.designId)); setDirty(changedSincePreview || selectionDirty); if (!changedSincePreview && !selectionDirty) guard.clear(); }}>保留当前方案</Button>}</Space></Form></div>}
    {applied && !undone && <Alert type="success" showIcon title="整站设计已保存，仍可自由编辑" description="在全站设计中继续维护导航和风格，也可以打开页眉或页脚的原拖拽编辑器。尚未更新公开网站。" action={<Space wrap>{currentLayout?.header.mode === 'block' && <Button disabled={!!busy} onClick={() => void editGeneratedBlock('header')}>拖拽编辑页眉</Button>}{currentLayout?.footer.mode === 'block' && <Button disabled={!!busy} onClick={() => void editGeneratedBlock('footer')}>拖拽编辑页脚</Button>}</Space>} />}
  </Space> : <Empty description="先描述你想要的整站效果，生成后在这里逐页比较。"><Button onClick={() => setTab('describe')}>描述整站想法</Button></Empty>;

  return <>{guard.dialog}<Modal className="ai-site-design-modal" title={<Space><ThunderboltOutlined aria-hidden="true" /><span>AI整站设计</span></Space>} open={open} width={1440} style={{ top: 20, maxWidth: 'calc(100vw - 24px)' }} closable={!busy} maskClosable={!busy} onCancel={() => !busy && guard.ask(onClose)} footer={<Flex justify="space-between" align="center" gap={12} wrap><Text type="secondary">先看整站真实效果，满意后采用；所有设计仍能继续手工编辑。</Text><Button disabled={!!busy} onClick={() => guard.ask(onClose)}>返回后台</Button></Flex>}>
    {!admin ? <Alert type="info" showIcon title="整站AI设计仅管理员可用" /> : <>
      <DesignGuidanceSummary visible={open} instruction={followup.instruction.trim() || options.instruction} stamp={preview?.designGuidance} />
      {error && <Alert className="ai-site-design-feedback" type="error" showIcon title={error} action={<Button size="small" disabled={!!busy} onClick={() => void refreshWorkspace()}>读取最新工作区</Button>} />}
      {success && <Alert className="ai-site-design-feedback" type="success" showIcon title={success} />}
      {reviewDesignId && <Alert className="ai-site-design-feedback" type="info" showIcon title="有一份外部AI方案待核对" description={dirty ? '当前未提交的设计要求仍保留。查看外部方案前，可选择保留输入或继续编辑。' : '只读取你账号下的方案，查看链接不会修改草稿。'} action={<Button disabled={!!busy} onClick={openExternalReview}>查看外部AI方案</Button>} />}
      {externalReviewSource && <Alert className="ai-site-design-feedback" type="info" showIcon title="外部AI方案已就绪" description="这是外部AI提交的方案，可直接预览和采用；继续调整可回原AI客户端。仅在此使用站内AI重新生成时需要配置站内模型。" action={<Button size="small" disabled={!!busy} onClick={aiSettings.open}>配置站内AI（可选）</Button>} />}
      {provider && !provider.enabled && !externalReviewSource && <Alert className="ai-site-design-feedback" type="info" showIcon title="使用你自己配置的AI服务" description="在站点设置统一配置模型。整站设计、页面调整和内容创作共用；这里不会启用其他服务。" action={<Button size="small" disabled={!!busy} onClick={aiSettings.open}>AI服务设置</Button>} />}
      {followup.instruction && (!preview || expired) && <Alert className="ai-site-design-feedback" type="warning" showIcon title="继续调整的文字仍然保留" description={<><Paragraph>{followup.instruction}</Paragraph><Text type="secondary">原方案暂时不可用。可以把这段追问追加到要求中，核对需要保留的设计后重新生成。</Text></>} action={<Button size="small" disabled={!!busy} onClick={restoreFollowupText}>把追问追加到要求</Button>} />}
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'describe', label: '描述整站想法', children: <Form layout="vertical" className="ai-site-design-form"><Typography.Title level={4}>说说你希望整个网站呈现什么感觉</Typography.Title><Paragraph type="secondary">页眉、页脚、导航和各页面可以一起设计。先给出一个方向，再用自然语言继续改到合适。</Paragraph><div className="ai-site-design-examples">{[
          ['整站更有商业感', '让整个网站更适合海外采购，统一页眉、页脚、导航和各页面的视觉风格，保持真实企业与产品资料，做到清楚、专业、有辨识度，手机也好用。'],
          ['统一顶部和底部', '重新设计全站页眉和页脚，导航清楚、联系方式方便找到，与现有页面风格统一；不要改动已经隐藏或独立设置的页面区域。'],
          ['让网站风格更一致', '统一网站各页面的标题层级、留白和配色，保留主要内容和已有独立设计，让页面之间有一致的品牌感觉，手机阅读更舒服。'],
        ].map(([title, instruction]) => <Button key={title} disabled={!!busy} onClick={() => change({ instruction })}>{title}</Button>)}</div><Form.Item label="你想怎样调整整个网站？" extra="只需说业务目标、喜欢的感觉和需要保留的内容。生成会使用你自己的AI额度；先预览，确认后才修改草稿。"><Input.TextArea aria-label="AI整站设计要求" rows={5} maxLength={2000} showCount styles={{ root: { marginBottom: 24 } }} value={options.instruction} disabled={!!busy} placeholder="例如：我们面向海外工程商，网站想更有商业感。页眉简洁、产品入口清楚，页脚突出联系信息，所有页面风格统一，保留现有产品和企业资料。" onChange={event => change({ instruction: event.target.value })} /></Form.Item>
          <Flex gap={8} wrap className="ai-site-design-scope"><Text type="secondary">本次范围</Text><Tag>{selectedAll ? '整个网站' : `${options.targets.pageIds.length} 个指定页面`}</Tag>{options.targets.header && <Tag>页眉</Tag>}{options.targets.footer && <Tag>页脚</Tag>}{options.targets.navigation && <Tag>导航</Tag>}{options.targets.style && <Tag>全站风格</Tag>}</Flex>
          <Collapse size="small" className="ai-site-design-advanced" items={[{ key: 'scope', label: '范围与保留选项（可选）', children: <><Form.Item label="应用到哪些页面"><Select aria-label="整站设计页面范围" mode="multiple" maxTagCount="responsive" value={options.targets.pageIds} onChange={selectPages} disabled={!!busy} options={state.pages.map(page => ({ value: page.id, label: `${page.title} · ${page.slug}` }))} /></Form.Item><Button size="small" disabled={!!busy} onClick={selectWholeSite}>选择整个网站</Button><Form.Item label="一起设计" className="ai-site-design-targets"><Space wrap>{([['header', '页眉'], ['footer', '页脚'], ['navigation', '导航'], ['style', '全站风格']] as const).map(([key, label]) => <Checkbox key={key} checked={options.targets[key]} disabled={!!busy || !selectedAll} onChange={event => change({ targets: { ...options.targets, [key]: event.target.checked } })}>{label}</Checkbox>)}</Space></Form.Item>{!selectedAll && <Alert type="info" showIcon title="只调整所选页面的样式" description="全站区域和主题会影响其他页面，选择部分页面时自动保留。需要一起设计时请选择整个网站。" />}<Form.Item><Checkbox disabled={!!busy} checked={options.preserveText} onChange={event => change({ preserveText: event.target.checked })}>保留页面和头尾文案</Checkbox><Paragraph type="secondary" style={{ margin: '8px 0 0' }}>导航仍可按要求重新整理。</Paragraph></Form.Item><Text type="secondary">已锁定节点受保护。隐藏或独立设置的页眉页脚保持，实际影响范围会在方案中列明。</Text></> }]} />
          <Space wrap><Button type="primary" icon={<ThunderboltOutlined aria-hidden="true" />} loading={busy === '生成整站方案'} disabled={!!busy || !provider?.enabled || options.instruction.trim().length < 2 || !options.targets.pageIds.length} onClick={() => void generate()}>生成整站设计方案</Button><Text type="secondary">生成与预览不会直接采用或发布。</Text></Space>
        </Form> },
        { key: 'review', label: '逐页看效果与继续调整', children: review },
        { key: 'history', label: <Space><HistoryOutlined aria-hidden="true" />设计记录</Space>, children: <><Flex justify="space-between" align="center" gap={12} wrap className="ai-site-design-history-heading"><Text type="secondary">仅本人记录；已采用方案七天内可撤销，后续手工编辑和新引用受到保护。</Text><Button size="small" icon={<ReloadOutlined />} disabled={!!busy} onClick={() => void run('刷新设计记录', refreshHistory)}>刷新记录</Button></Flex><List dataSource={history} locale={{ emptyText: '还没有整站设计记录' }} renderItem={item => <List.Item actions={[<Button key="view" size="small" disabled={!!busy} onClick={() => guard.ask(() => { void run('读取设计方案', async () => { choosePreview(await request<DesignPreview>(`/api/ai/site-designs/${item.designId}`)); generatedSignature.current = JSON.stringify(optionsRef.current); setTab('review'); setDirty(false); }); })}>查看方案</Button>, <Button key="remove" type="text" icon={<DeleteOutlined />} aria-label="移除整站设计记录" danger disabled={!!busy} onClick={() => removeRecord(item)} />]}><List.Item.Meta title={<Space wrap><Text>{item.summary}</Text><Tag>{item.undoneRevision !== null ? '已撤销' : item.appliedRevision !== null ? '已应用' : '待确认'}</Tag></Space>} description={`${item.affectedPages.length} 个影响页面 · 有效至 ${expires(item.expiresAt)}`} /></List.Item>} /></> },
      ]} />
    </>}
  </Modal></>;
}
