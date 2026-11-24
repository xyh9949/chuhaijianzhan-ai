'use client';
import LocaleFilter from './LocaleFilter';
import MoreSettings from './MoreSettings';
import AiSiteDesign from './AiSiteDesign';
import AiSiteTranslation from './AiSiteTranslation';
import {useLocalDraftGuard} from './useLocalDraftGuard';
import {readLocalRecovery,localRecoveries} from '@/lib/local-recovery';
import {readFreshStudio} from '@/lib/refresh-studio';
import {localeOf} from '@/lib/localization';
import SeoFields from './SeoFields';
import LocaleFields from './LocaleFields';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, ConfigProvider, Descriptions, Grid, Input, Tabs, Table, Tag, Space, Dropdown, Modal, Form, Select, App, Empty, Tooltip, Typography } from 'antd';
import { PlusOutlined, SearchOutlined, MoreOutlined, FileTextOutlined, HomeOutlined, CopyOutlined, DeleteOutlined, ArrowRightOutlined, EyeOutlined, GlobalOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { ScreenProps, PageItem } from '@/lib/types';
import { createPageData, getPageData } from '@/lib/page-data';
import { formatDate } from '@/lib/date-format';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { createContentDesignData } from '@/lib/content-design-presets';
import { columnPreset } from '@/lib/content-columns';
import { contentTemplatePrefix, getTemplatePreviewPath } from '@/lib/content-routes';
import { PAGE_PUBLICATION_STATE, pagePublicationState } from '@/lib/page-publication-state';
import './content.css';

// 只比较可编辑字段，并固定键序；首次挂载或展开可选字段不应触发“未保存”提示。
const editablePageKeys=['title','type','slug','contentModelId','seoTitle','seoDescription','seoImage','noindex','nofollow','locale','translationGroupId','translationState'] as const;
function pageInfoValues(value:Partial<PageItem>&{nofollow?:boolean}){return Object.fromEntries(editablePageKeys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));}
export default function PagesScreen({ state, navigate, onEdit }: ScreenProps & { onEdit: (id: string) => void }) {
  const runtime = useStudioRuntime();
  const [aiOpen, setAiOpen] = useState(() => localRecoveries(runtime.actor.id).some(item => item.scope === 'ai-site-design' && item.screen === 'pages'));
  const compact = Grid.useBreakpoint().md === false;
  const [language,setLanguage]=useState('all'),[searchOpenSignal,setSearchOpenSignal]=useState(0);
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all'); const [open, setOpen] = useState(false); const [editing, setEditing] = useState<PageItem | null>(null);
  const [form] = Form.useForm(); const { message, modal } = App.useApp();
  const [saving, setSaving] = useState(false); const savingRef = useRef(false); const newPageId = useRef('');
  const selectedType = Form.useWatch('type', form);
  const baseRef=useRef(runtime.envelope.revision),initialRef=useRef(''),[pageError,setPageError]=useState('');
  const watched=Form.useWatch([], {form,preserve:true}),values=pageInfoValues(watched||{});
  const readPageRecovery=()=>readLocalRecovery<{id:string;base:number;existing:boolean;values:Partial<PageItem>}>(runtime.actor.id,'page-info',v=>{const r=v as {id:string;base:number;existing:boolean;values:Partial<PageItem>};return !!r&&typeof r.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(r.id)&&Number.isSafeInteger(r.base)&&typeof r.existing==='boolean'&&!!r.values&&typeof r.values==='object'&&!Array.isArray(r.values)&&Object.entries(r.values).every(([k,v])=>['title','type','slug','contentModelId','seoTitle','seoDescription','seoImage','noindex','nofollow','locale','translationGroupId','translationState'].includes(k)&&(typeof v==='string'&&v.length<=2000||typeof v==='boolean'))&&JSON.stringify(r.values).length<20000;});
  const [recovered]=useState(readPageRecovery);
  // 恢复仅恢复编辑输入和原修订号；刷新工作区后需用户明确重试，不能覆盖并发修改。
  function resumePageInfo(saved:ReturnType<typeof readPageRecovery>){if(!saved)return;const r=saved.snapshot;newPageId.current=r.id;baseRef.current=r.base;const current=runtime.getEnvelope().state;setEditing(r.existing?current.pages.find(p=>p.id===r.id)||null:null);initialRef.current='';form.resetFields();form.setFieldsValue(r.values);setOpen(true);setPageError(r.existing&&!current.pages.some(p=>p.id===r.id)?'原页面已删除，请保留输入并另建页面':'已恢复输入，先读取最新工作区并核对后保存');}
  useEffect(()=>{resumePageInfo(recovered);const handler=(event:Event)=>{if((event as CustomEvent).detail?.scope==='page-info')resumePageInfo(readPageRecovery());};window.addEventListener('form-studio:recover-local',handler);return()=>window.removeEventListener('form-studio:recover-local',handler);},[]);  const guard=useLocalDraftGuard({actorId:runtime.actor.id,scope:'page-info',screen:'pages',title:'页面信息',dirty:open&&JSON.stringify(values)!==initialRef.current,busy:saving,snapshot:{id:editing?.id||newPageId.current,base:baseRef.current,existing:!!editing,values},save,discard:()=>setOpen(false)});

  // 模型列表入口只携带预填目标；创建仍需用户填写路径并显式保存。
  useEffect(() => { try { const id = sessionStorage.getItem('form-studio:new-content-template-model'); sessionStorage.removeItem('form-studio:new-content-template-model'); const model = state.contentModels?.find(item => item.id === id && item.target === 'content'); if (model) {baseRef.current=runtime.getEnvelope().revision; newPageId.current = `page-${crypto.randomUUID()}`; setEditing(null); form.resetFields(); form.setFieldsValue({ title: `${model.name.slice(0, 118)}详情`, type: '内容详情模板', contentModelId: model.id, slug: '' });initialRef.current=JSON.stringify(pageInfoValues(form.getFieldsValue(true))); setOpen(true); } } catch { /* 存储不可用时仍可手动新建详情模板。 */ } }, []);
  // 同一套状态派生同时用于标签、计数和条件筛选。
  const publicationState = pagePublicationState(state.releases);
  const languagePages = state.pages.filter(p => language === 'all' || p.slug.includes(':') || localeOf(state.settings, p) === language);
  const pages = languagePages.filter(p => (filter === 'all' || publicationState(p) === filter) && (p.title + p.slug).toLowerCase().includes(query.toLowerCase()));
  const statusTag = (page: PageItem) => { const status = PAGE_PUBLICATION_STATE[publicationState(page)]; return <Tag className="status-tag" color={status.color}>{status.label}</Tag>; };
  const go = onEdit;
  function editInfo(page?: PageItem) { if (savingRef.current) return; baseRef.current=runtime.getEnvelope().revision;setPageError(''); newPageId.current = page?.id || `page-${crypto.randomUUID()}`; setEditing(page || null); form.resetFields(); form.setFieldsValue(page ? { ...page, type: page.contentModelId ? '内容详情模板' : page.type } : { title: '', slug: '', type: '普通页面' }); initialRef.current=JSON.stringify(pageInfoValues(form.getFieldsValue(true)));setOpen(true); }
  async function save() {
    if (savingRef.current) return false; savingRef.current = true; setSaving(true);setPageError('');
    try {
      const values = await form.validateFields(); const id = editing?.id || newPageId.current;
      if (state.pages.some(p => p.slug === values.slug && p.id !== id)) { form.setFields([{ name: 'slug', errors: ['此路径已被其他页面使用'] }]); return false; }
      const contentModelId = values.type === '内容详情模板' ? values.contentModelId : undefined;
      const page: PageItem = { ...editing, ...values, contentModelId, title: values.title.trim(), id, status: 'draft', updated: new Date().toISOString() };
      if(runtime.getEnvelope().revision!==baseRef.current){setPageError('工作区已变化，输入保留；请读取最新工作区后核对并重试');return false;}
      // 新建失败重试沿用同一个 ID；只有服务器确认后才关闭表单并提示成功。
      await runtime.mutate(env => { if(env.revision!==baseRef.current)throw new RequestError(409,'工作区已变化，输入保留；请读取最新工作区后核对并重试');if(editing&&!env.state.pages.some(p=>p.id===id))throw new Error('原页面已删除，请保留输入并另建页面');const current = env.state, model = current.contentModels?.find(item => item.id === contentModelId); const data = model ? createContentDesignData({ name: page.title, source: 'entry', model, recordId: current.contentEntries?.find(item => item.modelId === model.id)?.id, kind: 'detail', ...(columnPreset(model)?.key === 'case' ? { detailKind: 'case' as const } : {}) }) : createPageData('blank'); return request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { pages: current.pages.some(p => p.id === id) ? current.pages.map(p => p.id === id ? page : p) : [...current.pages, page], ...(!editing ? { editorData: { ...current.editorData, [id]: current.editorData[id] || data } } : {}) } }) }); });
      guard.clear();setOpen(false); message.success(editing ? '页面信息已保存到草稿' : contentModelId ? '内容详情模板已创建，可进入编辑器调整布局' : '已创建空白页面');return true;
    } catch (error) {
      if (!(error as { errorFields?: unknown }).errorFields)setPageError(error instanceof Error ? error.message : '页面保存失败，输入已保留');return false;
    } finally { savingRef.current = false; setSaving(false); }
  }
  function remove(page: PageItem) { if (page.slug === '/') return; modal.confirm({ title: `删除“${page.title}”？`, content: page.contentModelId ? '移除此模板后，该模型的记录将不再自动生成详情页。仍依赖详情链接的绑定会阻止保存；公开下架需另行发布。' : '草稿将被移除。首页不能删除，公开页面下架需要在发布时单独确认。', okText: '删除页面', okButtonProps: { danger: true }, cancelText: '取消', onOk: async () => { try { await runtime.mutate(env => request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { pages: env.state.pages.filter(p => p.id !== page.id) } }) })); message.success('页面已从草稿列表删除'); } catch (error) { message.error(error instanceof Error ? error.message : '删除未完成'); throw error; } } }); }
  async function duplicate(page: PageItem) {
    if (savingRef.current) return; savingRef.current = true; setSaving(true);
    try {
      const token = crypto.randomUUID(); const id = `page-${token}`;
      // 动态模板的 :slug 不能拼入普通页面路径；副本保留设计，使用独立可编辑地址。
      const path = page.slug.includes(':') ? page.slug.replace(/\/:slug$/, '') || '/template' : page.slug === '/' ? '/home' : page.slug;
      // 模板副本是独立普通页，不能为同一模型隐式建立第二条自动详情路由。
      await runtime.mutate(env => request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { pages: [...env.state.pages, { ...page, translationGroupId:undefined, translationState:undefined, contentModelId: undefined, type: page.contentModelId ? '普通页面' : page.type, id, title: `${page.title.slice(0, 116)} 副本`, slug: `${path.slice(0, 170)}-copy-${token.slice(0, 8)}`, status: 'draft', updated: new Date().toISOString() }], editorData: { ...env.state.editorData, [id]: structuredClone(env.state.editorData[page.id] || getPageData(page)) } } }) })); message.success('已复制为独立草稿');
    } catch (error) { message.error(error instanceof Error ? error.message : '复制未完成'); }
    finally { savingRef.current = false; setSaving(false); }
  }
  // Dropdown会给触发按钮显式传disabled，需把只读角色纳入，避免覆盖外层继承禁用。
  const pageActions = (p: PageItem) => <Space size={4}><Button type="link" aria-label={`编辑${p.title}`} onClick={() => go(p.id)}>编辑</Button><Dropdown disabled={saving || runtime.actor.role === 'viewer'} menu={{ items: [{ key: 'seo', label: '搜索与分享', icon: <GlobalOutlined /> }, { key: 'settings', label: '页面设置', icon: <FileTextOutlined /> }, { key: 'copy', label: '复制页面', icon: <CopyOutlined /> }, { type: 'divider' }, { key: 'delete', label: '删除页面', icon: <DeleteOutlined />, danger: true, disabled: p.slug === '/' }], onClick: ({ key }) => { if (key === 'copy') void duplicate(p); else if (key === 'delete') remove(p); else {editInfo(p);if(key==='seo')setSearchOpenSignal(v=>v+1);} } }} trigger={['click']}><Button disabled={runtime.actor.role === 'viewer'} type="text" aria-label={`${p.title}更多操作`} icon={<MoreOutlined />} /></Dropdown></Space>;
  function rowActions(page: PageItem) {
    if (runtime.actor.role !== 'viewer') return pageActions(page);
    // 只读成员按列表中的真实页面或模板样本打开独立草稿，不改变编辑目标、不提交草稿。
    const path = getTemplatePreviewPath(state, page);
    if (!path) return <Tooltip title="该详情模板还没有可预览的记录"><Typography.Text type="secondary">暂无预览样本</Typography.Text></Tooltip>;
    return <Button type="link" disabled={false} icon={<EyeOutlined />} aria-label={`预览草稿：${page.title}`} href={`/preview${path === '/' ? '' : path}`} target="_blank" rel="noopener noreferrer">预览草稿</Button>;
  }
  // 手机仅收起次要列；仍使用原Table，详情读取同一记录且不触发保存或页面切换。
  const pageDetails = (p: PageItem) => <Space className="mobile-table-details" orientation="vertical" size={12} style={{ width: '100%' }}><Descriptions column={1} size="small" items={[
    { key: 'title', label: '页面名称', children: p.title }, { key: 'slug', label: '页面路径', children: p.slug },
    { key: 'type', label: '页面类型', children: p.contentModelId ? `内容详情模板 · ${state.contentModels?.find(model => model.id === p.contentModelId)?.name || '未找到模型'}` : p.type },
    { key: 'status', label: '状态', children: PAGE_PUBLICATION_STATE[publicationState(p)].label }, { key: 'updated', label: '最近编辑', children: formatDate(p.updated, state.settings.timezone) },
    { key: 'seoTitle', label: '搜索标题', children: p.seoTitle || '使用页面标题' }, { key: 'seoDescription', label: '搜索描述', children: p.seoDescription || '尚未单独填写' },
  ]} />{rowActions(p)}</Space>;
  return <div className="pages-screen screen-enter min-w-0">{guard.dialog}
    <AiSiteDesign open={aiOpen} onClose={() => setAiOpen(false)} onOpen={() => setAiOpen(true)} state={state} navigate={navigate} originScreen="pages" />
    <div className="page-heading"><div className="min-w-0"><h1>网站页面 <span className="heading-count">{state.pages.length}</span></h1><p>管理页面结构与内容，随时继续编辑。</p></div><Space wrap>{runtime.actor.role === 'admin' && <AiSiteTranslation onRequestOpen={guard.ask}/>}{runtime.actor.role === 'admin' && <Button icon={<ThunderboltOutlined aria-hidden="true" />} onClick={() => guard.ask(() => setAiOpen(true))}>AI设计整个网站</Button>}<Button icon={<GlobalOutlined />} onClick={() => navigate('templates')}>从模板创建</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => editInfo()}>新建页面</Button></Space></div>
    <div className="surface page-table">
      <ConfigProvider componentDisabled={false}><div className="table-toolbar"><Tabs tabBarStyle={{ margin: 0 }} activeKey={filter} onChange={setFilter} items={[{ key: 'all', label: `全部页面 ${languagePages.length}` }, ...(['published', 'modified', 'draft'] as const).map(key => ({ key, label: `${PAGE_PUBLICATION_STATE[key].label} ${languagePages.filter(page => publicationState(page) === key).length}` }))]} /><LocaleFilter settings={state.settings} value={language} onChange={setLanguage}/><Input prefix={<SearchOutlined />} placeholder="搜索页面名称或路径" aria-label="搜索页面" value={query} onChange={e => setQuery(e.target.value)} allowClear /></div></ConfigProvider>
      <Table<PageItem> className="pages-records-table mobile-record-table" rowKey="id" dataSource={pages} pagination={false} scroll={compact ? undefined : { x: 760 }} tableLayout={compact ? 'fixed' : undefined} expandable={compact ? { columnWidth: 64, expandedRowRender: pageDetails, expandIcon: ({ expanded, onExpand, record }) => <Button className="mobile-record-toggle" type="link" size="small" disabled={false} aria-label={`${expanded ? '收起' : '查看'}页面详情：${record.title}`} aria-expanded={expanded} onClick={event => onExpand(record, event)}>{expanded ? '收起' : '详情'}</Button> } : undefined} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query || filter !== 'all' ? '没有符合条件的页面' : '创建你的第一个页面'}>{query || filter !== 'all' ? <Button disabled={false} onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</Button> : <Button type="primary" onClick={() => editInfo()}>新建页面</Button>}</Empty> }} columns={[
        { title: '页面名称', dataIndex: 'title', render: (_, p) => <div className="title-cell"><span className="file-icon">{p.id === 'home' ? <HomeOutlined /> : <FileTextOutlined />}</span><div><Button className="table-title" type="link" onClick={() => go(p.id)}>{p.title}</Button>{compact ? <><Typography.Text type="secondary" ellipsis className="mobile-record-path">{p.slug}</Typography.Text>{statusTag(p)}</> : <div className="muted mono">{p.slug}</div>}</div></div> },
        { title: '页面类型', dataIndex: 'type', responsive: ['md'], render: (v, page) => <div className="muted">{page.contentModelId ? '内容详情模板' : v}{page.contentModelId && <div><Tag color="cyan">{state.contentModels?.find(model => model.id === page.contentModelId)?.name || '未找到模型'}</Tag></div>}</div> },
        { title: '状态', key: 'status', responsive: ['md'], render: (_, p) => statusTag(p) },
        { title: '最近编辑', dataIndex: 'updated', responsive: ['md'], render: v => <span className="muted">{formatDate(v, state.settings.timezone)}</span> },
        { title: '操作', key: 'action', width: 136, responsive: ['md'], render: (_, p) => rowActions(p) }
      ]} />
      <div className="table-foot">共 {pages.length} 个页面<span>当前修改保存为草稿，确认发布后更新公开网站</span></div>
    </div>
    <div className="small-banner"><div className="banner-symbol"><GlobalOutlined /></div><div><h3>从设计资源开始</h3><p>选择页面模板或区块，创建一份可以独立编辑的草稿。</p></div><Button onClick={() => navigate('templates')} icon={<ArrowRightOutlined />} iconPlacement="end">浏览设计资源</Button></div>
    <Modal title={editing ? '页面设置' : '创建新页面'} open={open} onCancel={() => { if (!savingRef.current) guard.ask(()=>setOpen(false)); }} onOk={save} confirmLoading={saving} cancelButtonProps={{ disabled: saving }} closable={!saving} maskClosable={!saving} okText="保存草稿" cancelText="取消"><Form disabled={saving} form={form} layout="vertical" style={{ marginTop: 24 }}>
      {pageError&&<Alert type="warning" title={pageError} action={<Button onClick={async()=>{try{const env=await readFreshStudio(runtime);baseRef.current=env.revision;setPageError('已读取最新工作区，核对输入后再保存');}catch(e){setPageError((e as Error).message);}}}>读取最新工作区</Button>}/>}
      <Form.Item label="页面名称" name="title" rules={[{ required: true, whitespace: true, message: '请输入页面名称' }, { max: 120, message: '页面名称最多 120 个字符' }]}><Input maxLength={120} placeholder="例如：公司介绍" /></Form.Item>
      <MoreSettings title="页面用途（高级）" defaultOpen={!!editing?.contentModelId||selectedType==='内容详情模板'}>
      <Form.Item label="页面类型" name="type" rules={[{ required: true, message: '请选择页面类型' }]}><Select aria-label="页面类型" options={['普通页面', '产品列表', '动态模板', '内容详情模板'].map(v => ({ label: ({'普通页面':'普通页面','产品列表':'产品展示列表','动态模板':'产品详情页模板','内容详情模板':'案例等内容的详情模板'} as Record<string,string>)[v]||v, value: v }))} /></Form.Item>
      {selectedType === '内容详情模板' && <Form.Item label="使用哪个内容栏目" name="contentModelId" rules={[{ required: true, message: '请选择独立内容模型' }]} extra="每个栏目使用一份详情设计，发布后自动为每条内容生成页面。"><Select aria-label="详情模板关联模型" placeholder="选择案例、团队等栏目" options={(state.contentModels || []).filter(model => model.target === 'content').map(model => ({ value: model.id, label: model.name, disabled: state.pages.some(page => page.contentModelId === model.id && page.id !== editing?.id) }))} /></Form.Item>}
      </MoreSettings>
      <Form.Item label="页面网址" name="slug" extra={selectedType === '内容详情模板' ? '例如 /cases/:slug 或 /company/team/:slug；:slug 会替换为记录的网址标识。' : '填写网址最后的部分，例如 /about。使用小写英文字母，可用短横线分隔单词。'} rules={[{ required: true, message: '请输入页面路径' }, { validator: (_, value: string) => { const contentTemplate = form.getFieldValue('type') === '内容详情模板'; const valid = contentTemplate ? !!contentTemplatePrefix({ slug: value || '' }) : value === '/' || value === '/products/:slug' || /^\/[a-z0-9][a-z0-9/_-]*$/.test(value || ''); return !value || valid && !value.includes('//') && (value === '/' || !value.endsWith('/')) && !/^\/(api|admin|preview|_next|images|fonts)(\/|$)/.test(value) ? Promise.resolve() : Promise.reject(new Error(contentTemplate ? '请输入有效的详情模板路径，例如 /cases/:slug' : '请输入有效的小写路径，且不能使用系统保留路径')); } }]}><Input aria-label="页面网址" maxLength={200} /></Form.Item>
      {selectedType!=='内容详情模板'&&selectedType!=='动态模板'&&<LocaleFields settings={state.settings} page/>}<SeoFields media={state.media} fallbackTitle={editing?.title} openSignal={searchOpenSignal} />
      {selectedType === '内容详情模板' && <Alert showIcon type="info" title="一份设计，自动生成每条内容的页面" description="创建后进入编辑器，自由调整组件并绑定当前内容。模板、模型和内容记录需要一起发布；改变路径不会自动生成旧地址重定向。" />}
    </Form></Modal>
  </div>;
}
