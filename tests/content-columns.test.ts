import {beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Render} from '@puckeditor/core/rsc';
import type {Data} from '@puckeditor/core';
import {contentColumns,createContentColumn,CONTENT_COLUMN_PRESETS} from '../src/lib/content-columns';
import {getDatabase} from '../src/server/database';
import {getDraftRecord,getStudioEnvelope,patchStudio,readRelease} from '../src/server/studio';
import {initialState} from '../src/lib/demo';
import {createEmptyDraft} from '../src/server/seed';
import {publishSite} from '../src/server/publication';
import {resolveSitePage} from '../src/lib/site-routing';
import {createSiteConfig} from '../src/lib/site-render-config';

let directory='',previous:string|undefined;
beforeEach(()=>{previous=process.env.FORM_STUDIO_DATA_DIR;directory=mkdtempSync(join(tmpdir(),'studio-columns-'));process.env.FORM_STUDIO_DATA_DIR=directory;});
afterEach(()=>{getDatabase().close();if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-columns-`))rmSync(directory,{recursive:true,force:true});if(previous===undefined)delete process.env.FORM_STUDIO_DATA_DIR;else process.env.FORM_STUDIO_DATA_DIR=previous;});
const save=(patch:object)=>patchStudio({expectedRevision:getDraftRecord().revision,patch});
test('无栏目显示案例新闻团队入口但不写入；已有栏目含同类多个均保留，产品参数不混入',()=>{
 const before=getDraftRecord(),raw=JSON.stringify(before);assert.deepEqual(contentColumns([],[]).map(c=>c.name),['案例','新闻','团队']);assert.equal(JSON.stringify(getDraftRecord()),raw);
 const first=createContentColumn('case','a',[]).model,second={...first,id:'other',name:'客户案例'},product={...first,id:'product',name:'产品参数',target:'product' as const};
 const columns=contentColumns([first,second,product],[]);assert.equal(columns.length,4);assert.equal(columns.filter(c=>c.model).length,2);assert.ok(!columns.some(c=>c.key==='product'));assert.equal(first.name,'案例');assert.ok(!contentColumns([{...first,name:'Renamed projects'}],[]).some(c=>c.key==='preset:case'));
});
test('常用栏目字段图片与可编辑详情模板实际保存发布，真实记录取代空模板且无假记录',()=>{
 save({...createEmptyDraft(),media:initialState.media});for(const preset of CONTENT_COLUMN_PRESETS){const d=getDraftRecord().content,fresh=createContentColumn(preset.key,preset.key,d.pages);
  save({contentModels:[...(d.contentModels||[]),fresh.model],pages:[...d.pages,fresh.page],editorData:{...d.editorData,[fresh.page.id]:fresh.data},settings:{...d.settings,discovery:{...d.settings.discovery,mappings:[...(d.settings.discovery?.mappings||[]),fresh.mapping]}}});
 }
 let d=getDraftRecord().content;assert.equal(d.contentEntries?.length||0,0);assert.equal(d.products.length,0);assert.equal(d.contentModels!.length,3);
 const model=d.contentModels![1],body=model.fields.find(f=>f.key==='body')!,photo=model.fields.find(f=>f.key==='cover')!;
 save({contentEntries:[{id:'real-news',title:'Synthetic news title',modelId:model.id,customFields:{[body.id]:'Synthetic article body',[photo.id]:'/images/studio.jpg'},status:'draft',updated:''}]});
 d=getDraftRecord().content;const release=publishSite({expectedRevision:getDraftRecord().revision,baseReleaseId:getStudioEnvelope().activeReleaseId,pageIds:d.pages.map(p=>p.id),productIds:[],contentModelIds:d.contentModels!.map(m=>m.id),contentEntryIds:['real-news'],includeSettings:true,includeTheme:true},{id:'columns-qa',name:'Synthetic QA'}),snapshot=readRelease(release.releaseId);
 const resolved=resolveSitePage(snapshot,['news','real-news'])!;assert.ok(resolved);const html=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...snapshot,pageId:resolved.page.id,previewEntryId:resolved.entry!.id}),data:resolved.data as Data}));
 assert.match(html,/Synthetic news title/);assert.match(html,/Synthetic article body/);assert.match(html,/src="\/images\/studio.jpg"/);
});
test('新详情路径避开已有模板和静态子页，不改变旧页面或模型标识',()=>{
 const pages=[{id:'old',title:'Old',slug:'/cases/:slug',type:'普通页面',status:'draft' as const,updated:''},{id:'static',title:'Static',slug:'/news/old',type:'普通页面',status:'draft' as const,updated:''}],raw=JSON.stringify(pages);
 assert.equal(createContentColumn('case','fresh',pages).page.slug,'/cases-2/:slug');assert.equal(createContentColumn('news','fresh',pages).page.slug,'/news-2/:slug');assert.equal(JSON.stringify(pages),raw);
});
