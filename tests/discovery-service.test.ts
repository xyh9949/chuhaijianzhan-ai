import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';
import {getDatabase} from '../src/server/database';import {getDraftRecord,patchStudio,getStudioEnvelope,readRelease} from '../src/server/studio';import {publishSite,restoreDraft,activateRelease} from '../src/server/publication';
import {addObservations,listObservations,processIndexNowOnce,discoveryStatus,recordCrawl} from '../src/server/discovery-runtime';import {createDiscoveryPreset} from '../src/server/discovery-presets';import {buildSitePackage,previewSitePackage,commitSitePackage} from '../src/server/site-package';
const actor={id:'discovery-admin',name:'Discovery QA'};let directory='',previous:string|undefined;const envs=['FORM_STUDIO_INDEXNOW_ENABLED','FORM_STUDIO_INDEXNOW_KEY','FORM_STUDIO_CRAWL_LOG','BETTER_AUTH_SECRET','BETTER_AUTH_URL'] as const;let saved:Record<string,string|undefined>={};
beforeEach(()=>{previous=process.env.FORM_STUDIO_DATA_DIR;directory=mkdtempSync(join(tmpdir(),'form-studio-discovery-'));process.env.FORM_STUDIO_DATA_DIR=directory;saved=Object.fromEntries(envs.map(k=>[k,process.env[k]]));envs.forEach(k=>delete process.env[k]);process.env.BETTER_AUTH_SECRET=randomBytes(32).toString('base64url');process.env.BETTER_AUTH_URL='http://127.0.0.1:3201';});
afterEach(()=>{getDatabase().close();if(previous===undefined)delete process.env.FORM_STUDIO_DATA_DIR;else process.env.FORM_STUDIO_DATA_DIR=previous;for(const k of envs)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-discovery-`))rmSync(directory,{recursive:true,force:true});});
const save=(patch:object)=>patchStudio({expectedRevision:getDraftRecord().revision,patch},actor);
const selection=(extra:object={})=>({expectedRevision:getDraftRecord().revision,baseReleaseId:getStudioEnvelope().activeReleaseId,pageIds:['home'],productIds:[],includeTheme:true,includeSettings:true,...extra});
test('概览按当前公开版本显示目录与网址，保存草稿和仅发布页面不会误报生效',()=>{
 assert.deepEqual(discoveryStatus().publicFeatures,{llms:false,publicUrl:null});
 const settings=getDraftRecord().content.settings;
 save({settings:{...settings,publicUrl:'https://factory.example.invalid',discovery:{llms:true}}});
 assert.deepEqual(discoveryStatus().publicFeatures,{llms:false,publicUrl:null});
 publishSite(selection(),actor);
 assert.deepEqual(discoveryStatus().publicFeatures,{llms:true,publicUrl:'https://factory.example.invalid'});
 save({settings:{...getDraftRecord().content.settings,publicUrl:'https://changed.example.invalid',discovery:{llms:false}}});
 publishSite(selection({includeSettings:false}),actor);
 assert.deepEqual(discoveryStatus().publicFeatures,{llms:true,publicUrl:'https://factory.example.invalid'});
 publishSite(selection(),actor);
 assert.deepEqual(discoveryStatus().publicFeatures,{llms:false,publicUrl:'https://changed.example.invalid'});
});
test('资料草稿、明确部分发布、恢复与观测运行数据相互隔离',()=>{
 const d=getDraftRecord().content;save({settings:{...d.settings,publicUrl:'https://factory.example.invalid',discovery:{organization:{legalName:'Published factory'},facts:[{id:'private-assessment',title:'Pending assessment',value:'UNREVIEWED_CONFIDENTIAL',scope:'',sourceUrl:'',reviewedAt:'',validUntil:'',status:'pending'}]}}});const first=publishSite(selection(),actor),raw=JSON.stringify(readRelease(first.releaseId));assert.ok(!raw.includes('UNREVIEWED_CONFIDENTIAL'),'未核对事实不得进入公开快照或分发');assert.ok(JSON.stringify(getDraftRecord().content).includes('UNREVIEWED_CONFIDENTIAL'));
 save({settings:{...getDraftRecord().content.settings,discovery:{organization:{legalName:'Private changed name'}}}});const second=publishSite(selection({includeSettings:false,includeTheme:false,pageIds:['home']}),actor);assert.equal(readRelease(second.releaseId).settings.discovery?.organization?.legalName,'Published factory');
 addObservations([{kind:'bing-ai-citations',platform:'Bing',date:'2026-11-01',timezone:'UTC',count:0,url:'',source:'Synthetic official export; partial sample',notes:'zero is known, not missing'}],actor);
 restoreDraft(first.releaseId,{expectedRevision:getDraftRecord().revision,pageIds:[],includeSettings:true},actor);assert.equal(getDraftRecord().content.settings.discovery?.organization?.legalName,'Published factory');assert.equal(listObservations().length,1);assert.equal(JSON.stringify(readRelease(first.releaseId)),raw);activateRelease(first.releaseId,{expectedActiveReleaseId:second.releaseId},actor);assert.equal(listObservations().length,1);
 const pkg=buildSitePackage(readRelease(first.releaseId),{name:'QA',description:'Synthetic only',license:'Project QA'});assert.ok(!JSON.stringify(pkg).includes('zero is known'));assert.equal(pkg.snapshot.urlState,undefined);
});
test('IndexNow默认不外发；显式启用仅公开变更入队，200只表示接收',async()=>{
 const d=getDraftRecord().content;save({settings:{...d.settings,publicUrl:'https://factory.example.invalid'}});publishSite(selection(),actor);assert.equal(discoveryStatus().indexNow.jobs.length,0);
 process.env.FORM_STUDIO_INDEXNOW_ENABLED='true';process.env.FORM_STUDIO_INDEXNOW_KEY='synthetic-owner-key-12345';save({settings:{...getDraftRecord().content.settings,description:'Actual public content change'}});assert.equal(discoveryStatus().indexNow.jobs.length,0);publishSite(selection(),actor);assert.equal(discoveryStatus().indexNow.jobs.length,1);
 let calls=0;await processIndexNowOnce((async(url,init)=>{assert.equal(url,'https://api.indexnow.org/indexnow');const b=JSON.parse(String(init?.body));assert.equal(b.host,'factory.example.invalid');assert.ok(b.urlList.every((x:string)=>!x.includes('/preview')&&!x.includes('/admin')));calls++;return new Response('',{status:200});}) as typeof fetch);assert.equal(calls,1);assert.equal((discoveryStatus().indexNow.jobs[0] as {status:string}).status,'accepted');
 publishSite(selection(),actor);assert.equal(discoveryStatus().indexNow.jobs.length,1,'无事实改变不重复通知');
});
test('最小抓取计数显式启用、跳过预取，只表示声称UA而不是索引',()=>{
 recordCrawl('/',new Headers({'User-Agent':'OAI-SearchBot'}));assert.equal(discoveryStatus().crawl.items.length,0);process.env.FORM_STUDIO_CRAWL_LOG='true';recordCrawl('/',new Headers({'User-Agent':'OAI-SearchBot','rsc':'1'}));assert.equal(discoveryStatus().crawl.items.length,0);recordCrawl('/',new Headers({'User-Agent':'OAI-SearchBot'}));assert.equal(discoveryStatus().crawl.items[0].count,1);assert.ok(discoveryStatus().crawl.identity.includes('未经'));
});
test('资料预设创建真实字段与自由详情，无假记录，冲突不写，跨实例映射保留目标身份',async()=>{
 const before=getDraftRecord().revision;createDiscoveryPreset('selection',before,actor);const d=getDraftRecord().content;assert.equal(d.contentEntries?.length||0,0);const model=d.contentModels![0],page=d.pages.find(p=>p.contentModelId===model.id)!;assert.ok(page);assert.ok(d.settings.discovery?.mappings?.some(m=>m.modelId===model.id));assert.throws(()=>createDiscoveryPreset('case',before,actor),/变化|修改/);
 save({contentEntries:[{id:'guide-entry',modelId:model.id,title:'Verified synthetic guide',slug:'guide',status:'draft',updated:'',customFields:{[model.fields[0].id]:'Real provided test content'}}]});const release=publishSite(selection({pageIds:['home',page.id],contentModelIds:[model.id],contentEntryIds:['guide-entry']}),actor);const pkg=buildSitePackage(readRelease(release.releaseId),{name:'QA',description:'Only synthetic',license:'Project QA'});
 const current=getDraftRecord();save({settings:{...current.content.settings,discovery:{...current.content.settings.discovery,organization:{legalName:'Target identity'}}}});
 const plan=await previewSitePackage({expectedRevision:getDraftRecord().revision,package:pkg,options:{mode:'merge',prefix:'import-guides',skuPrefix:'G-',enableJs:false}});assert.ok(plan);await commitSitePackage({expectedRevision:getDraftRecord().revision,package:pkg,options:{mode:'merge',prefix:'import-guides',skuPrefix:'G-',enableJs:false},confirmation:plan.confirmation},Date.now(),actor);const imported=getDraftRecord().content;assert.equal(imported.settings.discovery?.organization?.legalName,'Target identity');assert.equal(imported.settings.discovery?.mappings?.length,2);const importedMapping=imported.settings.discovery!.mappings![1];assert.notEqual(importedMapping.modelId,model.id);assert.ok(imported.contentModels?.some(m=>m.id===importedMapping.modelId&&m.fields.some(f=>f.id===importedMapping.descriptionFieldId)));
 assert.throws(()=>addObservations([{kind:'manual-answer',platform:'X',date:'2026-11-01',timezone:'UTC',count:1,url:'',source:'',notes:''}],actor),/来源/);
});
test('观测按游标有界分页，来源时区/零值保留，未知字段与非法游标拒绝',()=>{
 const row={kind:'google-ai-impressions',platform:'Google official export sample',date:'2026-11-01',timezone:'America/Los_Angeles',count:0,url:'',source:'Synthetic partial official-export sample',notes:''};
 addObservations(Array.from({length:100},()=>({...row})),actor);addObservations(Array.from({length:5},()=>({...row})),actor);const first=listObservations(),second=listObservations(first.at(-1)!.id);assert.equal(first.length,100);assert.equal(second.length,5);assert.equal(first[0].count,0);assert.equal(first[0].timezone,'America/Los_Angeles');assert.ok(second.every(r=>r.id<first.at(-1)!.id));assert.throws(()=>listObservations(-1),/游标/);assert.throws(()=>addObservations([{...row,secret:'private'}],actor),/无效/);
});
