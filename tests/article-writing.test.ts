import {afterEach,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Render} from '@puckeditor/core/rsc';
import type {Data} from '@puckeditor/core';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
import type {ContentEntry,ContentModel} from '../src/lib/types';
import type {SiteSnapshot} from '../src/server/types';
import {richTextErrors,richTextHasContent,richTextPlainText,textToRichText,type RichNode} from '../src/lib/presentation-content';
import {getContentEntryPath} from '../src/lib/content-routes';
import {resolveSitePage} from '../src/lib/site-routing';
import {createSiteConfig} from '../src/lib/site-render-config';
import {getDatabase} from '../src/server/database';
import {createEmptyDraft} from '../src/server/seed';
import {getDraftRecord,getStudioEnvelope,patchStudio,readRelease} from '../src/server/studio';
import {activateRelease,getActiveSiteSnapshot,getDraftSiteSnapshot,publishSite,restoreDraft} from '../src/server/publication';
import {deleteMedia,isPublishedMedia,readMediaFile,uploadMedia} from '../src/server/media';
import {mediaUsage} from '../src/server/media-operations';
import {commitSitePackage,exportSitePackage,previewSitePackage} from '../src/server/site-package';
import {ApiError} from '../src/server/http';

const actor={id:'article-writing-test',name:'文章写作合成验收'};
const model:ContentModel={id:'article-model',name:'Articles',target:'content',description:'Synthetic test schema',updated:'',fields:[
 {id:'article-body-field',key:'body',label:'正文',type:'textarea',required:false},
 {id:'article-cover-field',key:'cover',label:'封面',type:'image',required:false},
 {id:'article-summary-field',key:'summary',label:'摘要',type:'textarea',required:false},
]};
const bodyField=model.fields[0].id,coverField=model.fields[1].id;
let directory='',directories:string[]=[],previous:NodeJS.ProcessEnv;

beforeEach(()=>{
 previous={...process.env};directory=mkdtempSync(join(tmpdir(),'studio-article-writing-'));directories=[directory];
 process.env.FORM_STUDIO_DATA_DIR=directory;process.env.BETTER_AUTH_URL='https://articles.example.invalid';process.env.BETTER_AUTH_SECRET=randomBytes(48).toString('base64url');
 const base=createEmptyDraft(),detail={id:'article-detail',title:'Article detail',slug:'/news/:slug',type:'普通页面',status:'draft' as const,updated:'',contentModelId:model.id};
 save({...base,settings:{...base.settings,publicUrl:'https://articles.example.invalid'},contentModels:[structuredClone(model)],contentEntries:[],pages:[...base.pages,detail],editorData:{...base.editorData,[detail.id]:data(
  node('Heading','article-title',{text:'Fallback',level:'h1',bindings:{text:binding('builtin:title')}}),
  node('Text','article-body',{text:'Fallback',bindings:{text:binding(`field:${bodyField}`)}}),
 )}});
});
afterEach(()=>{
 // 只清理本文件创建的独立实例，不读写正式数据库或共享QA实例。
 for(const target of directories){process.env.FORM_STUDIO_DATA_DIR=target;getDatabase().close();if(resolve(target).startsWith(`${resolve(tmpdir())}${sep}studio-article-writing-`))rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 for(const key of Object.keys(process.env))if(!Object.hasOwn(previous,key))delete process.env[key];Object.assign(process.env,previous);
});
function save(patch:object){return patchStudio({expectedRevision:getDraftRecord().revision,patch});}
function node(type:string,id:string,props:Record<string,unknown>={}){return {type,props:{id,...props}};}
function data(...content:ReturnType<typeof node>[]){return {root:{props:{showChrome:'no'}},content};}
function binding(field:string){return {source:'entry',mode:'current',modelId:model.id,field};}
async function upload(bytes:Uint8Array,name:string,type:string){const form=new FormData();form.set('file',new File([new Uint8Array(bytes)],name,{type}));form.set('expectedRevision',String(getDraftRecord().revision));form.set('folder','内容图片');return (await uploadMedia(form)).media;}
async function image(color:string,name='inline.png'){return upload(await sharp({create:{width:640,height:400,channels:3,background:color}}).png().toBuffer(),name,'image/png');}
function document(src:string,caption='Inline caption',headline='Article subheading'):RichNode{return {type:'doc',content:[
 {type:'heading',attrs:{level:2,textAlign:'center'},content:[{type:'text',text:headline}]},
 {type:'paragraph',content:[{type:'text',text:'Article '},{type:'text',text:'bold',marks:[{type:'bold'}]},{type:'text',text:' and '},{type:'text',text:'underlined',marks:[{type:'underline'}]},{type:'text',text:' text. '},{type:'text',text:'Self link',marks:[{type:'link',attrs:{href:'/news/article-one'}}]}]},
 {type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'Quoted words'}]}]},
 {type:'image',attrs:{src,alt:'Inline image alt',caption,width:75,align:'center'}},
 {type:'paragraph',content:[{type:'text',text:'<script>escaped body text</script>'}]},
]};}
function entry(doc:RichNode,cover?:string,id='article-one'):ContentEntry{return {id,slug:id,modelId:model.id,title:`Synthetic ${id}`,status:'draft',updated:'',customFields:{[bodyField]:richTextPlainText(doc),...(cover?{[coverField]:cover}:{})},richTextFields:{[bodyField]:doc}};}
function selection(extra:Record<string,unknown>={}){return {expectedRevision:getDraftRecord().revision,baseReleaseId:getStudioEnvelope().activeReleaseId,pageIds:['home','article-detail'],productIds:[],contentModelIds:[model.id],contentEntryIds:['article-one'],includeTheme:true,includeSettings:true,...extra};}
function render(snapshot:SiteSnapshot,path='/news/article-one'){const resolved=resolveSitePage(snapshot,path==='/'?[]:path.slice(1).split('/'))!;assert.ok(resolved,`Route missing: ${path}`);return renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...snapshot,pageId:resolved.page.id,previewEntryId:resolved.entry?.id}),data:resolved.data as Data}));}
function rejectsWithoutWriting(action:()=>unknown){const before=getDraftRecord();assert.throws(action,(error)=>error instanceof ApiError&&error.status===422);assert.deepEqual(getDraftRecord(),before);}

