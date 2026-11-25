import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, patchStudio, getStudioEnvelope, createInquiry } from '../src/server/studio';
import { publishSite, getActiveSiteSnapshot } from '../src/server/publication';
import { buildSitePackage, exportSitePackage, previewSitePackage, commitSitePackage, validateSitePackage, type SitePackage } from '../src/server/site-package';
import { remapPortableSite } from '../src/server/portable-site';
import { uploadMedia, readMediaFile, readImageVariant } from '../src/server/media';
import { createFormDefinition } from '../src/lib/form-content';
import { savePageAsTemplate } from '../src/server/page-templates';
import { resolveSitePage } from '../src/lib/site-routing';
import { contentBindingErrors } from '../src/lib/content-binding';
import { STARTER_KITS, createStarterSnapshot } from '../src/lib/starter-kits';
import { designClassName } from '../src/lib/responsive-style';
import {siteMetadata} from '../src/lib/site-metadata';
import { createEmptyDraft } from '../src/server/seed';
import protocol from '../src/lib/protocol.json';
import { actualSiteRoutes } from '../src/lib/site-redirects';

let directory = '', previous: NodeJS.ProcessEnv, directories: string[] = [];
const actor = { id: 'package-admin', name: '分发验收' }, options = { mode: 'fresh', prefix: 'imported', skuPrefix: '', enableJs: false };
beforeEach(() => { previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-package-')); directories = [directory]; process.env.FORM_STUDIO_DATA_DIR = directory; process.env.BETTER_AUTH_SECRET = 'package-test-secret-'.repeat(4); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3201'; });
afterEach(() => { for (const path of directories) { process.env.FORM_STUDIO_DATA_DIR = path; getDatabase().close(); if (resolve(path).startsWith(`${resolve(tmpdir())}${sep}studio-package-`)) rmSync(path, { recursive:true,force:true,maxRetries:5,retryDelay:100 }); } for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous,key)) delete process.env[key]; Object.assign(process.env, previous); });
const save = (patch: object) => patchStudio({ expectedRevision: getDraftRecord().revision, patch });
const node = (type: string, id: string, props: object = {}) => ({ type, props: { id, ...props } as Record<string, unknown> & { id: string } });
const data = (...content: ReturnType<typeof node>[]) => ({ root: { props: { showChrome:'no' } }, content });
const selection = () => { const d = getDraftRecord().content; return { expectedRevision: getDraftRecord().revision, baseReleaseId: getStudioEnvelope().activeReleaseId, pageIds:d.pages.map(p=>p.id),productIds:d.products.map(p=>p.id),contentModelIds:d.contentModels?.map(m=>m.id),contentEntryIds:d.contentEntries?.map(e=>e.id),sharedBlockIds:d.sharedBlocks?.map(b=>b.id),includeTheme:true,includeSettings:true,includeCode:true,includeLayout:true,includeTemplates:true,includeForms:true,includeCatalog:true,includeRedirects:true }; };
function switchFresh() { directory = mkdtempSync(join(tmpdir(),'studio-package-')); directories.push(directory); process.env.FORM_STUDIO_DATA_DIR = directory; return getDraftRecord(); }
async function sourcePackage() {
  const base = getDraftRecord().content, form = createFormDefinition('form-source');
  const bytes = await sharp({create:{width:640,height:400,channels:3,background:'#00aabb'}}).png().toBuffer(), upload = new FormData(); upload.set('file',new File([new Uint8Array(bytes)],'photo.png',{type:'image/png'}));upload.set('expectedRevision',String(getDraftRecord().revision)); const image = (await uploadMedia(upload)).media;
  const models = [{id:'model-p',name:'Product fields',description:'',target:'product' as const,updated:'',fields:[{id:'same-field',key:'spec',label:'Spec',type:'number' as const,required:false}]},{id:'model-c',name:'Cases',description:'',target:'content' as const,updated:'',fields:[{id:'same-field',key:'summary',label:'Summary',type:'text' as const,required:false}]}];
  const home = {...base.pages[0],id:'source-home',title:'Demo home',slug:'/'}, detail={...home,id:'source-product',title:'Product',slug:'/products/:slug'}, entryPage={...home,id:'source-entry',title:'Cases',slug:'/cases/:slug',contentModelId:'model-c'};
  const editorData = { [home.id]:data(node('Heading','hero',{text:'source-home',anchor:'welcome',stylePresetId:'preset',tokenBindings:{desktop:{color:'token'}}}),node('Image','photo',{src:image.url,alt:'Demo'}),node('Form','inquiry',{formId:form.id,wideFields:[form.fields[3].id]}),node('Navigation','nav',{menuId:'menu'}),node('SharedBlock','shared',{blockId:'block'}),node('ContentLoop','loop',{source:'entry',modelId:'model-c',itemBlockId:'card',query:{sort:'field:same-field',termIds:['term'],filters:[{field:'field:same-field',op:'contains',value:'Synthetic'}]},count:4})),[detail.id]:data(node('Heading','product-name',{text:'Fallback',bindings:{text:{source:'product',mode:'current',modelId:'model-p',field:'field:same-field'}}})),[entryPage.id]:data(node('Heading','entry-name',{text:'Fallback',bindings:{text:{source:'entry',mode:'current',modelId:'model-c',field:'field:same-field'}}})) };
  save({pages:[home,detail,entryPage],editorData,products:[{...base.products[0],id:'source-product-1',slug:'demo-product',sku:'DEMO-001',modelId:'model-p',customFields:{'same-field':0},image:image.url}],contentModels:models,contentEntries:[{id:'source-entry-1',slug:'case-one',modelId:'model-c',title:'Synthetic case',status:'draft',updated:'',customFields:{'same-field':'Synthetic example'},termIds:['term']}],forms:[form],sharedBlocks:[{id:'block',name:'Shared',updated:'',data:data(node('ActionButton','shared-link',{text:'Home',href:'/#welcome',linkTarget:{kind:'page',id:home.id}}))},{id:'card',name:'Card',updated:'',data:data(node('Heading','card-title',{text:'Example',bindings:{text:{source:'entry',mode:'current',modelId:'model-c',field:'builtin:title'}}}))}],siteLayout:{header:{mode:'default',blockId:'',menuId:'menu'},footer:{mode:'default',blockId:''},menus:[{id:'menu',name:'Main',items:[{id:'menu-item',label:'Case',target:{kind:'entry',id:'source-entry-1'}}]}]},theme:{...base.theme,tokens:[{id:'token',name:'Accent',value:'#fff'}],presets:[{id:'preset',name:'Heading',design:{desktop:{fontSize:32}},tokenBindings:{desktop:{color:'token'}}}]},taxonomies:[{id:'tax',name:'Cases',source:'entry',modelId:'model-c',terms:[{id:'term',label:'Demo',slug:'demo'}]}],customCode:{global:{css:`#hero,.${designClassName('hero')}{color:#fff}`,js:'document.getElementById("hero");',cssEnabled:true,jsEnabled:true},pages:{[home.id]:{css:'#welcome{padding:2px}',js:'document.querySelector("#hero"); const path="/cases/case-one";',cssEnabled:true,jsEnabled:true}}}});
  savePageAsTemplate({expectedRevision:getDraftRecord().revision,pageId:home.id,templateId:'source-template',name:'Demo template'});
  publishSite(selection(),actor);
  createInquiry({name:'Secret buyer',email:'buyer@example.invalid',message:'Never export inquiry'});
  return exportSitePackage({name:'Demonstration package',description:'Synthetic demonstration',license:'Synthetic content for QA. Replace real customer assets with licensed material.'});
}
const rehash = (p: SitePackage) => { p.manifest.snapshotSha256 = createHash('sha256').update(JSON.stringify(p.snapshot)).digest('hex'); return p; };
test('英德包合并法语实例需显式语言配置，前缀/翻译组/菜单映射保留原文身份且不串到host组',async()=>{
 const source=createStarterSnapshot('manufacturing'),enHome=source.pages.find(p=>p.slug==='/')!;
 source.settings.locales=[{code:'en',label:'English'},{code:'de',label:'Deutsch'}];enHome.locale='en';enHome.translationGroupId='group-home';
 const deHome={...enHome,id:'de-home',slug:'/de',locale:'de',title:'Startseite'};source.pages.push(deHome);source.editorData[deHome.id]=data(node('Heading','de-heading',{text:'Unser Unternehmen'}),node('LanguageSwitcher','de-switch',{missing:'disabled'}),node('Navigation','de-navigation',{menuId:'starter-menu',localeMenuIds:{de:'de-menu'}}));
 source.siteLayout!.menus!.push({id:'de-menu',name:'Deutsch',items:[{id:'de-menu-home',label:'Startseite',target:{kind:'page',id:'de-home'}}]});
 const product=source.products[0];product.slug='chair';product.locale='en';product.translationGroupId='group-product';source.products.push({...product,id:'de-product',name:'Stuhl',sku:`${product.sku}-DE`,locale:'de',slug:'stuhl'});
 const pkg=buildSitePackage(source,{name:'Bilingual fixture',description:'Synthetic',license:'Synthetic QA layout only.'});
 const d=getDraftRecord().content;save({settings:{...d.settings,language:'fr'}});save({settings:{...d.settings,name:'French host',language:'fr',locales:[{code:'fr',label:'Français'}],publicUrl:'https://french.example.invalid'},pages:[{id:'home',title:'Accueil',slug:'/',locale:'fr',translationGroupId:'group-home',type:'普通页面',status:'draft',updated:''}],products:[],media:[],editorData:{home:data(node('Heading','host-title',{text:'Entreprise française'}))}});const host=publishSite(selection(),actor);const before=getDraftRecord().revision;
 const input={package:pkg,expectedRevision:before,options:{mode:'merge',prefix:'bilingual',skuPrefix:'COPY-',enableJs:false}};await assert.rejects(()=>previewSitePackage(input),/明确选择合并语言/);assert.equal(getDraftRecord().revision,before);
 const explicit={...input,options:{...input.options,mergeLocales:true}},plan=await previewSitePackage(explicit);assert.ok(plan.paths.some(p=>p.from==='/de'&&p.to==='/de/bilingual'),'语言前缀须在命名空间之外');assert.ok(plan.paths.some(p=>p.from==='/'&&p.to==='/en/bilingual'),'来源默认英文不可冒充host默认法文');
 const result=await commitSitePackage({...explicit,confirmation:plan.confirmation});assert.equal(result.activeReleaseId,host.releaseId);assert.equal(result.state.settings.language,'fr');assert.equal(result.state.settings.name,'French host');assert.deepEqual(result.state.settings.locales?.map(l=>l.code),['fr','en','de']);
 const importedEn=result.state.pages.find(p=>p.slug==='/en/bilingual')!,importedDe=result.state.pages.find(p=>p.slug==='/de/bilingual')!;assert.equal(importedEn.translationGroupId,importedDe.translationGroupId);assert.notEqual(importedEn.translationGroupId,'group-home');
 const germanProduct=result.state.products.find(p=>p.locale==='de')!,englishProduct=result.state.products.find(p=>p.translationGroupId===germanProduct.translationGroupId&&p.locale==='en')!;assert.equal(germanProduct.slug?.endsWith('-stuhl'),true);assert.equal(englishProduct.locale,'en');assert.equal(resolveSitePage(getActiveSiteSnapshot()!,['de','bilingual']),null);
 publishSite(selection(),actor);const live=getActiveSiteSnapshot()!,resolved=resolveSitePage(live,['de','bilingual'])!;assert.equal(resolved.page.id,importedDe.id);assert.deepEqual(Object.keys(siteMetadata(live,resolved).alternates?.languages||{}).sort(),['de','en']);const nav=(result.state.editorData[importedDe.id] as {content:{props:{menuId?:string;localeMenuIds?:Record<string,string>}}[]}).content[2].props;assert.equal(nav.menuId,'');assert.ok(nav.localeMenuIds?.en&&nav.localeMenuIds?.de,'原英文菜单保存在en映射，德文映射独立');
 const exported=exportSitePackage({name:'Re-export',description:'Synthetic',license:'Synthetic QA only.'});assert.deepEqual(exported.snapshot.settings.locales,live.settings.locales);await validateSitePackage(exported);
});

