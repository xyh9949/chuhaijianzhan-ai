import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import type { Data } from '@puckeditor/core';
import SiteNavigation from '../src/components/SiteNavigation';
import { createSiteConfig } from '../src/lib/site-render-config';
import { compileAiSiteDesign } from '../src/lib/ai-site-design';
import { prepareAiPageEdit, compileAiPageEdit } from '../src/lib/ai-page-edit';
import { createEmptyDraft } from '../src/server/seed';
import { validateDraft } from '../src/server/validation';
import type { AiPageEditRequest } from '../src/lib/ai-page-edit-types';

const items=[{key:'home',label:'Actual Factory',href:'/'}];
test('旧菜单默认保持手机折叠，单项菜单和Company home标签也不触发隐式特殊处理',()=>{
  const ordinary=renderToStaticMarkup(React.createElement(SiteNavigation,{items}));
  assert.equal(ordinary,renderToStaticMarkup(React.createElement(SiteNavigation,{items,mobileMode:'collapse'})));
  assert.match(ordinary,/site-menu-mobile/);assert.match(ordinary,/☰/);
  assert.match(renderToStaticMarkup(React.createElement(SiteNavigation,{items,label:'Company home'})),/☰/);
});

test('显式inline直接渲染始终可见链接，不生成第二个汉堡菜单且编辑模式不跳走',()=>{
  const html=renderToStaticMarkup(React.createElement(SiteNavigation,{items,label:'Any link group',mobileMode:'inline'}));
  assert.match(html,/site-menu-inline/);assert.match(html,/href="\/"/);assert.match(html,/Actual Factory/);
  assert.doesNotMatch(html,/site-menu-mobile|☰/);assert.match(html,/site-menu-desktop/);
  const editing=renderToStaticMarkup(React.createElement(SiteNavigation,{items,mobileMode:'inline',editing:true}));assert.match(editing,/Actual Factory/);assert.doesNotMatch(editing,/href=/);
});

function source(){const content=createEmptyDraft();content.settings={...content.settings,name:'Actual Factory',language:'en',locales:[{code:'en',label:'English'},{code:'de',label:'Deutsch'}]};content.pages=[{id:'home',title:'Home',slug:'/',locale:'en',status:'draft',type:'普通页面',updated:''},{id:'home-de',title:'Startseite',slug:'/de',locale:'de',status:'draft',type:'普通页面',updated:''},{id:'about',title:'About',slug:'/about',locale:'en',status:'draft',type:'普通页面',updated:''},{id:'about-de',title:'Fabrik',slug:'/de/about',locale:'de',status:'draft',type:'普通页面',updated:''}];content.editorData=Object.fromEntries(content.pages.map(page=>[page.id,{root:{props:{showChrome:'yes'}},content:[{type:'Heading',props:{id:`heading-${page.id}`,text:page.title,level:'h1'}}],zones:{}}]));content.siteLayout={header:{mode:'default',blockId:''},footer:{mode:'hidden',blockId:''},menus:[]};return content;}

test('整站原生品牌在en/de实际渲染始终展示且分别返回真实首页，主导航仍可折叠',()=>{
  const content=source(),compiled=compileAiSiteDesign(content,{expectedRevision:0,instruction:'设计页眉，品牌保持可见，导航方便手机使用。',targets:{pageIds:content.pages.map(page=>page.id),header:true,footer:false,navigation:true,style:false},preserveText:false},{summary:'设计真实品牌与导航。',operations:[{kind:'chrome',slot:'header',operations:[]}],warnings:[]},'aisd-brand-mobile');
  const header=compiled.candidate.sharedBlocks!.find(block=>block.id===compiled.candidate.siteLayout!.header.blockId)!;assert.equal(header.data.content[0].props.content[0].props.mobileMode,'inline');
  for(const [pageId,locale,href] of [['home','en','/'],['home-de','de','/de']] as const){const html=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...compiled.candidate,pageId,locale}),data:compiled.candidate.editorData[pageId] as Data}));const brand=html.match(/<nav aria-label="Company home"[\s\S]*?<\/nav>/)?.[0];assert.ok(brand);assert.match(brand,/site-menu-inline/);assert.match(brand,new RegExp(`href="${href}"`));assert.match(brand,/Actual Factory/);assert.doesNotMatch(brand,/☰|site-menu-mobile/);assert.match(html,/site-menu-mobile/);}
  assert.doesNotThrow(()=>validateDraft(compiled.candidate));
});

test('mobileMode原生枚举验证，未设保持兼容，不能夹带任意展示值',()=>{
  const content=source();content.siteLayout!.menus=[{id:'main',name:'Main',items:[{id:'home-item',label:'Home',target:{kind:'page',id:'home'}}]}];const data=content.editorData.home as Data;data.content.push({type:'Navigation',props:{id:'main-nav',menuId:'main'}});
  for(const mode of [undefined,'collapse','inline']){if(mode===undefined)delete data.content[1].props.mobileMode;else data.content[1].props.mobileMode=mode;assert.doesNotThrow(()=>validateDraft(content));}
  for(const mode of ['auto',false,null]){data.content[1].props.mobileMode=mode;assert.throws(()=>validateDraft(content),/导航手机显示方式/);}
});

test('自然语言受控导航模式操作只改目标Navigation手机显示，保留文案/引用并保护锁定与其它端',()=>{
  const content=source();const data=content.editorData.home as Data;data.content.push({type:'Navigation',props:{id:'main-nav',menuId:'existing-menu',localeMenuIds:{de:'existing-de'}}});
  const request:AiPageEditRequest={pageId:'home',expectedRevision:0,instruction:'手机导航始终显示链接，保留其他效果。',mode:'design',preserveText:true,lockedIds:[],viewport:'mobile'};
  const model={summary:'保持菜单内容，只调整手机呈现。',operations:[{kind:'navigationMode',id:'main-nav',mobileMode:'inline'}],warnings:[]};
  assert.equal(prepareAiPageEdit(content,request).context.nodes.find(node=>node.id==='main-nav')?.mobileMode,'collapse');
  const compiled=compileAiPageEdit(content,request,model,'navigation-mode');assert.deepEqual(compiled.data.content[1].props,{id:'main-nav',menuId:'existing-menu',localeMenuIds:{de:'existing-de'},mobileMode:'inline'});assert.equal(data.content[1].props.mobileMode,undefined);
  const invalidRequests:Partial<AiPageEditRequest>[]=[{mode:'copy'},{viewport:'desktop'},{viewport:'tablet'},{lockedIds:['main-nav']}];for(const patch of invalidRequests)assert.throws(()=>compileAiPageEdit(content,{...request,...patch},model,'forbidden-mode'));
  for(const op of [{kind:'navigationMode',id:'heading-home',mobileMode:'inline'},{kind:'navigationMode',id:'main-nav',mobileMode:'unknown'},{kind:'navigationMode',id:'main-nav',mobileMode:'inline',menuId:'overwrite'}])assert.throws(()=>compileAiPageEdit(content,request,{...model,operations:[op]},'invalid-mode'));
  assert.throws(()=>compileAiPageEdit(content,request,{...model,operations:[{kind:'navigationMode',id:'main-nav',mobileMode:'collapse'}]},'no-change'),/没有产生实际变化/);
});
