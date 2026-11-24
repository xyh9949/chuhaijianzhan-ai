import { beforeEach,afterEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join,resolve,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { getDatabase } from '../src/server/database';
import { getDraftRecord,patchStudio,getStudioEnvelope } from '../src/server/studio';
import { previewPublication,publishSite,previewRestoreDraft,restoreDraft,getActiveSiteSnapshot,resolvePublicationPreview } from '../src/server/publication';
import { createFormDefinition } from '../src/lib/form-content';
import { listAudit } from '../src/server/audit';
import type { Actor } from '../src/server/permissions';
import { ApiError } from '../src/server/http';
import { getProductPath } from '../src/lib/content-routes';
import { discoveryRobots, type PublicFact } from '../src/lib/discovery';
let directory='',previous:string|undefined;
const actor={id:'diagnostics-admin',name:'发布诊断验收'};
beforeEach(()=>{previous=process.env.FORM_STUDIO_DATA_DIR;directory=mkdtempSync(join(tmpdir(),'studio-diagnostics-'));process.env.FORM_STUDIO_DATA_DIR=directory;});
afterEach(()=>{getDatabase().close();if(previous===undefined)delete process.env.FORM_STUDIO_DATA_DIR;else process.env.FORM_STUDIO_DATA_DIR=previous;if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-diagnostics-`))rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const save=(patch:object)=>patchStudio({expectedRevision:getDraftRecord().revision,patch});
const node=(type:string,id:string,props:object={})=>({type,props:{id,...props}});
const data=(...content:ReturnType<typeof node>[])=>({root:{props:{showChrome:'no'}},content});
const selection=(extra:object={})=>({expectedRevision:getDraftRecord().revision,baseReleaseId:getStudioEnvelope().activeReleaseId,pageIds:getDraftRecord().content.pages.map(p=>p.id),productIds:getDraftRecord().content.products.map(p=>p.id),includeTheme:true,includeSettings:true,...extra});
const publishBase=()=>{getDraftRecord();return publishSite(selection(),actor);};

test('公开候选与未选草稿差异分开、直接影响只包含真实修改页；预检不写入且携带精确版本',()=>{
 const base=publishBase(),d=getDraftRecord().content;save({editorData:{...d.editorData,home:data(node('Text','home-change',{text:'Selected home'})),about:data(node('Text','about-change',{text:'Unselected about'}))}});
 const expected=getDraftRecord().revision,check=previewPublication(selection({pageIds:['home'],productIds:[],includeTheme:false,includeSettings:false}));assert.deepEqual(check.errors,[]);assert.equal(check.expectedRevision,expected);assert.equal(check.baseReleaseId,base.releaseId);assert.equal(getDraftRecord().revision,expected);
 assert.deepEqual(check.diagnostics.changes,[{scope:'page',id:'home',label:d.pages.find(p=>p.id==='home')!.title,change:'update'}]);assert.equal(check.diagnostics.pendingDraftCount,1);assert.equal(check.diagnostics.impact.mode,'exact');assert.deepEqual(check.diagnostics.impact.pages.map(p=>p.id),['home']);
 const stale=selection({pageIds:['home'],productIds:[],includeTheme:false,includeSettings:false});save({settings:{...d.settings,description:'New pending settings'}});assert.throws(()=>publishSite(stale,actor),/草稿已变化/);assert.equal(getActiveSiteSnapshot()!.releaseId,base.releaseId);
});

const previewOwner: Actor = { ...actor, email: 'publisher@example.invalid', role: 'admin' };
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;

test('发布差异比较真实公开抓取设置，待核对事实不计入公开变化', () => {
  const draft = getDraftRecord().content;
  save({ settings: { ...draft.settings, publicUrl: 'https://catalog.example.invalid', discovery: { llms: false } } });
  const baseline = publishBase();
  const pending: PublicFact = { id: 'private-fact', title: 'Undocumented capacity', value: 'Private text', scope: '', sourceUrl: '', reviewedAt: '', validUntil: '', status: 'pending' };
  const publishedSettings = getDraftRecord().content.settings;
  const selected = () => selection({ pageIds: [], productIds: [], includeTheme: false, includeSettings: true });
  save({ settings: { ...publishedSettings, discovery: { llms: false, facts: [pending] } } });
  const privateOnly = previewPublication(selected(), previewOwner);
  assert.deepEqual(privateOnly.diagnostics.changes, []);
  assert.equal(privateOnly.diagnostics.pendingDraftCount, 0);
  const reviewed: PublicFact = { ...pending, id: 'confirmed-fact', value: 'Confirmed public text', status: 'reviewed', reviewedAt: '2026-11-19' };
  save({ settings: { ...publishedSettings, discovery: { llms: true, search: { openai: false }, facts: [reviewed, pending] } } });
  const unselected = previewPublication({ ...selected(), includeSettings: false, pageIds: ['home'] }, previewOwner);
  assert.deepEqual(unselected.errors, []);
  assert.equal(unselected.diagnostics.pendingDraftCount, 1);
  assert.equal(unselected.diagnostics.changes.length, 0);
  const included = previewPublication(selected(), previewOwner);
  assert.deepEqual(included.errors, []);
  assert.equal(included.diagnostics.pendingDraftCount, 0);
  assert.deepEqual(included.diagnostics.changes.map(change => change.scope), ['settings']);
  const preview = resolvePublicationPreview(included.preview!.href.split('/').at(-1)!, [], previewOwner);
  assert.ok(preview && !('redirectTo' in preview));
  assert.deepEqual(preview.snapshot.settings.discovery, { llms: true, search: { openai: false }, facts: [reviewed] });
  assert.equal(getActiveSiteSnapshot()?.releaseId, baseline.releaseId);
  publishSite(selected(), actor);
  const active = getActiveSiteSnapshot()!;
  assert.deepEqual(active.settings.discovery, preview.snapshot.settings.discovery);
  assert.match(JSON.stringify(discoveryRobots(active)), /"userAgent":"OAI-SearchBot","disallow":\["\/"\]/);
});

test('私有发布预览使用实际选中的页面、产品、表单与旧网址，保留未选内容的公开版本', () => {
  const baseline = publishBase(), draft = getDraftRecord().content;
  const form = createFormDefinition('review-form');
  const hidden = { ...draft.pages[0], id: 'unselected-draft', slug: '/unselected-draft', title: 'Not part of publication' };
  const products = draft.products.map((record, index) => ({ ...record, name: `Updated product ${index + 1}` }));
  save({ pages: [...draft.pages, hidden], products, forms: [form], redirects: [{ id: 'review-old-path', from: '/old-review', target: { kind: 'page', id: 'home' }, status: 301 }], editorData: { ...draft.editorData,
    home: data(node('Text', 'scope-new-home', { text: 'Selected home copy' }), node('Form', 'scope-form', { formId: form.id })),
    about: data(node('Text', 'scope-draft-about', { text: 'Unselected draft copy' })), [hidden.id]: data(),
  } });
  const before = getStudioEnvelope(), countAudit = listAudit(new URLSearchParams()).items.length;
  const scope = selection({ pageIds: ['home'], productIds: [products[0].id], includeTheme: false, includeSettings: false, includeForms: true });
  const missing = previewPublication({ ...scope, includeForms: false }, previewOwner);
  assert.ok(missing.errors.some(error => error.includes('表单')));
  assert.equal(missing.preview, undefined);
  const first = previewPublication(scope, previewOwner);
  assert.deepEqual(first.errors, []);
  const firstId = first.preview!.href.split('/').at(-1)!;
  assert.equal(resolvePublicationPreview(firstId, ['old-review'], previewOwner), null);
  const withRedirect = previewPublication({ ...scope, includeRedirects: true }, previewOwner);
  assert.deepEqual(withRedirect.errors, []);
  const url = withRedirect.preview!.href, id = url.split('/').at(-1)!;
  assert.notEqual(id, firstId);
  assert.ok(resolvePublicationPreview(firstId, [], previewOwner));
  assert.equal(resolvePublicationPreview(firstId, ['old-review'], previewOwner), null);
  assert.deepEqual(resolvePublicationPreview(id, ['old-review'], previewOwner, { source: 'preview', part: ['a', 'b'] }), { redirectTo: `${url}?source=preview&part=a&part=b` });
  const home = resolvePublicationPreview(id, [], previewOwner);
  assert.ok(home && !('redirectTo' in home));
  assert.equal(home.previewPrefix, url);
  assert.match(JSON.stringify(home.resolved.data), /Selected home copy/);
  assert.deepEqual(home.snapshot.forms, [form]);
  assert.equal(home.snapshot.products[0].name, 'Updated product 1');
  assert.equal(home.snapshot.products[1].name, draft.products[1].name);
  const productPath = getProductPath(home.snapshot, home.snapshot.products[0])!.slice(1).split('/');
  const product = resolvePublicationPreview(id, productPath, previewOwner);
  assert.ok(product && !('redirectTo' in product));
  assert.equal(product.resolved.product?.name, 'Updated product 1');
  const about = resolvePublicationPreview(id, ['about'], previewOwner);
  assert.ok(about && !('redirectTo' in about));
  assert.deepEqual(about.resolved.data, getActiveSiteSnapshot()!.editorData.about);
  assert.equal(resolvePublicationPreview(id, ['unselected-draft'], previewOwner), null);
  assert.equal(getActiveSiteSnapshot()!.releaseId, baseline.releaseId);
  assert.deepEqual(getStudioEnvelope(), before);
  assert.equal(listAudit(new URLSearchParams()).items.length, countAudit);
});

test('发布范围预览隔离操作者和角色，并随草稿、公开版本或有效期变化失效', context => {
  publishBase();
  const onlyHome = () => selection({ pageIds: ['home'], productIds: [], includeTheme: false, includeSettings: false });
  const make = () => previewPublication(onlyHome(), previewOwner).preview!;
  const rowId = (href: string) => href.split('/').at(-1)!;
  const first = rowId(make().href);
  assert.throws(() => resolvePublicationPreview(first, [], { ...previewOwner, id: 'other-admin' }), status(404));
  assert.throws(() => resolvePublicationPreview(first, [], { ...previewOwner, role: 'editor' }), status(403));
  const draft = getDraftRecord().content;
  save({ settings: { ...draft.settings, description: 'Draft changed while reviewing' } });
  assert.throws(() => resolvePublicationPreview(first, [], previewOwner), status(409));
  const second = rowId(make().href);
  publishSite(onlyHome(), actor);
  assert.throws(() => resolvePublicationPreview(second, [], previewOwner), status(409));
  const current = make();
  context.mock.method(Date, 'now', () => Date.parse(current.expiresAt));
  assert.throws(() => resolvePublicationPreview(rowId(current.href), [], previewOwner), status(410));
});

test('缺失绑定/卡片/表单/菜单/样式/分类按明确依赖建议，显式选择后才可发布；列表缺失与0条不混同',()=>{
 publishBase();const d=getDraftRecord().content,model={id:'case-model',name:'案例模型',target:'content',description:'',updated:'',fields:[{id:'summary',key:'summary',label:'Summary',type:'text',required:false}]},form=createFormDefinition('contact-form'),detail={...d.pages[0],id:'case-template',slug:'/cases/:slug',title:'案例详情',contentModelId:model.id};
 const card=data(node('Heading','case-heading',{text:'Fallback',bindings:{text:{source:'entry',mode:'current',modelId:model.id,field:'field:summary'}}}),node('ActionButton','case-link',{text:'Read more',href:'',bindings:{href:{source:'entry',mode:'current',modelId:model.id,field:'builtin:url'}}}));
 save({pages:[...d.pages,detail],editorData:{...d.editorData,home:data(node('Navigation','nav',{menuId:'case-menu'}),node('Heading','title',{text:'Cases',stylePresetId:'case-preset'}),node('Form','form',{formId:form.id}),node('ContentLoop','case-list',{source:'entry',modelId:model.id,itemBlockId:'case-card',count:6,query:{termIds:['case-term'],sort:'field:summary'}})),[detail.id]:data(node('Heading','detail-title',{text:'Fallback',bindings:{text:{source:'entry',mode:'current',modelId:model.id,field:'builtin:title'}}}))},sharedBlocks:[{id:'case-card',name:'案例卡片',updated:'',data:card}],contentModels:[model],contentEntries:[{id:'case-one',modelId:model.id,title:'Demonstration case',status:'draft',updated:'',customFields:{summary:'Synthetic case'},termIds:['case-term']}],forms:[form],theme:{...d.theme,presets:[{id:'case-preset',name:'Case title',design:{desktop:{fontSize:36}}}]},siteLayout:{header:{mode:'default',blockId:'',menuId:'case-menu'},footer:{mode:'default',blockId:''},menus:[{id:'case-menu',name:'案例菜单',items:[{id:'case-item',label:'Example case',target:{kind:'entry',id:'case-one'}}]}]},taxonomies:[{id:'case-tax',name:'Case category',source:'entry',modelId:model.id,terms:[{id:'case-term',label:'Demo',slug:'demo'}]}]});
 const rev=getDraftRecord().revision,partial=selection({pageIds:['home'],productIds:[],includeTheme:false,includeSettings:false}),check=previewPublication(partial);assert.ok(check.errors.length);assert.equal(getDraftRecord().revision,rev);const kinds=new Set(check.diagnostics.dependencies.map(d=>d.kind));for(const kind of ['page','entry','model','block','layout','forms','theme','catalog'])assert.ok(kinds.has(kind as never),kind);
 const full=previewPublication({...partial,pageIds:['home',detail.id],contentEntryIds:['case-one'],contentModelIds:[model.id],sharedBlockIds:['case-card'],includeTheme:true,includeForms:true,includeLayout:true,includeCatalog:true});assert.deepEqual(full.errors,[]);assert.equal(full.diagnostics.impact.mode,'conservative');const list=full.diagnostics.lists.find(l=>l.nodeId==='case-list')!;assert.equal(list.beforeState,'absent');assert.equal(list.after,1);assert.equal(full.diagnostics.dependencies.length,0);
 publishSite({...partial,pageIds:['home',detail.id],contentEntryIds:['case-one'],contentModelIds:[model.id],sharedBlockIds:['case-card'],includeTheme:true,includeForms:true,includeLayout:true,includeCatalog:true},actor);
});

test('草稿恢复先预检缺失表单/区块，失败不改数据/审计，确认再次验证并保留公开指针',()=>{
 const base=publishBase(),d=getDraftRecord().content,form=createFormDefinition('restore-form'),block={id:'restore-block',name:'Restore shared',updated:'',data:data(node('Text','shared-text',{text:'Synthetic'}))};
 save({forms:[form],sharedBlocks:[block],editorData:{...d.editorData,home:data(node('Form','restore-node',{formId:form.id}),node('SharedBlock','shared-node',{blockId:block.id}))}});const history=publishSite(selection({sharedBlockIds:[block.id],includeForms:true}),actor);
 restoreDraft(base.releaseId,{expectedRevision:getDraftRecord().revision,pageIds:['home']},actor);save({forms:[],sharedBlocks:[]});const revision=getDraftRecord().revision,auditCount=listAudit(new URLSearchParams()).items.length;
 const failed=previewRestoreDraft(history.releaseId,{expectedRevision:revision,pageIds:['home']});assert.ok(failed.errors.length);assert.equal(getDraftRecord().revision,revision);assert.equal(listAudit(new URLSearchParams()).items.length,auditCount);
 const input={expectedRevision:revision,pageIds:['home'],sharedBlockIds:[block.id],includeForms:true};const check=previewRestoreDraft(history.releaseId,input);assert.deepEqual(check.errors,[]);assert.equal(check.expectedRevision,revision);assert.equal(check.summary!.totalPages,d.pages.length);restoreDraft(history.releaseId,input,actor);assert.equal(getDraftRecord().revision,revision+1);assert.equal(getActiveSiteSnapshot()!.releaseId,history.releaseId);assert.throws(()=>restoreDraft(history.releaseId,input,actor),/草稿已变化/);
});

test('主题与公开资料可独立恢复，历史未设规范域名时明确清除草稿值', () => {
  const before = getDraftRecord().content;
  const baseline = publishBase();
  const changedTheme = { ...before.theme, radius: 20, primary: '#174FFF' };
  save({ settings: { ...before.settings, publicUrl: 'https://catalog.example.invalid' }, theme: changedTheme });
  const publicNow = publishSite(selection({ pageIds: [], productIds: [] }), actor);
  const themeOnly = { expectedRevision: getDraftRecord().revision, pageIds: [], includeTheme: true };
  const unchangedPages = structuredClone(getDraftRecord().content.editorData);
  assert.deepEqual(previewRestoreDraft(baseline.releaseId, themeOnly).summary?.fields, ['includeTheme']);
  restoreDraft(baseline.releaseId, themeOnly, actor);
  assert.deepEqual(getDraftRecord().content.theme, before.theme);
  assert.deepEqual(getDraftRecord().content.editorData, unchangedPages);
  assert.equal(getDraftRecord().content.settings.publicUrl, 'https://catalog.example.invalid');
  const settingsOnly = { expectedRevision: getDraftRecord().revision, pageIds: [], includeSettings: true };
  const preflight = previewRestoreDraft(baseline.releaseId, settingsOnly);
  assert.deepEqual(preflight.errors, []);
  assert.ok(preflight.warnings.some(item => item.includes('清除当前草稿的规范地址')));
  assert.equal(getDraftRecord().content.settings.publicUrl, 'https://catalog.example.invalid');
  restoreDraft(baseline.releaseId, settingsOnly, actor);
  assert.equal(Object.hasOwn(getDraftRecord().content.settings, 'publicUrl'), false);
  assert.equal(getActiveSiteSnapshot()?.releaseId, publicNow.releaseId);
  assert.equal(getActiveSiteSnapshot()?.settings.publicUrl, 'https://catalog.example.invalid');
});

test('模型新增必填规则按全部候选旧记录校验，不能只选结构绕过未选记录的值',()=>{
 const d=getDraftRecord().content,model={id:'required-model',name:'Required model',target:'product',description:'',updated:'',fields:[{id:'required-field',key:'spec',label:'Spec',type:'text',required:false}]};
 save({contentModels:[model],products:d.products.map(p=>({...p,modelId:model.id,customFields:{}}))});publishSite(selection({contentModelIds:[model.id]}),actor);
 save({contentModels:[{...model,fields:[{...model.fields[0],required:true}]}],products:getDraftRecord().content.products.map(p=>({...p,customFields:{'required-field':'Filled in draft'}}))});
 const check=previewPublication(selection({pageIds:[],productIds:[],contentModelIds:[model.id],includeTheme:false,includeSettings:false}));assert.ok(check.errors.some(e=>e.includes('必填')));const active=getStudioEnvelope().activeReleaseId;assert.throws(()=>publishSite(selection({pageIds:[],productIds:[],contentModelIds:[model.id],includeTheme:false,includeSettings:false}),actor),/必填/);assert.equal(getStudioEnvelope().activeReleaseId,active);
});