test('旧正文读取与预览不改模型或草稿，富文本纯文本投影有确定的段落与图片说明规则',()=>{
 const legacy:ContentEntry={id:'article-one',slug:'article-one',modelId:model.id,title:'Legacy article',status:'draft',updated:'',customFields:{[bodyField]:'Legacy body\n\n<script>safe text</script>'}};
 save({contentEntries:[legacy]});const before=getDraftRecord();const html=render(getDraftSiteSnapshot());assert.match(html,/Legacy body/);assert.match(html,/&lt;script&gt;safe text&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);assert.deepEqual(getDraftRecord(),before);assert.equal(getDraftRecord().content.contentModels![0].fields[0].type,'textarea');assert.equal(getDraftRecord().content.contentEntries![0].richTextFields,undefined);
 const doc=document('/images/chair.jpg');assert.equal(richTextPlainText(doc),'Article subheading\n\nArticle bold and underlined text. Self link\n\nQuoted words\n\nInline caption\n\n<script>escaped body text</script>');assert.equal(richTextPlainText({type:'doc',content:[{type:'image',attrs:{src:'/images/chair.jpg',alt:'not body text',caption:'',width:100,align:'left'}}]}),'');assert.equal(richTextHasContent({type:'doc',content:[{type:'image',attrs:{src:'/images/chair.jpg',alt:'',caption:'',width:100,align:'left'}}]}),true);assert.equal(richTextHasContent(textToRichText('')),false);
});

