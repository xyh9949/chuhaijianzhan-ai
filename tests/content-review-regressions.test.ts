import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEmptyDraft} from '../src/server/seed';
import {pageTemplateErrors,validateDraft} from '../src/server/validation';
import {detailTemplateErrors} from '../src/lib/detail-templates';
import type {PageTemplate} from '../src/lib/types';
import {taxonomyErrors} from '../src/lib/taxonomy';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {getDatabase} from '../src/server/database';
import {getDraftRecord,patchStudio,readRelease} from '../src/server/studio';
import {publishSite,previewPublication} from '../src/server/publication';
import {resolveSitePage} from '../src/lib/site-routing';
import {createSiteConfig} from '../src/lib/site-render-config';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Render} from '@puckeditor/core/rsc';

function entryFixture(){
 const draft=createEmptyDraft();
 draft.contentModels=[{id:'news',name:'News',description:'',target:'content',updated:'',fields:[]}];
 draft.pages.push({id:'news-detail',title:'News detail',slug:'/news/:slug',contentModelId:'news',type:'内容详情模板',status:'draft',updated:''});
 draft.editorData['news-detail']={root:{props:{showChrome:'no'}},content:[]};
 const asset:PageTemplate={id:'news-layout',name:'News layout',description:'',updated:'',kind:'entry',modelId:'news',detailRule:{enabled:true,priority:10},data:{root:{props:{title:'News layout'}},content:[{type:'ActionButton',props:{id:'self-link',text:'Article',href:'',bindings:{href:{source:'entry',mode:'current',modelId:'news',field:'builtin:url'}}}}]}};
 draft.pageTemplates=[asset];
 return draft;
}

test('条件内容布局自己的详情链接使用真实路由，不被同模型虚拟资产误判缺失',()=>{
 const draft=entryFixture();
 assert.deepEqual(pageTemplateErrors(draft,true),[]);
 draft.pageTemplates!.push({...structuredClone(draft.pageTemplates![0]),id:'news-layout-second',name:'Second',detailRule:{enabled:true,priority:20}});
 assert.deepEqual(pageTemplateErrors(draft,true),[]);
});

test('条件内容布局的虚拟页不能补齐未发布的真实详情入口',()=>{
 const draft=entryFixture();draft.pages=draft.pages.filter(p=>p.id!=='news-detail');
 assert.match(pageTemplateErrors(draft,true).join('；'),/兜底|详情模板/);
});

test('畸形详情规则只返回校验错误，不在同优先级碰撞检查抛运行时异常',()=>{
 const draft=entryFixture();
 draft.pageTemplates![0].detailRule!.recordIds=['sample'];
 draft.pageTemplates!.unshift({...structuredClone(draft.pageTemplates![0]),id:'invalid-rule',name:'Invalid',detailRule:{enabled:true,priority:10,recordIds:'bad' as unknown as string[]}});
 assert.match(detailTemplateErrors(draft).join('；'),/格式无效/);
 assert.throws(()=>validateDraft(draft),(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===422);
});

test('分类混入空项目时返回明确格式错误，父项遍历不再把坏输入变成服务器异常',()=>{
 const draft=createEmptyDraft();
 draft.taxonomies=[{id:'topics',name:'Topics',source:'product',terms:[null,{id:'child',label:'Child',slug:'child',parentId:'parent'},{id:'parent',label:'Parent',slug:'parent'}] as unknown as NonNullable<typeof draft.taxonomies>[number]['terms']}];
 assert.match(taxonomyErrors(draft).join('；'),/无效/);
 assert.throws(()=>validateDraft(draft),(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===422);
});

test('合法条件内容布局经真实草稿预检发布后仍命中布局并渲染本条详情网址',()=>{
 const previous=process.env.FORM_STUDIO_DATA_DIR,directory=mkdtempSync(join(tmpdir(),'studio-content-review-'));
 process.env.FORM_STUDIO_DATA_DIR=directory;
 try{
  const draft=entryFixture();
  draft.contentEntries=[{id:'article-one',modelId:'news',title:'Article one',slug:'article-one',customFields:{},status:'draft',updated:''}];
  patchStudio({expectedRevision:getDraftRecord().revision,patch:draft});
  const selection={expectedRevision:getDraftRecord().revision,baseReleaseId:null,pageIds:draft.pages.map(p=>p.id),productIds:[],contentModelIds:['news'],contentEntryIds:['article-one'],includeTemplates:true,includeSettings:true,includeTheme:true};
  assert.deepEqual(previewPublication(selection).errors,[]);
  const {releaseId}=publishSite(selection,{id:'review-qa',name:'Synthetic review'}),snapshot=readRelease(releaseId),resolved=resolveSitePage(snapshot,['news','article-one'])!;
  assert.equal(resolved.detailTemplateId,'news-layout');
  const html=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...snapshot,pageId:resolved.page.id,previewEntryId:resolved.entry!.id}),data:resolved.data}));
  assert.match(html,/href="\/news\/article-one"/);
 }finally{getDatabase().close();if(previous===undefined)delete process.env.FORM_STUDIO_DATA_DIR;else process.env.FORM_STUDIO_DATA_DIR=previous;if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-content-review-`))rmSync(directory,{recursive:true,force:true,maxRetries:5});}
});
