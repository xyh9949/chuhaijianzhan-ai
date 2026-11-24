'use client';
import {useEffect,useState} from 'react';
import {Alert,App,Button,Card,ConfigProvider,Drawer,Image,Avatar,Dropdown,Empty,Flex,Grid,Input,List,Menu,Modal,Select,Space,Table,Tabs,Tag,Typography} from 'antd';
import {DeleteOutlined,FileTextOutlined,PlusOutlined,SettingOutlined} from '@ant-design/icons';
import type {ContentEntry,ContentModel,ScreenProps} from '@/lib/types';
import type {AiWritingReceiptInput} from '@/lib/ai-writing-types';
import {saveWritingDraft} from '@/lib/ai-writing-save-client';
import {clearExternalContentEditor,readExternalContentEditor} from '@/lib/external-ai-review-client';
import {RequestError,request,useStudioRuntime,type StudioEnvelope} from '@/lib/studio-client';
import {CONTENT_COLUMN_PRESETS,contentColumns,createContentColumn,type ColumnPresetKey} from '@/lib/content-columns';
import {entryCover,entryExcerpt,entryPublicationState,ENTRY_PUBLICATION_LABELS} from '@/lib/content-writing';
import {DISCOVERY_PRESETS} from '@/lib/discovery-presets';
import {localeOf} from '@/lib/localization';
import {getContentEntryPath} from '@/lib/content-routes';
import {formatDate} from '@/lib/date-format';
import {ModelEditor,EntryEditor,readRecovery,clearRecovery,usageOf,usedCount,type EditorDraft} from './ContentEditors';
import LocaleFilter from './LocaleFilter';
import AiTranslationDialog from './AiTranslationDialog';
import AiBatchTasks from './AiBatchTasks';
import MoreSettings from './MoreSettings';
import CatalogManager from './CatalogManager';
import ContentImportDialog from './ContentImportDialog';
import './system.css';
import './content-models.css';

