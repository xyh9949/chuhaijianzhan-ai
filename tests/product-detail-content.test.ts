import {afterEach,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Render} from '@puckeditor/core/rsc';
import type {Data} from '@puckeditor/core';
import type {AiWritingGenerateInput} from '../src/lib/ai-writing-types';
import type {Actor} from '../src/server/permissions';
import {getDatabase} from '../src/server/database';
import {getDraftRecord,getStudioEnvelope,patchStudio} from '../src/server/studio';
import {getDraftSiteSnapshot,publishSite} from '../src/server/publication';
import {collectReferences,validateDraft} from '../src/server/validation';
import {ApiError} from '../src/server/http';
import {textToRichText,richTextPlainText,type RichNode} from '../src/lib/presentation-content';
import {fieldChoices,resolveBindingValue,resolveRichTextBinding} from '../src/lib/content-binding';
import {createSiteConfig} from '../src/lib/site-render-config';
import {remapPortableSite} from '../src/server/portable-site';
import {createExternalAiWritingCandidate,readAiWritingProfile,saveAiWritingDraft,undoAiWritingReceipt} from '../src/server/ai-writing';
import {seoProposalContext} from '../src/server/seo-proposals';
import {createServer} from 'node:http';
import {once} from 'node:events';
import sharp from 'sharp';
import {uploadMedia,deleteMedia} from '../src/server/media';
import {saveAiProvider} from '../src/server/ai-provider';
import {generateAiWritingProposal} from '../src/server/ai-writing';
import {readRelease} from '../src/server/studio';

