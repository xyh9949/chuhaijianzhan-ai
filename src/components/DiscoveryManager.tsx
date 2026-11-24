'use client';
import {useEffect,useState} from 'react';
import {Alert,App,Avatar,Button,Card,Checkbox,Col,Collapse,Descriptions,Divider,Drawer,Flex,Form,Input,InputNumber,Popconfirm,Row,Select,Space,Switch,Table,Tabs,Tag,Typography,Upload} from 'antd';
import {request,useStudioRuntime,type StudioEnvelope} from '@/lib/studio-client';
import type {ScreenProps} from '@/lib/types';
import type {DiscoverySettings,DiscoveryIssue} from '@/lib/discovery';
import {DISCOVERY_PRESETS} from '@/lib/discovery-presets';
import {publicSiteOrigin} from '@/lib/site-seo';
import {readLocalRecovery} from '@/lib/local-recovery';
import {useLocalDraftGuard} from './useLocalDraftGuard';
import type {DiscoveryObservation} from '@/server/discovery-runtime';

type Status=Awaited<ReturnType<typeof import('@/server/discovery-runtime').discoveryStatus>>;
type Panel='company'|'content'|'check'|'advanced';
type Recovery={value:DiscoverySettings;baseline:string};
const metrics=[['google-ai-impressions','Google AI展示'],['bing-ai-citations','Bing AI引用'],['indexed-url-count','已索引URL数'],['manual-answer','人工回答样本'],['ai-referral-visits','可识别AI引荐访问'],['qualified-inquiries','有效询盘']];
const presetDescriptions:Record<string,string>={capability:'说明能做什么、生产流程和服务范围。',selection:'回答客户怎么选、不同方案有什么区别。',case:'展示真实项目的需求、方案和结果。',certificate:'展示检测报告、证书及其适用范围。',procurement:'回答样品、下单、交付等常见采购问题。'};
/** 普通客户看到可执行的建议；完整技术诊断仍在高级设置保留。 */
function friendlyIssue(issue:DiscoveryIssue){
 if(issue.message.includes('规范地址'))return {title:'填写网站的正式网址',detail:'上线前，到常规设置填写客户实际访问的网址。',target:'general'};
 if(issue.message.includes('本机地址'))return {title:'上线前更换正式网址',detail:'当前网址只用于本机预览，外部搜索服务无法访问。',target:'general'};
 if(issue.message.includes('法定名称'))return {title:'补充公司全称',detail:'填写真实公司名称，帮助访客和搜索服务识别企业。',target:'company'};
 if(issue.message.includes('有效期'))return {title:'重新核对过期资料',detail:issue.message.replace('事实','资料'),target:'company'};
 if(issue.message.includes('标题与'))return {title:'检查重复的页面标题',detail:'为内容不同的页面填写各自的标题，方便客户区分。',target:'editor'};
 return {title:'检查页面的主标题',detail:issue.message.includes('多个')?'页面里有多个主要标题，请在编辑器核对标题层级。':'系统未识别到页面主标题，请在编辑器核对；动态内容需要人工确认。',target:'editor'};
}
const readRecovery=(actor:string)=>readLocalRecovery<Recovery>(actor,'discovery-settings',v=>{const r=v as Recovery;return !!r&&typeof r.baseline==='string'&&!!r.value&&typeof r.value==='object'&&!Array.isArray(r.value);});

