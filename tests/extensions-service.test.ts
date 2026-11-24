import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {getDatabase} from '../src/server/database';
import {getDraftRecord,getStudioEnvelope,patchStudio,readRelease} from '../src/server/studio';
import {publishSite,previewPublication,activateRelease,restoreDraft,getActiveSiteSnapshot} from '../src/server/publication';
import {extensionInventory} from '../src/server/extensions';
import {SPEC_TYPE,migrateExtensionData,extensionMigrationsNeeded} from '../src/extensions/registry';
import {componentCompatibilityErrors} from '../src/lib/component-contract';
import {resolveSitePage} from '../src/lib/site-routing';
import legacyV14 from './fixtures/snapshot-v14.json';
import type {SiteSnapshot} from '../src/server/types';
const actor={id:'extension-admin',name:'Extension QA'};let directory='',previous:string|undefined;
beforeEach(()=>{previous=process.env.FORM_STUDIO_DATA_DIR;directory=mkdtempSync(join(tmpdir(),'form-studio-extensions-'));process.env.FORM_STUDIO_DATA_DIR=directory;});
afterEach(()=>{getDatabase().close();if(previous===undefined)delete process.env.FORM_STUDIO_DATA_DIR;else process.env.FORM_STUDIO_DATA_DIR=previous;if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-extensions-`))rmSync(directory,{recursive:true,force:true});});
const save=(patch:object)=>patchStudio({expectedRevision:getDraftRecord().revision,patch},actor);
const select=(extra:object={})=>({expectedRevision:getDraftRecord().revision,baseReleaseId:getStudioEnvelope().activeReleaseId,pageIds:['home','product-detail'],productIds:['p1'],includeTheme:true,includeSettings:true,...extra});
const data=(version=2)=>({root:{props:{showChrome:'no'}},content:[{type:SPEC_TYPE,props:{id:'spec-main',extensionVersion:version,title:'Service specifications',...(version===1?{items:[{name:'Width',value:'Verified 100'}]}:{rows:[{label:'Width',value:'Verified 100'}]}),productId:'p1',fileUrl:''}}]});
test('扩展引用、明确发布/隔离/恢复与历史移除检查贯通真实事务',()=>{
 const d=getDraftRecord().content;save({editorData:{...d.editorData,home:data()}});const missing=previewPublication(select({productIds:[],pageIds:['home']}));assert.ok(missing.errors.some(e=>e.includes('产品')),'未选固定产品应阻止发布');assert.ok(missing.diagnostics.dependencies.some(dep=>dep.kind==='product'&&dep.id==='p1'),'产品依赖需可明确选择');
 const first=publishSite(select(),actor),original=JSON.stringify(readRelease(first.releaseId));const current=getDraftRecord().content;save({editorData:{...current.editorData,home:{...data(),content:[{type:SPEC_TYPE,props:{...data().content[0].props,rows:[{label:'Width',value:'PRIVATE DRAFT'}]}}]}}});const partial=publishSite(select({pageIds:[],productIds:[],includeTheme:false}),actor);assert.ok(!JSON.stringify(readRelease(partial.releaseId)).includes('PRIVATE DRAFT'),'未选组件草稿不公开');assert.equal(JSON.stringify(readRelease(first.releaseId)),original);
 const revision=getDraftRecord().revision;assert.throws(()=>save({products:getDraftRecord().content.products.filter(p=>p.id!=='p1')}),/业务组件引用产品/);assert.equal(getDraftRecord().revision,revision);
 const inventory=extensionInventory(),row=inventory.items.find(e=>e.type===SPEC_TYPE)!;assert.equal(inventory.coverage.complete,true);assert.equal(row.draftUses,1);assert.ok(row.historyUses>=2,'保留历史也阻止移除');assert.equal(row.removalBlocked,true);
 restoreDraft(first.releaseId,{expectedRevision:revision,pageIds:['home']},actor);assert.equal(((getDraftRecord().content.editorData.home as ReturnType<typeof data>).content[0].props as {rows:{value:string}[]}).rows[0].value,'Verified 100');assert.equal(getStudioEnvelope().activeReleaseId,partial.releaseId);
});
test('未知组件与未来数据版本不执行/不丢弃，无法发布或激活，兼容快照指针保持',()=>{
 const d=getDraftRecord().content;save({editorData:{...d.editorData,home:data()}});const first=publishSite(select(),actor);const unknown={root:{props:{}},content:[{type:'foreign/Unknown',props:{id:'unknown',text:'Keep original'}}]};save({pages:[...d.pages,{id:'unknown-page',title:'Unknown original',slug:'/unknown',type:'普通页面',status:'draft',updated:''}],editorData:{...getDraftRecord().content.editorData,'unknown-page':unknown}});assert.equal(JSON.stringify(getDraftRecord().content.editorData['unknown-page']),JSON.stringify(unknown));assert.ok(componentCompatibilityErrors(unknown).length,'画布必须先检测未知类型');assert.ok(previewPublication(select({pageIds:['unknown-page'],productIds:[],includeTheme:false,includeSettings:false})).errors.length,'不能静默丢未知组件发布');
 const revision=getDraftRecord().revision;assert.throws(()=>save({editorData:{...getDraftRecord().content.editorData,home:data(99)}}),/不支持数据版本/);assert.equal(getDraftRecord().revision,revision);
 const bad={...readRelease(first.releaseId),releaseId:'unknown-release',editorData:{home:unknown}},raw=JSON.stringify(bad);getDatabase().prepare('INSERT INTO cms_release(id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES(?,?,?,?,15,15,?,?,?,?)').run('unknown-release','Unknown',raw,'fixture',actor.id,actor.name,new Date().toISOString(),'{}');assert.throws(()=>activateRelease('unknown-release',{expectedActiveReleaseId:first.releaseId},actor),/未知组件/);assert.equal(getStudioEnvelope().activeReleaseId,first.releaseId);assert.equal(JSON.stringify(readRelease('unknown-release')),raw);
});
test('本地v1属性明确升级草稿，历史记录仍保留原版本',()=>{
 const d=getDraftRecord().content;save({editorData:{...d.editorData,home:data(1)}});const first=publishSite(select(),actor);assert.equal(extensionMigrationsNeeded(getDraftRecord().content.editorData.home),true);save({editorData:{...getDraftRecord().content.editorData,home:migrateExtensionData(getDraftRecord().content.editorData.home)}});assert.equal(extensionMigrationsNeeded(getDraftRecord().content.editorData.home),false);assert.equal((readRelease(first.releaseId).editorData.home as ReturnType<typeof data>).content[0].props.extensionVersion,1);assert.equal(getStudioEnvelope().activeReleaseId,first.releaseId);
});
test('实际B协议14双语关系/条件快照可在扩展渲染器激活，原JSON不被升级改写',()=>{
 const snapshot=structuredClone(legacyV14) as SiteSnapshot,id='actual-b-v14',raw=JSON.stringify({...snapshot,releaseId:id});getDatabase().prepare('INSERT INTO cms_release(id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES(?,?,?,?,14,14,?,?,?,?)').run(id,'Actual B v14',raw,'fixture',actor.id,actor.name,new Date().toISOString(),'{}');activateRelease(id,{expectedActiveReleaseId:null},actor);assert.equal(getActiveSiteSnapshot()?.schemaVersion,14);assert.equal(resolveSitePage(readRelease(id),['de','products','sample-1'])?.detailTemplateId,'b-layout-de');assert.equal(JSON.stringify(readRelease(id)),raw);
});
test('引用扫描达到历史覆盖上限时明确阻止移除，不能把未扫描历史当成零引用',()=>{
 const d=getDraftRecord().content,snapshot={schemaVersion:15,pages:[d.pages[0]],editorData:{home:{root:{props:{showChrome:'no'}},content:[]}},products:[],media:[],theme:d.theme,settings:d.settings};
 const insert=getDatabase().prepare('INSERT INTO cms_release(id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES(?,?,?,?,15,15,?,?,?,?)');
 getDatabase().transaction(()=>{for(let n=0;n<51;n++)insert.run(`coverage-${n}`,'Synthetic coverage fixture',JSON.stringify(snapshot),'fixture',actor.id,actor.name,new Date().toISOString(),'{}');})();
 const inventory=extensionInventory();assert.equal(inventory.coverage.totalReleases,51);assert.equal(inventory.coverage.scannedReleases,50);assert.equal(inventory.coverage.complete,false);assert.equal(inventory.items.find(r=>r.type===SPEC_TYPE)?.removalBlocked,true);
});
