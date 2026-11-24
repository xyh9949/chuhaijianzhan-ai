'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, ConfigProvider, Empty, Flex, Input, List, Modal, Pagination, Popconfirm, Select, Space, Tabs, Tag, Typography } from 'antd';
import { ReloadOutlined, TranslationOutlined, UndoOutlined } from '@ant-design/icons';
import type { SiteTranslationContext, SiteTranslationPreview, TranslationGlossary } from '@/lib/ai-site-translation-types';
import type { AiTranslationTerm, AiTranslationValue } from '@/lib/ai-translation-types';
import { richTextPlainText } from '@/lib/presentation-content';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { readLocalRecovery } from '@/lib/local-recovery';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import { useAiSettings } from './AiProviderSettings';
import AiDesignPreview from './AiDesignPreview';
import AiSiteTranslationGlossary from './AiSiteTranslationGlossary';

type Inputs = { sourceLocale: string; targetLocale: string; pageIds: string[]; includeChrome: boolean; useGlossary: boolean; termsText: string; proposalId?: string; glossaryDraft?: TranslationGlossary };
type History = { id: string; sourceLocale: string; targetLocale: string; pageCount: number; includeChrome: boolean; createdAt: string; appliedRevision: number | null; undoneRevision: number | null };
const empty: Inputs = { sourceLocale: '', targetLocale: '', pageIds: [], includeChrome: true, useGlossary: true, termsText: '' };
const validInputs = (value: unknown): value is Inputs => { const v = value as Inputs, glossary = v?.glossaryDraft; return !!v && typeof v.sourceLocale === 'string' && v.sourceLocale.length <= 35 && typeof v.targetLocale === 'string' && v.targetLocale.length <= 35 && Array.isArray(v.pageIds) && v.pageIds.length <= 20 && v.pageIds.every(id => typeof id === 'string' && id.length <= 160) && typeof v.includeChrome === 'boolean' && typeof v.useGlossary === 'boolean' && typeof v.termsText === 'string' && v.termsText.length <= 8000 && (!v.proposalId || /^ast-[a-f0-9-]{36}$/.test(v.proposalId)) && (!glossary || Number.isSafeInteger(glossary.revision) && glossary.revision >= 0 && Array.isArray(glossary.entries) && glossary.entries.length <= 100 && glossary.entries.every(row => !!row && ['id', 'sourceLocale', 'targetLocale', 'source', 'target'].every(key => typeof row[key as keyof typeof row] === 'string' && row[key as keyof typeof row].length <= 100))); };
const signature = ({ sourceLocale, targetLocale, pageIds, includeChrome, useGlossary, termsText }: Inputs) => JSON.stringify({ sourceLocale, targetLocale, pageIds: [...pageIds].sort(), includeChrome, useGlossary, termsText });
function parseTerms(text: string): AiTranslationTerm[] { return text.split('\n').filter(line => line.trim()).map(line => { const index = line.indexOf('='); if (index < 1 || !line.slice(index + 1).trim()) throw new Error('术语请每行填写“原术语 = 目标用词”'); return { source: line.slice(0, index).trim(), target: line.slice(index + 1).trim() }; }); }
const plain = (value: AiTranslationValue) => value === null ? '未填写' : typeof value === 'string' ? value : richTextPlainText(value);
const api = '/api/ai/site-translations';

