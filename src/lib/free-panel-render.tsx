import React from 'react';
import type {Field} from '@puckeditor/core';
import {componentTranslatableLabels} from './component-translatable-labels';

/** 服务端与编辑器都必须声明深层 slot，Puck 才会把数组内容转换成可渲染/拖放区域。 */
export function panelSlotsField(max:number):Field{return {type:'array',label:'内容项',max,arrayFields:{content:{type:'slot'}}};}

/** 编辑时平铺各项，避免内容藏在未激活面板里而无法拖放；交互预览与公开站仍用原生语义。 */
export function FreePanelRender({type,id,items=[],editing=false,firstOpen=false,labels}:{type:'Tabs'|'Accordion'|'Carousel';id:string;items:any[];editing?:boolean;firstOpen?:boolean;labels?:unknown}){
 const text=componentTranslatableLabels(type,labels);
 const content=(item:any)=><item.content className="site-free-panel-content" minEmptyHeight={100}/>;
 if(editing)return <div className="site-panel-editor" data-panel-component={id}>{items.map((item,index)=><div className="site-panel-edit-item" key={item.id} data-panel-owner={id} data-panel-id={item.id}><div className="site-panel-edit-label">{type==='Tabs'?'标签页':type==='Accordion'?'折叠面板':'轮播内容'} {index+1} · {item.title||'未命名'}<small>拖入图片、文字、按钮或容器</small></div>{content(item)}</div>)}</div>;
 if(type==='Accordion')return <div className="site-accordion">{items.map((item,index)=><details key={item.id} open={firstOpen&&index===0}><summary>{item.title}</summary>{content(item)}</details>)}</div>;
 if(type==='Tabs')return <div className="site-tabs" role="group" aria-label={text.sections} style={{'--tab-count':Math.max(1,items.length)} as React.CSSProperties}>{items.map((item,index)=><div className="site-tab" key={item.id}><input type="radio" id={`${id}-tab-${item.id}`} name={`${id}-tabs`} defaultChecked={index===0} aria-label={item.title}/><label htmlFor={`${id}-tab-${item.id}`} style={{gridColumn:index+1}}>{item.title}</label><section aria-label={item.title}>{content(item)}</section></div>)}</div>;
 return <div className="site-carousel site-content-carousel"><div className="site-carousel-track" tabIndex={0} role="region" aria-label={text.content}>{items.map((item,index)=><figure key={item.id} id={`${id}-slide-${item.id}`} aria-label={item.title}>{content(item)}<nav aria-label={`${text.slide} ${index+1} ${text.controls}`}><a href={`#${id}-slide-${items[(index+items.length-1)%items.length]?.id}`} aria-label={text.previousSlide}>← {text.previous}</a><span>{index+1} / {items.length}</span><a href={`#${id}-slide-${items[(index+1)%items.length]?.id}`} aria-label={text.nextSlide}>{text.next} →</a></nav></figure>)}</div></div>;
}
