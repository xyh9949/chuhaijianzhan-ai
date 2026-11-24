import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope, patchStudio, createInquiry } from '../src/server/studio';
import { generateAiSitePlan, previewAiSite, applyAiSite, undoAiSite, resolveAiSitePreview, aiBriefContext, readAiBuildRun, listAiBuildRuns } from '../src/server/ai-builder';
import type { AiSiteBrief, AiSitePlan } from '../src/lib/ai-builder-types';
import type { Data } from '@puckeditor/core';
import type { Actor } from '../src/server/permissions';
import { ApiError } from '../src/server/http';

const admin: Actor = { id: 'ai-admin', name: 'AI管理员', email: 'admin@example.invalid', role: 'admin' };
const other: Actor = { id: 'ai-other', name: '其他管理员', email: 'other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'ai-editor', name: '编辑员', email: 'editor@example.invalid', role: 'editor' };
const brief: AiSiteBrief = { companyName: 'North Products', description: 'We provide furniture products for project buyers.', industry: 'Furniture', audience: 'Project buyers', market: 'Global', language: 'en', styleNotes: '' };
function plan(): AiSitePlan {
  return { summary: 'Use the supplied product information; confirm specifications before publishing.',
    pages: [['home', 'Home', '/', 'hero'], ['products', 'Products', '/products', 'products'], ['detail', 'Product detail', '/products/:slug', 'text'], ['contact', 'Contact', '/contact', 'contact']].map(([key,title,path,kind]) => ({ key,title,path,purpose: `Explain ${title} to project buyers`,seoTitle: `${title} | North Products`,seoDescription: `Verified ${title.toLowerCase()} information for project buyers.`,sections: [{kind:'hero',heading:title,body:`Explore ${title.toLowerCase()}.`},...(kind === 'hero' ? [] : [{kind: kind as 'products'|'text'|'contact',heading:`Explore ${title}`,body:'Discuss your requirements with our team.'}])] })),
    directions: ['editorial','catalog','showcase'].map((layout,index) => ({ id:layout,name:`Direction ${index+1}`,rationale:'Use clear product information and a distinct content rhythm.',primary:['#173443','#234d38','#6c333b'][index],background:'#faf9f6',text:'#172033',headingFont:index===0?'serif':'sans',layout:layout as 'editorial'|'catalog'|'showcase' })) };
}
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-ai-builder-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory,'data'); process.env.BETTER_AUTH_SECRET = 'ai-builder-tests-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3297';
  getDraftRecord(); const db = getDatabase(); db.prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(createEmptyDraft()));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin,other,editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id,actor.name,actor.email,actor.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous,key)) delete process.env[key]; Object.assign(process.env,previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-ai-builder-`)) rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
function status(code: number) { return (error: unknown) => error instanceof ApiError && error.status === code; }
function storePlan(data: AiSitePlan = plan()) {
  const id=`aip-${randomUUID()}`; getDatabase().prepare('INSERT INTO cms_ai_build(id,actor_id,kind,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,admin.id,'plan',getDraftRecord().revision,JSON.stringify({brief,plan:data}),new Date().toISOString(),new Date(Date.now()+60000).toISOString()); return id;
}
test('AI资料上下文只发送白名单，不包含扩展私密字段和图片文件地址', () => {
  const content=createEmptyDraft(); content.products=[{id:'p1',name:'Chair',sku:'C1',category:'Chairs',description:'Wood chair',material:'Wood',status:'draft',image:'/api/media/private-image',customFields:{internal:'DO_NOT_SEND_PRIVATE'}}]; content.media=[{id:'image-1',name:'private-file.jpg',url:'/api/media/private-image',kind:'image',alt:'Chair photograph',size:'1 MB',folder:'private-folder'}];
  const encoded=JSON.stringify(aiBriefContext(brief,content)); assert.match(encoded,/Chair photograph/); assert.doesNotMatch(encoded,/DO_NOT_SEND_PRIVATE|private-file|private-folder|\/api\/media/); assert.equal(JSON.parse(encoded).products.length,1);
});
test('本批产品ID优先于旧目录前20条，按确认顺序读取当前草稿且不接受自带正文', async () => {
  const content=createEmptyDraft(); content.products=Array.from({length:25},(_,index)=>({id:`p${index}`,name:`Product ${index}`,sku:`S${index}`,category:'Chairs',description:'Current server description',material:'Wood',status:'draft' as const,image:'',customFields:{internal:'PRIVATE'}}));
  assert.deepEqual(aiBriefContext(brief,content).products.map(product=>product.id),content.products.slice(0,20).map(product=>product.id));
  const selected=aiBriefContext(brief,content,['p24','p22']); assert.deepEqual(selected.products.map(product=>product.id),['p24','p22']); assert.equal(selected.products[0].description,'Current server description'); assert.doesNotMatch(JSON.stringify(selected),/PRIVATE/);
  for(const ids of [[],['missing'],['p24','p24'],content.products.map(product=>product.id),[{id:'p24',description:'Client text'}],['../p24']]) assert.throws(()=>aiBriefContext(brief,content,ids),status(422));
  await assert.rejects(generateAiSitePlan({brief,expectedRevision:0,selectedProductIds:['missing']},admin),status(422));
  assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_build').get() as {n:number}).n,0,'无效选择应在外发与预留付费记录前拒绝');
});
test('未配置时生成明确失败，坏资料返回422，编辑角色不能生成且不更改网站', async () => {
  const before=getDraftRecord(); await assert.rejects(generateAiSitePlan({brief,expectedRevision:0},admin),status(422)); await assert.rejects(generateAiSitePlan({brief:{},expectedRevision:0},admin),status(422)); await assert.rejects(generateAiSitePlan({brief,expectedRevision:0},editor),status(403)); assert.deepEqual(getDraftRecord(),before);
});
test('调用模型前预留容量，满额先拒绝，服务失败释放本次空记录', async () => {
  for(let index=0;index<30;index++)storePlan();
  await assert.rejects(generateAiSitePlan({brief,expectedRevision:0},admin),status(429));
  const db=getDatabase(); assert.equal((db.prepare('SELECT count(*) n FROM cms_ai_build').get() as {n:number}).n,30);
  db.prepare('DELETE FROM cms_ai_build WHERE id=(SELECT id FROM cms_ai_build LIMIT 1)').run();
  await assert.rejects(generateAiSitePlan({brief,expectedRevision:0},admin),status(422));
  assert.equal((db.prepare('SELECT count(*) n FROM cms_ai_build').get() as {n:number}).n,29);
});
test('首页已有收录、分享图或语言设置时不作为原始空站替换', () => {
  for(const metadata of [{noindex:true},{seoImage:'/images/chair.jpg'},{locale:'en'}]){
    const content=createEmptyDraft();Object.assign(content.pages[0],metadata);getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
    assert.throws(()=>previewAiSite({planId:storePlan(),directionId:'editorial',prefix:''},admin),status(422));
    assert.deepEqual(getDraftRecord().content.pages[0],content.pages[0]);
  }
});
test('三方向预览不写草稿、不发布，品牌仅进入新页面且可用真实私有预览', () => {
  const before=getDraftRecord(), planId=storePlan(); const results=['editorial','catalog','showcase'].map(directionId => previewAiSite({planId,directionId,prefix:''},admin));
  assert.deepEqual(getDraftRecord(),before); assert.equal(getStudioEnvelope().activeReleaseId,null); assert.equal(results[0].pages.length,4);
  const candidate=resolveAiSitePreview(results[0].previewId,[],admin); assert.ok(candidate); assert.equal(candidate.snapshot.settings.name,brief.companyName);
  assert.equal((candidate.resolved.data.root.props as Record<string,unknown>)?.showChrome,'yes');
  assert.match(JSON.stringify(candidate.snapshot.sharedBlocks?.find(block=>block.id===candidate.snapshot.siteLayout?.header.blockId)),/North Products/);
  assert.equal(candidate.snapshot.customCode?.global.jsEnabled,false);
  assert.notDeepEqual(candidate.resolved.data,resolveAiSitePreview(results[1].previewId,[],admin)!.resolved.data);
});
test('保存为普通草稿且同一预览重试幂等，不触碰询盘与公开指针', () => {
  const inquiry=createInquiry({name:'Test buyer',email:'buyer@example.invalid',message:'Private inquiry stays private'}).item;
  const preview=previewAiSite({planId:storePlan(),directionId:'editorial',prefix:''},admin), first=applyAiSite({previewId:preview.previewId,expectedRevision:0},admin), second=applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
  assert.equal(first.revision,1); assert.equal(second.revision,1); assert.equal(first.activeReleaseId,null); assert.equal(first.state.inquiries[0].id,inquiry.id); assert.equal(first.state.pages.length,4); assert.ok(first.state.forms?.length);
  assert.deepEqual(first.state.settings,{...createEmptyDraft().settings,name:brief.companyName,description:plan().pages[0].seoDescription}); const actions=getDatabase().prepare("SELECT action FROM cms_audit WHERE action='ai.apply'").all(); assert.equal(actions.length,1);
});
test('预览后并发修改拒绝409，重新预览无须模型并保留最新主题', () => {
  const planId=storePlan(), preview=previewAiSite({planId,directionId:'catalog',prefix:'/generated'},admin);
  const theme={...getDraftRecord().content.theme,primary:'#654321'}; patchStudio({expectedRevision:0,patch:{theme}},admin);
  assert.throws(()=>applyAiSite({previewId:preview.previewId,expectedRevision:0},admin),status(409));
  const updated=previewAiSite({planId,directionId:'catalog',prefix:'/generated'},admin); assert.equal(updated.baseRevision,1); assert.match(updated.warnings.join(' '),/资料发生变化/);
  const saved=applyAiSite({previewId:updated.previewId,expectedRevision:1},admin); assert.equal(saved.state.theme.primary,'#654321'); assert.equal(saved.revision,2);
});
test('规划与预览绑定管理员，过期与降权不会继续应用', () => {
  const planId=storePlan(); assert.throws(()=>previewAiSite({planId,directionId:'editorial',prefix:''},other),status(404)); assert.throws(()=>previewAiSite({planId,directionId:'editorial',prefix:''},editor),status(403));
  const preview=previewAiSite({planId,directionId:'editorial',prefix:''},admin); assert.throws(()=>resolveAiSitePreview(preview.previewId,[],other),status(404));
  getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); assert.throws(()=>applyAiSite({previewId:preview.previewId,expectedRevision:0},admin),status(403));
  getDatabase().prepare("UPDATE auth_user SET role='admin' WHERE id=?").run(admin.id); getDatabase().prepare('UPDATE cms_ai_build SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',preview.previewId); assert.throws(()=>applyAiSite({previewId:preview.previewId,expectedRevision:0},admin),status(410)); assert.equal(getDraftRecord().revision,0);
});
test('模型规划再次检查，拒绝注入属性、无效方向和系统目录', () => {
  const bad=plan(); (bad.pages[0] as unknown as Record<string,unknown>).script='alert(1)'; const planId=storePlan(bad);
  assert.throws(()=>previewAiSite({planId,directionId:'editorial',prefix:''},admin),status(422)); assert.throws(()=>previewAiSite({planId,directionId:'unknown',prefix:''},admin),status(422)); assert.throws(()=>previewAiSite({planId,directionId:'editorial',prefix:'/admin'},admin),status(422)); assert.equal(getDraftRecord().revision,0);
});

/** 更新时间由原生保存服务维护；验收比较业务字段及可选集合存在性，不伪造旧保存日期。 */
function withoutPageDates(value: ReturnType<typeof getDraftRecord>['content']) {
  return {...value,pages:value.pages.map(({updated,...page})=>{void updated;return page;})};
}
test('初次建站可恢复原生字段及缺省集合，7天回执只读恢复且撤销幂等',()=>{
  const original=getDraftRecord().content,preview=previewAiSite({planId:storePlan(),directionId:'editorial',prefix:''},admin);
  const pending=readAiBuildRun(preview.previewId,admin);assert.equal(pending.kind,'preview');if(pending.kind==='preview')assert.equal(pending.canUndo,false);
  const applied=applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
  assert.equal(applied.buildUndo.canUndo,true);assert.equal(applied.buildUndo.undoneRevision,null);
  assert.ok(Date.parse(applied.buildUndo.expiresAt)>Date.now()+6.9*24*60*60*1000);
  const recovered=readAiBuildRun(preview.previewId,admin);assert.equal(recovered.kind,'preview');if(recovered.kind==='preview')assert.equal(recovered.canUndo,true);
  assert.equal(listAiBuildRuns(admin).items.find(item=>item.id===preview.previewId)?.canUndo,true);
  const undone=undoAiSite({previewId:preview.previewId,expectedRevision:1},admin);
  assert.equal(undone.revision,2);assert.equal(undone.buildUndo.canUndo,false);assert.equal(undone.buildUndo.undoneRevision,2);
  assert.deepEqual(withoutPageDates(getDraftRecord().content),withoutPageDates(original));
  assert.equal(Object.hasOwn(getDraftRecord().content,'forms'),false);assert.equal(Object.hasOwn(getDraftRecord().content,'pageTemplates'),false);
  assert.equal(undoAiSite({previewId:preview.previewId,expectedRevision:0},admin).revision,2,'已完成撤销的重试不再写入');
  assert.throws(()=>applyAiSite({previewId:preview.previewId,expectedRevision:2},admin),status(409));
  assert.equal((getDatabase().prepare("SELECT count(*) n FROM cms_audit WHERE action='ai.undo'").get() as {n:number}).n,1);
});
test('撤销只反转本次差异，保留后来邮箱、主题、产品及其他页面和资源',()=>{
  const original=getDraftRecord().content,preview=previewAiSite({planId:storePlan(),directionId:'catalog',prefix:''},admin);
  applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
  const current=getDraftRecord().content,manualPage={...original.pages[0],id:'manual',title:'Manual page',slug:'/manual'};
  const manualForm={...current.forms![0],id:'manual-form',name:'Manual form'};
  const manualTemplate={id:'manual-template',name:'Manual template',description:'Human layout',kind:'page' as const,data:original.editorData.home,updated:new Date().toISOString()};
  const product={id:'manual-product',name:'Manual product',sku:'MANUAL',category:'Manual',description:'Human facts',material:'Steel',image:'',status:'draft' as const};
  patchStudio({expectedRevision:1,patch:{settings:{...current.settings,email:'human@example.invalid'},theme:{...current.theme,primary:'#663344'},products:[product],pages:[...current.pages,manualPage],editorData:{...current.editorData,manual:original.editorData.home},forms:[...current.forms!,manualForm],pageTemplates:[...(current.pageTemplates||[]),manualTemplate]}},admin);
  const beforeUndo=getDraftRecord().content,undone=undoAiSite({previewId:preview.previewId,expectedRevision:2},admin);
  assert.equal(undone.state.settings.email,'human@example.invalid');assert.equal(undone.state.settings.name,original.settings.name);assert.equal(undone.state.settings.description,original.settings.description);assert.equal(undone.state.theme.primary,'#663344');
  assert.deepEqual(getDraftRecord().content.products,beforeUndo.products);assert.ok(getDraftRecord().content.pages.some(page=>page.id==='manual'));
  assert.deepEqual(getDraftRecord().content.editorData.manual,original.editorData.home);assert.deepEqual(getDraftRecord().content.forms,[manualForm]);
  assert.deepEqual(getDraftRecord().content.pageTemplates,beforeUndo.pageTemplates!.filter(template=>template.id==='manual-template'));
});
test('现站生成的详情模板按资源撤销，保留旧详情和后来独立模板',()=>{
  const first=previewAiSite({planId:storePlan(),directionId:'editorial',prefix:''},admin);applyAiSite({previewId:first.previewId,expectedRevision:0},admin);
  const original=getDraftRecord().content,second=previewAiSite({planId:storePlan(),directionId:'catalog',prefix:'/alternative'},admin);
  assert.match(second.warnings.join(' '),/未激活的页面模板/);applyAiSite({previewId:second.previewId,expectedRevision:1},admin);
  const current=getDraftRecord().content,newTemplate=current.pageTemplates![0],manual={...newTemplate,id:'manual-template',name:'Human independent layout',sourcePath:'/manual',kind:'page' as const,data:original.editorData[original.pages[0].id]};
  patchStudio({expectedRevision:2,patch:{pageTemplates:[...current.pageTemplates!,manual]}},admin);
  const savedManual=getDraftRecord().content.pageTemplates!.find(template=>template.id==='manual-template');
  undoAiSite({previewId:second.previewId,expectedRevision:3},admin);assert.deepEqual(getDraftRecord().content.pageTemplates,[savedManual]);
  assert.deepEqual(getDraftRecord().content.editorData,original.editorData);assert.deepEqual(withoutPageDates(getDraftRecord().content).pages,withoutPageDates(original).pages);
});
test('共享头尾撤销仅移除本次资产，后来独立的菜单和区块仍可编辑',()=>{
  const preview=previewAiSite({planId:storePlan(),directionId:'editorial',prefix:''},admin);
  applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
  const current=getDraftRecord().content;
  const menu={id:'other-menu',name:'独立菜单',items:[{id:'home-link',label:'Home',target:{kind:'page' as const,id:'home'}}]};
  const block={id:'other-block',name:'独立区块',data:{root:{props:{}},content:[{type:'Text',props:{id:'manual-copy',text:'Human content'}}]},updated:''};
  patchStudio({expectedRevision:1,patch:{siteLayout:{...current.siteLayout!,menus:[...(current.siteLayout?.menus || []),menu]},sharedBlocks:[...(current.sharedBlocks || []),block]}},admin);
  const savedBlock=getDraftRecord().content.sharedBlocks?.find(item=>item.id===block.id);
  undoAiSite({previewId:preview.previewId,expectedRevision:2},admin);
  const next=getDraftRecord().content;
  assert.deepEqual(next.siteLayout,{header:{mode:'default',blockId:''},footer:{mode:'default',blockId:''},menus:[menu]});
  assert.deepEqual(next.sharedBlocks,[savedBlock]);
});
test('撤销保护后来明确使用的共享区块及本次菜单手工改动',()=>{
  for(const scope of ['block','menu'] as const){
    getDatabase().prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(createEmptyDraft()));
    const preview=previewAiSite({planId:storePlan(),directionId:'editorial',prefix:''},admin);
    applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
    const current=getDraftRecord().content;
    if(scope==='menu'){
      const layout=structuredClone(current.siteLayout!);
      layout.menus![0].items[0].label='Human label';
      patchStudio({expectedRevision:1,patch:{siteLayout:layout}},admin);
    }else{
      const page={id:'manual-reference',title:'Manual',slug:'/manual',type:'普通页面',status:'draft' as const,updated:''};
      patchStudio({expectedRevision:1,patch:{pages:[...current.pages,page],editorData:{...current.editorData,[page.id]:{root:{props:{}},content:[{type:'SharedBlock',props:{id:'block-ref',blockId:current.siteLayout!.header.blockId}}]}}}},admin);
    }
    const before=getDraftRecord();
    assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:2},admin),status(409));
    assert.deepEqual(getDraftRecord(),before);
  }
});
test('同一页面布局或本次站名后改会阻止旧撤销，失败保持回执和草稿',()=>{
  for(const kind of ['layout','name'] as const){
    getDatabase().prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(createEmptyDraft()));
    const preview=previewAiSite({planId:storePlan(),directionId:'showcase',prefix:''},admin);applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
    const current=getDraftRecord().content;
    if(kind==='name')patchStudio({expectedRevision:1,patch:{settings:{...current.settings,name:'Human brand'}}},admin);
    else {const id=preview.pages.find(page=>page.slug==='/')!.id,data=current.editorData[id] as Data;patchStudio({expectedRevision:1,patch:{editorData:{...current.editorData,[id]:{...data,root:{...data.root,props:{...data.root.props,brand:'Human layout'}}}}}},admin);}
    const before=getDraftRecord(),run=readAiBuildRun(preview.previewId,admin);if(run.kind==='preview'){assert.equal(run.canUndo,false);assert.match(run.undoReason||'',/后续修改/);}
    assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:2},admin),status(409));assert.deepEqual(getDraftRecord(),before);
  }
});
test('撤销删除新页面前阻止后来菜单、富文本路径和页面源码引用',()=>{
  for(const kind of ['menu','rich-link','absolute-link','code'] as const){
    const original=createEmptyDraft();original.settings.publicUrl='https://factory.example.invalid';getDatabase().prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(original));
    const preview=previewAiSite({planId:storePlan(),directionId:'editorial',prefix:''},admin);applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
    const current=getDraftRecord().content,target=preview.pages.find(page=>page.slug==='/contact')!;
    if(kind==='menu')patchStudio({expectedRevision:1,patch:{siteLayout:{...current.siteLayout!,menus:[...(current.siteLayout?.menus || []),{id:'manual-menu',name:'Manual menu',items:[{id:'manual-link',label:'Contact',target:{kind:'page',id:target.id}}]}]}}},admin);
    else if(kind==='code')patchStudio({expectedRevision:1,patch:{customCode:{global:{css:'',js:'',cssEnabled:false,jsEnabled:false},pages:{[target.id]:{css:'.human {color:red}',js:'',cssEnabled:true,jsEnabled:false}}}}},admin);
    else patchStudio({expectedRevision:1,patch:{pages:[...current.pages,{...original.pages[0],id:'manual',title:'Manual article',slug:'/manual'}],editorData:{...current.editorData,manual:{root:{props:{showChrome:'no'}},content:[{type:'RichText',props:{id:'manual-link',doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Contact our team',marks:[{type:'link',attrs:{href:`${kind==='absolute-link'?original.settings.publicUrl:''}/contact?source=manual#form`}}]}]}]}}}]}}}},admin);
    const before=getDraftRecord();assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:2},admin),status(409));assert.deepEqual(getDraftRecord(),before);
  }
});
test('旧内容已有的未来页面URL不是后续新增引用，初次采用后仍能立即精确撤销',()=>{
  const original=createEmptyDraft();original.editorData.home={root:{props:{showChrome:'no'}},content:[{type:'RichText',props:{id:'existing-future-link',doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Prepared contact link',marks:[{type:'link',attrs:{href:'/generated/contact'}}]}]}]}}}]};
  getDatabase().prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(original));
  const preview=previewAiSite({planId:storePlan(),directionId:'editorial',prefix:'/generated'},admin),applied=applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
  assert.equal(applied.buildUndo.canUndo,true);undoAiSite({previewId:preview.previewId,expectedRevision:1},admin);
  assert.deepEqual(withoutPageDates(getDraftRecord().content),withoutPageDates(original));
});
test('不能删除原URL后在新页面或新节点复制同URL来绕过撤销依赖检查',()=>{
  for(const destination of ['new-page','new-node'] as const){
    const original=createEmptyDraft(),node={type:'RichText',props:{id:'original-link-node',doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Prepared contact',marks:[{type:'link',attrs:{href:'/generated/contact'}}]}]}]}}};
    original.editorData.home={root:{props:{showChrome:'no'}},content:[node]};getDatabase().prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(original));
    const preview=previewAiSite({planId:storePlan(),directionId:'catalog',prefix:'/generated'},admin);applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
    const current=getDraftRecord().content,copy={...node,props:{...node.props,id:'new-link-node'}},home=current.editorData.home as Data;
    patchStudio({expectedRevision:1,patch:{...(destination==='new-page'?{pages:[...current.pages,{...original.pages[0],id:'manual',slug:'/manual'}]}:{}),editorData:{...current.editorData,home:{...home,content:destination==='new-node'?[copy]:[]},...(destination==='new-page'?{manual:{root:{props:{showChrome:'no'}},content:[copy]}}:{})}}},admin);
    const before=getDraftRecord();assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:2},admin),status(409));assert.deepEqual(getDraftRecord(),before);
  }
});
test('旧采用记录不猜测整站恢复，撤销仍绑定权限、会话、最新版本与有效期',()=>{
  const preview=previewAiSite({planId:storePlan(),directionId:'editorial',prefix:''},admin);applyAiSite({previewId:preview.previewId,expectedRevision:0},admin);
  assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:1},other),status(404));assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:1},editor),status(403));
  assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:0},admin),status(409));
  assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:1},admin,()=>{throw new ApiError(401,'Revoked session');}),status(401));assert.equal(getDraftRecord().revision,1);
  const db=getDatabase(),row=db.prepare('SELECT payload_json FROM cms_ai_build WHERE id=?').get(preview.previewId) as {payload_json:string},payload=JSON.parse(row.payload_json);delete payload.receipt;db.prepare('UPDATE cms_ai_build SET payload_json=? WHERE id=?').run(JSON.stringify(payload),preview.previewId);
  const legacy=readAiBuildRun(preview.previewId,admin);if(legacy.kind==='preview'){assert.equal(legacy.canUndo,false);assert.match(legacy.undoReason||'',/没有安全撤销回执/);}assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:1},admin),status(422));
  db.prepare('UPDATE cms_ai_build SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',preview.previewId);assert.throws(()=>undoAiSite({previewId:preview.previewId,expectedRevision:1},admin),status(410));assert.equal(getDraftRecord().revision,1);
});
test('真实预览给出原生布局事实，恢复始终来自旧冻结snapshot且不写记录或重编当前站',()=>{
  const preview=previewAiSite({planId:storePlan(),directionId:'catalog',prefix:''},admin);assert.equal(preview.inspection.source,'native-components');assert.ok(preview.inspection.pages.length>=4);
  const home=preview.inspection.pages.find(page=>page.path==='/')!;assert.ok(home.sections.some(section=>section.desktop.flow.includes('title')));
  const db=getDatabase(),row=db.prepare('SELECT payload_json FROM cms_ai_build WHERE id=?').get(preview.previewId) as{payload_json:string},payload=JSON.parse(row.payload_json);
  // 构造旧记录特征：只有冻结原生页面有这个7列值；重新编当前模型规划绝不会得到它。
  const contentIndex=home.sections.findIndex(section=>section.role==='content');
  delete payload.inspectionTemplateIds;payload.snapshot.editorData[home.id].content[contentIndex].props.design.desktop.columns=7;
  db.prepare('UPDATE cms_ai_build SET payload_json=? WHERE id=?').run(JSON.stringify(payload),preview.previewId);
  const stored=db.prepare('SELECT * FROM cms_ai_build WHERE id=?').get(preview.previewId),draft=getDraftRecord(),restored=readAiBuildRun(preview.previewId,admin);
  assert.equal(restored.kind,'preview');if(restored.kind==='preview')assert.equal(restored.inspection?.pages.find(page=>page.id===home.id)?.sections[contentIndex].desktop.columns,7);
  assert.deepEqual(getDraftRecord(),draft);assert.deepEqual(db.prepare('SELECT * FROM cms_ai_build WHERE id=?').get(preview.previewId),stored);
  assert.throws(()=>readAiBuildRun(preview.previewId,other),status(404));
});
