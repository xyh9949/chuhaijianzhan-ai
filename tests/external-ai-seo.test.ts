import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type { Data } from '@puckeditor/core';
import { getDatabase } from '../src/server/database';
import { DATABASE_MIGRATIONS, migrateDatabase } from '../src/server/database-migrations';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { createExternalAiToken, requireExternalAiGrant, revokeExternalAiToken, type ExternalAiGrant, type ExternalAiScope } from '../src/server/external-ai-tokens';
import { externalAiSeoContext, externalAiSeoOverview, readExternalAiSeo, requestExternalAiSeoReview, submitExternalAiSeo } from '../src/server/external-ai-seo';
import { applySeoProposal, createExternalSeoCandidate, generateSeoProposal, resolveSeoProposalPreview, undoSeoProposal } from '../src/server/seo-proposals';
import { getAiProviderSummary } from '../src/server/ai-provider';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';
import type { SeoKeywordReport, SeoSearchReport } from '../src/lib/seo-types';

const actor:Actor={id:'external-seo-admin',name:'SEO administrator',email:'seo@example.invalid',role:'admin'},other:Actor={id:'external-seo-other',name:'Other',email:'other@example.invalid',role:'admin'};
const status=(expected:number)=>(error:unknown)=>error instanceof ApiError&&error.status===expected;
let directory='',previous:NodeJS.ProcessEnv;
beforeEach(()=>{
  previous={...process.env};directory=mkdtempSync(join(tmpdir(),'studio-external-seo-'));process.env.FORM_STUDIO_DATA_DIR=join(directory,'data');process.env.BETTER_AUTH_URL='http://127.0.0.1:3298';process.env.BETTER_AUTH_SECRET='external-seo-private-secret-'.repeat(3);
  getDraftRecord();const content=createEmptyDraft();content.settings={...content.settings,name:'Saved Factory',publicUrl:'https://factory.example.invalid',description:'Supplied furniture facts.',language:'en',email:'PRIVATE_SETTINGS_EMAIL@example.invalid'};
  content.pages.push({id:'product-page',title:'Products',slug:'/products/:slug',status:'draft',type:'产品详情',updated:'now'},{id:'news-page',title:'News',slug:'/news/:slug',contentModelId:'news',status:'draft',type:'内容详情',updated:'now'},{id:'hidden-page',title:'PRIVATE_UNAUTHORIZED_PAGE',slug:'/private',status:'draft',type:'自定义页面',updated:'now'});
  content.products=[{id:'chair',name:'Wooden Chair',sku:'CH-01',category:'Chairs',description:'Wooden chair for supplied project spaces.',material:'Wood',image:'/images/chair.jpg',status:'draft',slug:'chair'},{id:'private-product',name:'PRIVATE_UNAUTHORIZED_PRODUCT',sku:'SECRET',category:'Other',description:'PRIVATE_PRODUCT_BODY',material:'Wood',image:'/images/chair.jpg',status:'draft'}];
  content.contentModels=[{id:'news',name:'News',description:'Saved model',updated:'now',target:'content',fields:[]}];content.contentEntries=[{id:'news-item',title:'Saved news facts',modelId:'news',slug:'story',status:'draft',updated:'now',customFields:{}},{id:'private-entry',title:'PRIVATE_UNAUTHORIZED_ENTRY',modelId:'news',status:'draft',updated:'now',customFields:{}}];
  for(const page of content.pages)content.editorData[page.id]={root:{props:{title:page.title}},content:[{type:'Heading',props:{id:`h1-${page.id}`,level:'h1',text:page.title}},{type:'Text',props:{id:`body-${page.id}`,text:'Wooden furniture for project spaces.'}}],zones:{}};
  (content.editorData.home as Data).content.push({type:'Container',props:{id:'locked-parent',locked:true,content:[{type:'Text',props:{id:'locked-child',text:'PRIVATE_LOCKED_TEXT'}}]}});
  const db=getDatabase();db.prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(content));db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');for(const member of[actor,other])db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(member.id,member.name,member.email,member.role);
});
afterEach(()=>{getDatabase().close();for(const key of Object.keys(process.env))if(!Object.hasOwn(previous,key))delete process.env[key];Object.assign(process.env,previous);if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-seo-`))rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
function grant(owner=actor,scopes:ExternalAiScope[]=['read','seo:read','seo:propose'],pageIds:string[]|null=['home'],productIds:string[]|null=['chair'],entryIds:string[]|null=['news-item']):ExternalAiGrant{const created=createExternalAiToken({name:'External SEO client',scopes,pageIds,recordIds:{productIds,entryIds},expiresInDays:1},owner);return requireExternalAiGrant(new Request('http://127.0.0.1:3298/api/mcp',{headers:{Authorization:`Bearer ${created.token}`}}));}
function request(extra:Record<string,unknown>={}){return{target:{kind:'page',id:'home'},expectedRevision:getDraftRecord().revision,instruction:'Make the search listing describe the actual supplied furniture.',reportIds:[],...extra};}
function proposal(title='Wooden furniture for project spaces',extra:Record<string,unknown>={}){return{seoTitle:title,seoDescription:'Review supplied wooden furniture and discuss requirements for project spaces.',summary:'Use saved furniture facts to describe this page accurately.',evidence:[],warnings:[],...extra};}
function submit(connection:ExternalAiGrant,id='seo-request',req:unknown=request(),output:unknown=proposal()){return submitExternalAiSeo(connection,{requestId:id,request:req,proposal:output});}
function count(table:string){return(getDatabase().prepare(`SELECT count(*) n FROM ${table}`).get() as{n:number}).n;}
function report(sourceMock=false){const item:SeoSearchReport={id:`ser-${randomUUID()}`,kind:'search',provider:'gsc',connectionRevision:0,createdAt:new Date().toISOString(),source:{name:'Supplied Google export',url:'https://developers.google.com/webmaster-tools/v1/searchanalytics/query',sourceMock},scope:{property:'https://factory.example.invalid/',startDate:'2026-10-01',endDate:'2026-10-28',timeZone:'America/Los_Angeles',country:'USA'},coverage:{partial:true,reasons:['Returned top rows only'],rowCount:3},warnings:['Historical supplied dataset'],rows:[{rowNumber:1,page:'https://factory.example.invalid/',query:'wooden furniture',clicks:0,impressions:200,ctr:0,position:8},{rowNumber:2,page:'https://factory.example.invalid/private',query:'PRIVATE_UNAUTHORIZED_QUERY',clicks:80,impressions:1000,ctr:.08,position:1},{rowNumber:3,page:'https://other.example.invalid/',query:'PRIVATE_OTHER_HOST_QUERY',clicks:2,impressions:20,ctr:.1,position:2}]};saveReport(item);return item;}
function saveReport(item:SeoSearchReport|SeoKeywordReport,owner=actor){const{rows,...metadata}=item;getDatabase().prepare('INSERT INTO cms_seo_report VALUES(?,?,?,?,?,?,?)').run(item.id,owner.id,item.provider,item.connectionRevision,JSON.stringify(metadata),JSON.stringify(rows),item.createdAt);}

test('原设计read/propose凭据不扩权；SEO只读与三类资源范围分别生效',()=>{
  const legacy=grant(actor,['read','propose']);assert.throws(()=>externalAiSeoOverview(legacy),status(403));assert.throws(()=>submit(legacy),status(403));
  const connection=grant(actor,['read','seo:read']);assert.equal(externalAiSeoOverview(connection).total,3);assert.throws(()=>submit(connection),status(403));
  for(const target of[{kind:'page',id:'hidden-page'},{kind:'product',id:'private-product'},{kind:'entry',id:'private-entry'}])assert.throws(()=>externalAiSeoContext(connection,request({target})),status(403));
  const names=JSON.stringify(externalAiSeoOverview(connection));assert.doesNotMatch(names,/PRIVATE_UNAUTHORIZED/);assert.equal(externalAiSeoOverview(connection,{limit:1}).nextOffset,1);
});

test('有限站内诊断不泄漏锁定子树、其他资料或密钥，无搜索数据明确缺口',()=>{
  const context=externalAiSeoContext(grant(),request()),encoded=JSON.stringify(context);assert.doesNotMatch(encoded,/PRIVATE_|external-seo-private-secret|seo@example/);assert.match(encoded,/Wooden furniture/);assert.ok(context.diagnostics.issues.some(issue=>issue.code==='title-fallback'));assert.ok(context.warnings.some(warning=>warning.includes('不能宣称')));assert.equal(context.siteModelCalls,false);assert.equal(context.searchSourceCalls,false);assert.deepEqual(context.context.reports,[]);
});

test('受限诊断保留问题但不外发锁定链接、全站导航或重复对象名称路径和数量',()=>{
  const content=getDraftRecord().content,home=content.editorData.home as Data;home.content.push({type:'Container',props:{id:'locked-links',locked:true,content:[{type:'ActionButton',props:{id:'private-link',text:'PRIVATE_LOCKED_LINK_TEXT',href:'/PRIVATE_LOCKED_PATH'}}]}});
  content.siteLayout={header:{mode:'default',blockId:'',menuId:'private-menu'},footer:{mode:'hidden',blockId:''},menus:[{id:'private-menu',name:'PRIVATE_GLOBAL_MENU',items:[{id:'private-nav',label:'PRIVATE_GLOBAL_NAV_NAME',target:{kind:'page',id:'PRIVATE_MISSING_TARGET'}}]}]};
  content.pages[0].seoTitle='Shared factual title';content.pages.find(page=>page.id==='hidden-page')!.seoTitle='Shared factual title';getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const before=getStudioEnvelope(),context=externalAiSeoContext(grant(),request()),encoded=JSON.stringify(context);assert.doesNotMatch(encoded,/PRIVATE_|\/private/);assert.ok(context.diagnostics.issues.some(issue=>issue.code==='duplicate-title'));const broken=context.diagnostics.issues.find(issue=>issue.code==='broken-internal-link');assert.ok(broken);assert.match(broken.evidence[0].description,/名称和路径示例未外发/);assert.equal(context.diagnostics.coverage.checkedTargets,1);assert.equal(context.diagnostics.coverage.totalTargets,1);assert.equal(context.diagnostics.coverage.truncated,false);assert.deepEqual(getStudioEnvelope(),before);
});

test('有限诊断未进入目标时明确未检查，不把其他页面覆盖数量当作本目标结论',()=>{
  const content=getDraftRecord().content;content.pages=Array.from({length:501},(_,index)=>({id:`bounded-${index}`,title:`Synthetic page ${index}`,slug:`/bounded-${index}`,status:'draft' as const,type:'普通页面',updated:'now'}));content.editorData={};for(const page of content.pages)content.editorData[page.id]={root:{props:{title:page.title}},content:[],zones:{}};getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const connection=grant(actor,['read','seo:read'],['bounded-500']),context=externalAiSeoContext(connection,request({target:{kind:'page',id:'bounded-500'}}));assert.equal(context.diagnostics.coverage.checkedTargets,0);assert.equal(context.diagnostics.coverage.totalTargets,1);assert.equal(context.diagnostics.coverage.truncated,true);assert.ok(context.diagnostics.coverage.notes.some(note=>note.includes('未进入')));assert.equal(context.diagnostics.issues.length,0);
});

test('未配置站内AI可生成实际私有前后预览；请求审核不写草稿或公开版本',()=>{
  const connection=grant(),before=getStudioEnvelope();assert.equal(getAiProviderSummary().enabled,false);const view=submit(connection);assert.deepEqual(getStudioEnvelope(),before);assert.equal(view.source,'external-ai');assert.equal(view.status,'pending');assert.equal(view.validation.searchResultsVerified,false);assert.equal(new URL(view.reviewUrl).hash,'#seo');assert.equal(new URL(view.reviewUrl).searchParams.get('externalSeo'),view.proposalId);
  const first=resolveSeoProposalPreview(view.proposalId,'before',actor)!,second=resolveSeoProposalPreview(view.proposalId,'after',actor)!;assert.deepEqual(first.resolved.data,second.resolved.data);assert.equal(second.resolved.page.seoTitle,view.after.seoTitle);assert.match(view.afterDisplay!.seoTitle,/ · Saved Factory$/);
  assert.equal(requestExternalAiSeoReview(connection,{proposalId:view.proposalId,action:'apply'}).requiresBrowserConfirmation,true);assert.deepEqual(getStudioEnvelope(),before);assert.throws(()=>requestExternalAiSeoReview(connection,{proposalId:view.proposalId,action:'apply',confirmed:true}),status(422));assert.throws(()=>requestExternalAiSeoReview(connection,{proposalId:view.proposalId,action:'undo'}),status(422));
});

test('同token语义幂等，修改requestId冲突及无关字段拒绝不留孤立候选',()=>{
  const connection=grant(),req=request(),output=proposal(),first=submit(connection,'same',req,output);const reordered={warnings:[],evidence:[],summary:output.summary,seoDescription:output.seoDescription,seoTitle:output.seoTitle};assert.equal(submit(connection,'same',req,reordered).proposalId,first.proposalId);assert.equal(count('cms_seo_proposal'),1);assert.equal(count('cms_external_ai_seo_request'),1);
  assert.throws(()=>submit(connection,'same',req,proposal('Changed actual title')),status(409));assert.throws(()=>submit(connection,'unknown',req,{...output,noindex:false}),status(422));assert.throws(()=>submit(connection,'html',req,proposal('<script>bad</script>')),status(422));assert.throws(()=>submit(connection,'url',req,proposal('javascript:bad')),status(422));assert.throws(()=>submit(connection,'req-extra',{...req,useAi:true}),status(422));assert.equal(count('cms_seo_proposal'),1);assert.equal(getDraftRecord().revision,0);
});

test('同账号另一凭据及其他负责人不能读取、续调或审核本连接候选',async()=>{
  const first=grant(),second=grant(),third=grant(other),view=submit(first);for(const connection of[second,third]){assert.throws(()=>readExternalAiSeo(connection,view.proposalId),status(404));assert.throws(()=>externalAiSeoContext(connection,request({baseProposalId:view.proposalId})),status(404));assert.throws(()=>submit(connection,'child',request({baseProposalId:view.proposalId}),proposal('Next title')),status(404));assert.throws(()=>requestExternalAiSeoReview(connection,{proposalId:view.proposalId,action:'apply'}),status(404));}
  const native=await generateSeoProposal({...request(),seoTitle:'Native title',seoDescription:'Native description',useAi:false},actor);assert.throws(()=>externalAiSeoContext(first,request({baseProposalId:native.proposalId})),status(404));
});

test('继续调整基于上一候选且保留最初before；实际采用与精确撤销可保留后续正文',()=>{
  const connection=grant(),initial=submit(connection),context=externalAiSeoContext(connection,request({baseProposalId:initial.proposalId,instruction:'Shorten title'}));assert.equal(context.context.current!.seoTitle,initial.after.seoTitle);assert.equal(context.context.refinement?.round,1);const refined=submit(connection,'refined',request({baseProposalId:initial.proposalId}),proposal('Wooden furniture'));assert.deepEqual(refined.before,initial.before);assert.equal(refined.refinement?.round,1);assert.equal(getDraftRecord().revision,0);
  const applied=applySeoProposal({proposalId:refined.proposalId,expectedRevision:0},actor);assert.equal(readExternalAiSeo(connection,refined.proposalId).status,'applied');assert.deepEqual(applied.state.products,getStudioEnvelope().state.products);assert.equal(requestExternalAiSeoReview(connection,{proposalId:refined.proposalId,action:'undo'}).requiresBrowserConfirmation,true);
  const content=getDraftRecord().content,data=structuredClone(content.editorData.home) as Data;data.content[1].props.text='Later manual page copy';patchStudio({expectedRevision:applied.revision,patch:{editorData:{...content.editorData,home:data}}},actor);undoSeoProposal({proposalId:refined.proposalId,expectedRevision:getDraftRecord().revision},actor);assert.equal(readExternalAiSeo(connection,refined.proposalId).status,'undone');assert.equal(Object.hasOwn(getDraftRecord().content.pages[0],'seoTitle'),false);assert.equal((getDraftRecord().content.editorData.home as Data).content[1].props.text,'Later manual page copy');
});

test('已有真实报告仅发送本目标匹配行和真实日期范围，未选择时只发现摘要',()=>{
  const connection=grant(),source=report(),empty=externalAiSeoContext(connection,request());assert.deepEqual(empty.context.reports,[]);assert.equal(empty.availableReports[0].id,source.id);assert.doesNotMatch(JSON.stringify(empty),/PRIVATE_UNAUTHORIZED_QUERY|PRIVATE_OTHER_HOST_QUERY/);
  const context=externalAiSeoContext(connection,request({reportIds:[source.id]})),selected=context.context.reports[0];assert.equal(selected.rows.length,1);assert.equal(selected.source.sourceMock,false);assert.equal(selected.scope.timeZone,'America/Los_Angeles');assert.ok(context.diagnostics.issues.some(issue=>issue.code==='gsc-no-clicks'));assert.doesNotMatch(JSON.stringify(context),/PRIVATE_UNAUTHORIZED_QUERY|PRIVATE_OTHER_HOST_QUERY/);
  const view=submit(connection,'actual',request({reportIds:[source.id]}),proposal(undefined,{evidence:[{reportId:source.id,rowNumbers:[1]}]}));assert.deepEqual(view.evidence[0].rowNumbers,[1]);assert.equal(view.evidence[0].partial,true);assert.equal(view.sourceMock,false);assert.ok(view.warnings.some(warning=>warning.includes('Historical supplied dataset')));
});

test('伪造/未选/越界或重复引用拒绝；历史连接和模拟来源不伪装为当前真实数据',()=>{
  const connection=grant(),source=report(true),req=request({reportIds:[source.id]});for(const evidence of[[{reportId:source.id,rowNumbers:[2]}],[{reportId:source.id,rowNumbers:[1,1]}],[{reportId:`ser-${randomUUID()}`,rowNumbers:[1]}],[{reportId:source.id,rowNumbers:[1]},{reportId:source.id,rowNumbers:[1]}]])assert.throws(()=>submit(connection,randomUUID(),req,proposal(undefined,{evidence})),status(422));assert.throws(()=>submit(connection,'unselected',request(),proposal(undefined,{evidence:[{reportId:source.id,rowNumbers:[1]}]})),status(422));assert.equal(count('cms_seo_proposal'),0);
  getDatabase().prepare("INSERT INTO cms_seo_connection VALUES('gsc',1,'{}','',?) ON CONFLICT(provider) DO UPDATE SET revision=1").run(new Date().toISOString());const view=submit(connection,'mock',req,proposal(undefined,{evidence:[{reportId:source.id,rowNumbers:[1]}]}));assert.equal(view.sourceMock,true);assert.match(view.evidence[0].description,/模拟数据/);assert.ok(view.warnings.some(warning=>warning.includes('旧连接')));
});

test('第三方缺失值与零值保留，异语词不猜测为页面真实关键词',()=>{
  const search=report(),source:SeoKeywordReport={...search,id:`ser-${randomUUID()}`,kind:'keywords',provider:'csv',source:{name:'User supplied CSV',url:'',sourceMock:false},scope:{...search.scope,languageCode:'en',locationCode:2840},rows:[{rowNumber:1,keyword:'wooden furniture',searchVolume:0,cpc:null,competition:null,competitionIndex:null,monthlySearches:[]}]};saveReport(source);const connection=grant(),context=externalAiSeoContext(connection,request({reportIds:[source.id]})),row=context.context.reports[0].rows[0];assert.equal((row as{searchVolume:number}).searchVolume,0);assert.equal((row as{cpc:number|null}).cpc,null);
  getDatabase().prepare("UPDATE cms_seo_report SET metadata_json=json_set(metadata_json,'$.scope.languageCode','de') WHERE id=?").run(source.id);const mismatch=externalAiSeoContext(connection,request({reportIds:[source.id]}));assert.equal(mismatch.context.reports[0].rows.length,0);assert.ok(mismatch.warnings.some(warning=>warning.includes('未据此猜测指标')));
});

test('产品和文章保持原生详情预览与字段边界，缺少详情不会虚构真实网址',()=>{
  const connection=grant();for(const target of[{kind:'product',id:'chair'},{kind:'entry',id:'news-item'}]){const before=getDraftRecord(),view=submit(connection,`target-${target.kind}`,request({target}));assert.ok(resolveSeoProposalPreview(view.proposalId,'after',actor));const saved=applySeoProposal({proposalId:view.proposalId,expectedRevision:before.revision},actor);assert.deepEqual(saved.state.editorData,before.content.editorData);undoSeoProposal({proposalId:view.proposalId,expectedRevision:saved.revision},actor);}
  const content=getDraftRecord().content;content.pages=content.pages.filter(page=>page.id!=='product-page');delete content.editorData['product-page'];content.products[0].noindex=true;getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));const view=submit(connection,'no-route',request({target:{kind:'product',id:'chair'}}));assert.equal(view.afterUrl,undefined);assert.ok(view.warnings.some(warning=>warning.includes('没有独立可访问路径')));assert.ok(view.warnings.some(warning=>warning.includes('不收录')));
});

test('过期、并发版本、已采用亲本与超过六轮拒绝，原候选和用户新值保留',()=>{
  const connection=grant();let view=submit(connection);for(let round=1;round<=6;round++)view=submit(connection,`round-${round}`,request({baseProposalId:view.proposalId}),proposal(`Supplied furniture variant ${round}`));assert.equal(view.refinement?.round,6);assert.throws(()=>submit(connection,'too-many',request({baseProposalId:view.proposalId}),proposal('Seventh variant')),status(422));
  getDatabase().prepare("UPDATE cms_seo_proposal SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(view.proposalId);assert.throws(()=>readExternalAiSeo(connection,view.proposalId),status(410));const pending=submit(connection,'fresh',request(),proposal('Current candidate'));patchStudio({expectedRevision:0,patch:{theme:{...getDraftRecord().content.theme,primary:'#123456'}}},actor);assert.equal(readExternalAiSeo(connection,pending.proposalId).stale,true);assert.throws(()=>applySeoProposal({proposalId:pending.proposalId,expectedRevision:1},actor),status(409));assert.throws(()=>submit(connection,'stale',request({expectedRevision:0}),proposal('Old version')),status(409));
});

test('容量、事务末授权复核及撤销连接不留下新SEO方案',()=>{
  const connection=grant();let checks=0;assert.throws(()=>createExternalSeoCandidate(request(),proposal(),actor,()=>{if(++checks===3)throw new ApiError(403,'Authorization revoked');}),status(403));assert.equal(count('cms_seo_proposal'),0);assert.equal(count('cms_external_ai_seo_request'),0);
  for(let i=0;i<30;i++)getDatabase().prepare('INSERT INTO cms_seo_proposal(id,actor_id,target_kind,target_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(`sep-${randomUUID()}`,actor.id,'page','home',0,'{"pending":true}',new Date().toISOString(),new Date(Date.now()+60000).toISOString());assert.throws(()=>submit(connection),status(429));assert.equal(count('cms_external_ai_seo_request'),0);revokeExternalAiToken(connection.tokenId,actor);assert.throws(()=>externalAiSeoOverview(connection),status(401));assert.equal(getDraftRecord().revision,0);
});

test('SQL13仅追加外部域授权和索引，保留旧SEO报告/提案及旧token原权限',()=>{
  const db=new Database(':memory:');try{for(const migration of DATABASE_MIGRATIONS.filter(item=>item.version<=12))db.exec(migration.sql);const stamp=new Date().toISOString();db.prepare('INSERT INTO cms_external_ai_token VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('old-token',actor.id,'Old design client','hash','hint','["read","propose"]','null',stamp,stamp,null,null);db.prepare('INSERT INTO cms_seo_report VALUES(?,?,?,?,?,?,?)').run('old-report',actor.id,'csv',0,'{}','[]',stamp);db.prepare('INSERT INTO cms_seo_proposal(id,actor_id,target_kind,target_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run('old-proposal',actor.id,'page','home',7,'{"preserved":true}',stamp,stamp);const before=db.prepare('SELECT * FROM cms_seo_proposal').get();migrateDatabase(db);assert.deepEqual(db.prepare('SELECT * FROM cms_seo_proposal').get(),before);assert.equal((db.prepare('SELECT payload_json FROM cms_seo_report').get() as{payload_json:string}).payload_json,'[]');const token=db.prepare('SELECT scopes_json,record_ids_json FROM cms_external_ai_token').get() as{scopes_json:string;record_ids_json:string};assert.equal(token.scopes_json,'["read","propose"]');assert.deepEqual(JSON.parse(token.record_ids_json),{productIds:[],entryIds:[]});assert.equal((db.prepare('SELECT count(*) n FROM cms_external_ai_seo_request').get() as{n:number}).n,0);}finally{db.close();}
});
