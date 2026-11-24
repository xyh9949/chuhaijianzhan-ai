import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Render} from '@puckeditor/core/rsc';
import type {ComponentData,Data} from '@puckeditor/core';
import {BUSINESS_BLOCKS,createBusinessBlock} from '../src/lib/business-blocks';
import {createInitialDraft} from '../src/server/seed';
import {validatePageData,collectReferences} from '../src/server/validation';
import {createSiteConfig} from '../src/lib/site-render-config';
import {convertToFreePanels,createFreePanelNode,initialPanelProps} from '../src/lib/presentation-content';
import {editorNodes,appendEditorNodeToZone,cloneEditorNode,moveTargets} from '../src/lib/editor-layout';
import {advancedLayoutErrors} from '../src/lib/advanced-layout';
import {createSharedBlockNodeCounter} from '../src/lib/shared-blocks';

const draft=()=>createInitialDraft();
const page=(content:ComponentData[]):Data=>({root:{props:{title:'Block test',showChrome:'no'} as Data['root']['props']},content});
const text=(id:string,value='A verified detail'):ComponentData=>({type:'Text',props:{id,text:value}});
const panel=(type='Tabs'):ComponentData=>({type,props:{id:'panels',panelMode:'free',[type==='Carousel'?'slides':'items']:[{id:'a',title:'First',content:[text('first-child')]},{id:'b',title:'Second',content:[]}]}});

test('18种业务区块均为合法可发布组件，重复插入ID独立，不改来源资料',()=>{
 const state=draft(),before=structuredClone(state),all:ComponentData[]=[];
 assert.equal(BUSINESS_BLOCKS.length,18);
 for(const item of BUSINESS_BLOCKS){
  const one=createBusinessBlock(item.id,state),two=createBusinessBlock(item.id,state);
  validatePageData(page([one,two]),item.title,true);
  const html=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...state,pageId:'home'}),data:page([one])}));
  assert.ok(html.length>100,item.title);assert.ok(!html.includes('site-panel-editor'),'公开端不能出现编辑提示');
  all.push(one);
 }
 assert.equal(new Set(editorNodes(page(all)).map(node=>node.id)).size,editorNodes(page(all)).length);
 assert.deepEqual(state,before);assert.ok(!JSON.stringify(createBusinessBlock('figures',state)).includes('1000+'));
});

test('采购和定制区块保留独立可拖放的面板，质检及物流用不同的层级组织内容',()=>{
 const state=draft();
 for(const [blockId,panelType] of [['buying-guide','Accordion'],['customization','Tabs']] as const){
  const data=page([createBusinessBlock(blockId,state)]);
  const area=editorNodes(data).find(item=>item.type===panelType);
  assert.ok(area);
  const zone=`${area.id}:items[1].content`;
  assert.ok(editorNodes(data).some(item=>item.zone===zone));
  const inserted=appendEditorNodeToZone(data,text('custom-copy','Add a verified procurement detail'),zone);
  assert.equal(editorNodes(inserted).find(item=>item.id==='custom-copy')?.zone,zone);
  validatePageData(inserted,'区块内新增控件',true);
 }
 const quality=editorNodes(page([createBusinessBlock('quality-dispatch',state)]));
 assert.ok(quality.some(item=>item.type==='ProjectTimeline'));
 assert.ok(quality.some(item=>item.type==='Image'));
 const logistics=editorNodes(page([createBusinessBlock('packing-logistics',state)]));
 assert.equal(logistics.filter(item=>item.type==='Divider').length,2);
});

test('新区块只在存在当前联系页或企业邮箱时提供询盘入口',()=>{
 const state=draft();
 const blank:ReturnType<typeof draft>={...state,pages:[],settings:{...state.settings,email:''}};
 const action=(source:typeof blank)=>{
  const [layout]=createBusinessBlock('buying-guide',source).props.content as ComponentData[];
  const [intro]=layout.props.content as ComponentData[];
  return (intro.props.content as ComponentData[]).find(item=>item.type==='ActionButton');
 };
 assert.equal(action(blank),undefined);
 assert.equal(action({...blank,pages:[{...state.pages[0],slug:'/contact'}]})?.props.href,'/contact');
 assert.equal(action({...blank,settings:{...blank.settings,email:'purchase@example.invalid'}})?.props.href,'mailto:purchase@example.invalid');
});

test('数组slot服务端递归渲染所有类型，文字转义且保留无JS切换语义',()=>{
 const state=draft();
 for(const type of ['Tabs','Accordion','Carousel']){
  const data=page([panel(type)]),html=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...state,pageId:'home'}),data}));
  assert.match(html,/A verified detail/);assert.match(html,/(?:site-tabs|site-accordion|site-carousel)[^"]*editor-design-node/);assert.ok(!html.includes('site-panel-editor'));
  if(type==='Tabs')assert.match(html,/type="radio"/);
  if(type==='Accordion')assert.match(html,/<details>/);
  if(type==='Carousel')assert.match(html,/Next slide/);
  data.content[0].props[type==='Carousel'?'slides':'items'][0].content[0].props.text='<script>bad()</script>';
  const escaped=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...state,pageId:'home'}),data}));assert.ok(escaped.includes('&lt;script&gt;'));assert.ok(!escaped.includes('<script>bad()'));
 }
});

