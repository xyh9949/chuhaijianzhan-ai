'use client';
import {useMemo,useState} from 'react';
import {Button,Card,Empty,Input,Modal,Segmented,Space,Typography} from 'antd';
import {EyeOutlined,PlusOutlined} from '@ant-design/icons';
import {Render,type ComponentData} from '@puckeditor/core';
import {BUSINESS_BLOCKS,createBusinessBlock,type BusinessBlockId} from '@/lib/business-blocks';
import {createSiteConfig} from '@/lib/site-render-config';
import type {StudioState} from '@/lib/types';

/** 缩略图仅提示布局；预览使用真实渲染器，插入生成独立可编辑节点，不改已有页面。 */
export default function BusinessBlockLibrary({state,onInsert,open,onClose}:{state:StudioState;onInsert:(node:ComponentData)=>void;open:boolean;onClose:()=>void}){
 const [query,setQuery]=useState(''),[group,setGroup]=useState('全部'),[preview,setPreview]=useState<BusinessBlockId>();
 const previewNode=useMemo(()=>preview?createBusinessBlock(preview,state):undefined,[preview,state]);
 const data={root:{props:{showChrome:'no',title:'区块预览'}},content:previewNode?[previewNode]:[]};
 const config=useMemo(()=>createSiteConfig({...state,products:state.products.map(product=>({...product,status:'published'})),editorCanvas:false,previewPrefix:'/preview',pageId:'block-preview',editorData:{'block-preview':data}}),[state,previewNode]);
 const blocks=BUSINESS_BLOCKS.filter(block=>(group==='全部'||block.group===group)&&`${block.title}${block.description}`.includes(query));
 function insert(id:BusinessBlockId){onInsert(createBusinessBlock(id,state));setPreview(undefined);onClose();}
 return <>
  <Modal className="business-block-library" title="现成业务区块" open={open} onCancel={onClose} footer={null} width={1000} styles={{body:{maxHeight:'76vh',overflowY:'auto'}}}>
   <Typography.Paragraph type="secondary">选择一种起点，插入后图片、文字和布局都可以继续调整。</Typography.Paragraph>
   <Space orientation="vertical" style={{width:'100%',marginBottom:20}}><Input.Search aria-label="搜索业务区块" placeholder="搜索区块用途…" allowClear value={query} onChange={event=>setQuery(event.target.value)}/><Segmented block value={group} onChange={setGroup} options={['全部','公司展示','产品与案例','联系转化']}/></Space>
   <div className="business-block-grid">{blocks.map(block=><Card key={block.id} size="small" title={block.title} cover={<div className={`business-block-art business-block-art-${block.art}`} aria-hidden="true"><div className="business-art-copy"><i/><b/><b/><span/></div><div className="business-art-panels">{Array.from({length:4},(_,i)=><span key={i}><i/><b/><b/></span>)}</div></div>}><Typography.Paragraph type="secondary">{block.description}</Typography.Paragraph><Space><Button size="small" icon={<EyeOutlined/>} aria-label={`预览${block.title}`} onClick={()=>setPreview(block.id)}>预览</Button><Button size="small" type="primary" icon={<PlusOutlined/>} aria-label={`插入${block.title}`} onClick={()=>insert(block.id)}>插入</Button></Space></Card>)}</div>
   {!blocks.length&&<Empty description="没有找到匹配的区块"/>}
  </Modal>
  <Modal title={BUSINESS_BLOCKS.find(block=>block.id===preview)?.title||'区块预览'} open={!!preview} onCancel={()=>setPreview(undefined)} width={1120} footer={<Space><Button onClick={()=>setPreview(undefined)}>返回区块列表</Button><Button type="primary" onClick={()=>preview&&insert(preview)}>插入这个区块</Button></Space>} styles={{body:{maxHeight:'70vh',overflowY:'auto'}}}><div className="business-block-preview">{previewNode&&<Render config={config} data={data}/>}</div></Modal>
 </>;
}