test('站A公开包到新站B：全部作用域、绑定、菜单、表单/整行、代码和原媒体映射，可再发布；没有源询盘/运行指针', async () => {
  const pkg=await sourcePackage(),original=JSON.stringify(pkg); assert.equal(original.includes('Secret buyer'),false); assert.equal(original.includes('activeReleaseId'),false); assert.equal(original.includes('releaseId'),false);
  switchFresh();const request={package:pkg,options,expectedRevision:0},plan=await previewSitePackage(request); assert.ok(plan.confirmation);assert.equal(getDraftRecord().revision,0);
  const imported=await commitSitePackage({...request,confirmation:plan.confirmation}), draft=getDraftRecord().content;
  assert.equal(imported.activeReleaseId,null);assert.equal(imported.state.inquiries.length,0);assert.equal(draft.pages.length,3);assert.equal(draft.products[0].customFields![draft.contentModels![0].fields[0].id],0);assert.notEqual(draft.contentModels![0].fields[0].id,draft.contentModels![1].fields[0].id);
  const h=draft.pages.find(p=>p.slug==='/')!,nodes=(draft.editorData[h.id] as ReturnType<typeof data>).content;
  assert.equal(nodes[0].props.text,'source-home');assert.equal((nodes[2].props.wideFields as string[])[0],draft.forms![0].fields[3].id); assert.equal(draft.customCode!.global.jsEnabled,false);assert.ok(!draft.customCode!.global.css.includes('#hero'));
  assert.deepEqual(contentBindingErrors({...draft,products:draft.products.map(p=>({...p,status:'published'})),contentEntries:draft.contentEntries!.map(e=>({...e,status:'published'}))},true),[]);
  assert.equal(readMediaFile(draft.media.find(m=>m.url.startsWith('/api/media/'))!.id).bytes.toString('base64'),pkg.files[0].content);
  publishSite(selection(),actor);assert.ok(resolveSitePage(getActiveSiteSnapshot()!,['cases','case-one']));assert.equal(JSON.stringify(pkg),original);
});

