'use client';
import { localRecoveries, requestLocalLeave } from '@/lib/local-recovery';
import { useDesignGuidance } from './DesignGuidanceProvider';
import FormManager from './FormManager';
import ThemeLibrary from './ThemeLibrary';
import AiSiteDesign from './AiSiteDesign';
import AiBuildChromeMigration from './AiBuildChromeMigration';
import AiSiteTranslation from './AiSiteTranslation';
import RedirectManager from './RedirectManager';
import MenuManager from './MenuManager';

import { useEffect, useRef, useState } from 'react';
import type { ComponentData, Data } from '@puckeditor/core';
import { App, Alert, Button, Card, Collapse, Descriptions, Drawer, Empty, Flex, Form, Grid, Input, Modal, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CodeOutlined, CopyOutlined, DeleteOutlined, EditOutlined, EyeOutlined, LayoutOutlined, LinkOutlined, PlusOutlined, SaveOutlined, SearchOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { CodeSnippet, ScreenProps, SharedBlock, SiteLayout, StudioState } from '@/lib/types';
import { request, useStudioRuntime } from '@/lib/studio-client';
import { getSharedBlockUsage, namespaceBlockData } from '@/lib/shared-blocks';
import { formatDate } from '@/lib/date-format';
import { getTemplatePreviewPath } from '@/lib/content-routes';
import { focusTemplateLibrary } from '@/lib/template-editor-client';
import './system.css';
import './global-design.css';

type CodeValue = CodeSnippet;
type LayoutSlot = SiteLayout['header'];
type DesignState = StudioState;
type CodeRecovery = { version: 1; actorId: string; scope: string; code: CodeValue; savedAt: string };
const emptyCode = (): CodeValue => ({ css: '', js: '', cssEnabled: false, jsEnabled: false });
const defaultLayout = () => ({ header: { mode: 'default', blockId: '' } as LayoutSlot, footer: { mode: 'default', blockId: '' } as LayoutSlot });
const codeOf = (state: DesignState, scope: string): CodeValue => ({ ...emptyCode(), ...(scope === 'global' ? state.customCode?.global : state.customCode?.pages[scope]) });
const recoveryKey = (actorId: string) => `form-studio:code-recovery:${actorId}`;
function readCodeRecovery(actorId: string): CodeRecovery | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(recoveryKey(actorId)) || 'null') as CodeRecovery | null;
    // 恢复区按账号隔离，并校验结构；缓存内容只放回文本框，绝不执行或自动提交。
    return saved?.version === 1 && saved.actorId === actorId && typeof saved.scope === 'string' && saved.code && typeof saved.code.css === 'string' && typeof saved.code.js === 'string' && typeof saved.code.cssEnabled === 'boolean' && typeof saved.code.jsEnabled === 'boolean' ? saved : null;
  } catch { return null; }
}

// 预设只提供可编辑基础节点和中性占位文案，不写入客户尚未提供的公司事实。
function createBlockData(name: string, kind: 'blank' | 'header' | 'footer'): Data {
  const node = (type: string, props: Record<string, unknown>): ComponentData => ({ type, props: { id: `node-${crypto.randomUUID()}`, ...props } });
  const title = node('Heading', { text: 'Your company', size: 26, mobileSize: 24, color: '#243047', align: 'left', style: 'sans', spacing: 0 });
  const links = node('Container', { content: [node('ActionButton', { text: 'Home', href: '/', kind: 'outline', align: 'left' }), node('ActionButton', { text: 'Contact', href: '/contact', kind: 'outline', align: 'left' })], layout: 'grid', columns: 2, mobileColumns: 2, gap: 12, padding: 0, inset: 0, background: '#ffffff', image: '', minHeight: 40, align: 'center' });
  const content = kind === 'blank' ? [] : [node('Container', { content: kind === 'header' ? [title, links] : [title, node('Text', { text: 'Add your contact information and company links here.', size: 14, color: '#657084', align: 'left', maxWidth: 560 })], layout: kind === 'header' ? 'grid' : 'column', columns: 2, mobileColumns: 1, gap: 20, padding: 28, inset: 32, background: '#ffffff', image: '', minHeight: 90, align: 'center', design: { desktop: { borderWidth: kind === 'footer' ? 1 : 0, borderColor: '#e5e9ef' }, mobile: { paddingLeft: 20, paddingRight: 20 } } })];
  const root = { props: { title: name, showChrome: 'no' } };
  return { root, content };
}