test('真实上传的正文图片独立于封面保存并受删除保护，旧Text绑定安全渲染排版与图注',async()=>{
 const cover=await image('#223344','cover.png'),inline=await image('#bb8844'),doc=document(inline.url);save({contentEntries:[entry(doc,cover.url)]});
 const saved=getDraftRecord().content.contentEntries![0];assert.deepEqual(saved.richTextFields?.[bodyField],doc);assert.equal(saved.customFields[bodyField],richTextPlainText(doc));assert.ok(mediaUsage(inline.id).draft.some(u=>u.id===saved.id));rejectsWithoutWriting(()=>deleteMedia(inline.id,{expectedRevision:getDraftRecord().revision}));assert.equal(isPublishedMedia(inline.id),false);
 const html=render(getDraftSiteSnapshot());assert.match(html,/<strong>bold<\/strong>/);assert.match(html,/<u>underlined<\/u>/);assert.match(html,/<blockquote>/);assert.match(html,/<figcaption[^>]*>Inline caption<\/figcaption>/);assert.ok(html.includes(inline.url));assert.match(html,/alt="Inline image alt"/);assert.match(html,/text-align:center/);assert.match(html,/width:75%/);assert.match(html,/&lt;script&gt;escaped body text&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>|<p[^>]*>\s*<h2/);
 const draft=getDraftRecord().content,card={id:'article-card',name:'Article excerpt',updated:'',data:data(node('Text','article-card-body',{text:'Fallback',bindings:{text:binding(`field:${bodyField}`)}}))};
 save({sharedBlocks:[card],editorData:{...draft.editorData,home:{root:{props:{showChrome:'no',bindingContext:{source:'entry',recordId:saved.id,modelId:model.id}}},content:[node('SharedBlock','article-shared',{blockId:card.id}),node('ContentLoop','article-loop',{source:'entry',modelId:model.id,itemBlockId:card.id,count:3})]}}});
 const home=render(getDraftSiteSnapshot(),'/');assert.equal((home.match(/<figcaption[^>]*>Inline caption<\/figcaption>/g)||[]).length,2,'共享区块与循环卡片应使用各自当前内容的富文本覆盖');
});

test('同一段文字同时使用四种允许标记可保存和发布，仍拒绝超量及危险链接',()=>{
 // 工具栏允许B/I/U叠加链接，服务端与SSR必须接受同一文字节点的完整组合。
 const marked:RichNode={type:'text',text:'Combined formatting',marks:[{type:'bold'},{type:'italic'},{type:'underline'},{type:'link',attrs:{href:'/news/article-one'}}]};
 const doc:RichNode={type:'doc',content:[{type:'paragraph',content:[marked]}]};
 assert.deepEqual(richTextErrors(doc),[]);assert.equal(richTextPlainText(doc),'Combined formatting');save({contentEntries:[entry(doc)]});
 const formatted=/<a href="\/news\/article-one"><u><em><strong>Combined formatting<\/strong><\/em><\/u><\/a>/;
 assert.match(render(getDraftSiteSnapshot()),formatted);const published=publishSite(selection(),actor);assert.deepEqual(readRelease(published.releaseId).contentEntries![0].richTextFields?.[bodyField],doc);assert.match(render(readRelease(published.releaseId)),formatted);
 const excess=structuredClone(doc);excess.content![0].content![0].marks!.push({type:'bold'});rejectsWithoutWriting(()=>save({contentEntries:[entry(excess)]}));
 const unsafe=structuredClone(doc);unsafe.content![0].content![0].marks![3].attrs={href:'javascript:alert(1)'};rejectsWithoutWriting(()=>save({contentEntries:[entry(unsafe)]}));
});