test('旧正文与图片仅显式转换且完整保留，原数据不变',()=>{
 const old={id:'legacy',items:[{id:'q',title:'Question',body:'Line one\nLine two'}],firstOpen:false,design:{mobile:{fontSize:16}}};
 const converted=convertToFreePanels('Accordion',old),original=structuredClone(old);
 assert.equal(converted.items[0].content[0].props.text,old.items[0].body);assert.deepEqual(old,original);assert.equal(converted.firstOpen,false);assert.deepEqual(converted.design,old.design);assert.equal(converted.items[0].id,'q');
 const images={id:'photos',images:[{id:'photo',src:'/images/studio.jpg',alt:'Alternative text',caption:'Caption'}],ratio:'4/3',fit:'contain'};
 const slides=convertToFreePanels('Carousel',images);assert.equal(slides.slides[0].content[0].props.alt,'Alternative text');assert.equal(slides.slides[0].content[1].props.text,'Caption');assert.equal(slides.images,undefined);assert.equal(images.images.length,1);
 validatePageData(page([{type:'Carousel',props:{...slides,id:images.id}}]),'转换轮播',true);
 assert.equal(convertToFreePanels('Carousel',slides),slides);
});

test('面板深层节点同样拒绝重复ID、危险链接、未知组件、未转换内容和失效模式',()=>{
 for(const type of ['Tabs','Accordion','Carousel']){
  const key=type==='Carousel'?'slides':'items';
  for(const change of [(node:ComponentData)=>node.props[key][0].content.push(text('first-child')),(node:ComponentData)=>node.props[key][0].content.push({type:'ActionButton',props:{id:'bad-link',text:'Bad',href:'javascript:bad()'}}),(node:ComponentData)=>node.props[key][0].content.push({type:'UnknownWidget',props:{id:'bad-widget'}}),(node:ComponentData)=>{node.props.panelMode='unknown';}]){
   const node=panel(type);change(node);assert.throws(()=>validatePageData(page([node]),'深层验证',true));
  }
 }
 const legacy={type:'Tabs',props:{id:'legacy',items:[{id:'a',title:'Legacy',body:'Old text',content:[text('hidden')]}]}};
 assert.throws(()=>validatePageData(page([legacy]),'旧面板',true),/转换/);
});

test('图层、插入、复制和移动目标认识数组slot，复制不会共享ID或破坏其他项',()=>{
 const source=page([panel()]),before=structuredClone(source),zone='panels:items[1].content';
 const added=appendEditorNodeToZone(source,{type:'Container',props:{id:'inside',content:[text('nested')]}},zone);
 assert.deepEqual(source,before);assert.equal(editorNodes(added).find(node=>node.id==='inside')?.zone,zone);assert.equal(editorNodes(added).find(node=>node.id==='nested')?.zone,'inside:content');
 assert.equal(moveTargets(added,'inside').length,0);assert.equal(moveTargets(added,'first-child').length,1);
 const copy=cloneEditorNode(added.content[0],'copy');validatePageData(page([added.content[0],copy]),'复制面板',true);
 assert.ok(!editorNodes(page([copy])).some(node=>['inside','nested','first-child'].includes(node.id)));
 assert.equal(appendEditorNodeToZone(source,text('missing'),'missing:content'),source);
});

test('面板内部的素材引用、展开预算和通过复用样式绝对定位仍受保护',()=>{
 const state=draft(),node=panel();node.props.items[0].content.push({type:'Image',props:{id:'media',src:'/api/media/nested-image',alt:'Media'}},{type:'Container',props:{id:'container',content:[]}});
 const data=page([node]);assert.ok(collectReferences({...state,editorData:{...state.editorData,home:data}}).urls.has('/api/media/nested-image'));
 assert.ok(createSharedBlockNodeCounter([])(data)>=4);
 state.theme.presets=[{id:'absolute',name:'Absolute',design:{desktop:{position:'absolute'}}}];node.props.items[0].content[0].props.stylePresetId='absolute';
 assert.ok(advancedLayoutErrors({...state,editorData:{...state.editorData,home:data}}).length);
});

test('明确新增的三个面板默认支持拖放，渲染默认值不强制转换历史数据',()=>{
 for(const type of ['Tabs','Accordion','Carousel'] as const){assert.equal(initialPanelProps(type).panelMode,undefined);const first=createFreePanelNode(type),second=createFreePanelNode(type);assert.equal(first.props.panelMode,'free');validatePageData(page([first,second]),'新增自由面板',true);}
});