test('合并保留原站/线上/询盘，SKU冲突必须显式前缀，源产品详情存资源；重复路径拒绝且无半批写入', async () => {
  const pkg=await sourcePackage();switchFresh();const before=getDraftRecord();save({products:[{...before.content.products[0],sku:'DEMO-001'}]}); createInquiry({name:'Host buyer',email:'host@example.invalid',message:'Host inquiry'});
  const opts={...options,mode:'merge'},request={package:pkg,options:opts,expectedRevision:getDraftRecord().revision}; await assert.rejects(()=>previewSitePackage(request),/SKU/);
  request.options.skuPrefix='COPY-';const plan=await previewSitePackage(request),env=await commitSitePackage({...request,confirmation:plan.confirmation});
  assert.equal(env.state.inquiries[0].name,'Host buyer');assert.equal(env.state.settings.name,before.content.settings.name);assert.equal(env.state.pages.filter(p=>p.slug==='/products/:slug').length,1);assert.ok(env.state.pageTemplates?.some(t=>t.kind==='product'));assert.equal(env.activeReleaseId,null);assert.ok(env.state.pages.some(p=>p.slug==='/imported')); const copy=env.state.pages.find(p=>p.slug==='/imported')!;assert.match(env.state.customCode!.pages[copy.id].js,/getElementById/);assert.equal(env.state.customCode!.pages[copy.id].jsEnabled,false);
  const revision=getDraftRecord().revision;await assert.rejects(()=>previewSitePackage({...request,expectedRevision:revision}),/SKU|路径|重复/); assert.equal(getDraftRecord().revision,revision);
  await assert.rejects(()=>previewSitePackage({package:pkg,options,expectedRevision:revision}),/新建模式/);
});

