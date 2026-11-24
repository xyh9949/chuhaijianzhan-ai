'use client';
import AiDetailDesign, { readDetailDesignRecovery } from './AiDetailDesign';
import { focusTemplateLibrary, rememberTemplateEditor } from '@/lib/template-editor-client';
import DetailTemplateRuleDialog,{readRuleRecovery} from './DetailTemplateRuleDialog';
import { readFreshStudio } from '@/lib/refresh-studio';
import { useEffect,useRef,useState } from 'react';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import { readLocalRecovery,clearLocalRecovery,requestLocalLeave } from '@/lib/local-recovery';

import { Alert, App, Button, Checkbox, Collapse, Empty, Flex, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { CopyOutlined, EditOutlined, EyeOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { PageTemplate, ScreenProps } from '@/lib/types';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { formatDate } from '@/lib/date-format';

type CaptureRecovery={pageId?:string;name:string;description:string;templateId:string;isUpdate:boolean;base:number};
type ApplyRecovery={templateId:string;newPageId:string;base:number;title:string;slug:string;targetPageId?:string};
const captureRecovery=(actorId:string)=>readLocalRecovery<CaptureRecovery>(actorId,'template-capture',value=>{const v=value as CaptureRecovery;return !!v&&typeof v.name==='string'&&v.name.length<=120&&typeof v.description==='string'&&v.description.length<=2000&&typeof v.templateId==='string'&&v.templateId.length<=100&&typeof v.isUpdate==='boolean'&&Number.isSafeInteger(v.base)&&(v.pageId===undefined||typeof v.pageId==='string');});
const applyRecovery=(actorId:string)=>readLocalRecovery<ApplyRecovery>(actorId,'template-apply',value=>{const v=value as ApplyRecovery;return !!v&&typeof v.templateId==='string'&&typeof v.newPageId==='string'&&typeof v.title==='string'&&v.title.length<=120&&typeof v.slug==='string'&&v.slug.length<=400&&Number.isSafeInteger(v.base)&&(v.targetPageId===undefined||typeof v.targetPageId==='string');});
type Result = StudioEnvelope & { pageId?: string; warnings?: string[] };
function CaptureDialog({ initial, onClose }: { initial?: PageTemplate; onClose: () => void }) {
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const [recovered]=useState(()=>captureRecovery(runtime.actor.id)),isUpdate=!!initial||!!recovered?.snapshot.isUpdate;
  const [pageId,setPageId]=useState<string|undefined>(recovered?.snapshot.pageId),[name,setName]=useState(recovered?.snapshot.name??initial?.name??''),[description,setDescription]=useState(recovered?.snapshot.description??initial?.description??'');
  const [templateId]=useState(recovered?.snapshot.templateId||initial?.id||`template-${crypto.randomUUID()}`),[base,setBase]=useState(recovered?.snapshot.base??runtime.getEnvelope().revision), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function refresh() { try { const env=await readFreshStudio(runtime); setBase(env.revision); setError('');message.info('已读取最新工作区。输入仍保留，请核对来源页面和名称后再保存。'); } catch (e) { setError((e as Error).message); } }
  async function save() {
    setBusy(true); setError('');
    try { await runtime.mutate(() => request<StudioEnvelope>('/api/page-templates/from-page', { method: 'POST', body: JSON.stringify({ expectedRevision: base, pageId, templateId, name, description, replaceExisting:isUpdate }) })); clearLocalRecovery(runtime.actor.id,'template-capture');message.success(isUpdate?'模板资源已更新，已复制页面保持原设计':'页面设计已保存为模板资源');onClose();return true; }
    catch (e) { setError((e as Error).message);return false; } finally { setBusy(false); }
  }
  const guard=useLocalDraftGuard({actorId:runtime.actor.id,scope:'template-capture',screen:'templates',title:'页面模板捕获输入',dirty:!!recovered||!!pageId||name!==(initial?.name||'')||description!==(initial?.description||''),busy,snapshot:{pageId,name,description,templateId,isUpdate,base},save,discard:onClose});
  return <>{guard.dialog}<Modal title={isUpdate ? '用页面更新模板设计' : '保存页面为模板'} open onCancel={()=>guard.ask(onClose)} onOk={save} okText={isUpdate ? '更新模板资源' : '保存模板资源'} confirmLoading={busy} okButtonProps={{ disabled: !pageId || !name.trim() }}>
    <Space orientation="vertical" size={16} style={{ width: '100%' }}><Alert type="info" showIcon title="保存设计副本，已复制页面不会跟随更新" description="选择当前草稿页面，保存它的布局、内容和页面代码。全站主题、表单及同步区块仍是本站引用；需要共享更新的内容请使用同步区块。" />
    {error && <Alert type="warning" showIcon title={error} action={<Button size="small" onClick={refresh}>重新读取工作区</Button>} />}
    <Form layout="vertical"><Form.Item label="来源页面" required><Select aria-label="模板来源页面" value={pageId} showSearch optionFilterProp="label" options={runtime.envelope.state.pages.map(p => ({ value: p.id, label: `${p.title} · ${p.slug}` }))} onChange={id => { setPageId(id); if (!name) setName(runtime.envelope.state.pages.find(p => p.id === id)?.title || ''); }} /></Form.Item><Form.Item label="模板名称" required><Input aria-label="保存模板名称" value={name} maxLength={120} onChange={e => setName(e.target.value)} /></Form.Item><Form.Item label="模板说明"><Input.TextArea aria-label="模板说明" value={description} maxLength={2000} rows={3} onChange={e => setDescription(e.target.value)} /></Form.Item></Form></Space>
  </Modal></>;
}

function ApplyDialog({ template, onClose, onApplied }: { template: PageTemplate; onClose: () => void; onApplied: (id: string) => Promise<void> }) {
  const runtime = useStudioRuntime(), { message } = App.useApp(), state = runtime.envelope.state;
  const [recovered]=useState(()=>{const saved=applyRecovery(runtime.actor.id);return saved?.snapshot.templateId===template.id?saved:undefined;});
  const [newPageId]=useState(recovered?.snapshot.newPageId||`page-${crypto.randomUUID()}`),[base,setBase]=useState(recovered?.snapshot.base??runtime.getEnvelope().revision);
  const [title, setTitle] = useState(recovered?.snapshot.title??`${template.name.slice(0,114)} · 副本`), [slug, setSlug] = useState(recovered?.snapshot.slug??(template.kind === 'product' ? '/products/:slug' : template.kind === 'entry' ? `/content-${crypto.randomUUID().slice(0, 8)}/:slug` : `/page-${crypto.randomUUID().slice(0,8)}`));
  const [targetPageId,setTargetPageId]=useState<string|undefined>(recovered?.snapshot.targetPageId), [includeCode, setIncludeCode] = useState(false), [enableJs, setEnableJs] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(()=>{setIncludeCode(false);setEnableJs(false);},[template.updated]);
  const existing = template.kind === 'page' ? undefined : state.pages.find(p => template.kind === 'product' ? p.slug === '/products/:slug' : p.contentModelId === template.modelId);
  const code = template.code, canCode = runtime.actor.role === 'admin';
  const [initialInputs]=useState(()=>JSON.stringify({title,slug,targetPageId,includeCode,enableJs}));
  async function refresh() { try { const env=await readFreshStudio(runtime); setBase(env.revision); setTargetPageId(undefined); setError('');message.info('已读取最新工作区，请重新核对路径和详情目标；输入仍保留。'); } catch (e) { setError((e as Error).message); } }
  async function apply() {
    setBusy(true); setError('');
    try { let id = ''; let warnings: string[] = []; await runtime.mutate(async () => { const result = await request<Result>('/api/page-templates/apply', { method: 'POST', body: JSON.stringify({ expectedRevision: base, templateId: template.id, newPageId, targetPageId, title, slug, includeCode, enableJs: includeCode && enableJs }) }); id = result.pageId!; warnings = result.warnings || []; return result; }); if (warnings.length) message.info(warnings.join('；')); message.success(existing ? '默认详情草稿设计已替换，尚未发布' : '已创建独立页面草稿'); // API已提交；本弹层即将卸载，不能用busy保护拦住进入新画布。
      guard.resolve();await onApplied(id);onClose();return true; }
    catch (e) { setError((e as Error).message);return false; } finally { setBusy(false); }
  }
  const guard=useLocalDraftGuard({actorId:runtime.actor.id,scope:'template-apply',screen:'templates',title:'页面模板复制输入',dirty:!!recovered||JSON.stringify({title,slug,targetPageId,includeCode,enableJs})!==initialInputs,busy,snapshot:{templateId:template.id,newPageId,base,title,slug,targetPageId},save:apply,discard:onClose});
  return <>{guard.dialog}<Modal title={existing ? '应用到默认详情页' : '复制成独立页面'} open width={720} onCancel={()=>guard.ask(onClose)} onOk={apply} confirmLoading={busy} okText={existing ? '替换选中详情草稿并编辑' : '创建草稿并编辑'} okButtonProps={{ disabled: existing ? !targetPageId : !title.trim() || !slug.trim() }}>
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>{recovered&&<Alert type="warning" title="已恢复布局复制输入；页面代码和JS选项需重新核对" />}<Alert type={existing ? 'warning' : 'info'} showIcon title={existing ? '此模型/产品已有默认详情页，请明确选择替换目标' : '布局成为独立副本，模板更新不改变此页面'} description="保存仍是草稿。全站样式、表单和同步区块继续使用本站定义；公开生效需要另行选择发布。" />
    {error && <Alert type="warning" title={error} action={<Button size="small" onClick={refresh}>重新读取工作区</Button>} />}
    <Form layout="vertical">{existing ? <Form.Item label="替换的默认详情页" required><Select aria-label="模板替换目标" value={targetPageId} placeholder="请选择并核对目标" options={[{ value: existing.id, label: `${existing.title} · ${existing.slug}` }]} onChange={setTargetPageId} /></Form.Item> : <><Form.Item label="新页面名称" required><Input aria-label="模板新页面名称" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} /></Form.Item><Form.Item label="新页面路径" required><Input aria-label="模板新页面路径" value={slug} disabled={template.kind === 'product'} maxLength={400} onChange={e => setSlug(e.target.value)} /></Form.Item></>}</Form>
    {code && (code.css || code.js) && <><Alert type="info" title="模板页面代码需要单独选择" description="布局复制默认不带入代码。已有目标页面的代码会保留；复制代码时替换该页代码。JavaScript默认关闭，只能由管理员检查后选择。" /><Collapse items={[{ key: 'css', label: '查看模板CSS', children: <pre style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{code.css || '（无CSS）'}</pre> }, { key: 'js', label: '查看模板JavaScript', children: <pre style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{code.js || '（无JavaScript）'}</pre> }]} /><Checkbox disabled={!canCode} checked={includeCode} onChange={e => { setIncludeCode(e.target.checked); if (!e.target.checked) setEnableJs(false); }}>复制模板的页面代码（仅管理员）</Checkbox>{code.js && <Checkbox disabled={!canCode || !includeCode || !code.jsEnabled} checked={enableJs} onChange={e => setEnableJs(e.target.checked)}>启用来源中原本开启的JavaScript（已核对代码）</Checkbox>}</>}
    </Space>
  </Modal></>;
}

/** 详情资产直接编辑布局；复制页面、适用内容规则和AI候选各自明确操作，避免误认为已经公开生效。 */
export default function PageTemplateLibrary({ state, navigate, update }: ScreenProps) {
  const runtime = useStudioRuntime(), { message } = App.useApp(), admin = runtime.actor.role === 'admin';
  const [initialCapture]=useState(()=>captureRecovery(runtime.actor.id)),[initialApply]=useState(()=>applyRecovery(runtime.actor.id));
  const resumeCapture=!!initialCapture&&(!initialApply||initialCapture.updatedAt>=initialApply.updatedAt);
  const [capture,setCapture]=useState<{template?:PageTemplate}|undefined>(()=>resumeCapture?{template:state.pageTemplates?.find(t=>t.id===initialCapture!.snapshot.templateId)}:undefined),[applying,setApplying]=useState<PageTemplate|undefined>(()=>!resumeCapture&&initialApply?state.pageTemplates?.find(t=>t.id===initialApply.snapshot.templateId):undefined),[preview,setPreview]=useState<PageTemplate>(),[search,setSearch]=useState('');
  useEffect(()=>{const resume=(e:Event)=>{const scope=(e as CustomEvent<{scope?:string}>).detail?.scope;if(scope==='template-capture'){const saved=captureRecovery(runtime.actor.id);if(saved){setApplying(undefined);setCapture({template:state.pageTemplates?.find(t=>t.id===saved.snapshot.templateId)});}}else if(scope==='template-apply'){const saved=applyRecovery(runtime.actor.id),template=state.pageTemplates?.find(t=>t.id===saved?.snapshot.templateId);if(template){setCapture(undefined);setApplying(template);}}};window.addEventListener('form-studio:recover-local',resume);return()=>window.removeEventListener('form-studio:recover-local',resume);},[runtime.actor.id,state.pageTemplates]);
  const [ruleTemplate,setRuleTemplate]=useState<PageTemplate|undefined>(()=>{const saved=readRuleRecovery(runtime.actor.id);return state.pageTemplates?.find(t=>t.id===saved?.snapshot.templateId);});
  useEffect(()=>{const resume=(e:Event)=>{if((e as CustomEvent).detail?.scope==='detail-template-rule'){const saved=readRuleRecovery(runtime.actor.id);setRuleTemplate(state.pageTemplates?.find(t=>t.id===saved?.snapshot.templateId));}};window.addEventListener('form-studio:recover-local',resume);return()=>window.removeEventListener('form-studio:recover-local',resume);},[runtime.actor.id,state.pageTemplates]);
  const [initialAi] = useState(() => readDetailDesignRecovery(runtime.actor.id));
  const [aiTarget, setAiTarget] = useState<string | undefined>(() => {
    // 外部审核打开保留的输入时仍需用户确认离开，但不能被该输入的旧模板范围锁住。
    if (typeof window !== 'undefined' && new URL(location.href).searchParams.has('externalTemplate')) return undefined;
    return initialAi?.snapshot.options.templateId;
  });
  const [aiOpen, setAiOpen] = useState(!!initialAi), [externalReview, setExternalReview] = useState(''), [externalError, setExternalError] = useState(false);
  const lastExternal = useRef('');
  function openExternalReview() {
    // 外部链接是独立审核入口；上次关闭的行面板范围不能沿用到新链接。
    setAiTarget(undefined);
    setAiOpen(true);
  }
  function clearExternal(id?: string) {
    const url = new URL(location.href); if (id && url.searchParams.get('externalTemplate') !== id) return;
    url.searchParams.delete('externalTemplate'); history.replaceState(history.state, '', url.href); setExternalReview(''); setExternalError(false); lastExternal.current = '';
  }
  useEffect(() => {
    const receive = () => {
      const raw = new URL(location.href).searchParams.get('externalTemplate'); if (!raw || lastExternal.current === raw) return;
      lastExternal.current = raw;
      if (!/^aitd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) { setExternalError(true); return; }
      setExternalReview(raw);
      if (admin && !aiOpen) requestLocalLeave(openExternalReview, 'external-template-review');
    };
    receive(); window.addEventListener('hashchange', receive); window.addEventListener('popstate', receive);
    return () => { window.removeEventListener('hashchange', receive); window.removeEventListener('popstate', receive); };
  }, [admin]);
  useEffect(() => { const restore = (event: Event) => { if ((event as CustomEvent).detail?.scope === 'ai-detail-design') { const saved = readDetailDesignRecovery(runtime.actor.id); if (saved) { setAiTarget(saved.snapshot.options.templateId); setAiOpen(true); } } }; window.addEventListener('form-studio:recover-local', restore); return () => window.removeEventListener('form-studio:recover-local', restore); }, [runtime.actor.id]);
  function editTemplate(id: string) { requestLocalLeave(() => { rememberTemplateEditor(runtime.actor.id, id); focusTemplateLibrary(); navigate('editor'); }, 'edit-detail-template'); }
  const templates = state.pageTemplates || [];
  async function remove(id: string) { try { await runtime.mutate(env => request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { pageTemplates: (env.state.pageTemplates || []).filter(t => t.id !== id) } }) })); message.success('模板已移出草稿资源库，已复制页面保持不变'); } catch (e) { message.error((e as Error).message); } }
  // 提示、工具栏与列表使用同一组间距，表格单元格内的紧凑排版保持独立。
  return <Space orientation="vertical" size={20} style={{ width: '100%' }}><Alert type="info" showIcon title="把做好的页面设计保存下来，下次直接使用" description={<Space wrap><span>复制出来的页面可以独立修改。产品、案例等详情模板可直接编辑或交给AI调整布局；适用内容单独设置，发布后生效。</span><Button onClick={() => navigate('global-design')}>管理同步区块</Button></Space>} />
    <Flex gap={12} justify="space-between" wrap><Input aria-label="搜索页面模板" placeholder="搜索模板名称或说明" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 320 }} allowClear /><Button type="primary" icon={<PlusOutlined />} disabled={!admin} onClick={() => setCapture({})}>从页面保存模板</Button></Flex>
    <Table<PageTemplate> rowKey="id" scroll={{ x: 1120 }} dataSource={templates.filter(t => `${t.name} ${t.description}`.toLowerCase().includes(search.trim().toLowerCase()))} pagination={{ pageSize: 10 }} locale={{ emptyText: <Empty description="把已设计好的页面保存为资源，供后续页面复制" /> }} columns={[{ title: '模板设计', render: (_, t) => <Space orientation="vertical" size={0}><Typography.Text strong>{t.name}</Typography.Text><Typography.Text type="secondary">{t.description || '可独立编辑的页面布局'}</Typography.Text></Space> }, { title: '用途', render: (_, t) => <Tag color={t.kind === 'page' ? 'blue' : 'purple'}>{t.kind === 'page' ? '独立页面' : t.kind === 'product' ? '产品默认详情' : `${state.contentModels?.find(m => m.id === t.modelId)?.name || '内容'}详情`}</Tag> }, { title: '更新于', dataIndex: 'updated', render: value => formatDate(value, state.settings.timezone) }, { title: '操作', width: 560, render: (_, t) => <Space wrap><Button size="small" icon={<EyeOutlined />} onClick={() => setPreview(t)}>预览</Button>{t.kind !== 'page' && <><Button size="small" icon={<ThunderboltOutlined />} disabled={!admin} onClick={() => requestLocalLeave(() => { setAiTarget(t.id); setAiOpen(true); }, 'open-ai-detail-design')}>AI调整布局</Button><Button size="small" icon={<EditOutlined />} disabled={!admin} onClick={() => editTemplate(t.id)}>编辑布局</Button></>}<Button size="small" icon={<CopyOutlined />} disabled={runtime.actor.role === 'viewer'} onClick={() => setApplying(t)}>{t.kind === 'page' ? '复制到页面' : '应用详情设计'}</Button>{t.kind!=='page'&&<Button size="small" disabled={!admin} onClick={()=>setRuleTemplate(t)}>适用内容</Button>}<Button size="small" disabled={!admin} onClick={() => setCapture({ template: t })}>从页面更新</Button><Popconfirm title="移出草稿模板资源库？" description="已复制页面保持不变，历史资源库仍保留。" onConfirm={() => remove(t.id)}><Button size="small" danger disabled={!admin}>移除</Button></Popconfirm></Space> }]} />
    {externalError && <Alert type="warning" showIcon title="外部AI详情审核链接无效" action={<Button onClick={() => clearExternal()}>忽略此链接</Button>} />}
    {externalReview && !aiOpen && <Alert type="info" showIcon title={admin ? '有一个外部AI详情方案等待核对' : '请由管理员核对详情方案'} action={<Space>{admin && <Button onClick={() => requestLocalLeave(openExternalReview, 'external-template-review')}>查看方案</Button>}<Button onClick={() => clearExternal()}>忽略此链接</Button></Space>} />}
    {aiOpen && <AiDetailDesign key={aiTarget || 'external-review'} open state={state} templateId={aiTarget} reviewDesignId={aiTarget ? undefined : externalReview || undefined} onReviewHandled={clearExternal} onOpen={() => setAiOpen(true)} onClose={() => setAiOpen(false)} navigate={navigate} />}
    {ruleTemplate&&<DetailTemplateRuleDialog template={state.pageTemplates?.find(t=>t.id===ruleTemplate.id)||ruleTemplate} onClose={()=>setRuleTemplate(undefined)}/>}
    {capture && <CaptureDialog initial={capture.template} onClose={() => setCapture(undefined)} />}
    {applying && <ApplyDialog template={state.pageTemplates?.find(t=>t.id===applying.id)||applying} onClose={() => setApplying(undefined)} onApplied={async id => { await update({ activePageId: id }); navigate('editor'); }} />}
    <Modal title={`模板预览 · ${preview?.name || ''}`} open={!!preview} onCancel={() => setPreview(undefined)} width={1180} footer={<Button onClick={() => setPreview(undefined)}>关闭预览</Button>}><Typography.Paragraph type="secondary">此处强制预览模板布局，不代表当前适用内容规则已经命中；布局使用本站资料作为样本，并关闭自定义JavaScript。</Typography.Paragraph>{preview && <iframe title={`页面模板预览 ${preview.name}`} src={`/preview/~template/${preview.id}`} referrerPolicy="no-referrer" style={{ width: '100%', height: '68vh', border: '1px solid #e7ebf0', background: '#fff' }} />}</Modal>
  </Space>;
}
