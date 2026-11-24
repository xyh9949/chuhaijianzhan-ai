'use client';
import React from 'react';
import {Alert,Button,Collapse,Form,Input,Popconfirm,Space,Typography} from 'antd';
import {createUsePuck} from '@puckeditor/core';
import type {MediaItem} from '@/lib/types';
import type {FreePanel} from '@/lib/presentation-content';
import {convertToFreePanels} from '@/lib/presentation-content';
import {groupedEditorFields} from './DesignFields';
import {CollectionEditor} from './PresentationFields';

const usePanelPuck=createUsePuck();

/** 原生 array/slot 注册仍由 Puck 处理，管理操作使用 Ant；排序移动整项，不重建子节点 ID。 */
export function panelEditorFields({fields,media}:{fields:Record<string,React.ReactNode>;media:MediaItem[]}){return <PanelEditorFields fields={fields} media={media}/>;}
function PanelEditorFields({fields,media}:{fields:Record<string,React.ReactNode>;media:MediaItem[]}){
 const item=usePanelPuck(store=>store.selectedItem);
 const next={...fields};
 if(item){const key=item.type==='Carousel'?'slides':'items';next[key]=<PanelManager media={media}/>;if(item.props.panelMode==='free'){delete next.ratio;delete next.fit;}}
 return groupedEditorFields({fields:next});
}
function PanelManager({media}:{media:MediaItem[]}){
 const {selectedItem:item,dispatch,getSelectorForId}=usePanelPuck(store=>store);
 if(!item)return null;
 const carousel=item.type==='Carousel',key=carousel?'slides':'items',max=carousel?10:item.type==='Tabs'?8:50;
 const locked=!!item.props.locked,panels:FreePanel[]=item.props[key]||[];
 const replace=(props:Record<string,any>)=>{const selector=getSelectorForId(item.props.id);if(selector)dispatch({type:'replace',destinationIndex:selector.index,destinationZone:selector.zone,data:{...item,props:{...props,id:item.props.id}}});};
 const change=(values:FreePanel[])=>replace({...item.props,[key]:values});
 if(item.props.panelMode!=='free')return <Space orientation="vertical" style={{width:'100%'}}><Alert type="info" title="当前使用旧版内容" description="可以继续编辑；转换后，每一项内部都能拖入图片、文字和按钮。转换可以撤销，布局可继续调整。"/><Button block onClick={()=>replace(convertToFreePanels(item.type,item.props))} disabled={locked}>转换为自由拖拽排版</Button><CollectionEditor media={media} images={carousel} max={max} value={carousel?item.props.images:item.props.items} readOnly={locked} onChange={values=>replace({...item.props,[carousel?'images':'items']:values})}/></Space>;
 const patch=(index:number,title:string)=>change(panels.map((panel,i)=>i===index?{...panel,title}:panel));
 const move=(index:number,delta:number)=>{const values=[...panels];[values[index],values[index+delta]]=[values[index+delta],values[index]];change(values);};
 function addContainer(index:number){
  const content={type:'Container',props:{id:`panel-container-${crypto.randomUUID()}`,content:[],layout:'column',columns:1,mobileColumns:1,gap:16,padding:16,inset:16,background:'transparent',image:'',minHeight:100,align:'start'}};
  change(panels.map((panel,i)=>i===index?{...panel,content:[...panel.content,content]}:panel));
 }
 return <div className="editor-panel-manager"><Typography.Paragraph type="secondary">画布中已展开所有内容项，直接拖入控件即可。实际切换效果请使用“交互模式”或预览。</Typography.Paragraph><Collapse size="small" defaultActiveKey={panels.slice(0,1).map(panel=>panel.id)} items={panels.map((panel,index)=>({key:panel.id,label:`${index+1}. ${panel.title||'未命名'}`,children:<><Form.Item label="本项标题" htmlFor={`panel-title-${item.props.id}-${panel.id}`}><Input id={`panel-title-${item.props.id}-${panel.id}`} value={panel.title} maxLength={300} disabled={locked} onChange={event=>patch(index,event.target.value)}/></Form.Item><Space wrap size={4}><Button size="small" disabled={locked||index===0} aria-label={`上移内容项${index+1}`} onClick={()=>move(index,-1)}>上移</Button><Button size="small" disabled={locked||index===panels.length-1} aria-label={`下移内容项${index+1}`} onClick={()=>move(index,1)}>下移</Button><Button size="small" disabled={locked} onClick={()=>addContainer(index)}>添加内容容器</Button><Popconfirm title="移除这一项及其中的内容？" description="移除后可使用撤销恢复。" onConfirm={()=>change(panels.filter((_,i)=>i!==index))} okText="移除" cancelText="取消" disabled={locked}><Button size="small" danger disabled={locked}>移除</Button></Popconfirm></Space></>}))}/><Button block style={{marginTop:12}} disabled={locked||panels.length>=max} onClick={()=>change([...panels,{id:`item-${crypto.randomUUID()}`,title:carousel?'New slide':item.type==='Tabs'?'New tab':'New question',content:[]}])}>添加{carousel?'轮播内容':item.type==='Tabs'?'标签页':'折叠内容'}（{panels.length}/{max}）</Button></div>;
}