test('篡改/缺文件/路径穿越/伪造媒体/未知组件/敏感顶层均拒绝，失败无文件索引和草稿变化', async () => {
  const pkg=await sourcePackage();switchFresh();
  for (const mutate of [(p:SitePackage)=>{p.files[0].path='../escape.webp';},(p:SitePackage)=>{p.files=[];},(p:SitePackage)=>{p.files[0].content=(p.files[0].content[0]==='A'?'B':'A')+p.files[0].content.slice(1);},(p:SitePackage)=>{p.snapshot.pages[0].title='tampered';},(p:SitePackage)=>{(p.snapshot.editorData[p.snapshot.pages[0].id] as ReturnType<typeof data>).content[0].type='UnknownWidget';rehash(p);},(p:SitePackage)=>{(p.snapshot.settings as unknown as Record<string,unknown>).password='secret';rehash(p);},(p:SitePackage)=>{p.manifest.rendererVersion=999;}]) {
    const bad=structuredClone(pkg);mutate(bad);await assert.rejects(()=>previewSitePackage({package:bad,options,expectedRevision:0}));assert.equal(getDraftRecord().revision,0);assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_media_file').get() as {n:number}).n,0);
  }
});

test('确认绑定文件/选项/版本/时间；事务写入故障回滚媒体索引和新增文件，保留原包',async()=>{
  const pkg=await sourcePackage();switchFresh();const input={package:pkg,options,expectedRevision:0},plan=await previewSitePackage(input,1000);
  await assert.rejects(()=>commitSitePackage({...input,confirmation:plan.confirmation},301001),/过期/);
  await assert.rejects(()=>commitSitePackage({...input,options:{...options,enableJs:true},confirmation:plan.confirmation},1001),/变化/);
  getDatabase().exec("CREATE TRIGGER fail_package BEFORE UPDATE ON cms_draft BEGIN SELECT RAISE(ABORT,'injected-write-failure'); END;");
  await assert.rejects(()=>commitSitePackage({...input,confirmation:plan.confirmation},1001),/injected/);assert.equal(getDraftRecord().revision,0);assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_media_file').get() as {n:number}).n,0);assert.deepEqual(readdirSync(join(directory,'media')),[]);getDatabase().exec('DROP TRIGGER fail_package');
  const result=await commitSitePackage({...input,confirmation:plan.confirmation},1002);assert.equal(result.revision,1);await assert.rejects(()=>commitSitePackage({...input,confirmation:plan.confirmation},1003),/变化/);
});