/** 全站资产保留同一份草稿；发布时另行显式选择范围，不在这里修改公开版本。 */
export default function GlobalDesignScreen({ state: rawState, update, navigate }: ScreenProps) {
  const state = rawState as DesignState;
  const runtime = useStudioRuntime(), designGuidance = useDesignGuidance();
  const { message, modal } = App.useApp();
  const compactBlocks = Grid.useBreakpoint().md === false;
  const canEdit = runtime.actor.role !== 'viewer';
  const canCode = runtime.actor.role === 'admin';
  const [aiOpen, setAiOpen] = useState(() => localRecoveries(runtime.actor.id).some(item => item.scope === 'ai-site-design' && item.screen === 'global-design'));
  const [externalReview, setExternalReview] = useState(''), [externalReviewError, setExternalReviewError] = useState(false);
  const lastExternalLink = useRef('');
  const blocks = state.sharedBlocks || [];
  const layout = state.siteLayout || defaultLayout();
  const [initialRecovery] = useState(() => readCodeRecovery(runtime.actor.id));
  const [recovery, setRecovery] = useState(initialRecovery);
  const recoverable = !!initialRecovery && (initialRecovery.scope === 'global' || state.pages.some(page => page.id === initialRecovery.scope));
  const orphanRecovery = !!recovery && recovery.scope !== 'global' && !state.pages.some(page => page.id === recovery.scope);
  const [tab, setTab] = useState(localRecoveries(runtime.actor.id).some(r=>r.scope.startsWith('form-definition:'))?'forms':initialRecovery?'code':'layout');
  useEffect(()=>{const resume=(e:Event)=>{if((e as CustomEvent<{scope?:string}>).detail?.scope?.startsWith('form-definition:'))setTab('forms');};window.addEventListener('form-studio:recover-local',resume);return()=>window.removeEventListener('form-studio:recover-local',resume);},[]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [blockDialog, setBlockDialog] = useState<{ id?: string; kind: 'blank' | 'header' | 'footer' } | null>(null);
  const [name, setName] = useState('');
  const [usageId, setUsageId] = useState<string | null>(null);
  const [scope, setScope] = useState(recoverable ? initialRecovery!.scope : 'global');
  const [code, setCode] = useState<CodeValue>(() => recoverable ? initialRecovery!.code : codeOf(state, 'global'));
  const [dirty, setDirty] = useState(recoverable);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState('');
  const [codeCheck, setCodeCheck] = useState<{ errors: string[]; warnings: string[] } | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const pendingLeave = useRef<(() => void) | null>(null);
  const dirtyRef = useRef(recoverable);
  const codeBusyRef = useRef(false);
  const codeRef = useRef(code);
  const scopeRef = useRef(scope);
  const baseline = useRef(JSON.stringify(codeOf(state, scope)));
  const usage = (blockId: string) => getSharedBlockUsage(blockId, { pages: state.pages, editorData: state.editorData, sharedBlocks: blocks, siteLayout: layout });
  const activeUsage = usageId ? usage(usageId) : null;
  const activeBlock = blocks.find(item => item.id === usageId);

  function clearRecovery(target: string) {
    try { if (readCodeRecovery(runtime.actor.id)?.scope === target) sessionStorage.removeItem(recoveryKey(runtime.actor.id)); } catch { /* 存储被禁用不影响正常保存。 */ }
    setRecovery(previous => previous?.scope === target ? null : previous);
  }
  function exportRecovery() {
    if (!recovery) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(recovery, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'form-studio-recovered-code.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  useEffect(() => {
    // 401 事件会卸载工作区，必须在同一次事件分发中同步保留输入，供同账号重新登录恢复。
    const retainCode = () => {
      if (!dirtyRef.current) return;
      try { sessionStorage.setItem(recoveryKey(runtime.actor.id), JSON.stringify({ version: 1, actorId: runtime.actor.id, scope: scopeRef.current, code: codeRef.current, savedAt: new Date().toISOString() } satisfies CodeRecovery)); }
      catch { /* 浏览器禁止存储或容量不足时无法跨登录保留；正常编辑不因此中断。 */ }
    };
    window.addEventListener('form-studio:session-expired', retainCode, true);
    return () => window.removeEventListener('form-studio:session-expired', retainCode, true);
  }, [runtime.actor.id]);

  function replaceCode(next: CodeValue) {
    codeRef.current = next;
    setCode(next);
    dirtyRef.current = JSON.stringify(next) !== baseline.current;
    setDirty(dirtyRef.current);
    if (!dirtyRef.current) clearRecovery(scopeRef.current);
    setCodeError(''); setCodeCheck(null);
  }
  function loadScope(next: string) {
    const value = codeOf(runtime.getEnvelope().state as DesignState, next);
    scopeRef.current = next; setScope(next); baseline.current = JSON.stringify(value);
    dirtyRef.current = false; setDirty(false); codeRef.current = value; setCode(value); setCodeError(''); setCodeCheck(null);
  }
  function requestLeave(proceed: () => void) {
    if (codeBusyRef.current) { message.info('正在处理代码，请稍后再切换'); return; }
    if (!dirtyRef.current) { proceed(); return; }
    pendingLeave.current = proceed; setLeaveOpen(true);
  }
  function clearExternalReview(id?: string) {
    const url = new URL(location.href);
    if (id && url.searchParams.get('externalDesign') !== id) return;
    setExternalReview(''); setExternalReviewError(false); lastExternalLink.current = '';
    url.searchParams.delete('externalDesign'); history.replaceState(history.state, '', url.href);
  }
  useEffect(() => {
    const readLink = () => {
      const raw = new URL(location.href).searchParams.get('externalDesign');
      if (!raw || raw === lastExternalLink.current) return;
      lastExternalLink.current = raw;
      if (!/^aisd-[a-f0-9-]{36}$/.test(raw)) { setExternalReview(''); setExternalReviewError(true); return; }
      setExternalReview(raw); setExternalReviewError(false);
      // 登录后的审核链接先经过现有代码离开保护；它只打开预览，不带采用权限。
      if (canCode) requestLeave(() => setAiOpen(true));
    };
    readLink(); window.addEventListener('popstate', readLink); window.addEventListener('hashchange', readLink);
    return () => { window.removeEventListener('popstate', readLink); window.removeEventListener('hashchange', readLink); };
    // dirty/busy以ref读取，不因表单输入反复重新打开审核弹窗。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCode]);
  useEffect(() => {
    // 导航、浏览器前进后退与代码范围切换共用保护；保存失败不解除脏状态。
    const guard = (event: Event) => {
      const next = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed;
      if (!next || (!dirtyRef.current && !codeBusyRef.current)) return;
      event.preventDefault();
      if (codeBusyRef.current) { message.info('正在处理代码，请等待完成'); return; }
      pendingLeave.current = next; setLeaveOpen(true);
    };
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('form-studio:before-navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('form-studio:before-navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [message]);
  useEffect(() => {
    // 没有本地输入时跟随服务器恢复/重载；编辑中的文本不被异步回包覆盖。
    if (dirtyRef.current || codeBusyRef.current) return;
    const value = codeOf(state, scopeRef.current);
    baseline.current = JSON.stringify(value); codeRef.current = value; setCode(value);
  }, [state.customCode]);

  async function editBlock(id: string) {
    requestLeave(() => { sessionStorage.setItem('form-studio:editing-shared-block', id); navigate('editor'); });
  }
  async function saveBlock() {
    if (!blockDialog || !name.trim()) return;
    setBusy(true);
    try {
      const current = (runtime.getEnvelope().state as DesignState).sharedBlocks || [];
      const id = blockDialog.id || `block-${crypto.randomUUID()}`;
      const next = blockDialog.id ? current.map(item => item.id === id ? { ...item, name: name.trim(), updated: new Date().toISOString() } : item) : [...current, { id, name: name.trim(), data: createBlockData(name.trim(), blockDialog.kind), updated: new Date().toISOString() }];
      await update({ sharedBlocks: next });
      setBlockDialog(null); message.success(blockDialog.id ? '区块名称已保存' : '同步区块已创建');
    } catch (error) { message.error((error as Error).message); }
    finally { setBusy(false); }
  }
  async function duplicateBlock(block: SharedBlock) {
    setBusy(true);
    try {
      const id = `block-${crypto.randomUUID()}`;
      // 复制重建内部节点 ID；SharedBlock 引用仍指向其原资产，避免隐式复制整张依赖图。
      const copy = { ...block, id, name: `${block.name} · 副本`, data: namespaceBlockData(block.data, id), updated: new Date().toISOString() };
      const current = (runtime.getEnvelope().state as DesignState).sharedBlocks || [];
      await update({ sharedBlocks: [...current, copy] }); message.success('已创建独立副本');
    } catch (error) { message.error((error as Error).message); }
    finally { setBusy(false); }
  }
  function deleteBlock(block: SharedBlock) {
    const used = usage(block.id);
    if (used.pageIds.length || used.blockIds.length || used.layoutSlots.length) { setUsageId(block.id); return; }
    modal.confirm({ title: `删除「${block.name}」？`, content: '此区块当前未被使用，删除只作用于工作区草稿。', okText: '删除区块', okButtonProps: { danger: true }, cancelText: '取消', onOk: async () => {
      try { const current = (runtime.getEnvelope().state as DesignState).sharedBlocks || []; await update({ sharedBlocks: current.filter(item => item.id !== block.id) }); message.success('区块已删除'); }
      catch (error) { message.error((error as Error).message); throw error; }
    } });
  }
  // 语言关联只修改最新修订中的一个映射，保留另一窗口对其它语言和基础头尾的修改。
  async function saveLocaleBlock(slot: 'header' | 'footer', locale: string, id?: string) {
    setBusy(true);
    try { await runtime.mutate(async envelope => { const current=envelope.state.siteLayout||defaultLayout(), variants={...current[slot].localeBlockIds}; if(id)variants[locale]=id;else delete variants[locale]; return request('/api/studio',{method:'PATCH',body:JSON.stringify({expectedRevision:envelope.revision,patch:{siteLayout:{...current,[slot]:{...current[slot],localeBlockIds:variants}}}})}); }); message.success('语言内容关联已保存到草稿'); }
    catch(error){message.error((error as Error).message);}finally{setBusy(false);}
  }
  async function saveLayout(slot: 'header' | 'footer', next: LayoutSlot) {
    setBusy(true);
    try {
      const current = (runtime.getEnvelope().state as DesignState).siteLayout || defaultLayout();
      await update({ siteLayout: { ...current, [slot]: { ...current[slot], ...next } } }); message.success(`${slot === 'header' ? '页眉' : '页脚'}设置已保存到草稿`);
    } catch (error) { message.error((error as Error).message); }
    finally { setBusy(false); }
  }
  async function checkCode() {
    setCodeBusy(true); codeBusyRef.current = true;
    try { const result = await request<{ errors: string[]; warnings: string[] }>('/api/studio/code-check', { method: 'POST', body: JSON.stringify(codeRef.current) }); setCodeCheck(result); setCodeError(''); }
    catch (error) { setCodeError((error as Error).message); }
    finally { setCodeBusy(false); codeBusyRef.current = false; }
  }
  async function saveCode(): Promise<boolean> {
    if (!canCode || codeBusyRef.current || orphanRecovery) return false;
    setCodeBusy(true); codeBusyRef.current = true; setCodeError('');
    try {
      const value = { ...codeRef.current }, target = scopeRef.current;
      // 先做只读校验，错误不会进入全局自动保存队列；服务端 PATCH 仍再次验证。
      const result = await request<{ errors: string[]; warnings: string[] }>('/api/studio/code-check', { method: 'POST', body: JSON.stringify(value) });
      setCodeCheck(result);
      if (result.errors.length) { setCodeError('请先修正已启用代码中的错误，或关闭对应开关后保存为草稿。'); return false; }
      const current = (runtime.getEnvelope().state as DesignState).customCode || { global: emptyCode(), pages: {} };
      const customCode = target === 'global' ? { ...current, global: value } : { ...current, pages: { ...current.pages, [target]: value } };
      await update({ customCode }); await runtime.flush();
      baseline.current = JSON.stringify(value); dirtyRef.current = false; setDirty(false); clearRecovery(target); message.success('代码已保存到草稿'); return true;
    } catch (error) { setCodeError((error as Error).message); return false; }
    finally { setCodeBusy(false); codeBusyRef.current = false; }
  }
  async function preview() {
    // 先同步再打开，避免用户误把上一次已保存内容当成当前编辑效果。
    if (dirtyRef.current && !(await saveCode())) return;
    try {
      await runtime.flush();
      const current = runtime.getEnvelope().state;
      const page = current.pages.find(item => item.id === (scopeRef.current === 'global' ? current.activePageId : scopeRef.current)) || current.pages.find(item => item.slug === '/');
      if (!page) { message.info('请先创建一个页面后预览'); return; }
      const slug = getTemplatePreviewPath(current, page);
      if (!slug) { message.info('此详情模板还没有可预览的内容，请先添加记录。'); return; }
      window.open(`/preview${slug === '/' ? '' : slug}`, '_blank', 'noopener,noreferrer');
    } catch (error) { message.error((error as Error).message); }
  }
  function finishLeave(discard: boolean) {
    if (discard) { dirtyRef.current = false; setDirty(false); clearRecovery(scopeRef.current); }
    setLeaveOpen(false); const next = pendingLeave.current; pendingLeave.current = null; next?.();
  }

  function blockUsage(item: SharedBlock) {
    const used = usage(item.id);
    return <Button type="link" className="global-usage-link" onClick={() => setUsageId(item.id)}>{used.pageIds.length} 个页面{used.layoutSlots.length ? ' · 全站布局' : ''}{used.blockIds.length ? ` · ${used.blockIds.length} 个区块` : ''}</Button>;
  }
  function blockActions(item: SharedBlock) {
    return canEdit && <Space size={4} wrap={compactBlocks}><Button size="small" onClick={() => editBlock(item.id)}>编辑</Button><Tooltip title="重命名"><Button aria-label={`重命名 ${item.name}`} type="text" icon={<EditOutlined />} onClick={() => { setName(item.name); setBlockDialog({ id: item.id, kind: 'blank' }); }} /></Tooltip><Tooltip title="创建独立副本"><Button aria-label={`复制 ${item.name}`} type="text" icon={<CopyOutlined />} disabled={busy} onClick={() => duplicateBlock(item)} /></Tooltip><Tooltip title="删除（正在引用的区块需先解除引用）"><Button aria-label={`删除 ${item.name}`} danger type="text" icon={<DeleteOutlined />} onClick={() => deleteBlock(item)} /></Tooltip></Space>;
  }

  const blockTab = <>
    <Flex className="global-toolbar" justify="space-between" gap={16} wrap><Input allowClear prefix={<SearchOutlined />} placeholder="搜索同步区块" aria-label="搜索同步区块" value={search} onChange={event => setSearch(event.target.value)} style={{ maxWidth: 320 }} /><Space wrap><Typography.Text type="secondary">{blocks.length} 个区块</Typography.Text>{canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={() => { setName('新的同步区块'); setBlockDialog({ kind: 'blank' }); }}>新建区块</Button>}</Space></Flex>
    <Alert type="info" showIcon title="编辑一处，在引用它的页面同步生效" description="把区块拖入页面即可引用。页眉页脚也可以使用同一份区块；修改保存为草稿，检查并发布后才会更新公开网站。" />
    {/* 与页面列表使用同一窄屏断点；合并列而不替换 Table，翻页和选中的记录不因切宽度而丢失。 */}
    <Card className="global-table-card" styles={{ body: { padding: 'var(--admin-panel-space,24px)' } }}><Table<SharedBlock> className="global-block-table mobile-record-table" rowKey="id" pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={compactBlocks ? undefined : { x: 690 }} tableLayout={compactBlocks ? 'fixed' : undefined} locale={{ emptyText: <Empty description="创建一份公共内容，可在多个页面重复使用" /> }} dataSource={blocks.filter(item => item.name.toLowerCase().includes(search.toLowerCase()))} columns={[
      { title: '区块', dataIndex: 'name', render: (value, item) => <Flex align={compactBlocks ? 'start' : 'center'} gap={8}><span className="global-asset-icon"><LinkOutlined /></span><Flex className="global-block-fields" vertical gap={4}><Typography.Text strong>{value}</Typography.Text><div className="global-cell-meta">{item.data.content.length} 个顶层组件</div>{compactBlocks && <><div>{blockUsage(item)}</div><Typography.Text type="secondary" className="global-cell-meta">{formatDate(item.updated, state.settings.timezone)}</Typography.Text><div>{blockActions(item)}</div></>}</Flex></Flex> },
      { title: '使用范围', key: 'usage', responsive: ['md'], render: (_, item) => blockUsage(item) },
      { title: '更新于', dataIndex: 'updated', responsive: ['md'], render: value => <Typography.Text type="secondary">{formatDate(value, state.settings.timezone)}</Typography.Text> },
      { title: '操作', key: 'actions', responsive: ['md'], render: (_, item) => blockActions(item) },
    ]} /></Card>
  </>;
  const layoutTab = <><Alert type="info" showIcon title="统一管理网站的页眉与页脚" description="页面默认继承这里的设置。页面编辑器中仍可以单独隐藏页眉或页脚；已有的默认布局继续保留。" action={canCode && <AiBuildChromeMigration state={state} onRequestOpen={requestLeave} />} /><div className="global-layout-grid">{(['header', 'footer'] as const).map(slot => <Card key={slot} title={<Space><LayoutOutlined />{slot === 'header' ? '全站页眉' : '全站页脚'}</Space>} extra={<Tag>{layout[slot].mode === 'default' ? '默认布局' : layout[slot].mode === 'hidden' ? '不显示' : '同步区块'}</Tag>} styles={{ header: { paddingInline: 'var(--admin-panel-space,24px)' }, body: { padding: 'var(--admin-panel-space,24px)' } }}>
    <div className={`global-layout-diagram is-${slot}`} aria-hidden><span /><span /><span /></div><Form layout="vertical"><Form.Item label="显示方式"><Select aria-label={`${slot === 'header' ? '页眉' : '页脚'}显示方式`} value={layout[slot].mode} disabled={!canEdit || busy} options={[{ value: 'default', label: '使用原有默认布局' }, { value: 'block', label: '使用已设计的公共内容', disabled: !blocks.length }, { value: 'hidden', label: '隐藏' }]} onChange={mode => saveLayout(slot, { mode, blockId: mode === 'block' ? (layout[slot].blockId || blocks[0]?.id || '') : '' })} /></Form.Item>{layout[slot].mode === 'block' && <Form.Item label="使用哪份内容"><Select aria-label={`${slot === 'header' ? '页眉' : '页脚'}关联区块`} showSearch optionFilterProp="label" value={layout[slot].blockId || undefined} disabled={!canEdit || busy} options={blocks.map(item => ({ value: item.id, label: item.name }))} onChange={blockId => saveLayout(slot, { mode: 'block', blockId })} /></Form.Item>}
    {(state.settings.locales?.length||0)>1&&<Collapse size="small" style={{marginBottom:16}} items={[{key:'languages',label:'不同语言的公共内容（选填）',children:<Space orientation="vertical" size={12} style={{width:'100%'}}><Typography.Text type="secondary">为每种语言选择可继续拖拽编辑的公共内容。默认语言备用版供切换默认语言时保留原版。</Typography.Text>{state.settings.locales!.filter(item=>item.code!==state.settings.language||layout[slot].localeBlockIds?.[item.code]).map(item=><Form.Item key={item.code} label={`${item.label}（${item.code}${item.code===state.settings.language?'，备用':''}）`} style={{marginBottom:0}}><Flex gap={8} wrap><Select aria-label={`${slot==='header'?'页眉':'页脚'}${item.code}语言内容`} showSearch optionFilterProp="label" allowClear={item.code!==state.settings.language||Object.keys(layout[slot].localeBlockIds||{}).length<=1} placeholder="沿用基础布局" value={layout[slot].localeBlockIds?.[item.code]} disabled={!canEdit||busy} options={blocks.map(block=>({value:block.id,label:block.name}))} style={{flex:'1 1 200px',minWidth:0}} onChange={id=>void saveLocaleBlock(slot,item.code,id)}/>{layout[slot].localeBlockIds?.[item.code]&&<Button disabled={!canEdit||busy} onClick={()=>editBlock(layout[slot].localeBlockIds![item.code])}>编辑内容</Button>}</Flex></Form.Item>)}</Space>}]} />}</Form>
    {canEdit && <Space wrap>{layout[slot].mode === 'block' && layout[slot].blockId && <Button icon={<EditOutlined />} onClick={() => editBlock(layout[slot].blockId)}>编辑所选区块</Button>}<Button icon={<PlusOutlined />} onClick={() => { setName(slot === 'header' ? '网站页眉' : '网站页脚'); setBlockDialog({ kind: slot }); }}>创建{slot === 'header' ? '页眉' : '页脚'}区块</Button></Space>}
  </Card>)}</div></>;
  const codeTab = <>
    {recovery && <Alert style={{ marginBottom: 16 }} type="warning" showIcon title={orphanRecovery ? '原页面已删除，无法恢复代码到原范围' : '已恢复会话过期前的代码输入，尚未保存'} description={orphanRecovery ? '原代码保留在当前标签页，不会写入全站范围。请先导出备份或明确放弃这份代码，再开始编辑。' : '请检查恢复的内容后点击“保存代码”。恢复仅供当前账号使用，不会自动修改服务器草稿。'} action={<Space wrap><Button size="small" disabled={false} onClick={exportRecovery}>导出保留代码</Button><Button size="small" danger disabled={codeBusy} onClick={() => { const target = recovery.scope; if (!orphanRecovery && scopeRef.current === target) loadScope(target); clearRecovery(target); }}>放弃恢复内容</Button></Space>} />}
    <Alert type="info" showIcon title={canCode ? '自定义样式与交互' : '仅管理员可以编辑自定义代码'} description="CSS 与标准浏览器 JavaScript 在完整预览和发布网站中加载；后台界面与拖拽画布不执行这些脚本。已发布代码由站点管理员维护。" />
    <Card className="global-code-card" styles={{ body: { padding: 'var(--admin-panel-space,24px)' } }}><Flex align="center" justify="space-between" gap={16} wrap><Space wrap><Typography.Text strong>应用范围</Typography.Text><Select aria-label="自定义代码应用范围" className="global-code-scope" value={scope} onChange={next => requestLeave(() => loadScope(next))} options={[{ value: 'global', label: '整个网站' }, ...state.pages.map(page => ({ value: page.id, label: `${page.title} · ${page.slug}` }))]} /><Tag color={dirty ? 'gold' : 'default'}>{dirty ? '未保存' : '已保存草稿'}</Tag></Space><Space wrap><Button icon={<EyeOutlined />} onClick={preview} disabled={codeBusy}>完整预览</Button>{canCode && <><Button onClick={checkCode} loading={codeBusy}>检查代码</Button><Button type="primary" icon={<SaveOutlined />} onClick={saveCode} loading={codeBusy} disabled={!dirty || orphanRecovery}>保存代码</Button></>}</Space></Flex><Typography.Paragraph className="global-code-note" type="secondary">{scope === 'global' ? '应用于所有页面。页面级代码会在全站代码之后加载。' : '只应用于当前页面，并保留全站代码。CSS 按正常浏览器规则叠加。'} 仅填写代码正文，不需要 &lt;style&gt; 或 &lt;script&gt; 标签。可用 .editor-site 定位网站外层、.editor-site-heading 定位标题。</Typography.Paragraph>
      {codeError && <Alert type="error" showIcon title="代码尚未保存" description={codeError} style={{ marginBottom: 16 }} />}{codeCheck && <Alert type={codeCheck.errors.length ? 'error' : 'success'} showIcon title={codeCheck.errors.length ? '检查发现错误' : '基础检查通过'} description={<>{codeCheck.errors.map((item, i) => <p key={`e-${i}`}>{item}</p>)}{codeCheck.warnings.map((item, i) => <p key={`w-${i}`}>{item}</p>)}{!codeCheck.errors.length && <span>已检查源码长度与 JavaScript 语法；CSS 效果和实际交互请在完整预览中验证。</span>}</>} style={{ marginBottom: 16 }} />}
      <div className="global-code-grid">{(['css', 'js'] as const).map(kind => <div className="global-code-panel" key={kind}><Flex justify="space-between" align="center"><Typography.Text strong>{kind === 'css' ? 'CSS 样式' : 'JavaScript 交互'}</Typography.Text><Space><Typography.Text type="secondary">启用</Typography.Text><Switch aria-label={`启用 ${kind === 'css' ? 'CSS' : 'JavaScript'}`} checked={code[`${kind}Enabled`]} disabled={!canCode || codeBusy || orphanRecovery} onChange={value => replaceCode({ ...codeRef.current, [`${kind}Enabled`]: value })} /></Space></Flex><Input.TextArea aria-label={kind === 'css' ? 'CSS 代码' : 'JavaScript 代码'} value={code[kind]} onChange={event => replaceCode({ ...codeRef.current, [kind]: event.target.value })} readOnly={!canCode || codeBusy || orphanRecovery} spellCheck={false} autoSize={{ minRows: 16, maxRows: 32 }} placeholder={kind === 'css' ? '.editor-site-heading {\n  letter-spacing: -0.02em;\n}' : "document.querySelectorAll('[data-toggle]').forEach((element) => {\n  element.addEventListener('click', () => {\n    element.classList.toggle('is-open');\n  });\n});"} /><Typography.Text type="secondary">{code[kind].length.toLocaleString()} 字符 · {code[`${kind}Enabled`] ? '将随所选范围发布' : '已停用，保留代码草稿'}</Typography.Text></div>)}</div>
    </Card>
  </>;
  return <section className="sys-screen global-design-screen"><Flex className="sys-heading" justify="space-between" align="flex-end" gap={16} wrap><div><Typography.Text className="sys-eyebrow">设计系统</Typography.Text><Typography.Title level={2}>全站设计</Typography.Title><Typography.Paragraph>统一调整网站顶部、底部、导航菜单和重复出现的内容。</Typography.Paragraph></div><Space wrap>{canCode && <AiSiteTranslation onRequestOpen={requestLeave}/>}{canCode && <><Button type="primary" icon={<ThunderboltOutlined aria-hidden="true" />} onClick={() => requestLeave(() => setAiOpen(true))}>AI设计整个网站</Button><Button onClick={() => requestLeave(() => requestLocalLeave(() => designGuidance.open(), 'design-guidance'))}>AI设计约定</Button></>}<Button icon={<LayoutOutlined />} onClick={() => requestLeave(() => { focusTemplateLibrary(); navigate('templates'); })}>产品与案例详情布局</Button><Tag icon={<LinkOutlined />} color="blue">保存后需发布</Tag></Space></Flex><Tabs activeKey={tab} onChange={next => requestLeave(() => setTab(next))} items={[{ key: 'layout', label: '页眉页脚', icon: <LayoutOutlined />, children: layoutTab }, { key: 'menus', label: '导航菜单', children: <MenuManager state={state} /> }, { key: 'forms', label: '网站表单', children: <FormManager /> }, { key: 'blocks', label: '重复使用的内容', icon: <LinkOutlined />, children: blockTab }, { key: 'styles', label: '复用样式（高级）', children: <ThemeLibrary /> }, { key: 'redirects', label: '旧网址跳转', children: <RedirectManager /> }, { key: 'code', label: '自定义代码（高级）', icon: <CodeOutlined />, children: codeTab }]} />
    {externalReviewError && <Alert style={{ marginTop: 16 }} type="error" showIcon title="外部AI审核链接无效" description="请从AI客户端重新打开完整审核地址。此链接未修改网站。" action={<Button onClick={() => clearExternalReview()}>忽略此链接</Button>} />}
    {externalReview && !aiOpen && <Alert style={{ marginTop: 16 }} type="info" showIcon title={canCode ? '有一份外部AI设计方案待核对' : '请由管理员核对此设计方案'} description="查看真实预览后，再决定是否应用或撤销。打开链接不会自动修改网站。" action={<Space wrap>{canCode && <Button onClick={() => requestLeave(() => setAiOpen(true))}>查看外部AI方案</Button>}<Button type="text" onClick={() => clearExternalReview()}>忽略此链接</Button></Space>} />}
    <AiSiteDesign open={aiOpen} onClose={() => setAiOpen(false)} onOpen={() => setAiOpen(true)} state={state} navigate={navigate} originScreen="global-design" reviewDesignId={externalReview || undefined} onReviewHandled={clearExternalReview} />
    <Modal title={blockDialog?.id ? '重命名区块' : '新建同步区块'} open={!!blockDialog} onCancel={() => !busy && setBlockDialog(null)} onOk={saveBlock} confirmLoading={busy} okText={blockDialog?.id ? '保存名称' : '创建区块'} okButtonProps={{ disabled: !name.trim() }}><Form layout="vertical"><Form.Item label="区块名称" required><Input value={name} maxLength={80} onChange={event => setName(event.target.value)} onPressEnter={saveBlock} placeholder="例如：全站联系信息" /></Form.Item></Form>{!blockDialog?.id && <Typography.Text type="secondary">{blockDialog?.kind === 'blank' ? '创建后进入编辑器，自由添加和调整组件。' : '创建基础布局后，可进入编辑器自由调整；在“页眉页脚”中选择该区块后应用。'}</Typography.Text>}</Modal>
    <Drawer title={`${activeBlock?.name || '同步区块'} · 使用范围`} open={!!usageId} onClose={() => setUsageId(null)} size={520}>{activeUsage && <><Descriptions column={1} items={[{ key: 'pages', label: '影响页面', children: `${activeUsage.pageIds.length} 个` }, { key: 'blocks', label: '区块引用', children: `${activeUsage.blockIds.length} 个` }, { key: 'slots', label: '全站布局', children: activeUsage.layoutSlots.map(slot => slot === 'header' ? '页眉' : '页脚').join('、') || '未使用' }]} /><Typography.Title level={5}>引用页面（包含间接引用）</Typography.Title><Table rowKey="id" size="small" pagination={false} dataSource={state.pages.filter(item => activeUsage.pageIds.includes(item.id))} columns={[{ title: '页面', dataIndex: 'title' }, { title: '路径', dataIndex: 'slug' }]} />{!!activeUsage.blockIds.length && <><Typography.Title level={5}>引用此内容的区块</Typography.Title><Space wrap>{blocks.filter(item => activeUsage.blockIds.includes(item.id)).map(item => <Tag key={item.id}>{item.name}</Tag>)}</Space></>}<Alert style={{ marginTop: 20 }} type="info" showIcon title="删除前需解除所有引用" description="页面、其他区块或全站页眉页脚仍使用此区块时，系统会阻止删除。这里展示的是工作区草稿的引用。" /></>}</Drawer>
    <Modal title="代码还有未保存的修改" open={leaveOpen} onCancel={() => setLeaveOpen(false)} footer={<Space><Button onClick={() => setLeaveOpen(false)}>继续编辑</Button><Button danger disabled={codeBusy} onClick={() => { loadScope(scopeRef.current); finishLeave(true); }}>放弃修改</Button><Button type="primary" loading={codeBusy} onClick={async () => { if (await saveCode()) finishLeave(false); }}>保存并继续</Button></Space>}><Typography.Paragraph>保存后再切换，避免当前输入丢失。保存失败时会保留代码和当前编辑位置。</Typography.Paragraph>{codeError && <Alert type="error" title={codeError} />}</Modal>
  </section>;
}
