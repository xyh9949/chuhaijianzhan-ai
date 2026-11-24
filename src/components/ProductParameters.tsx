'use client';
import {useState} from 'react';
import {App,Alert,Button,ConfigProvider,Drawer,Empty,List,Space,Tabs,Tag,Typography} from 'antd';
import {PlusOutlined,DeleteOutlined} from '@ant-design/icons';
import {request,useStudioRuntime,type StudioEnvelope} from '@/lib/studio-client';
import type {ContentModel} from '@/lib/types';
import {ModelEditor,clearRecovery,readRecovery,usageOf,usedCount,type ModelDraft} from './ContentEditors';
import CatalogManager from './CatalogManager';

/** 产品参数只在产品管理设置，仍按原模型ID保存，迁移入口不迁移或清空产品值。 */
export default function ProductParameters({onClose}:{onClose:()=>void}){
 const runtime=useStudioRuntime(),state=runtime.envelope.state,{message,modal}=App.useApp(),canManage=runtime.actor.role==='admin';
 const [recovered,setRecovered]=useState(()=>readRecovery(runtime.actor.id,'product'));
 const [editor,setEditor]=useState<ModelDraft|null>(()=>recovered?.kind==='model'&&canManage?recovered:null);
 const models=(state.contentModels||[]).filter(m=>m.target==='product');
 function reset(){clearRecovery(runtime.actor.id,'product');setRecovered(null);setEditor(null);}
 async function save(value:ContentModel){await runtime.mutate(env=>request<StudioEnvelope>('/api/studio',{method:'PATCH',body:JSON.stringify({expectedRevision:env.revision,patch:{contentModels:(env.state.contentModels||[]).some(m=>m.id===value.id)?env.state.contentModels!.map(m=>m.id===value.id?value:m):[...(env.state.contentModels||[]),value]}})}));reset();}
 function remove(model:ContentModel){const usage=usageOf(state,model.id);if(usedCount(usage)){modal.info({title:'这组参数仍在使用',content:`有${usage.products}件产品、${usage.pages}个页面或其他资料引用。请先调整使用这些参数的产品与页面。`});return;}modal.confirm({title:`删除“${model.name}”参数组？`,content:'只删除草稿设置，历史发布版本保留。',okText:'删除参数组',cancelText:'取消',okButtonProps:{danger:true},onOk:async()=>{try{await runtime.mutate(env=>request<StudioEnvelope>('/api/studio',{method:'PATCH',body:JSON.stringify({expectedRevision:env.revision,patch:{contentModels:(env.state.contentModels||[]).filter(m=>m.id!==model.id)}})}));message.success('参数组已删除');}catch(e){message.error((e as Error).message);throw e;}}});}
 return <ConfigProvider componentDisabled={false}><Drawer title="产品参数与分类" open size={980} onClose={()=>{if(editor){message.info('请先保存或关闭参数编辑');return;}onClose();}} className="content-parameters" destroyOnHidden>
  <Tabs items={[{key:'parameters',label:'产品参数',children:<><Alert type="info" showIcon title="给不同产品设置需要填写的参数" description="例如为橱柜增加长度、宽度和表面处理。在这里设置一次，再到产品里选择参数组、填写具体数值。"/><Space style={{margin:'20px 0'}}>{canManage&&<Button type="primary" icon={<PlusOutlined/>} onClick={()=>setEditor({kind:'model',value:{id:`model-${crypto.randomUUID()}`,name:'',description:'',target:'product',fields:[],updated:''}})}>新建参数组</Button>}</Space><List dataSource={models} rowKey="id" locale={{emptyText:<Empty description="暂未设置额外参数，产品基础资料仍可正常填写"/>}} renderItem={model=><List.Item><List.Item.Meta title={<Space wrap><Typography.Text strong>{model.name}</Typography.Text><Tag>{state.products.filter(p=>p.modelId===model.id).length} 件产品使用</Tag></Space>} description={model.fields.length?model.fields.map(f=>f.label).join('、'):'尚未添加填写项目'}/><Space wrap><Button onClick={()=>setEditor({kind:'model',value:model,existingId:model.id})}>{canManage?'编辑填写项目':'查看填写项目'}</Button>{canManage&&<Button danger type="text" aria-label={`删除参数组 ${model.name}`} icon={<DeleteOutlined/>} onClick={()=>remove(model)}/>}</Space></List.Item>}/></>},{key:'catalog',label:'分类与标签',children:<CatalogManager source="product"/>}]}/>
 </Drawer>{editor&&<ModelEditor key={editor.value.id} initial={editor.value} original={models.find(m=>m.id===editor.existingId)} state={state} imageOptions={[]} onSave={save} onClose={reset} readonly={!canManage} recovered={!!recovered&&recovered.value.id===editor.value.id}/>}</ConfigProvider>;
}