let directory='',previous:NodeJS.ProcessEnv;
const actor:Actor={id:'long-detail-admin',name:'长详情验收',email:'long@example.invalid',role:'admin'};
const doc=():RichNode=>({type:'doc',content:[{type:'heading',attrs:{level:2},content:[{type:'text',text:'Supplied product applications'}]},{type:'paragraph',content:[{type:'text',text:'Read the supplied specification.',marks:[{type:'link',attrs:{href:'/about'}}]}]},{type:'image',attrs:{src:'/images/chair.jpg',alt:'Original chair',caption:'Supplied photograph',width:75,align:'center'}},{type:'bulletList',content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'Project specification must be confirmed.'}]}]}]}]});
beforeEach(()=>{
 previous={...process.env};directory=mkdtempSync(join(tmpdir(),'studio-product-detail-'));process.env.FORM_STUDIO_DATA_DIR=directory;process.env.BETTER_AUTH_SECRET='synthetic-long-detail-'.repeat(3);process.env.BETTER_AUTH_URL='http://127.0.0.1:3291';
 getDraftRecord();getDatabase().exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');getDatabase().prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id,actor.name,actor.email,actor.role);
});
afterEach(()=>{getDatabase().close();for(const key of Object.keys(process.env))if(!Object.hasOwn(previous,key))delete process.env[key];Object.assign(process.env,previous);if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-product-detail-`))rmSync(directory,{recursive:true,force:true,maxRetries:5});});
function save(value:RichNode){const d=getDraftRecord();return patchStudio({expectedRevision:d.revision,patch:{products:d.content.products.map(p=>p.id==='p1'?{...p,detailContent:value}:p)}},actor);}
function request(before:RichNode|null=null):AiWritingGenerateInput{return {target:{kind:'product',id:'p1'},fields:[{key:'detailContent',label:'产品图文详情',kind:'richtext',maxLength:30000,before}],outputKeys:['detailContent'],task:'product',sourceText:'Supplied product information only.',instruction:'',language:'en',audience:'',tone:'',factIds:[],profileRevision:readAiWritingProfile(actor).revision};}
const status=(n:number)=>(e:unknown)=>e instanceof ApiError&&e.status===n;

test('旧产品缺省保持，长详情严格原生校验，短介绍不会被长正文替换',()=>{
 const original=getDraftRecord().content,description=original.products[0].description;
 assert.equal(original.products[0].detailContent,undefined);
 for(const bad of [null,'<h2>HTML</h2>',{type:'doc',content:[{type:'script'}]}])assert.throws(()=>validateDraft({...original,products:original.products.map(p=>p.id==='p1'?{...p,detailContent:bad}:p)}),status(422));
 save(doc());assert.equal(getDraftRecord().content.products[0].description,description);assert.deepEqual(getDraftRecord().content.products[0].detailContent,doc());
 assert.ok(collectReferences(getDraftRecord().content).urls.has('/images/chair.jpg'));
});

test('产品长详情可动态绑定为原生图文，纯文字消费者只读取文字投影',()=>{
 save(doc());const source=getDraftSiteSnapshot(),binding={source:'product' as const,mode:'fixed' as const,recordId:'p1',field:'builtin:detailContent'};
 assert.ok(fieldChoices('product',undefined,'text').some(f=>f.value==='builtin:detailContent'));
 assert.equal(resolveBindingValue(binding,'text',source),richTextPlainText(doc()));assert.deepEqual(resolveRichTextBinding(binding,source),doc());
 const data:Data={root:{props:{}},content:[{type:'Text',props:{id:'bound-long-detail',text:'Fallback',bindings:{text:binding}}}]};
 const html=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...source,pageId:'home'}),data}));
 assert.match(html,/<h2[^>]*>Supplied product applications/);assert.match(html,/href="\/about"/);assert.match(html,/alt="Original chair"/);assert.doesNotMatch(html,/<p[^>]*><h2/);
});

test('默认产品详情渲染完整图文及SEO依据，不需要用户重做旧模板',()=>{
 save(doc());const source=getDraftSiteSnapshot(),data:Data={root:{props:{}},content:[{type:'ProductDetail',props:{id:'default-detail',productId:'p1',layout:'split',imageHeight:500,padding:40,cta:'Contact'}}]};
 const html=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...source,pageId:'product-detail',previewProductId:'p1'}),data}));
 assert.match(html,/data-product-detail-content="p1"/);assert.match(html,/Supplied product applications/);assert.match(html,/Project specification must be confirmed/);
 const context=seoProposalContext(getDraftRecord().content,{kind:'product',id:'p1',label:'p1',url:null},[]);
 assert.match(context.context.facts,/Supplied product applications/);
});

test('分发时长详情图片和站内链接重映射，原文与原实例不被改写',()=>{
 save(doc());const source=getDraftSiteSnapshot(),before=JSON.stringify(source);
 const result=remapPortableSite(source,{namespace:'long-detail',prefix:'imported',merge:true,skuPrefix:'',enableJs:false});
 const detail=result.site.products[0].detailContent!;
 assert.notEqual((detail.content![2].attrs as {src:string}).src,'/images/chair.jpg');
 assert.match((detail.content![1].content![0].marks![0].attrs as {href:string}).href,/^\/imported\/about$/);
 assert.equal(richTextPlainText(detail),richTextPlainText(doc()));assert.equal(JSON.stringify(source),before);
});

test('长详情提案预览不改草稿，确认保存后可撤销回缺省字段并保留其他人工修改',()=>{
 const before=getStudioEnvelope(),generated=textToRichText('Reviewed detailed product information.');
 const proposal=createExternalAiWritingCandidate(request(),{fields:[{key:'detailContent',after:generated}],warnings:[],missingFacts:[],evidenceIds:[]},actor,()=>{});
 assert.deepEqual(getStudioEnvelope(),before);const current=getStudioEnvelope();
 const saved=saveAiWritingDraft({expectedRevision:current.revision,patch:{products:current.state.products.map(p=>p.id==='p1'?{...p,detailContent:generated}:p)},receipts:[{proposalId:proposal.id,selectedKeys:['detailContent'],before:{detailContent:null},after:{detailContent:generated},beforePresent:{detailContent:false}}]},actor);
 assert.equal(saved.writingReceipts.length,1);assert.deepEqual(saved.state.products[0].detailContent,generated);
 patchStudio({expectedRevision:saved.revision,patch:{products:saved.state.products.map(p=>p.id==='p1'?{...p,name:'Later human name'}:p)}},actor);
 const undone=undoAiWritingReceipt(saved.writingReceipts[0].id,{expectedRevision:getDraftRecord().revision},actor);
 assert.equal(Object.hasOwn(undone.state.products[0],'detailContent'),false);assert.equal(undone.state.products[0].name,'Later human name');assert.equal(undone.activeReleaseId,before.activeReleaseId);
});

test('AI重写长详情必须保留原图片和链接，不得删除、重复或引入新引用',()=>{
 save(doc());const original=doc(),changed=doc();changed.content![0].content![0].text='Reviewed applications';
 assert.doesNotThrow(()=>createExternalAiWritingCandidate(request(original),{fields:[{key:'detailContent',after:changed}],warnings:[],missingFacts:[],evidenceIds:[]},actor,()=>{}));
 for(const invalid of [textToRichText('Removed original references'),{...changed,content:[...changed.content!,changed.content![2]]},{...changed,content:[...changed.content!,{type:'image',attrs:{src:'/images/interior.jpg'}}]}]){
  assert.throws(()=>createExternalAiWritingCandidate(request(original),{fields:[{key:'detailContent',after:invalid}],warnings:[],missingFacts:[],evidenceIds:[]},actor,()=>{}),status(422));
 }
});

test('已保存图文详情有后续人工改动时，旧AI撤销不会覆盖新内容',()=>{
 const generated=textToRichText('Reviewed content'),proposal=createExternalAiWritingCandidate(request(),{fields:[{key:'detailContent',after:generated}],warnings:[],missingFacts:[],evidenceIds:[]},actor,()=>{}),current=getStudioEnvelope();
 const saved=saveAiWritingDraft({expectedRevision:current.revision,patch:{products:current.state.products.map(p=>p.id==='p1'?{...p,detailContent:generated}:p)},receipts:[{proposalId:proposal.id,selectedKeys:['detailContent'],before:{detailContent:null},after:{detailContent:generated},beforePresent:{detailContent:false}}]},actor);
 save(textToRichText('Later human detail'));const before=getDraftRecord();
 assert.throws(()=>undoAiWritingReceipt(saved.writingReceipts[0].id,{expectedRevision:before.revision},actor),status(409));assert.deepEqual(getDraftRecord(),before);
});

test('用户自配兼容模型接收完整长详情树并返回可预览建议，不提前保存产品',async()=>{
 save(doc());const original=getStudioEnvelope(),after=doc();after.content![0].content![0].text='Reviewed applications';let calls=0;
 const server=createServer(async(request,response)=>{calls++;const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const payload=JSON.parse(Buffer.concat(chunks).toString('utf8')),prompt=JSON.parse(payload.messages[1].content);assert.deepEqual(prompt.fields[0].current,doc());assert.match(payload.messages[0].content,/保留其原有图片|保留.*图片/);response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({fields:[{key:'detailContent',after}],warnings:[],missingFacts:[],evidenceIds:[]})},finish_reason:'stop'}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const address=server.address();assert.ok(address&&typeof address!=='string');saveAiProvider({expectedRevision:0,enabled:true,baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'synthetic-detail',apiKey:'',allowLocal:true},actor);
  const proposal=await generateAiWritingProposal(request(doc()),actor);assert.equal(calls,1);assert.deepEqual(proposal.fields[0].after,after);assert.deepEqual(getStudioEnvelope(),original);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('长详情唯一引用的真实上传图受删除保护且随实际发布快照保留',async()=>{
 const bytes=await sharp({create:{width:32,height:24,channels:3,background:'#b0c0d0'}}).png().toBuffer(),form=new FormData();form.set('file',new File([new Uint8Array(bytes)],'detail.png',{type:'image/png'}));form.set('expectedRevision',String(getDraftRecord().revision));const media=(await uploadMedia(form)).media;
 const detail=doc();detail.content![2].attrs!.src=media.url;save(detail);
 assert.throws(()=>deleteMedia(media.id,{expectedRevision:getDraftRecord().revision}),status(422));
 const current=getStudioEnvelope(),release=publishSite({expectedRevision:current.revision,baseReleaseId:current.activeReleaseId,pageIds:['home','about','product-detail'],productIds:['p1'],includeTheme:true,includeSettings:true},actor),snapshot=readRelease(release.releaseId);
 assert.deepEqual(snapshot.products[0].detailContent,detail);assert.ok(snapshot.media.some(item=>item.id===media.id));
});
