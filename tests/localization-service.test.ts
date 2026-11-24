import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {getDatabase} from '../src/server/database';
import {getDraftRecord,getStudioEnvelope,patchStudio,readRelease} from '../src/server/studio';
import {publishSite,previewPublication,activateRelease,restoreDraft,previewRestoreDraft} from '../src/server/publication';
import {copyTranslation,previewDefaultLocaleMigration,commitDefaultLocaleMigration} from '../src/server/localization';
import {resolveSitePage} from '../src/lib/site-routing';
import {translationLinks} from '../src/lib/translation-links';
const actor={id:'locale-admin',name:'Locale QA'};let directory='',previous:string|undefined;
beforeEach(()=>{previous=process.env.FORM_STUDIO_DATA_DIR;directory=mkdtempSync(join(tmpdir(),'form-studio-locales-'));process.env.FORM_STUDIO_DATA_DIR=directory;});
afterEach(()=>{getDatabase().close();if(previous===undefined)delete process.env.FORM_STUDIO_DATA_DIR;else process.env.FORM_STUDIO_DATA_DIR=previous;if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-locales-`))rmSync(directory,{recursive:true,force:true});});
const save=(patch:object)=>patchStudio({expectedRevision:getDraftRecord().revision,patch:JSON.parse(JSON.stringify(patch))},actor);
function configure(){save({settings:{...getDraftRecord().content.settings,locales:[{code:'en',label:'English'},{code:'de',label:'Deutsch'}]}});}
const copy=(kind:string,sourceId:string,locale='de',extra:object={})=>copyTranslation({expectedRevision:getDraftRecord().revision,kind,sourceId,locale,...extra},actor);
const select=(extra:object={})=>({expectedRevision:getDraftRecord().revision,baseReleaseId:getStudioEnvelope().activeReleaseId,pageIds:['home'],includeTheme:true,includeSettings:true,...extra});
test('复制页独立节点/同组身份/待核对草稿，源设计不变；独立发布不会泄露缺译',()=>{
 configure();const before=structuredClone(getDraftRecord().content.editorData.home),created=copy('page','home'),de=created.state.pages.find(p=>p.id===created.translationId)!;assert.equal(de.slug,'/de');assert.equal(de.locale,'de');assert.equal(de.translationState,'needs-review');assert.equal(de.translationGroupId,created.state.pages.find(p=>p.id==='home')?.translationGroupId);assert.deepEqual(created.state.editorData.home,before);assert.notDeepEqual(created.state.editorData[de.id],before);
 const revision=getDraftRecord().revision;assert.throws(()=>copy('page','home'),/已有/);assert.equal(getDraftRecord().revision,revision);assert.throws(()=>copy('product','p1','fr'),/已配置/);
 const en=publishSite(select(),actor),snapshot=readRelease(en.releaseId);assert.equal(resolveSitePage(snapshot,['de']),null);assert.equal(translationLinks(snapshot,'page',snapshot.pages[0]).find(l=>l.locale==='de')?.href,undefined);assert.ok(previewPublication(select({pageIds:[de.id],includeTheme:false,includeSettings:false})).errors.some(e=>e.includes('待核对')),'待核对译文必须阻止发布');
 assert.throws(()=>save({pages:getDraftRecord().content.pages.map(p=>p.id===de.id?{...p,translationState:undefined}:p)}),/不能清空/);
 const draft=getDraftRecord().content;save({pages:draft.pages.map(p=>p.id===de.id?{...p,title:'Startseite',translationState:'reviewed'}:p),editorData:{...draft.editorData,[de.id]:{root:{props:{showChrome:'no'}},content:[{type:'Heading',props:{id:'german-title',text:'Willkommen in unserem Unternehmen'}}]}}});
 const both=publishSite(select({pageIds:[de.id],includeTheme:false,includeSettings:false}),actor),live=readRelease(both.releaseId);assert.equal(resolveSitePage(live,['de'])?.page.title,'Startseite');assert.equal(translationLinks(live,'page',live.pages.find(p=>p.id==='home')!).find(l=>l.locale==='de')?.href,'/de');activateRelease(en.releaseId,{expectedActiveReleaseId:both.releaseId},actor);assert.equal(resolveSitePage(readRelease(en.releaseId),['de']),null);
});
test('复制关系只映射同组目标译文，缺译清空警告；目标型号冲突不修改来源身份',()=>{
 configure();const d=getDraftRecord().content;
 save({contentModels:[{id:'goods',name:'Goods',target:'product',description:'',updated:'',fields:[{id:'work',key:'work',label:'Work',type:'relation',required:false,relation:{source:'entry',modelId:'cases',multiple:true,onDelete:'restrict'}}]},{id:'cases',name:'Cases',target:'content',description:'',updated:'',fields:[]}],contentEntries:[{id:'case-one-en',modelId:'cases',title:'Case one',locale:'en',translationGroupId:'one',customFields:{},status:'draft',updated:''},{id:'case-one-de',modelId:'cases',title:'Fall eins',locale:'de',translationGroupId:'one',customFields:{},status:'draft',updated:''},{id:'case-two-en',modelId:'cases',title:'Case two',locale:'en',customFields:{},status:'draft',updated:''}],products:d.products.map(p=>p.id==='p1'?{...p,modelId:'goods',customFields:{work:['case-two-en','case-one-en']}}:p)});
 const revision=getDraftRecord().revision;assert.throws(()=>copy('product','p1','de',{sku:d.products[1].sku}),/重复|型号/);assert.equal(getDraftRecord().revision,revision);assert.equal(getDraftRecord().content.products[0].translationGroupId,undefined);
 const created=copy('product','p1'),product=created.state.products.find(p=>p.id===created.translationId)!;assert.deepEqual(product.customFields?.work,['case-one-de']);assert.ok(created.warnings.some(w=>w.includes('缺译')),'缺译清空需有明确提示');assert.equal(product.translationState,'needs-review');assert.deepEqual(created.state.products[0].customFields?.work,['case-two-en','case-one-en']);
});
test('默认语言迁移先预检固定版本/旧址占用，保留原文语言，设置单独发布拒绝并支持完整回退',()=>{
 configure();const created=copy('page','home'),deId=created.translationId;save({pages:created.state.pages.map(p=>p.id===deId?{...p,translationState:'reviewed'}:p)});
 const first=publishSite(select({pageIds:getDraftRecord().content.pages.map(p=>p.id),productIds:getDraftRecord().content.products.map(p=>p.id)}),actor),revision=getDraftRecord().revision;
 assert.throws(()=>save({settings:{...getDraftRecord().content.settings,language:'de'}}),/迁移方案/);assert.equal(getDraftRecord().revision,revision);
 const input={expectedRevision:revision,baseReleaseId:first.releaseId,language:'de',includeRedirects:true},plan=previewDefaultLocaleMigration(input);assert.deepEqual(plan.errors,[]);assert.ok(plan.unavailableRedirects.some(r=>r.from==='/'),'旧默认首页被新语言占用需明确说明');assert.throws(()=>commitDefaultLocaleMigration({...input,expectedChangeHash:plan.changeHash},actor),/明确确认/);
 const applied=commitDefaultLocaleMigration({...input,expectedChangeHash:plan.changeHash,acknowledgeUnavailableRedirects:true},actor);assert.equal(applied.state.settings.language,'de');assert.equal(applied.state.pages.find(p=>p.id==='home')?.slug,'/en');assert.equal(applied.state.pages.find(p=>p.id===deId)?.slug,'/');assert.equal(applied.state.products[1].locale,'en');assert.ok(previewPublication(select({pageIds:[],includeTheme:false})).errors.length,'只发布设置不能重解释未选原文');
 const second=publishSite(select({pageIds:applied.state.pages.map(p=>p.id),productIds:applied.state.products.map(p=>p.id),includeRedirects:true,includeTheme:false}),actor);assert.equal(resolveSitePage(readRelease(second.releaseId),['en','products','p2'])?.product?.id,'p2');activateRelease(first.releaseId,{expectedActiveReleaseId:second.releaseId},actor);assert.equal(resolveSitePage(readRelease(first.releaseId),['products','p2'])?.product?.id,'p2');
 assert.throws(()=>commitDefaultLocaleMigration({...input,expectedChangeHash:plan.changeHash,acknowledgeUnavailableRedirects:true},actor),/已变化/);
});

test('历史内容恢复到新默认语言保留原文与已知链接，恢复语言设置需显式选择',()=>{
 configure();let d=getDraftRecord().content;save({editorData:{...d.editorData,about:{root:{props:{showChrome:'no'}},content:[{type:'ActionButton',props:{id:'old-home-link',text:'Home',href:'/'}}]}}});
 const copied=copy('page','home'),deId=copied.translationId;save({pages:copied.state.pages.map(p=>p.id===deId?{...p,translationState:'reviewed'}:p)});
 const first=publishSite(select({pageIds:getDraftRecord().content.pages.map(p=>p.id),productIds:['p2']}),actor);
 const input={expectedRevision:getDraftRecord().revision,baseReleaseId:first.releaseId,language:'de',includeRedirects:false},plan=previewDefaultLocaleMigration(input);
 commitDefaultLocaleMigration({...input,expectedChangeHash:plan.changeHash,acknowledgeUnavailableRedirects:true},actor);
 const scope={expectedRevision:getDraftRecord().revision,pageIds:['about'],productIds:['p2']};
 assert.deepEqual(previewRestoreDraft(first.releaseId,scope).errors,[]);const restored=restoreDraft(first.releaseId,scope,actor);
 assert.equal(restored.state.settings.language,'de');assert.equal(restored.state.pages.find(p=>p.id==='about')?.slug,'/en/about');assert.equal(restored.state.products.find(p=>p.id==='p2')?.locale,'en');
 assert.match(JSON.stringify(restored.state.editorData.about),/"href":"\/en"/);
 const all=restoreDraft(first.releaseId,{expectedRevision:restored.revision,pageIds:copied.state.pages.map(p=>p.id),productIds:['p2'],includeSettings:true},actor);
 assert.equal(all.state.settings.language,'en');assert.equal(all.state.pages.find(p=>p.id==='home')?.slug,'/');assert.equal(all.activeReleaseId,first.releaseId);
});

test('禁止把内容模板保存到已启用语言的产品目录，历史版本仍可切换且正常路径继续可访问', () => {
  configure();
  const draft = getDraftRecord().content;
  const germanProduct = { ...draft.products[0], id: 'de-route-product', sku: 'DE-ROUTE', name: 'Stuhl', slug: 'stuhl', locale: 'de' };
  save({ products: [...draft.products, germanProduct] });
  const model = { id: 'route-cases', name: 'Cases', target: 'content' as const, description: '', fields: [], updated: '' };
  const template = { id: 'route-case-detail', title: 'Case details', slug: '/de/products/:slug', type: '内容详情模板', contentModelId: model.id, status: 'published' as const, updated: '' };
  const article = { id: 'route-case', title: 'Stuhl installation', modelId: model.id, slug: 'stuhl', customFields: {}, status: 'published' as const, updated: '' };
  const pageData = { root: { props: { showChrome: 'no' } }, content: [{ type: 'Heading', props: { id: 'case-title', text: 'A published case' } }] };
  const revision = getDraftRecord().revision;
  assert.throws(() => save({ pages: [...draft.pages, template], editorData: { ...draft.editorData, [template.id]: pageData }, contentModels: [model], contentEntries: [article] }), /详情路径 \/de\/products\/:slug 占用了该语言的系统或产品路径.*\/cases\/:slug/);
  assert.equal(getDraftRecord().revision, revision);

  const valid = publishSite(select({ pageIds: ['home', 'product-detail'], productIds: [germanProduct.id] }), actor);
  // 用旧规则可能允许的快照作为历史夹具；不改现有版本数据或路由优先级。
  const old = readRelease(valid.releaseId);
  const legacyId = 'legacy-locale-directory';
  old.releaseId = legacyId; old.pages.push(template); old.editorData[template.id] = pageData;
  old.contentModels = [model]; old.contentEntries = [article, { ...article, id: 'without-product', slug: 'missing' }];
  const json = JSON.stringify(old);
  getDatabase().prepare('INSERT INTO cms_release(id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(legacyId, '历史多语言路由夹具', json, createHash('sha256').update(json).digest('hex'), old.schemaVersion, old.schemaVersion, actor.id, actor.name, new Date().toISOString(), JSON.stringify({ pageIds: [template.id] }));
  assert.equal(activateRelease(legacyId, { expectedActiveReleaseId: valid.releaseId }, actor).activeReleaseId, legacyId);
  assert.equal(resolveSitePage(readRelease(legacyId), [])?.page.id, 'home');
  assert.equal(resolveSitePage(readRelease(legacyId), ['de', 'products', 'stuhl'])?.product?.id, germanProduct.id);
  assert.equal(resolveSitePage(readRelease(legacyId), ['de', 'products', 'missing']), null);
  const checked = previewPublication(select({ pageIds: [], includeSettings: false }));
  assert.match(checked.errors.join('；'), /详情地址 \/de\/products\/stuhl 与产品“Stuhl”冲突/);
  assert.equal(activateRelease(valid.releaseId, { expectedActiveReleaseId: legacyId }, actor).activeReleaseId, valid.releaseId);
  save({ pages: [...draft.pages, { ...template, status: 'draft', slug: '/company/team/:slug' }], editorData: { ...draft.editorData, [template.id]: pageData }, contentModels: [model], contentEntries: [{ ...article, locale: 'de', status: 'draft' }] });
  const nested = publishSite(select({ pageIds: [template.id], contentModelIds: [model.id], contentEntryIds: [article.id], includeTheme: false, includeSettings: false }), actor);
  assert.equal(resolveSitePage(readRelease(nested.releaseId), ['de', 'company', 'team', 'stuhl'])?.entry?.id, article.id);
  assert.equal(nested.state.releases.find(release => release.id === nested.releaseId)?.snapshot?.releaseId, nested.releaseId);
  assert.ok(nested.state.releases.filter(release => release.status === 'history').every(release => !Object.hasOwn(release, 'snapshot')));
  assert.equal(readRelease(legacyId).releaseId, legacyId);
});