test('正文覆盖拒绝不一致纯文本、未知字段、危险HTML节点与远程或错误类型图片，失败不写半批',async()=>{
 const inline=await image('#44aa88'),valid=entry(document(inline.url));save({contentEntries:[valid]});
 const mismatch={...valid,customFields:{...valid.customFields,[bodyField]:'Different plain body'}};rejectsWithoutWriting(()=>save({contentEntries:[mismatch]}));
 const missingPlain={...valid,customFields:{}};rejectsWithoutWriting(()=>save({contentEntries:[missingPlain]}));
 const omittedOverlay={...valid};delete omittedOverlay.richTextFields;rejectsWithoutWriting(()=>save({contentEntries:[omittedOverlay]}));
 const invalidDocs:unknown[]=[
  {type:'doc',content:[{type:'iframe',attrs:{src:'https://bad.example.invalid'}}]},
  {type:'doc',content:[{type:'image',attrs:{src:'https://bad.example.invalid/photo.jpg',alt:'',caption:'',width:100,align:'left'}}]},
  {type:'doc',content:[{type:'image',attrs:{src:inline.url,alt:'',caption:'',width:999,align:'left',onerror:'alert(1)'}}]},
  {type:'doc',content:[{type:'paragraph',attrs:{textAlign:'position:fixed'},content:[{type:'text',text:'x'}]}]},
  {type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'bad link',marks:[{type:'link',attrs:{href:'javascript:alert(1)'}}]}]}]},
  {type:'doc',content:Array.from({length:2001},()=>({type:'paragraph',content:[{type:'text',text:'x'}]}))},
 ];
 for(const doc of invalidDocs)rejectsWithoutWriting(()=>save({contentEntries:[{...valid,richTextFields:{[bodyField]:doc}}]}));
 rejectsWithoutWriting(()=>save({contentEntries:[{...valid,richTextFields:{unknown:textToRichText('Unknown')}}]}));
 rejectsWithoutWriting(()=>save({contentEntries:[{...valid,customFields:{...valid.customFields,[coverField]:inline.url},richTextFields:{[coverField]:textToRichText(inline.url)}}]}));
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);const documentMedia=await upload(await pdf.save(),'not-image.pdf','application/pdf');const wrongKind=document(documentMedia.url);rejectsWithoutWriting(()=>save({contentEntries:[entry(wrongKind)]}));
 const imageOnly:RichNode={type:'doc',content:[{type:'image',attrs:{src:inline.url,alt:'',caption:'',width:100,align:'left'}}]};save({contentEntries:[entry(imageOnly)]});assert.equal(getDraftRecord().content.contentEntries![0].customFields[bodyField],'');assert.ok(getDraftRecord().content.contentEntries![0].richTextFields?.[bodyField]);
 // 只有明确清空排版映射，才允许回到普通文本；不能被不认识新字段的旧客户端静默丢格式。
 save({contentEntries:[{...valid,richTextFields:{},customFields:{[bodyField]:'Explicit plain replacement'}}]});assert.deepEqual(getDraftRecord().content.contentEntries![0].richTextFields,{});assert.match(render(getDraftSiteSnapshot()),/Explicit plain replacement/);assert.equal(mediaUsage(inline.id).draft.length,0);
});

test('正文与内嵌图片随所选文章发布，其他草稿隔离，历史切换和选中恢复保留不可变排版',async()=>{
 const cover=await image('#113355','cover.png'),inline=await image('#cc8822'),privateImage=await image('#4466cc','private.png'),firstDoc=document(inline.url),privateDoc=document(privateImage.url,'Private caption','Private heading');
 save({contentEntries:[entry(firstDoc,cover.url),entry(privateDoc,undefined,'article-private')]});const first=publishSite(selection(),actor),snapshot=readRelease(first.releaseId);assert.ok(snapshot.media.some(m=>m.id===inline.id));assert.ok(!snapshot.media.some(m=>m.id===privateImage.id));assert.equal(isPublishedMedia(inline.id),true);assert.equal(isPublishedMedia(privateImage.id),false);assert.equal(snapshot.contentEntries!.length,1);assert.deepEqual(snapshot.contentEntries![0].richTextFields?.[bodyField],firstDoc);assert.match(render(snapshot),/<figcaption[^>]*>Inline caption<\/figcaption>/);
 const nextImage=await image('#dd2255','changed.png'),nextDoc=document(nextImage.url,'Changed caption','Changed heading');save({contentEntries:getDraftRecord().content.contentEntries!.map(e=>e.id==='article-one'?entry(nextDoc,cover.url):e)});const privateBefore=structuredClone(getDraftRecord().content.contentEntries!.find(e=>e.id==='article-private'));
 const partial=publishSite(selection({pageIds:['home'],contentModelIds:[],contentEntryIds:[],includeTheme:false,includeSettings:false}),actor);assert.deepEqual(readRelease(partial.releaseId).contentEntries![0].richTextFields?.[bodyField],firstDoc);assert.equal(isPublishedMedia(nextImage.id),false);
 const second=publishSite(selection({pageIds:[],contentModelIds:[],includeTheme:false,includeSettings:false}),actor);assert.deepEqual(readRelease(second.releaseId).contentEntries![0].richTextFields?.[bodyField],nextDoc);assert.equal(isPublishedMedia(nextImage.id),true);assert.deepEqual(readRelease(first.releaseId).contentEntries![0].richTextFields?.[bodyField],firstDoc);
 // 新正文不再使用旧图时，可移出草稿；历史恢复必须从不可变版本补回旧图元数据。
 deleteMedia(inline.id,{expectedRevision:getDraftRecord().revision});assert.ok(!getDraftRecord().content.media.some(m=>m.id===inline.id));assert.ok(readMediaFile(inline.id).bytes.length);
 activateRelease(first.releaseId,{expectedActiveReleaseId:getStudioEnvelope().activeReleaseId},actor);assert.deepEqual(getActiveSiteSnapshot()!.contentEntries![0].richTextFields?.[bodyField],firstDoc);
 restoreDraft(first.releaseId,{expectedRevision:getDraftRecord().revision,pageIds:[],productIds:[],contentModelIds:[],contentEntryIds:['article-one'],sharedBlockIds:[],includeTheme:false,includeSettings:false},actor);const restored=getDraftRecord().content,after=restored.contentEntries!;assert.deepEqual(after.find(e=>e.id==='article-one')!.richTextFields?.[bodyField],firstDoc);assert.equal(after.find(e=>e.id==='article-one')!.customFields[bodyField],richTextPlainText(firstDoc));assert.deepEqual(after.find(e=>e.id==='article-private'),privateBefore);assert.ok(restored.media.some(m=>m.id===inline.id));
});