test('包内四张演示JPEG保持原字节，转换为实例私有ID，发布后可读取及派生，不覆盖应用静态资源',async()=>{
  getDraftRecord(); const d=getDraftRecord().content;save({pages:[d.pages[0]],editorData:{[d.pages[0].id]:data(node('Image','demo-image',{src:'/images/chair.jpg',alt:'Demo image'}))},products:[]});publishSite(selection(),actor);
  const pkg=exportSitePackage({name:'JPEG example',license:'QA only, no assertion of redistribution rights'});assert.equal(pkg.files[0].mime,'image/jpeg'); switchFresh();const input={package:pkg,options,expectedRevision:0},plan=await previewSitePackage(input);await commitSitePackage({...input,confirmation:plan.confirmation}); const media=getDraftRecord().content.media[0];assert.match(media.url,/^\/api\/media\//);assert.equal(readMediaFile(media.id).bytes.toString('base64'),pkg.files[0].content);assert.ok((await readImageVariant(media.id,320)).bytes.length);
});

test('旧JPEG与新增案例PNG通过同一分发协议保留字节及MIME，导入后全部映射私有媒体且可再次分发',async()=>{
  const snapshot={schemaVersion:protocol.snapshot,...createEmptyDraft()}, originalRoot=process.cwd();
  const legacyBytes=readFileSync(join(originalRoot,'public/images/chair.jpg'));
  const pngBytes=await sharp({create:{width:12,height:8,channels:3,background:'#334455'}}).png().toBuffer();
  snapshot.media=[{id:'legacy-static',name:'chair.jpg',url:'/images/chair.jpg',kind:'image',folder:'',size:'',alt:''},{id:'showcase-static',name:'showcase-factory.png',url:'/images/showcase-factory.png',kind:'image',folder:'',size:'',alt:'',width:12,height:8}];
  snapshot.editorData.home=data(node('Image','legacy',{src:'/images/chair.jpg',alt:'Legacy demonstration'}),node('Image','new',{src:'/images/showcase-factory.png',alt:'New demonstration'}));
  snapshot.customCode={global:{css:'body{background:url(/images/showcase-factory.png)}',js:'',cssEnabled:false,jsEnabled:false},pages:{}};
  // 静态文件在独立临时根目录合成，不要求或覆盖项目中的真实案例图片。
  const staticRoot=join(directory,'static-fixture');mkdirSync(join(staticRoot,'public/images'),{recursive:true});writeFileSync(join(staticRoot,'public/images/chair.jpg'),legacyBytes);writeFileSync(join(staticRoot,'public/images/showcase-factory.png'),pngBytes);
  let pkg:SitePackage;
  try{process.chdir(staticRoot);pkg=buildSitePackage(snapshot,{name:'Legacy and showcase images',license:'Synthetic QA only'});}finally{process.chdir(originalRoot);}
  assert.equal(pkg.version,1);assert.equal(pkg.manifest.rendererVersion,protocol.renderer);assert.equal(pkg.snapshot.schemaVersion,protocol.snapshot);
  assert.deepEqual(pkg.files.map(file=>file.mime),['image/jpeg','image/png']);assert.equal(pkg.files[0].content,legacyBytes.toString('base64'));assert.equal(pkg.files[1].content,pngBytes.toString('base64'));
  switchFresh();const input={package:pkg,options,expectedRevision:0},plan=await previewSitePackage(input);await commitSitePackage({...input,confirmation:plan.confirmation});
  const imported=getDraftRecord().content;assert.equal(imported.media.length,2);assert.ok(imported.media.every(media=>/^\/api\/media\//.test(media.url)));assert.doesNotMatch(JSON.stringify(imported.editorData)+imported.customCode!.global.css,/\/images\//);
  for(const media of imported.media){const file=pkg.files.find(file=>file.mime===readMediaFile(media.id).mime)!;assert.equal(readMediaFile(media.id).bytes.toString('base64'),file.content);assert.ok((await readImageVariant(media.id,320)).bytes.length);}
  publishSite(selection(),actor);const exported=exportSitePackage({name:'Re-export images',license:'Synthetic QA only'});assert.deepEqual(exported.files.map(file=>file.mime),['image/jpeg','image/png']);await validateSitePackage(exported);
  const invalid=structuredClone(snapshot);invalid.media[1].url='/images/unlisted.png';assert.throws(()=>buildSitePackage(invalid,{name:'Invalid static path',license:'QA'}),/素材地址/);
});


test('全部starter均走真实分发导入与整站发布，模型/列表/详情/全站头尾/表单可编辑且没有硬编码行业渲染',async()=>{
  const designs:string[]=[];
  const textValues=(value:unknown):string[]=>Array.isArray(value)?value.flatMap(textValues):value&&typeof value==='object'?Object.entries(value).flatMap(([key,item])=>['text','title','label'].includes(key)&&typeof item==='string'?[item]:textValues(item)):[];
  for(const kit of STARTER_KITS){
    switchFresh();const snapshot=createStarterSnapshot(kit.id), pkg=buildSitePackage(snapshot,{name:kit.name,description:kit.description,license:'Original synthetic demonstration layouts; replace with authorized customer content.'});
    const input={package:pkg,options,expectedRevision:0},plan=await previewSitePackage(input);await commitSitePackage({...input,confirmation:plan.confirmation});publishSite(selection(),actor);
    const active=getActiveSiteSnapshot()!;assert.equal(active.pages.length,kit.pageCount);assert.equal(active.forms?.length,1);assert.equal(active.settings.name,snapshot.settings.name);assert.deepEqual(active.theme,snapshot.theme);
    assert.equal(active.products.length,snapshot.products.length);assert.equal(active.contentEntries?.length,snapshot.contentEntries?.length);assert.deepEqual(active.contentModels?.map(model=>({name:model.name,target:model.target,fields:model.fields.map(field=>({key:field.key,label:field.label,type:field.type}))})),snapshot.contentModels?.map(model=>({name:model.name,target:model.target,fields:model.fields.map(field=>({key:field.key,label:field.label,type:field.type}))})));
    for(const path of actualSiteRoutes(active))assert.ok(resolveSitePage(active,path.path.split('/').filter(Boolean)),`${kit.id}: ${path.path}`);
    for(const slot of ['header','footer'] as const){assert.equal(active.siteLayout?.[slot].mode,'block');const imported=active.sharedBlocks!.find(block=>block.id===active.siteLayout![slot].blockId)!,source=snapshot.sharedBlocks!.find(block=>block.id===snapshot.siteLayout![slot].blockId)!;assert.ok(imported,`${kit.id}: ${slot}`);assert.deepEqual(textValues(imported.data),textValues(source.data));}
    assert.deepEqual(active.forms?.map(form=>({name:form.name,enabled:form.enabled,submitLabel:form.submitLabel,fields:form.fields.map(field=>({label:field.label,type:field.type,mapTo:field.mapTo,required:field.required}))})),snapshot.forms?.map(form=>({name:form.name,enabled:form.enabled,submitLabel:form.submitLabel,fields:form.fields.map(field=>({label:field.label,type:field.type,mapTo:field.mapTo,required:field.required}))})));
    assert.equal(active.customCode?.global.jsEnabled,false);assert.deepEqual(contentBindingErrors(active,true),[]);assert.ok(active.media.every(media=>media.url.startsWith('/api/media/')),`${kit.id}: 素材未完整映射到私有媒体`);
    for(const page of snapshot.pages){const imported=active.pages.find(item=>item.slug===page.slug)!;assert.equal((active.editorData[imported.id] as {root:{props:{brand?:string}}}).root.props.brand,(snapshot.editorData[page.id] as {root:{props:{brand?:string}}}).root.props.brand);}
    assert.match(active.settings.description,/\bfictional\b/i);designs.push(JSON.stringify({theme:active.theme,data:active.editorData}));
  }
  assert.equal(new Set(designs).size,STARTER_KITS.length);
});


test('固定产品/旧列表字段/后备图/PDF/视频和生成DOM选择器在实际导入后保持可解析，代码不执行',async()=>{
  await sourcePackage();const pdf=await PDFDocument.create();pdf.addPage([200,200]);const pdfBytes=await pdf.save();
  const upload=new FormData();upload.set('file',new File([new Uint8Array(pdfBytes)],'catalog.pdf',{type:'application/pdf'}));upload.set('expectedRevision',String(getDraftRecord().revision));const doc=(await uploadMedia(upload)).media;
  const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom00000000moovmdat00000000000000000000000000000000')]);
  const videoForm=new FormData();videoForm.set('file',new File([video],'demo.mp4',{type:'video/mp4'}));videoForm.set('expectedRevision',String(getDraftRecord().revision));const clip=(await uploadMedia(videoForm)).media;
  const d=getDraftRecord().content,h=draftHome(d.editorData['source-home']), form=d.forms![0],image=d.products[0].image;
  h.content.push(node('ProductDetail','fixed-detail',{productId:'source-product-1'}),node('ContentList','legacy-list',{source:'entry',modelId:'model-c',titleField:'builtin:title',descriptionField:'field:same-field',imageField:'',linkField:'builtin:url'}),node('Image','fallback-img',{src:'',alt:'Fallback',bindings:{src:{source:'product',mode:'fixed',recordId:'source-product-1',field:'builtin:image',fallback:image}}}),node('Download','pdf',{fileUrl:doc.url,label:'Download demo'}),node('Video','clip',{videoUrl:clip.url,poster:image,title:'Synthetic video'}));
  const css=`[data-page-id="source-home"] [data-product-field="same-field"]{color:#fff}[data-content-model="model-c"] [data-shared-block="block"]{padding:1px} .${designClassName('shared-shared--1')},.${designClassName('shared-loop-item-1--1')}{color:#000} [href="#welcome"],#inquiry_${form.fields[0].id}{padding:2px}`;
  save({editorData:{...d.editorData,'source-home':h},customCode:{global:{css,js:'const declared="/?page_loop=2&term_loop=term#welcome";document.getElementById("shared-shared--1");globalThis.__packageExecuted=true;',cssEnabled:true,jsEnabled:true},pages:{}}});publishSite(selection(),actor);
  const pkg=exportSitePackage({name:'Media and scope QA',license:'Synthetic, local QA only'});switchFresh();const input={package:pkg,options,expectedRevision:0},check=await previewSitePackage(input);await commitSitePackage({...input,confirmation:check.confirmation});
  const next=getDraftRecord().content,home=next.pages.find(p=>p.slug==='/')!,content=draftHome(next.editorData[home.id]).content,find=(type:string,idPart?:string)=>content.find(n=>n.type===type&&(!idPart||String(n.props.id).includes(idPart)))!;
  assert.equal(find('ProductDetail').props.productId,next.products[0].id);assert.equal(find('ContentList').props.descriptionField,`field:${next.contentModels!.find(m=>m.target==='content')!.fields[0].id}`);
  assert.equal(find('Download').props.fileUrl,next.media.find(m=>m.kind==='document')!.url);assert.equal(find('Video').props.videoUrl,next.media.find(m=>m.kind==='video')!.url);assert.equal((find('Image','')===content[1]),true);
  const fallback=content.find(n=>n.type==='Image'&&n.props.src==='')!.props.bindings as {src:{recordId:string;fallback:string}};assert.equal(fallback.src.recordId,next.products[0].id);assert.equal(fallback.src.fallback,next.products[0].image);
  const code=next.customCode!.global;assert.ok(code.css.includes(next.pages[0].id));assert.ok(code.css.includes(next.contentModels![1].id));assert.ok(!code.css.includes('source-home'));assert.ok(!code.css.includes('same-field'));assert.match(code.css,/:is\(/);
  const shared=content.find(n=>n.type==='SharedBlock')!,loop=content.find(n=>n.type==='ContentLoop')!;assert.ok(code.css.includes(designClassName(`shared-${shared.props.id}--1`)));assert.ok(code.css.includes(designClassName(`shared-${loop.props.id}-item-1--1`)));assert.ok(code.js.includes(`page_${loop.props.id}=2`));assert.ok(code.js.includes(`term_${loop.props.id}=${next.taxonomies![0].terms[0].id}`));assert.ok(code.js.includes(`shared-${shared.props.id}--1`));assert.equal((globalThis as {__packageExecuted?:boolean}).__packageExecuted,undefined);assert.equal(code.jsEnabled,false);publishSite(selection(),actor);
});
function draftHome(value:unknown){return structuredClone(value) as ReturnType<typeof data>;}

// 分发时全部原生产品图与生成缩略图锚点一起映射，不能留源实例私有URL。
test('原生产品相册分发重映射全部照片、封面顺序和缩略图锚点',async()=>{
 const d=getDraftRecord().content,p=d.products[0],photos=['/images/chair.jpg','/images/studio.jpg'];
 save({products:d.products.map(x=>x.id===p.id?{...x,image:photos[0],images:photos}:x),editorData:{...d.editorData,home:data(node('ProductDetail','native-gallery',{productId:p.id}))},customCode:{global:{css:'#native-gallery-photo-1{opacity:1}',js:'',cssEnabled:true,jsEnabled:false},pages:{}}});
 publishSite(selection(),actor);const pkg=await exportSitePackage({name:'Native gallery',description:'Synthetic',license:'Synthetic QA only'});
 switchFresh();const request={package:pkg,options,expectedRevision:0},plan=await previewSitePackage(request);await commitSitePackage({...request,confirmation:plan.confirmation});
 const next=getDraftRecord().content,product=next.products.find(x=>x.sku===p.sku)!;assert.equal(product.images!.length,2);assert.equal(product.image,product.images![0]);assert.ok(product.images!.every(url=>url.startsWith('/api/media/')));assert.notEqual(product.images![0],product.images![1]);
 const component=(next.editorData[next.pages.find(x=>x.slug==='/')!.id] as ReturnType<typeof data>).content[0];assert.ok(next.customCode!.global.css.includes(`#${component.props.id}-photo-1`));publishSite(selection(),actor);
});