/** 日常资料与技术维护分层显示；所有弹层共用同一份表单，隐藏配置也完整保存。 */
export default function DiscoveryManager({state,update,navigate,onEditSite}:ScreenProps&{onEditSite?:()=>void}){
 const runtime=useStudioRuntime(),{message}=App.useApp(),[form]=Form.useForm<DiscoverySettings>(),[observation]=Form.useForm<DiscoveryObservation>();
 const savedDiscovery=JSON.stringify(state.settings.discovery||{});
 const [recovered,setRecovered]=useState(()=>readRecovery(runtime.actor.id));
 const [draft,setDraft]=useState<DiscoverySettings>(()=>recovered?.snapshot.value||JSON.parse(savedDiscovery));
 const [baseline,setBaseline]=useState(()=>recovered?.snapshot.baseline||savedDiscovery),[dirty,setDirty]=useState(!!recovered);
 const [status,setStatus]=useState<Status>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[panel,setPanel]=useState<Panel>(),[tab,setTab]=useState('policy');
 async function load(){try{setStatus(await request<Status>('/api/discovery'));setError('');}catch(e){setError((e as Error).message);}}
 // 只有资料本身变化且没有本地输入时才重置，刷新运行记录不会清空表单。
 useEffect(()=>{if(!dirty){form.resetFields();form.setFieldsValue(JSON.parse(savedDiscovery));setDraft(JSON.parse(savedDiscovery));setBaseline(savedDiscovery);}},[savedDiscovery,form,dirty]);
 // 恢复内容仅在挂载时放回表单；不使用可变initialValues，避免重置后复活已删除的配置。
 useEffect(()=>{if(recovered)form.setFieldsValue(recovered.snapshot.value);},[form]);
 useEffect(()=>{if(runtime.actor.role==='admin')void load();},[runtime.actor.role]);
 useEffect(()=>{const resume=(event:Event)=>{if((event as CustomEvent<{scope?:string}>).detail?.scope!=='discovery-settings')return;const entry=readRecovery(runtime.actor.id);if(entry){setRecovered(entry);form.resetFields();form.setFieldsValue(entry.snapshot.value);setDraft(entry.snapshot.value);setBaseline(entry.snapshot.baseline);setDirty(true);setPanel('company');}};window.addEventListener('form-studio:recover-local',resume);return()=>window.removeEventListener('form-studio:recover-local',resume);},[form,runtime.actor.id]);
 async function action(work:()=>Promise<unknown>,success:string){if(busy)return;setBusy(true);try{await work();message.success(success);await load();}catch(e){message.error((e as Error).message);}finally{setBusy(false);}}
 async function save(){
  if(busy)return false;setBusy(true);
  try{
   await form.validateFields();
   if(JSON.stringify(runtime.getEnvelope().state.settings.discovery||{})!==baseline)throw Error('已保存的资料发生了变化，输入已保留。请先核对最新资料。');
   // getFieldsValue(true)包含未打开的高级设置，避免只改公司名称却丢失访问政策或模型映射。
   const value=form.getFieldsValue(true);
   await update({settings:{...runtime.getEnvelope().state.settings,discovery:value}});
   setDirty(false);setRecovered(undefined);guard.clear();message.success('资料已保存，发布后对外生效');await load();return true;
  }catch(e){if(e&&typeof e==='object'&&'errorFields' in e){setPanel('company');message.error('请检查标出的资料项');}else message.error((e as Error).message);return false;}finally{setBusy(false);}
 }
 const guard=useLocalDraftGuard({actorId:runtime.actor.id,scope:'discovery-settings',screen:'settings',title:'搜索与AI资料',dirty,busy,snapshot:{value:draft,baseline},save,discard:()=>{setDirty(false);setRecovered(undefined);}});
 const go=(target:Parameters<ScreenProps['navigate']>[0])=>guard.ask(()=>navigate(target));
 function download(value:unknown,name:string){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 if(runtime.actor.role!=='admin')return <Alert type="info" title="搜索与AI设置仅管理员可用"/>;
 const company=<>
  <Typography.Paragraph type="secondary">填写真实的公开资料，不清楚的项目可以留空。</Typography.Paragraph>
  <Form.Item name={['organization','legalName']} label="公司全称"><Input maxLength={200} placeholder="与对外使用的正式名称一致"/></Form.Item>
  <Form.Item name={['organization','role']} label="主要业务"><Input.TextArea rows={2} maxLength={200} placeholder="介绍主营产品、服务和面向的客户"/></Form.Item>
  <Form.Item name={['organization','address']} label="公司地址"><Input maxLength={1000}/></Form.Item>
  <Form.Item name={['organization','telephone']} label="联系电话"><Input maxLength={200}/></Form.Item>
  <Collapse items={[{key:'identity',label:'其他名称与官方链接（选填）',children:<>
   <Form.Item name={['organization','alternateName']} label="其他名称 / 品牌名称"><Input maxLength={200}/></Form.Item>
   <Form.List name={['organization','sameAs']}>{(fields,{add,remove})=><Space orientation="vertical" style={{width:'100%'}}><Typography.Text type="secondary">填写企业的官方社交主页等网址，使用 https:// 开头的链接。</Typography.Text>{fields.map(f=><Flex key={f.key} gap={8}><Form.Item name={f.name} style={{flex:1}}><Input aria-label={`官方链接${f.name+1}`} placeholder="https://…" maxLength={2048}/></Form.Item><Button danger onClick={()=>remove(f.name)}>移除</Button></Flex>)}<Button disabled={fields.length>=12} onClick={()=>add('')}>添加官方链接</Button></Space>}</Form.List>
  </>}]} />
 </>;
 const facts=<>
  <Divider/>
  <Typography.Title level={5}>资质与实力说明 <Typography.Text type="secondary">（选填）</Typography.Text></Typography.Title>
  <Typography.Paragraph type="secondary">例如真实资质、服务范围或工厂能力。确认无误的说明，才能随设置发布。</Typography.Paragraph>
  <Form.List name="facts">{(fields,{add,remove})=><Space orientation="vertical" style={{width:'100%'}}>{fields.map(f=><Card key={f.key} size="small" title={`说明 ${f.name+1}`} extra={<Button danger onClick={()=>remove(f.name)}>移除</Button>}>
   <Form.Item name={[f.name,'id']} hidden><Input/></Form.Item>
   <Form.Item name={[f.name,'title']} label="说明标题" rules={[{required:true,message:'请填写说明标题'}]}><Input maxLength={200} placeholder="例如：服务范围"/></Form.Item>
   <Form.Item name={[f.name,'value']} label="具体内容" rules={[{validator:(_,v)=>form.getFieldValue(['facts',f.name,'status'])==='reviewed'&&!v?.trim()?Promise.reject(new Error('已确认的说明需要填写具体内容')):Promise.resolve()}]}><Input.TextArea rows={3} maxLength={4000}/></Form.Item>
   {/* 仅用户主动确认时补UTC核对日期；打开或保存资料不会刷新已有日期。 */}
   <Form.Item name={[f.name,'status']} getValueProps={v=>({checked:v==='reviewed'})} getValueFromEvent={e=>e.target.checked?'reviewed':'pending'}>
    <Checkbox onChange={e=>{if(e.target.checked&&!form.getFieldValue(['facts',f.name,'reviewedAt'])){const date=new Date().toISOString().slice(0,10);form.setFieldValue(['facts',f.name,'reviewedAt'],date);setDraft(form.getFieldsValue(true));}}}>我已核对，信息准确，可随设置发布</Checkbox>
   </Form.Item>
   <Collapse items={[{key:'proof',label:'来源、适用范围与日期',forceRender:true,children:<>
    <Form.Item name={[f.name,'scope']} label="适用范围与限制"><Input.TextArea rows={2} maxLength={1000}/></Form.Item>
    <Form.Item name={[f.name,'sourceUrl']} label="证明资料链接（选填）"><Input placeholder="https://…" maxLength={2048}/></Form.Item>
    <Flex wrap gap={16}><Form.Item name={[f.name,'reviewedAt']} label="核对日期（UTC）" rules={[{validator:(_,v)=>form.getFieldValue(['facts',f.name,'status'])==='reviewed'&&!v?Promise.reject(new Error('请填写核对日期')):Promise.resolve()}]}><Input type="date"/></Form.Item><Form.Item name={[f.name,'validUntil']} label="有效期至（选填）"><Input type="date"/></Form.Item></Flex>
   </>}]} />
  </Card>)}<Button disabled={fields.length>=100} onClick={()=>add({id:`fact-${crypto.randomUUID()}`,title:'',value:'',scope:'',sourceUrl:'',reviewedAt:'',validUntil:'',status:'pending'})}>添加一条说明</Button></Space>}</Form.List>
  <Typography.Paragraph type="secondary" style={{marginTop:16}}>想在网页展示这些说明：到页面编辑器添加“企业事实与证据”组件，再发布页面和设置。系统不会自动插入网页。</Typography.Paragraph>
 </>;
 const templates=<Space orientation="vertical" size={16} style={{width:'100%'}}>
  <Typography.Paragraph type="secondary">有用的内容比反复调整开关更重要。先完善产品，再按业务需要补充真实资料。</Typography.Paragraph>
  <Space wrap><Button onClick={()=>go('products')}>完善产品信息</Button><Button onClick={()=>go('content-models')}>编辑已有内容</Button></Space>
  <Divider style={{margin:'4px 0'}}/>
  <Typography.Title level={5} style={{margin:0}}>需要新的内容栏目？</Typography.Title>
  {DISCOVERY_PRESETS.map(p=><Card key={p.id} size="small" title={p.name} extra={<Button loading={busy} onClick={()=>{if(dirty){message.info('请先保存资料，再创建栏目，当前输入会保留');return;}void action(()=>runtime.mutate(base=>request<StudioEnvelope>('/api/discovery/presets',{method:'POST',body:JSON.stringify({kind:p.id,expectedRevision:base.revision})})),'栏目已创建，请到内容管理填写资料');}}>创建栏目</Button>}><Typography.Text type="secondary">{presetDescriptions[p.id]}</Typography.Text></Card>)}
  <Typography.Text type="secondary">创建后在“内容管理”中填写资料和调整模板。不会生成示例记录，也不会自动发布。</Typography.Text>
 </Space>;
 const policy=<Space orientation="vertical" style={{width:'100%'}}><Alert type="info" title="搜索参与和训练偏好分别设置" description="默认沿用平台规则。Google-Extended还影响部分Gemini grounding，不影响Google Search；用户触发取页可能不遵守robots。这里不能替代权限或CDN设置。"/>{(['openai','claude','perplexity'] as const).map(k=><Form.Item key={k} name={['search',k]} label={`${k} 搜索抓取`} getValueProps={value=>({checked:value!==false})}><Switch checkedChildren="允许" unCheckedChildren="禁止"/></Form.Item>)}{(['openai','claude','googleExtended'] as const).map(k=><Form.Item key={k} name={['training',k]} label={`${k} 训练/扩展用途偏好`}><Select options={[{value:'inherit',label:'沿用平台默认'},{value:'allow',label:'明确允许'},{value:'deny',label:'明确拒绝'}]}/></Form.Item>)}<Alert type="warning" title="Bing新偏好尚待2027生效" description="微软公告的新训练/grounding偏好从2027-02-01随重抓生效，2027-03-01迁移旧标记。本版不伪造已生效的通用控制；见官方规则入口。"/><Form.Item name="llms" label="AI阅读目录（llms.txt）" valuePropName="checked"><Switch/></Form.Item><Typography.Text type="secondary">仅列当前发布且允许索引的网址。Google Search不使用此目录提升排名；未开启时返回404。</Typography.Text></Space>;
 const mappings=<Space orientation="vertical" style={{width:'100%'}}><Alert type="info" title="按内容模型映射真实语义" description="正文与结构化资料共用字段；不为询价产品创造价格、Offer或评分。字段须为对应模型的文字字段。"/><Form.List name="mappings">{(fields,{add,remove})=><Space orientation="vertical" style={{width:'100%'}}>{fields.map(f=><Card key={f.key} size="small" extra={<Button danger onClick={()=>remove(f.name)}>移除</Button>}><Form.Item name={[f.name,'modelId']} label="内容模型"><Select options={(state.contentModels||[]).map(m=>({value:m.id,label:m.name}))}/></Form.Item><Form.Item name={[f.name,'type']} label="内容类型"><Select options={['WebPage','Article','TechArticle'].map(value=>({value,label:value}))}/></Form.Item><Form.Item noStyle shouldUpdate>{({getFieldValue})=>{const id=getFieldValue(['mappings',f.name,'modelId']),options=(state.contentModels?.find(m=>m.id===id)?.fields||[]).filter(x=>['text','textarea'].includes(x.type)).map(x=>({value:x.id,label:x.label}));return <><Form.Item name={[f.name,'authorFieldId']} label="实际作者/负责人字段"><Select allowClear options={options}/></Form.Item><Form.Item name={[f.name,'descriptionFieldId']} label="摘要字段"><Select allowClear options={options}/></Form.Item></>;}}</Form.Item></Card>)}<Button onClick={()=>add({modelId:'',type:'WebPage'})}>添加模型映射</Button></Space>}</Form.List></Space>;
 const health=<Space orientation="vertical" style={{width:'100%'}}><Descriptions size="small" column={1} items={[{key:'routes',label:'当前可索引公开网址',children:status?.publicRoutes??'未加载'},{key:'release',label:'检查版本',children:status?.activeReleaseId||'尚未发布'},{key:'scope',label:'范围',children:'代码与资料检查；不等于搜索引擎已索引或AI已推荐'}]}/><Table size="small" rowKey={(_,i)=>String(i)} pagination={{pageSize:10}} dataSource={status?.draftIssues||[]} columns={[{title:'工作区提示',dataIndex:'message'},{title:'网址',dataIndex:'path',responsive:['md']},{title:'级别',dataIndex:'level',render:v=><Tag color={v==='warning'?'orange':'blue'}>{v==='warning'?'需要检查':'建议'}</Tag>}]}/><Collapse items={[{key:'public',label:`公开版本提示（${status?.publicIssues.length||0}）`,children:(status?.publicIssues||[]).map((i,n)=><Typography.Paragraph key={n}>{i.path} · {i.message}</Typography.Paragraph>)}]}/><Button onClick={()=>navigate('editor')}>进入页面编辑器</Button></Space>;
 const observe=<Space orientation="vertical" style={{width:'100%'}}><Alert type="info" title="记录真实来源，不计算通用AI排名分" description="Google AI报表目前主要为展示数据，日期采用PT；Bing引用不等于推荐位置。人工回答样本、可识别引荐与询盘要分开。没有数据不是零。"/><Form form={observation} layout="vertical" initialValues={{kind:'manual-answer',platform:'',date:'',timezone:'UTC',count:1,url:'',source:'',notes:''}} onFinish={v=>void action(()=>request('/api/discovery',{method:'POST',body:JSON.stringify({action:'record',rows:[v]})}),'观测已记录')}><Form.Item name="kind" label="指标"><Select options={metrics.map(([value,label])=>({value,label}))}/></Form.Item><Flex gap={12} wrap><Form.Item name="platform" label="平台" rules={[{required:true}]}><Input maxLength={100}/></Form.Item><Form.Item name="date" label="数据日期 YYYY-MM-DD" rules={[{required:true}]}><Input/></Form.Item><Form.Item name="timezone" label="来源时区"><Select style={{minWidth:180}} options={['UTC','America/Los_Angeles','Asia/Hong_Kong'].map(value=>({value,label:value}))}/></Form.Item><Form.Item name="count" label="原始数量"><InputNumber min={0} max={1e12} precision={0}/></Form.Item></Flex><Form.Item name="url" label="被引/落地网址（可留空）"><Input maxLength={2048}/></Form.Item><Form.Item name="source" label="证据来源/文件及覆盖范围" rules={[{required:true}]}><Input.TextArea maxLength={2000}/></Form.Item><Form.Item name="notes" label="样本问题、语言、是否联网、结果和限制"><Input.TextArea rows={3} maxLength={4000}/></Form.Item><Button type="primary" htmlType="submit" loading={busy}>记录观测</Button></Form><Flex gap={8} wrap><Button onClick={()=>download(status?.observations||[],'discovery-observations.json')}>导出已加载记录</Button><Upload accept=".json" showUploadList={false} beforeUpload={file=>{void action(async()=>{if(file.size>30000)throw Error('每批JSON不超过30KB/100条');const rows=JSON.parse(await file.text());await request('/api/discovery',{method:'POST',body:JSON.stringify({action:'record',rows})});},'观测批次已导入');return false;}}><Button loading={busy}>导入观测JSON</Button></Upload><Button disabled={!status?.observations.length} onClick={()=>{void (async()=>{try{const next=await request<Status>(`/api/discovery?before=${status!.observations.at(-1)!.id}`);setStatus(old=>old?{...old,observations:[...old.observations,...next.observations]}:next);if(!next.observations.length)message.info('没有更早的记录');}catch(e){message.error((e as Error).message);}})();}}>加载更早记录</Button></Flex><Table scroll={{x:760}} rowKey="id" size="small" pagination={{pageSize:8}} dataSource={status?.observations||[]} columns={[{title:'日期/时区',render:(_,v)=>`${v.date} · ${v.timezone}`},{title:'平台',dataIndex:'platform'},{title:'指标',dataIndex:'kind',render:v=>metrics.find(x=>x[0]===v)?.[1]||v},{title:'数量',dataIndex:'count'},{title:'操作',render:(_,v)=><Popconfirm title="删除这条运行观测？不影响网站内容。" onConfirm={()=>action(()=>request('/api/discovery',{method:'POST',body:JSON.stringify({action:'delete',id:v.id})}),'观测已删除')}><Button danger size="small">删除</Button></Popconfirm>}]} expandable={{expandedRowRender:v=><Typography.Paragraph style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{v.source}{'\n'}{v.url}{'\n'}{v.notes}</Typography.Paragraph>}}/></Space>;
 const operations=<Space orientation="vertical" style={{width:'100%'}}><Alert type="info" title={status?.indexNow.enabled?(status.indexNow.keyConfigured?'实例已启用IndexNow发送':'已开启但缺少有效所有权key，暂不发送'):'IndexNow对外发送未启用'} description="需要运维显式设置环境开关和所有权key。成功发布后排队；200只是已接收，202为验证处理中。平台凭据不进入公开配置或分发。"/><Table rowKey="id" size="small" scroll={{x:600}} dataSource={status?.indexNow.jobs||[]} columns={[{title:'时间',dataIndex:'createdAt'},{title:'状态',dataIndex:'status',render:v=>({'pending':'待发送/重试','processing':'发送中','accepted':'已接收（不等于收录）','verification-pending':'所有权验证中','failed':'失败'}[String(v)]||v)},{title:'尝试',dataIndex:'attempts'},{title:'响应',dataIndex:'responseCode'}]}/><Alert type="info" title={status?.crawl.enabled?'最小抓取计数已启用':'最小抓取计数未启用'} description="可选环境FORM_STUDIO_CRAWL_LOG=true；仅记录成功公开页的UA类别/路径/UTC日期，保留30天。不保存IP/Cookie/正文/查询串。UA仅声称身份，未经核验，不能当成收录证据。"/><Table rowKey={v=>v.day+v.agent} size="small" dataSource={status?.crawl.items||[]} columns={[{title:'日期UTC',dataIndex:'day'},{title:'声称机器人',dataIndex:'agent'},{title:'请求数',dataIndex:'count'}]}/></Space>;

 const origin=status?.publicFeatures.publicUrl;
 const localPreview=!!origin&&['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname);
 const draftOrigin=publicSiteOrigin(state.settings.publicUrl);
 const needsWebsiteUrl=!draftOrigin||['localhost','127.0.0.1','[::1]'].includes(new URL(draftOrigin).hostname);
 const openSiteSettings=()=>guard.ask(()=>onEditSite?.());
 const issues=(status?.draftIssues||[]).map(issue=>({...friendlyIssue(issue),path:issue.path}));
 const steps=[
  {key:'company' as const,title:'完善公司资料',description:'告诉客户你是谁、主营什么，以及有哪些真实资质。',button:'编辑资料'},
  {key:'content' as const,title:'补充网站内容',description:'完善产品说明，按需添加工厂介绍、案例和采购指南。',button:'管理内容'},
  {key:'check' as const,title:'检查并发布',description:'检查需要补充的地方，再到发布管理让修改对外生效。',button:'查看建议'},
 ];
 const pendingLlms=!!state.settings.discovery?.llms!==!!status?.publicFeatures.llms;
 const saveFooter=<Flex justify="space-between" align="center" gap={12} wrap><Typography.Text type="secondary">保存后，还需发布才对外生效。</Typography.Text><Space><Button onClick={()=>setPanel(undefined)}>收起</Button><Button type="primary" loading={busy} onClick={()=>void save()}>保存资料</Button></Space></Flex>;
 return <Form form={form} component={false} layout="vertical" disabled={busy} onValuesChange={()=>{setDraft(form.getFieldsValue(true));setDirty(true);}}>
  {guard.dialog}
  <Space orientation="vertical" size={20} style={{width:'100%',minWidth:0}}>
   <Flex justify="space-between" align="start" wrap gap={12}><div><Typography.Title level={4} style={{margin:'0 0 8px'}}>让客户更容易找到你</Typography.Title><Typography.Text type="secondary">补充真实资料，帮助搜索引擎和AI理解你的业务。</Typography.Text></div><Button loading={busy} onClick={load}>刷新状态</Button></Flex>
   {error&&<Alert type="error" showIcon title="暂时无法读取最新状态" description={error} action={<Button onClick={load}>重试</Button>}/>}
   {recovered&&<Alert type="info" showIcon title="已恢复上次未保存的输入，请核对后保存。"/>}
   {dirty&&savedDiscovery!==baseline&&<Alert type="warning" showIcon title="已保存的资料发生了变化，当前输入仍保留。" action={<Popconfirm title="放弃当前输入，读取已保存资料？" onConfirm={()=>{setDirty(false);setRecovered(undefined);guard.clear();}}><Button>读取已保存资料</Button></Popconfirm>}/>}
   <Row gutter={[12,12]}>
    <Col xs={24} sm={8}><Card size="small" style={{height:'100%'}}><Typography.Text type="secondary">网站状态</Typography.Text><div style={{marginTop:8}}><Tag color={status?.activeReleaseId?'blue':'default'}>{!status?'读取中':status.activeReleaseId?(localPreview?'本机预览':'已有发布版本'):'尚未发布'}</Tag></div><Typography.Paragraph type="secondary" style={{margin:'8px 0 0'}}>{status?`已发布 ${status.publicRoutes} 个可访问页面`:'正在读取发布状态'}</Typography.Paragraph></Card></Col>
    <Col xs={24} sm={8}><Card size="small" style={{height:'100%'}}><Typography.Text type="secondary">AI阅读目录</Typography.Text><div style={{marginTop:8}}><Tag color={status?.publicFeatures.llms?'green':'default'}>{!status?'读取中':status.publicFeatures.llms?'已开启':'未开启'}</Tag>{status&&pendingLlms&&<Tag>草稿有修改</Tag>}</div><Typography.Paragraph type="secondary" style={{margin:'8px 0 0'}}>{status?.publicFeatures.llms?'整理已发布的网址，方便工具读取':'可在高级设置中开启'}</Typography.Paragraph></Card></Col>
    <Col xs={24} sm={8}><Card size="small" style={{height:'100%'}}><Typography.Text type="secondary">抓取访问记录</Typography.Text><div style={{marginTop:8}}><Tag color={status?.crawl.enabled?'green':'default'}>{!status?'读取中':status.crawl.enabled?'已开启':'未开启'}</Tag></div><Typography.Paragraph type="secondary" style={{margin:'8px 0 0'}}>记录访问请求，不代表已被收录</Typography.Paragraph></Card></Col>
   </Row>
   {needsWebsiteUrl&&<Alert type="info" showIcon title="上线前，记得填写网站的正式网址" description="目前用于本机预览。填写真实域名并发布设置后，外部搜索服务才能按正式地址访问。" action={onEditSite&&<Button onClick={openSiteSettings}>填写网址</Button>}/>}
   <Card title="日常只需要做好这三件事" extra={dirty?<Tag color="gold">资料尚未保存</Tag>:undefined}>
    {steps.map((step,index)=><div key={step.key}>{index>0&&<Divider style={{margin:'20px 0'}}/>}<Flex gap={16} align="start"><Avatar size={32} style={{flexShrink:0}}>{index+1}</Avatar><Flex style={{flex:1,minWidth:0}} gap={16} justify="space-between" align="center" wrap><div><Typography.Title level={5} style={{margin:'0 0 6px'}}>{step.title}</Typography.Title><Typography.Text type="secondary">{step.description}</Typography.Text></div><Button onClick={()=>setPanel(step.key)}>{step.button}</Button></Flex></Flex></div>)}
   </Card>
   <Flex align="center" justify="space-between" gap={12} wrap><Typography.Text type="secondary">技术配置已集中收起，日常维护无需反复调整。</Typography.Text><Button onClick={()=>setPanel('advanced')}>高级设置</Button></Flex>
  </Space>
  <Drawer title="完善公司资料" size={720} open={panel==='company'} onClose={()=>setPanel(undefined)} footer={saveFooter}>
   {company}{facts}
  </Drawer>
  <Drawer title="补充网站内容" size={720} open={panel==='content'} onClose={()=>setPanel(undefined)}>{templates}</Drawer>
  <Drawer title="检查并发布" size={720} open={panel==='check'} onClose={()=>setPanel(undefined)} footer={<Space wrap><Button onClick={()=>setPanel(undefined)}>收起</Button><Button type="primary" loading={busy} onClick={async()=>{if(dirty&&!await save())return;go('releases');}}>前往发布管理</Button></Space>}>
   <Typography.Paragraph>以下建议基于已保存的草稿。发布时请勾选“站点设置”，页面改动也需要选中对应页面。</Typography.Paragraph>
   {dirty&&<Alert type="info" showIcon title="当前还有未保存的资料" action={<Button loading={busy} onClick={()=>void save()}>先保存资料</Button>}/>}
   <Space orientation="vertical" size={12} style={{width:'100%',marginTop:16}}>{!status?<Alert type="info" title="正在读取检查结果，请稍后刷新状态。"/>:issues.length?issues.map((issue,index)=><Card key={index} size="small"><Flex gap={12} wrap justify="space-between" align="start"><div style={{flex:'1 1 260px',minWidth:0}}><Typography.Text strong>{issue.title}</Typography.Text><Typography.Paragraph type="secondary" style={{margin:'8px 0',overflowWrap:'anywhere'}}>{issue.detail}</Typography.Paragraph><Typography.Text type="secondary" style={{overflowWrap:'anywhere'}}>相关页面：{issue.path}</Typography.Text></div><Button onClick={()=>issue.target==='company'?setPanel('company'):issue.target==='general'?openSiteSettings():go('editor')}>{issue.target==='company'?'补充资料':issue.target==='general'?'填写网址':'打开编辑器'}</Button></Flex></Card>):<Alert type="success" showIcon title="暂未发现需要补充的基础资料" description="可前往发布管理核对并发布。"/>}</Space>
   <Typography.Paragraph type="secondary" style={{marginTop:16}}>这些是资料和页面检查建议，不代表搜索引擎已收录或AI已经推荐。</Typography.Paragraph>
  </Drawer>
  <Drawer title="高级设置" size={880} open={panel==='advanced'} onClose={()=>setPanel(undefined)} footer={saveFooter}>
   <Typography.Paragraph type="secondary">供建站维护人员使用。这里保留访问规则、内容映射、技术诊断与运行记录。</Typography.Paragraph>
   <Tabs activeKey={tab} onChange={setTab} items={[
    {key:'policy',label:'访问规则',children:policy},{key:'mappings',label:'内容映射',children:mappings},
    {key:'health',label:'技术检查',children:health},{key:'operations',label:'提交与抓取',children:operations},
    {key:'observe',label:'效果记录',children:observe},
    {key:'sources',label:'规则来源',children:<><Typography.Paragraph>规则核对 {status?.policyDate}。引用、索引、推荐、流量和训练许可分别处理；平台规则会变化。Google AI参与设置在Search Console中核对，后台尚未连接平台账号。</Typography.Paragraph>{status?.sources.map(s=><Typography.Paragraph key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a></Typography.Paragraph>)}</>},
   ]}/>
  </Drawer>
 </Form>;
}