/** 整站翻译只产生私有候选；选范围后重新冻结预览，确认采用才修改原生草稿。 */
export default function AiSiteTranslation({ initialPageId,onRequestOpen }: { initialPageId?: string;onRequestOpen?:(next:()=>void)=>void }) {
  const runtime = useStudioRuntime(), ai = useAiSettings(), { modal } = App.useApp();
  const [open, setOpen] = useState(false), [tab, setTab] = useState('prepare'), [context, setContext] = useState<SiteTranslationContext>(), [inputs, setInputs] = useState<Inputs>(empty);
  const [proposal, setProposal] = useState<SiteTranslationPreview>(), [history, setHistory] = useState<History[]>([]), [dirty, setDirty] = useState(false), [glossaryDirty, setGlossaryDirty] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [previewPage, setPreviewPage] = useState(''), [fieldPage, setFieldPage] = useState(1), [scopePages, setScopePages] = useState<string[]>([]), [scopeChrome, setScopeChrome] = useState(false);
  const lock = useRef(false), epoch = useRef(0), generated = useRef('');
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope: 'ai-site-translation', screen: 'pages', title: '网站翻译输入', dirty: open && (dirty || glossaryDirty), busy: !!busy, snapshot: inputs, discard: () => { setDirty(false); setGlossaryDirty(false); setInputs(empty); } });
  const changed = !!proposal && !!generated.current && signature(inputs) !== generated.current;
  const scopeChanged = !!proposal && (JSON.stringify([...scopePages].sort()) !== JSON.stringify([...proposal.selectedPageIds].sort()) || scopeChrome !== proposal.includesChrome);
  async function run(name: string, work: () => Promise<void>) { if (lock.current) return; lock.current = true; setBusy(name); setError(''); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，输入保持'); } finally { lock.current = false; setBusy(''); } }
  async function historyRead() { setHistory((await request<{ items: History[] }>(api)).items); }
  function display(value: SiteTranslationPreview) { setProposal(value); setScopePages(value.selectedPageIds); setScopeChrome(value.includesChrome); setPreviewPage(value.pages[0]?.sourceId || ''); setFieldPage(1); setTab('review'); }
  async function refresh() { await runtime.refresh(); const next = await request<SiteTranslationContext>(`${api}/context`); setContext(next); setNotice('已读取最新保存的资料，当前输入与已有建议保持；不会自动重新生成。'); }
  useEffect(() => {
    if (!open || runtime.actor.role !== 'admin') return;
    const sequence = ++epoch.current;
    void run('读取网站资料', async () => {
      setContext(undefined);
      const [next, records] = await Promise.all([request<SiteTranslationContext>(`${api}/context`), request<{ items: History[] }>(api)]);
      if (sequence !== epoch.current) return;
      setContext(next); setHistory(records.items); setError(''); setNotice(''); setProposal(undefined); setGlossaryDirty(false); setTab('prepare');
      const saved = readLocalRecovery<Inputs>(runtime.actor.id, 'ai-site-translation', validInputs), sourceLocale = next.pages.find(page => page.id === initialPageId)?.locale || next.defaultLocale;
      const nextInputs = saved?.snapshot || { ...empty, sourceLocale, targetLocale: next.locales.find(locale => locale.code !== sourceLocale)?.code || '', pageIds: initialPageId ? [initialPageId] : next.pages.filter(page => page.locale === sourceLocale).slice(0, 20).map(page => page.id) };
      setInputs(nextInputs); setDirty(!!saved); setGlossaryDirty(!!nextInputs.glossaryDraft); generated.current = '';
      if (nextInputs.proposalId) { const value = await request<SiteTranslationPreview>(`${api}/${nextInputs.proposalId}`); if (sequence === epoch.current) { display(value); generated.current = signature(nextInputs); } }
    });
    return () => { epoch.current++; };
    // AI设置更新不能重置翻译选项或重放收费模型调用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runtime.actor.id]);
  function change(patch: Partial<Inputs>) { setInputs(value => ({ ...value, ...patch, proposalId: undefined })); setDirty(true); }
  async function generate() {
    if (!context) return; await runtime.flush();
    const value = await request<SiteTranslationPreview>(api, { method: 'POST', body: JSON.stringify({ expectedRevision: runtime.getEnvelope().revision, sourceLocale: inputs.sourceLocale, targetLocale: inputs.targetLocale, pageIds: inputs.pageIds, includeChrome: inputs.includeChrome, useGlossary: inputs.useGlossary, glossaryRevision: context.glossary.revision, terms: parseTerms(inputs.termsText) }) });
    generated.current = signature(inputs); setInputs(current => ({ ...current, proposalId: value.id })); display(value); setDirty(true); await historyRead();
  }
  async function selectScope() {
    const value = await request<SiteTranslationPreview>(`${api}/${proposal!.id}/select`, { method: 'POST', body: JSON.stringify({ expectedRevision: runtime.getEnvelope().revision, pageIds: scopePages, includeChrome: scopeChrome }) });
    display(value); setInputs(current => ({ ...current, proposalId: value.id })); setDirty(true); setNotice('已按选定范围重新准备实际预览，没有再次调用模型。请核对后采用。'); await historyRead();
  }
  async function adopt(undo = false) {
    const id = proposal!.id;
    await runtime.mutate(async env => { const result = await request<StudioEnvelope & { translation: SiteTranslationPreview }>(`${api}/${id}/${undo ? 'undo' : 'apply'}`, { method: 'POST', body: JSON.stringify({ expectedRevision: env.revision }) }); display(result.translation); return result; });
    setDirty(false); guard.clear(); setNotice(undo ? '本次翻译已撤销，后续无关修改保留。' : '译文已保存到网站草稿，可在页面编辑器继续拖拽修改；核对后再发布。'); await historyRead();
  }
  async function saveGlossary(value: TranslationGlossary) {
    // 子表单必须收到拒绝才能保留脏状态；外层run只负责展示错误，不能吞掉保存失败。
    let failure: unknown;
    await run('保存术语', async () => { try { const saved = await request<TranslationGlossary>(`${api}/glossary`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: value.revision, entries: value.entries }) }); setContext(current => current && ({ ...current, glossary: saved })); setNotice('术语已保存，已有候选保持；下次生成才使用新用词。'); } catch (cause) { failure = cause; throw cause; } });
    if (failure) throw failure;
  }
  const pages = context?.pages.filter(page => page.locale === inputs.sourceLocale) || [], viewPage = proposal?.pages.find(page => page.sourceId === previewPage) || proposal?.pages[0], locales = context?.locales.map(locale => ({ value: locale.code, label: `${locale.label} · ${locale.code}` })) || [];
  const applied = proposal?.appliedRevision !== null && proposal?.appliedRevision !== undefined, undone = proposal?.undoneRevision !== null && proposal?.undoneRevision !== undefined;
  return <><Button icon={<TranslationOutlined />} disabled={runtime.actor.role !== 'admin'} onClick={() => onRequestOpen?onRequestOpen(()=>setOpen(true)):setOpen(true)}>AI翻译网站</Button>
    <Modal title="AI翻译网站" open={open} width={1180} zIndex={1100} styles={{ body: { maxHeight: 'calc(100dvh - 230px)', overflowY: 'auto', overflowX: 'hidden' } }} closable={!busy} mask={{ closable: !busy }} onCancel={() => guard.ask(() => setOpen(false))} footer={<Flex gap={12} justify="space-between" wrap><Button disabled={!!busy} onClick={() => guard.ask(() => setOpen(false))}>返回后台</Button><Space wrap>{tab === 'prepare' && <Button type="primary" loading={busy === '生成翻译'} disabled={!!busy || !inputs.pageIds.length || inputs.pageIds.length > 20 || !inputs.targetLocale || inputs.targetLocale === inputs.sourceLocale} onClick={() => void run('生成翻译', generate)}>生成翻译预览</Button>}{tab === 'review' && proposal && (!applied ? <Button type="primary" disabled={!!busy || changed || scopeChanged || proposal.stale || undone} loading={busy === '采用翻译'} onClick={() => modal.confirm({ zIndex: 1300, title: '采用此范围的译文到草稿？', content: '将保存所选页面、关联区块和选定的目标语言头尾。所有内容仍可在原编辑器修改，网站不会自动发布。', okText: '确认采用译文', cancelText: '继续核对', onOk: () => run('采用翻译', () => adopt()) })}>采用译文到草稿</Button> : <Button icon={<UndoOutlined />} disabled={!!busy || !proposal.canUndo} loading={busy === '撤销翻译'} onClick={() => modal.confirm({ zIndex: 1300, title: '撤销本次网站翻译？', content: '只恢复本次影响的对象。译文若被后改或新引用，系统会保留当前工作并拒绝危险撤销。', okText: '确认撤销', onOk: () => run('撤销翻译', () => adopt(true)) })}>撤销本次翻译</Button>)}</Space></Flex>}>
      <Space orientation="vertical" size={16} style={{ display: 'flex', width: '100%', minWidth: 0 }} styles={{ item: { minWidth: 0, maxWidth: '100%' } }}>
        <Flex align="center" gap={8} justify="space-between" wrap><Typography.Text type="secondary">使用你配置的AI服务，先核对完整页面，再确认采用。</Typography.Text><Button type="link" onClick={() => ai.open()}>配置AI服务</Button></Flex>
        {error && <Alert type="error" showIcon title={error} description="输入与已有建议保留，不自动重试模型。" action={<Button disabled={!!busy} onClick={() => void run('读取最新资料', refresh)}>读取最新资料</Button>}/>} {notice && <Alert type="success" showIcon title={notice}/>}
        <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'prepare', label: '选择页面' }, { key: 'review', label: '核对并采用', disabled: !proposal }, { key: 'history', label: `最近记录 ${history.length}` }, { key: 'glossary', label: '统一术语', disabled: !context }]}/>
        {tab === 'prepare' && (context ? <>
          {context.locales.length < 2 && <Alert type="info" title="请先在站点设置中启用目标语言" description="翻译会使用已有的独立语言网址，不会自行更改网站的语言设置。"/>}
          <Flex gap={16} wrap><div style={{ flex: '1 1 220px' }}><Typography.Paragraph style={{ marginBottom: 8 }}>原语言</Typography.Paragraph><Select aria-label="网站翻译原语言" style={{ width: '100%' }} value={inputs.sourceLocale || undefined} options={locales} disabled={!!busy} onChange={sourceLocale => change({ sourceLocale, pageIds: [], targetLocale: inputs.targetLocale === sourceLocale ? '' : inputs.targetLocale })}/></div><div style={{ flex: '1 1 220px' }}><Typography.Paragraph style={{ marginBottom: 8 }}>翻译成</Typography.Paragraph><Select aria-label="网站翻译目标语言" style={{ width: '100%' }} value={inputs.targetLocale || undefined} options={locales.filter(locale => locale.value !== inputs.sourceLocale)} disabled={!!busy} onChange={targetLocale => change({ targetLocale })}/></div></Flex>
          <Card size="small" title={`本次翻译的页面 · ${inputs.pageIds.length}/20`} extra={<Button type="link" disabled={!!busy} onClick={() => change({ pageIds: inputs.pageIds.length ? [] : pages.slice(0, 20).map(page => page.id) })}>{inputs.pageIds.length ? '清空选择' : '选择前20页'}</Button>} styles={{ body: { padding: 16 } }}><Checkbox.Group value={inputs.pageIds} disabled={!!busy} onChange={pageIds => change({ pageIds: pageIds as string[] })}><Space orientation="vertical" size={12}>{pages.map(page => <Checkbox key={page.id} value={page.id}>{page.title} <Typography.Text type="secondary">{page.slug}</Typography.Text></Checkbox>)}</Space></Checkbox.Group>{!pages.length && <Empty description="此语言还没有可翻译的普通页面"/>}</Card>
          <Checkbox checked={inputs.includeChrome} disabled={!!busy} onChange={event => change({ includeChrome: event.target.checked })}>同时翻译目标语言的页眉、页脚和导航</Checkbox><Checkbox checked={inputs.useGlossary} disabled={!!busy} onChange={event => change({ useGlossary: event.target.checked })}>使用已保存的统一术语</Checkbox>
          <Collapse items={[{ key: 'terms', label: '本次临时指定用词（选填）', children: <Input.TextArea aria-label="网站翻译临时术语" value={inputs.termsText} rows={4} maxLength={8000} showCount disabled={!!busy} placeholder={'每行一条，例如：\nwooden chair = Holzstuhl'} onChange={event => change({ termsText: event.target.value })}/> }, { key: 'impact', label: `原文更新提醒 · ${context.impacts.filter(item => item.sourceChanged || item.targetChanged || item.missingSource || item.missingTarget).length}`, children: <List dataSource={context.impacts.filter(item => item.sourceChanged || item.targetChanged || item.missingSource || item.missingTarget)} locale={{ emptyText: '已有译文没有检测到后续变化' }} renderItem={item => <List.Item><Typography.Text>{item.label} → {item.locale} · {item.missingSource || item.missingTarget ? '记录已删除' : [item.sourceChanged && '原文已更新', item.targetChanged && '译文另有修改'].filter(Boolean).join('、')}</Typography.Text></List.Item>}/> }]}/>
          <Alert type="info" showIcon title="页面布局与图片保持可编辑" description="同步翻译所选页面引用的区块、菜单和表单，保留图片、链接、绑定、品牌型号和数字。产品、文章等动态资料使用已有的对应语言记录；尚无译文的资料需在原管理栏目翻译。一次最多20页、24000字符和400段文字，超限请分次选择。"/>
        </> : <Empty description={busy || '暂时无法读取资料'}/>)}
        {tab === 'review' && proposal && <>
          <Flex gap={8} wrap><Tag color={undone ? 'default' : applied ? 'green' : 'blue'}>{undone ? '已撤销' : applied ? '已采用' : '待核对'}</Tag><Typography.Text>{proposal.sourceLocale} → {proposal.targetLocale} · {proposal.pages.length}页</Typography.Text></Flex>
          {changed && !applied && <Alert type="warning" title="翻译要求已变化，请重新生成后再采用"/>}{proposal.stale && !applied && <Alert type="warning" title={proposal.staleReason || '涉及的原文或译文已更新，请重新核对'}/>}
          {!applied && <Card size="small" title="采用范围" styles={{ body: { padding: 16 } }}><Space orientation="vertical" size={12} style={{ display: 'flex' }}><Checkbox.Group value={scopePages} disabled={!!busy} onChange={value => setScopePages(value as string[])}><Space wrap>{proposal.allPageIds.map(id => <Checkbox key={id} value={id}>{context?.pages.find(page => page.id === id)?.title || id}</Checkbox>)}</Space></Checkbox.Group>{proposal.availableChrome && <Checkbox checked={scopeChrome} disabled={!!busy} onChange={event => setScopeChrome(event.target.checked)}>包含目标语言头尾和导航</Checkbox>}{scopeChanged && <Alert type="info" title="范围变化后需更新实际预览" description="这一步使用已生成的译文，不再次调用模型。" action={<Button disabled={!!busy || !scopePages.length && !scopeChrome || changed} onClick={() => void run('更新范围预览', selectScope)}>更新范围预览</Button>}/>}</Space></Card>}
          {proposal.warnings.length > 0 && <Collapse items={[{ key: 'warnings', label: `采用前请核对 · ${proposal.warnings.length}条提醒`, children: <List size="small" dataSource={proposal.warnings} renderItem={warning => <List.Item>{warning}</List.Item>}/> }]}/>}
          {viewPage ? <><Select aria-label="翻译预览页面" style={{ width: '100%' }} value={viewPage.sourceId} onChange={setPreviewPage} options={proposal.pages.map(page => ({ value: page.sourceId, label: `${page.sourceTitle} → ${page.targetTitle}${page.isNew ? '（新语言页面）' : ''}` }))}/><AiDesignPreview editId={proposal.id} beforeUrl={viewPage.beforeUrl} afterUrl={viewPage.afterUrl}/></> : <Alert type="warning" title="当前范围没有可预览的目标页面，请调整范围"/>}
          <Collapse items={[{ key: 'fields', label: `逐项核对文字 · ${proposal.fields.length}项`, children: <Space orientation="vertical" size={12} style={{ display: 'flex' }}>{proposal.fields.slice((fieldPage - 1) * 12, fieldPage * 12).map(field => <Card key={field.id} size="small" title={<Typography.Text style={{ whiteSpace: 'normal' }}>{field.label}</Typography.Text>} styles={{ body: { padding: 16 } }}><Collapse size="small" items={[{ key: 'source', label: '原文', children: <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{plain(field.source)}</Typography.Paragraph> }, { key: 'before', label: '修改前', children: <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{plain(field.before)}</Typography.Paragraph> }]}/><Typography.Paragraph style={{ margin: '12px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{plain(field.after)}</Typography.Paragraph></Card>)}<Pagination current={fieldPage} pageSize={12} total={proposal.fields.length} showSizeChanger={false} onChange={setFieldPage}/></Space> }]}/>
          {proposal.undoReason && <Alert type="warning" title={proposal.undoReason}/>}
        </>}
        {tab === 'history' && <><Button icon={<ReloadOutlined />} disabled={!!busy} onClick={() => void run('读取记录', historyRead)}>刷新本人记录</Button><List dataSource={history} locale={{ emptyText: '还没有本人整站翻译记录' }} renderItem={item => <List.Item actions={[<Button key="read" disabled={!!busy} onClick={() => void run('读取翻译', async () => { const value = await request<SiteTranslationPreview>(`${api}/${item.id}`); display(value); const next = { ...inputs, sourceLocale: value.sourceLocale, targetLocale: value.targetLocale, pageIds: value.allPageIds, includeChrome: value.availableChrome, proposalId: value.id }; setInputs(next); generated.current = signature(next); setDirty(value.appliedRevision === null); })}>核对</Button>, <Popconfirm key="delete" title="删除本人记录？" description="删除记录不会撤销已采用的译文，之后无法通过此记录撤销。" onConfirm={() => run('删除记录', async () => { await request(`${api}/${item.id}`, { method: 'DELETE' }); if (proposal?.id === item.id) { setProposal(undefined); setTab('history'); } await historyRead(); })}><Button danger disabled={!!busy}>删除</Button></Popconfirm>]}><List.Item.Meta title={`${item.sourceLocale} → ${item.targetLocale} · ${item.pageCount}页${item.includeChrome ? '和头尾' : ''}`} description={`${item.undoneRevision !== null ? '已撤销' : item.appliedRevision !== null ? '已采用' : '待核对'} · ${new Date(item.createdAt).toLocaleString()}`}/></List.Item>}/></>}
        {open && context && <div key={epoch.current} hidden={tab !== 'glossary'}><AiSiteTranslationGlossary value={context.glossary} initialDraft={inputs.glossaryDraft} locales={context.locales} sourceLocale={inputs.sourceLocale} targetLocale={inputs.targetLocale} busy={!!busy} onDirty={(value, draft) => { setGlossaryDirty(value); setInputs(current => ({ ...current, glossaryDraft: draft })); }} onSave={saveGlossary}/></div>}
      </Space>
    </Modal><ConfigProvider theme={{ token: { zIndexPopupBase: 1400 } }}>{guard.dialog}</ConfigProvider></>;
}