test('整站分发重映射正文字段ID、内嵌图片与站内链接，合并后可再次发布且源包不变',async()=>{
 const inline=await image('#998844'),doc=document(inline.url);save({contentEntries:[entry(doc)]});publishSite(selection(),actor);const pkg=exportSitePackage({name:'Article writing fixture',description:'Synthetic article formatting',license:'Synthetic test content only.'}),original=JSON.stringify(pkg);
 directory=mkdtempSync(join(tmpdir(),'studio-article-writing-'));directories.push(directory);process.env.FORM_STUDIO_DATA_DIR=directory;save(createEmptyDraft());
 const request={package:pkg,expectedRevision:getDraftRecord().revision,options:{mode:'merge',prefix:'articles-imported',skuPrefix:'',enableJs:false}},preview=await previewSitePackage(request);await commitSitePackage({...request,confirmation:preview.confirmation});
 const imported=getDraftRecord().content,newModel=imported.contentModels!.find(m=>m.name===model.name)!,newBodyId=newModel.fields.find(f=>f.key==='body')!.id,article=imported.contentEntries!.find(e=>e.modelId===newModel.id)!;
 assert.notEqual(newBodyId,bodyField);assert.equal(article.richTextFields?.[bodyField],undefined);const restored=article.richTextFields![newBodyId];assert.equal(article.customFields[newBodyId],richTextPlainText(restored));
 const photo=restored.content!.find(n=>n.type==='image')!;assert.notEqual(photo.attrs!.src,inline.url);const mappedMedia=imported.media.find(m=>m.url===photo.attrs!.src)!;assert.ok(mappedMedia);assert.ok(readMediaFile(mappedMedia.id).bytes.length);
 assert.equal(photo.attrs!.alt,'Inline image alt');assert.equal(photo.attrs!.caption,'Inline caption');assert.equal(photo.attrs!.width,75);const href=restored.content![1].content!.find(n=>n.marks?.some(m=>m.type==='link'))!.marks!.find(m=>m.type==='link')!.attrs!.href;assert.equal(href,getContentEntryPath(imported,article));
 const final=publishSite({expectedRevision:getDraftRecord().revision,baseReleaseId:getStudioEnvelope().activeReleaseId,pageIds:imported.pages.map(p=>p.id),productIds:[],contentModelIds:imported.contentModels!.map(m=>m.id),contentEntryIds:imported.contentEntries!.map(e=>e.id),includeTheme:true,includeSettings:true},actor),published=readRelease(final.releaseId);
 assert.match(render(published,getContentEntryPath(published,published.contentEntries![0])!),/<figcaption[^>]*>Inline caption<\/figcaption>/);assert.equal(JSON.stringify(pkg),original);
});