/** 普通维护只面对栏目与内容；已有模型ID、字段、模板和记录保持原有存储与发布规则。 */
export default function ContentModelsScreen({state,update,navigate}:ScreenProps){
 const runtime=useStudioRuntime(),{message,modal}=App.useApp(),compact=!!Grid.useBreakpoint().xs;
 const canManage=runtime.actor.role==='admin',canEdit=runtime.actor.role!=='viewer';
 const [recovered,setRecovered]=useState(()=>readRecovery(runtime.actor.id,'content'));
 const [editor,setEditor]=useState<EditorDraft|null>(()=>recovered&&(recovered.kind==='model'?canManage:canEdit)?recovered:null);
 const [columnKey,setColumnKey]=useState(recovered?(recovered.kind==='entry'?recovered.value.modelId:recovered.value.id):'all');
 const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[language,setLanguage]=useState('all'),[term,setTerm]=useState('all');
 const [choosing,setChoosing]=useState(false),[creating,setCreating]=useState(false),[catalogOpen,setCatalogOpen]=useState(false);
 const [externalEditor,setExternalEditor]=useState(()=>readExternalContentEditor(runtime.actor.id));
 const [externalRecoveryNotice,setExternalRecoveryNotice]=useState(false);
 useEffect(()=>{
  if(!externalEditor||externalEditor.target.kind!=='entry')return;
  if(editor&&(editor.kind!=='entry'||editor.value.id!==externalEditor.target.id))return;
  const entry=state.contentEntries?.find(item=>item.id===externalEditor.target.id);
  // 审核页只传记录定位；已有恢复稿保留，处理完成后才打开目标文章。
  if(!editor&&entry){setColumnKey(entry.modelId);setEditor({kind:'entry',value:entry,existingId:entry.id});}
  else if(!entry)message.warning('这条内容已不存在，请核对最新草稿。');
  else if(recovered?.kind==='entry'&&recovered.value.id===entry.id)setExternalRecoveryNotice(true);
  clearExternalContentEditor(runtime.actor.id);setExternalEditor(null);
 },[externalEditor,editor,state.contentEntries,runtime.actor.id,message]);
 const models=(state.contentModels||[]).filter(m=>m.target==='content'),entries=state.contentEntries||[],columns=contentColumns(state.contentModels||[],entries),column=columns.find(c=>c.key===columnKey),model=column?.model;
 const imageOptions=state.media.filter(m=>m.kind==='image').map(m=>({value:m.url,label:m.name}));
 const resetEditor=()=>{clearRecovery(runtime.actor.id,'content');setRecovered(null);setExternalRecoveryNotice(false);setEditor(null);};
 function chooseColumn(key:string){setColumnKey(key);setQuery('');setTerm('all');setStatus('all');}
 function editModel(){if(model)setEditor({kind:'model',value:model,existingId:model.id});}
 async function saveModel(value:ContentModel){await runtime.mutate(env=>{
  const current=(env.state.contentModels||[]).find(m=>m.id===value.id);
  // 重读工作区不代表旧表单已核对；非空服务端日期也标识旧栏目，兼容恢复缓存丢失existingId，真正新建的日期为空。
  if((current||editor?.existingId||value.updated)&&(!current||current.updated!==value.updated))throw new RequestError(409,'这个栏目已在别处更新或删除，当前输入已保留，请返回列表核对最新栏目。');
  return request<StudioEnvelope>('/api/studio',{method:'PATCH',body:JSON.stringify({expectedRevision:env.revision,patch:{contentModels:current?env.state.contentModels!.map(m=>m.id===value.id?value:m):[...(env.state.contentModels||[]),value]}})});
 });chooseColumn(value.id);resetEditor();}
 async function saveEntry(value:ContentEntry,receipts:AiWritingReceiptInput[]=[]):Promise<ContentEntry>{
  let saved:ContentEntry|undefined;
  // 保存后继续写作；用服务器确认的记录更新基线，不能把上传或别处更新覆盖成旧副本。
  await runtime.mutate(async env=>{const current=(env.state.contentEntries||[]).find(e=>e.id===value.id);if((current||editor?.existingId)&&(!current||current.updated!==value.updated))throw new RequestError(409,'这条内容已在别处更新，当前输入已保留，请先核对最新内容。');
   const patch={contentEntries:current?env.state.contentEntries!.map(e=>e.id===value.id?{...e,...value}:e):[...(env.state.contentEntries||[]),value]};
   // AI字段回执与原保存使用同一事务；只对仍等于AI结果的实际保存字段登记安全撤销。
   const response=receipts.length?await saveWritingDraft(env,patch,receipts,{kind:'entry',id:value.id,modelId:value.modelId},value):await request<StudioEnvelope&{writingWarnings?:string[]}>('/api/studio',{method:'PATCH',body:JSON.stringify({expectedRevision:env.revision,patch})});saved=response.state.contentEntries?.find(e=>e.id===value.id);if(response.writingWarnings?.length)message.warning(response.writingWarnings.join('；'));return response;});
  if(!saved)throw new Error('未收到服务器的保存确认，请核对内容后重试');
  clearRecovery(runtime.actor.id,'content');setRecovered(null);setExternalRecoveryNotice(false);setColumnKey(saved.modelId);setQuery('');setStatus('all');setTerm('all');setEditor({kind:'entry',value:saved,existingId:saved.id});return saved;
 }
 function newEntry(value:ContentModel){setChoosing(false);setEditor({kind:'entry',value:{id:`entry-${crypto.randomUUID()}`,modelId:value.id,title:'',customFields:{},status:'draft',updated:'',...(language==='all'?{}:{locale:language})}});}
 async function enableColumn(kind:ColumnPresetKey,write=false){
  if(!canManage||creating)return;setCreating(true);
  try{let created:ContentModel|undefined;await runtime.mutate(async env=>{const current=contentColumns(env.state.contentModels||[],env.state.contentEntries||[]).find(c=>c.preset?.key===kind&&c.model);if(current?.model){created=current.model;return env;}
   const fresh=createContentColumn(kind,crypto.randomUUID(),env.state.pages);created=fresh.model;
   return request<StudioEnvelope>('/api/studio',{method:'PATCH',body:JSON.stringify({expectedRevision:env.revision,patch:{contentModels:[...(env.state.contentModels||[]),fresh.model],pages:[...env.state.pages,fresh.page],editorData:{...env.state.editorData,[fresh.page.id]:fresh.data},settings:{...env.state.settings,discovery:{...env.state.settings.discovery,mappings:[...(env.state.settings.discovery?.mappings||[]),fresh.mapping]}}}})});
  });if(created){chooseColumn(created.id);message.success(`${created.name}栏目已启用，尚未发布`);if(write)newEntry(created);}}
  catch(e){message.error((e as Error).message);}finally{setCreating(false);}
 }
 function createInColumn(key=columnKey){const c=columns.find(c=>c.key===key);if(c?.model)newEntry(c.model);else if(c?.preset)void enableColumn(c.preset.key,true);else setChoosing(true);}
 async function addColumn(key:string){if(CONTENT_COLUMN_PRESETS.some(p=>p.key===key)){await enableColumn(key as ColumnPresetKey);return;}if(key==='custom'){setEditor({kind:'model',value:{id:`model-${crypto.randomUUID()}`,name:'',description:'',target:'content',fields:[],updated:''}});return;}
  setCreating(true);try{let added='';await runtime.mutate(async env=>{const next=await request<StudioEnvelope>('/api/discovery/presets',{method:'POST',body:JSON.stringify({kind:key,expectedRevision:env.revision})});added=next.state.contentModels?.find(m=>!env.state.contentModels?.some(old=>old.id===m.id))?.id||'';return next;});if(added)chooseColumn(added);message.success('栏目已添加，可开始填写内容');}catch(e){message.error((e as Error).message);}finally{setCreating(false);}}
 async function editTemplate(){if(!model)return;const page=state.pages.find(p=>p.contentModelId===model.id);try{if(page){await update({activePageId:page.id});navigate('editor');}else{sessionStorage.setItem('form-studio:new-content-template-model',model.id);navigate('pages');}}catch(e){message.error((e as Error).message);}}
 function deleteColumn(){if(!model)return;const used=usageOf(state,model.id);if(usedCount(used)){modal.info({title:'栏目仍在使用',content:`有${used.entries}条内容、${used.pages}个页面、${used.blocks}个区块或其他填写项目引用。请先处理这些内容与页面，再删除栏目。`});return;}modal.confirm({title:`删除“${model.name}”栏目？`,content:'只删除草稿栏目，已发布历史版本保留。',okText:'删除栏目',cancelText:'取消',okButtonProps:{danger:true},onOk:async()=>{await runtime.mutate(env=>request<StudioEnvelope>('/api/studio',{method:'PATCH',body:JSON.stringify({expectedRevision:env.revision,patch:{contentModels:(env.state.contentModels||[]).filter(m=>m.id!==model.id)}})}));chooseColumn('all');}});}
 function deleteEntry(value:ContentEntry){modal.confirm({title:`删除“${value.title}”？`,content:'只删除草稿；网站下架需在发布管理确认。仍被页面使用时不能删除。',okText:'删除草稿',cancelText:'取消',okButtonProps:{danger:true},onOk:async()=>{try{await runtime.mutate(env=>request<StudioEnvelope>('/api/studio',{method:'PATCH',body:JSON.stringify({expectedRevision:env.revision,patch:{contentEntries:(env.state.contentEntries||[]).filter(e=>e.id!==value.id)}})}));message.success('内容草稿已删除');}catch(e){message.error((e as Error).message);throw e;}}});}
 const base=entries.filter(e=>(columnKey==='all'||e.modelId===columnKey)&&(language==='all'||localeOf(state.settings,e)===language)&&(term==='all'||e.termIds?.includes(term))&&e.title.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>(Date.parse(b.updated)||0)-(Date.parse(a.updated)||0)),filtered=base.filter(e=>status==='all'||entryPublicationState(e,state.releases,runtime.envelope.activeReleaseId)===status);
 const actions=(entry:ContentEntry)=><Space wrap><Button size={compact?'large':'small'} onClick={()=>setEditor({kind:'entry',value:entry,existingId:entry.id})}>{canEdit?'编辑':'查看'}</Button>{getContentEntryPath(state,entry)&&<Button size={compact?'large':'small'} type="link" href={`/preview${getContentEntryPath(state,entry)}`} target="_blank" rel="noreferrer">预览</Button>}{canManage&&<AiTranslationDialog target={{kind:'entry',id:entry.id}}/>}{canEdit&&<Button type="text" danger aria-label={`删除内容 ${entry.title}`} icon={<DeleteOutlined/>} onClick={()=>deleteEntry(entry)}/>}</Space>;
 const columnOptions=[{key:'all',label:`全部内容 · ${entries.length}`},...columns.map(c=>({key:c.key,label:`${c.name} · ${c.count}`}))];
 if(editor?.kind==='entry')return <ConfigProvider componentDisabled={false}>{externalEditor?.target.kind==='entry'&&editor.value.id!==externalEditor.target.id&&<Alert style={{marginBottom:20}} type="info" showIcon title="先保留当前内容的未保存输入" description="已采用的外部AI内容仍在草稿中。处理当前表单并返回列表后，会打开那条内容继续编辑。"/>}{externalRecoveryNotice&&<Alert style={{marginBottom:20}} type="warning" showIcon title="当前显示之前未保存的内容输入" description="外部AI保存的草稿仍在服务器中。这份本地恢复稿已完整保留，请核对差异后再保存，避免覆盖刚采用的内容。"/>}<EntryEditor key={editor.value.id} initial={editor.value} original={entries.find(e=>e.id===editor.existingId)} state={state} models={models} imageOptions={imageOptions} onSave={saveEntry} onClose={resetEditor} readonly={!canEdit} recovered={!!recovered&&recovered.value.id===editor.value.id} onRepair={(target,pageId)=>{if(pageId)void update({activePageId:pageId}).then(()=>navigate('editor'));else navigate(target);}}/></ConfigProvider>;
 // 只读成员也能切换栏目、筛选与查看；写操作仍逐项受权限和服务端验证约束。
 return <ConfigProvider componentDisabled={false}><section className="sys-screen content-models-screen">
  <Flex className="sys-heading" justify="space-between" align="flex-end" gap={16} wrap><div><Typography.Text className="sys-eyebrow">网站内容</Typography.Text><Typography.Title level={2} style={{margin:'6px 0 8px'}}>内容管理</Typography.Title><Typography.Paragraph style={{margin:0}}>按栏目维护案例、新闻和团队资料，保存后到发布管理更新网站。</Typography.Paragraph></div><Space wrap>{canManage&&<AiBatchTasks sourceKind="entry"/>}{canManage&&<Dropdown trigger={['click']} menu={{items:[...CONTENT_COLUMN_PRESETS.map(p=>({key:p.key,label:`添加${p.name}栏目`,disabled:columns.some(c=>c.model&&c.preset?.key===p.key)})),...DISCOVERY_PRESETS.filter(p=>p.id!=='case').map(p=>({key:p.id,label:p.name})),{key:'custom',label:'自定义栏目…'}],onClick:({key})=>{void addColumn(key);}}}><Button loading={creating} icon={<PlusOutlined/>}>添加栏目</Button></Dropdown>}{canEdit&&<Button type="primary" icon={<PlusOutlined/>} loading={creating} onClick={()=>createInColumn()} disabled={!!column&&!model&&!canManage}>新建{column?.preset?.key==='team'?'成员':column?.name||'内容'}</Button>}</Space></Flex>
  <div className="cm-workspace"><aside className="cm-column-nav"><Card size="small" title="内容栏目" styles={{header:{paddingInline:20,minHeight:52},body:{padding:8}}}><Menu aria-label="内容栏目" selectedKeys={[columnKey]} items={columnOptions} onClick={({key})=>chooseColumn(key)}/></Card></aside><div className="cm-content-main">
   <Select className="cm-mobile-columns" aria-label="内容栏目" value={columnKey} options={columnOptions.map(c=>({value:c.key,label:c.label}))} onChange={chooseColumn}/>
   <Flex justify="space-between" align="center" gap={12} wrap className="cm-column-heading"><Space><Typography.Title level={4} style={{margin:0}}>{column?.name||'全部内容'}</Typography.Title><Typography.Text type="secondary">{base.length} 条</Typography.Text></Space>{model&&<Dropdown trigger={['click']} menu={{items:[{key:'fields',label:canManage?'编辑填写项目':'查看填写项目'},{key:'template',label:state.pages.some(p=>p.contentModelId===model.id)?'设计详情页':'设置详情页',disabled:!canEdit},{key:'catalog',label:'分类与标签'},...(canManage?[{key:'delete',label:'删除栏目',danger:true}]:[])],onClick:({key})=>{if(key==='fields')editModel();else if(key==='template')void editTemplate();else if(key==='catalog')setCatalogOpen(true);else deleteColumn();}}}><Button icon={<SettingOutlined/>}>栏目设置</Button></Dropdown>}{columnKey==='all'&&<Button onClick={()=>setCatalogOpen(true)}>分类与标签</Button>}</Flex>
   {/* 卡片统一承担留白，避免Tabs/Flex默认重置覆盖间距，也避免移动列表重复缩进。 */}
   <Card className="cm-table-card" styles={{body:{padding:'var(--cm-panel-space)'}}}><Tabs className="cm-status-tabs" tabBarStyle={{marginBottom:20}} activeKey={status} onChange={setStatus} items={[{key:'all',label:`全部 ${base.length}`},{key:'published',label:`已发布 ${base.filter(e=>entryPublicationState(e,state.releases,runtime.envelope.activeReleaseId)==='published').length}`},{key:'modified',label:`待更新 ${base.filter(e=>entryPublicationState(e,state.releases,runtime.envelope.activeReleaseId)==='modified').length}`},{key:'draft',label:`草稿 ${base.filter(e=>entryPublicationState(e,state.releases,runtime.envelope.activeReleaseId)==='draft').length}`}]} />
    <div className="cm-list-tools"><Input.Search allowClear aria-label="搜索内容" placeholder={`搜索${column?.name||'内容'}标题`} value={query} onChange={e=>setQuery(e.target.value)}/><MoreSettings title="筛选与批量导入"><Space wrap><LocaleFilter settings={state.settings} value={language} onChange={setLanguage}/><Select aria-label="内容标签筛选" value={term} style={{minWidth:180}} options={[{value:'all',label:'全部标签'},...(state.taxonomies||[]).filter(t=>t.source==='entry'&&(!model||!t.modelId||t.modelId===model.id)).flatMap(t=>t.terms.map(v=>({value:v.id,label:`${t.name} / ${v.label}`})))]} onChange={setTerm}/>{model&&canEdit&&<ContentImportDialog target="entry" modelId={model.id}/>}</Space></MoreSettings></div>
    {column&&!model?<Empty style={{padding:'36px 16px'}} description={<Space orientation="vertical"><Typography.Text>{column.name}栏目还没有内容</Typography.Text><Typography.Text type="secondary">{canManage?column.preset?.description:'请管理员先启用该栏目。'}</Typography.Text></Space>}>{canManage&&<Button type="primary" loading={creating} onClick={()=>createInColumn()}>启用并新建{column.preset?.key==='team'?'成员':column.name}</Button>}</Empty>:compact?<List<ContentEntry> style={{padding:0}} dataSource={filtered} rowKey="id" pagination={{pageSize:10,hideOnSinglePage:true}} locale={{emptyText:'暂无内容，点击上方新建开始填写'}} renderItem={entry=><List.Item><Card size="small" style={{width:'100%'}} title={<Button type="link" className="cm-entry-title" onClick={()=>setEditor({kind:'entry',value:entry,existingId:entry.id})}>{entry.title}</Button>}><Space wrap><Tag>{models.find(m=>m.id===entry.modelId)?.name}</Tag><Tag color={entryPublicationState(entry,state.releases,runtime.envelope.activeReleaseId)==='published'?'green':entryPublicationState(entry,state.releases,runtime.envelope.activeReleaseId)==='modified'?'orange':undefined}>{ENTRY_PUBLICATION_LABELS[entryPublicationState(entry,state.releases,runtime.envelope.activeReleaseId)]}</Tag></Space><Typography.Paragraph type="secondary">更新于 {formatDate(entry.updated,state.settings.timezone)}</Typography.Paragraph>{actions(entry)}</Card></List.Item>}/>:<Table<ContentEntry> rowKey="id" tableLayout="fixed" scroll={{x:720}} pagination={{pageSize:10,hideOnSinglePage:true}} dataSource={filtered} locale={{emptyText:<Empty description="暂无内容，点击上方新建开始填写"/>}} columns={[{title:'内容',dataIndex:'title',width:320,render:(_,entry)=><div className="cm-entry-cell">{entryCover(entry,models)?<Image src={entryCover(entry,models)} alt="" width={52} height={52} preview={false} styles={{image:{objectFit:'cover',borderRadius:4}}}/>:<Avatar shape="square" size={52} icon={<FileTextOutlined/>}/>}<div><Button type="link" className="cm-entry-title" onClick={()=>setEditor({kind:'entry',value:entry,existingId:entry.id})}>{entry.title}</Button><Typography.Paragraph ellipsis={{rows:1}} className="cm-entry-excerpt">{entryExcerpt(entry,models)||'尚未填写摘要'}</Typography.Paragraph></div></div>},{title:'栏目',dataIndex:'modelId',width:120,render:id=>models.find(m=>m.id===id)?.name||'原栏目已删除'},{title:'状态',dataIndex:'status',width:85,render:(_,entry)=>{const status=entryPublicationState(entry,state.releases,runtime.envelope.activeReleaseId);return <Tag color={status==='published'?'green':status==='modified'?'orange':undefined}>{ENTRY_PUBLICATION_LABELS[status]}</Tag>}},{title:'更新时间',dataIndex:'updated',width:160,render:v=>formatDate(v,state.settings.timezone)},{title:'操作',width:200,render:(_,entry)=>actions(entry)}]}/>}</Card>
  </div></div>
  <Modal title="选择要新增内容的栏目" open={choosing} onCancel={()=>setChoosing(false)} footer={null}><List dataSource={columns.filter(c=>c.model||canManage)} renderItem={c=><List.Item><Button block loading={creating} onClick={()=>createInColumn(c.key)}>{c.name}{c.model?` · ${c.count} 条`:' · 启用后填写'}</Button></List.Item>}/>{!canManage&&!models.length&&<Empty description="请管理员先添加内容栏目"/>}</Modal>
  <Drawer title={`${model?.name||'内容'} · 分类与标签`} open={catalogOpen} onClose={()=>setCatalogOpen(false)} size={900} destroyOnHidden><CatalogManager source="entry" modelId={model?.id}/></Drawer>
  {editor?.kind==='model'&&<ModelEditor key={editor.value.id} initial={editor.value} original={models.find(m=>m.id===editor.existingId)} state={state} imageOptions={imageOptions} onSave={saveModel} onClose={resetEditor} readonly={!canManage} recovered={!!recovered&&recovered.value.id===editor.value.id}/>}
 </section></ConfigProvider>;
}
