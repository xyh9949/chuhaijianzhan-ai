import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { cloneTemplateData } from '../src/lib/page-templates';
import { createFormDefinition } from '../src/lib/form-content';
import { designClassName } from '../src/lib/responsive-style';
import { resolveSitePage } from '../src/lib/site-routing';
import { remapCss, remapJs, remapSnippet } from '../src/server/portable-code';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, patchStudio, getStudioEnvelope, readRelease } from '../src/server/studio';
import { publishSite, previewPublication, restoreDraft, getDraftSiteSnapshot,activateRelease } from '../src/server/publication';
import { uploadMedia, deleteMedia, isPublishedMedia } from '../src/server/media';
import { savePageAsTemplate, applyPageTemplate } from '../src/server/page-templates';
import { readTemplatePreview } from '../src/server/template-preview';
import legacyV13 from './fixtures/snapshot-v13.json';
import legacyV12 from './fixtures/snapshot-v12.json';
import type {SiteSnapshot} from '../src/server/types';

let directory = '', previous: string | undefined;
const actor = { id: 'template-admin', name: '模板验收' }, emptyCode = { css: '', js: '', cssEnabled: false, jsEnabled: false };
beforeEach(() => { previous = process.env.FORM_STUDIO_DATA_DIR; directory = mkdtempSync(join(tmpdir(), 'form-studio-templates-')); process.env.FORM_STUDIO_DATA_DIR = directory; });
afterEach(() => { getDatabase().close(); if (previous === undefined) delete process.env.FORM_STUDIO_DATA_DIR; else process.env.FORM_STUDIO_DATA_DIR = previous; if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-templates-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const save = (patch: object) => patchStudio({ expectedRevision: getDraftRecord().revision, patch });
const selection = (extra: object = {}) => ({ expectedRevision: getDraftRecord().revision, baseReleaseId: getStudioEnvelope().activeReleaseId, pageIds: ['home'], productIds: [], includeTheme: true, includeSettings: true, ...extra });
const textData = () => ({ root: { props: { showChrome: 'no' } }, content: [{ type: 'Text', props: { id: 'template-copy', text: 'Independent template' } }] });

test('复制节点/局部集合与自链接，业务表单引用保持，源对象不被修改', () => {
  const data = { root: { props: {} }, content: [{ type: 'ActionButton', props: { id: 'link', text: 'Copy page', href: '/source?mode=x#section', linkTarget: { kind: 'page', id: 'source' } } }, { type: 'Gallery', props: { id: 'gallery', images: [{ id: 'item', src: '/images/studio.jpg', alt: 'Studio' }] } }, { type: 'Form', props: { id: 'form-node', formId: 'business-form' } }] };
  const before = JSON.stringify(data), copy = cloneTemplateData(data, { fromPageId: 'source', toPageId: 'copy', fromPath: '/source', toPath: '/copy' });
  assert.equal(JSON.stringify(data), before); assert.notEqual(copy.data.content[0].props.id, 'link');
  assert.equal(copy.data.content[0].props.linkTarget.id, 'copy'); assert.equal(copy.data.content[0].props.href, '/copy?mode=x#section'); assert.equal(copy.data.content[2].props.formId, 'business-form'); assert.notEqual(copy.data.content[1].props.images[0].id, 'item');
});

test('CSS按AST映射选择器/文件，不能误改相似ID、颜色或文案；JS仅改明确DOM常量且不执行', () => {
  const maps = { nodes: new Map([['a', 'node-copy'], ['fff', 'node-white']]), paths: new Map([['/old', '/copy'], ['/api/media/old-image', '/api/media/new-image']]) };
  const css = remapCss(`#a, #abc, #fff, [id="a"], .${designClassName('a')}, .fs-a {color:#fff;content:"a";background:url(/api/media/old-image)}`, maps);
  assert.ok(css.includes('#node-copy')); assert.ok(css.includes('#abc')); assert.ok(css.includes('#node-white')); assert.ok(css.includes('color:#fff')); assert.ok(css.includes('content:"a"')); assert.ok(css.includes('/api/media/new-image')); assert.ok(css.includes(`.${designClassName('node-copy')}`)); assert.ok(css.includes('.fs-a'));
  assert.ok(remapCss('@scope (#a) to (:not(#fff)) { #a { color:#fff } }', maps).includes('@scope (#node-copy) to (:not(#node-white))'));
  const source = `"use strict";const text='a';const color='#fff';document.getElementById('a');document.querySelector('#a > .${designClassName('a')}');fetch('/old?mode=x#a');document.querySelector(variable);globalThis.__portableCodeExecuted=true;`;
  const js = remapJs(source, maps); assert.match(js.source, /^"use strict"/); assert.ok(js.source.includes("const text='a'")); assert.ok(js.source.includes("const color='#fff'")); assert.ok(js.source.includes('getElementById("node-copy")')); assert.ok(js.source.includes('/copy?mode=x#node-copy')); assert.ok(js.warnings.length); assert.equal((globalThis as { __portableCodeExecuted?: boolean }).__portableCodeExecuted, undefined);
  assert.equal(remapSnippet({ ...emptyCode, js: source, jsEnabled: true }, maps).code.jsEnabled, false);
  const tagged = remapJs('const path=String.raw`/old`;', maps); assert.equal(tagged.source, 'const path=String.raw`/old`;'); assert.ok(tagged.warnings.length);
  assert.throws(() => remapCss('a { invalid', maps), /无法解析/);
});

test('页面模板独立保存/显式发布/恢复，素材与表单引用保护，不生成公开虚拟路由', async () => {
  const form = createFormDefinition('template-form'), upload = new FormData(); upload.set('file', new File([await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer()], 'template.png', { type: 'image/png' })); upload.set('expectedRevision', String(getDraftRecord().revision)); const media = (await uploadMedia(upload)).media;
  const template = { id: 'template-contact', name: 'Contact design', description: '', kind: 'page', sourcePath: '/contact', updated: '', data: { root: { props: { showChrome: 'no' } }, content: [{ type: 'Form', props: { id: 'template-form-node', formId: form.id } }, { type: 'Image', props: { id: 'template-image', src: media.url, alt: 'Synthetic template' } }, { type: 'ActionButton', props: { id: 'template-self', text: 'This copy', href: '', linkTarget: { kind: 'page', id: 'template-contact' } } }] } };
  save({ forms: [form], pageTemplates: [template] }); const revision = getDraftRecord().revision;
  assert.throws(() => deleteMedia(media.id, { expectedRevision: revision }), /引用/); assert.throws(() => save({ forms: [] }), /表单/);
  const first = publishSite(selection({ includeTemplates: true, includeForms: true }), actor), snapshot = readRelease(first.releaseId);
  assert.equal(snapshot.pageTemplates?.length, 1); assert.ok(snapshot.media.some(m => m.id === media.id)); assert.equal(resolveSitePage(snapshot, ['template-template-contact']), null);
  save({ pageTemplates: [{ ...template, name: 'Changed library name' }] }); assert.equal(readRelease(first.releaseId).pageTemplates![0].name, 'Contact design');
  const onlyLibrary = publishSite(selection({ pageIds: [], productIds: [], includeTheme: false, includeSettings: false, includeTemplates: true }), actor); assert.equal(readRelease(onlyLibrary.releaseId).pageTemplates![0].name, 'Changed library name');
  save({ pageTemplates: [] }); deleteMedia(media.id, { expectedRevision: getDraftRecord().revision }); assert.equal(isPublishedMedia(media.id), true);
  const beforeRestore=getDraftRecord().revision; assert.throws(()=>restoreDraft(first.releaseId,{expectedRevision:beforeRestore,pageIds:[],includeTemplates:'yes'},actor),/是\/否/);assert.equal(getDraftRecord().revision,beforeRestore);
  restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: [], includeTemplates: true }, actor); assert.equal(getDraftRecord().content.pageTemplates![0].name, 'Contact design'); assert.ok(getDraftRecord().content.media.some(m => m.id === media.id));
});

test('模板资产不能替代真实详情页满足公开绑定，未知组件原样保留且拒绝发布', () => {
  const draft = getDraftRecord().content;
  save({ pages: draft.pages.filter(p => p.slug !== '/products/:slug'), editorData: { ...draft.editorData, home: { root: { props: { showChrome: 'no', bindingContext: { source: 'product', recordId: 'p1' } } }, content: [{ type: 'ActionButton', props: { id: 'live-product-link', text: 'Product', href: '', bindings: { href: { source: 'product', mode: 'current', field: 'builtin:url' } } } }] } }, pageTemplates: [{ id: 'product-layout', name: 'Product layout', description: '', kind: 'product', updated: '', data: textData() }] });
  const preview = previewPublication(selection({ productIds: ['p1'], includeTemplates: true })); assert.ok(preview.errors.some(e => e.includes('产品详情模板')));
  const current = getDraftRecord().revision;
  save({ pageTemplates: [{ id: 'unknown-layout', name: 'Unknown', description: '', kind: 'page', updated: '', data: { root: { props: {} }, content: [{ type: 'UnknownPluginWidget', props: { id: 'unknown' } }] } }] });
  assert.equal(getDraftRecord().revision, current + 1);
  const failed = previewPublication(selection({ productIds: ['p1'], includeTemplates: true })); assert.ok(failed.errors.some(e => e.includes('组件类型')));
  assert.equal(getDraftRecord().content.pageTemplates![0].data.content[0].type, 'UnknownPluginWidget');
});

test('捕获/应用普通页是独立深拷贝，保留跨页样式ID，自链接改目标且代码需管理员显式复制', () => {
  const draft = getDraftRecord().content;
  const data = { root: { props: { showChrome: 'no' } }, content: [{ type: 'Text', props: { id: 'stable-style-id', text: 'Source text' } }, { type: 'ActionButton', props: { id: 'self-link', text: 'Self', href: '', linkTarget: { kind: 'page', id: 'home' } } }] };
  save({ editorData: { ...draft.editorData, home: data }, customCode: { global: emptyCode, pages: { home: { css: '#stable-style-id{color:#123456}', cssEnabled: true, js: `document.getElementById('stable-style-id');fetch('/');`, jsEnabled: true } } } });
  savePageAsTemplate({ expectedRevision: getDraftRecord().revision, pageId: 'home', templateId: 'copy-layout', name: 'Copy layout' });
  const captured = getDraftRecord().content.pageTemplates![0]; assert.equal(captured.data.content[0].props.id, 'stable-style-id'); assert.equal(captured.data.content[1].props.linkTarget.id, 'copy-layout');
  const result = applyPageTemplate({ expectedRevision: getDraftRecord().revision, templateId: captured.id, newPageId: 'copied-page', title: 'Independent copy', slug: '/copy' });
  assert.equal(result.pageId, 'copied-page'); assert.equal(result.state.customCode?.pages['copied-page'], undefined); assert.ok(result.warnings.length);
  const copied = result.state.editorData['copied-page'] as typeof data; assert.equal(copied.content[1].props.linkTarget!.id, 'copied-page'); assert.equal(captured.data.content[1].props.linkTarget.id, 'copy-layout');
  const rev = getDraftRecord().revision;
  assert.throws(() => applyPageTemplate({ expectedRevision: rev, templateId: captured.id, newPageId: 'code-copy', title: 'Code copy', slug: '/code-copy', includeCode: true }), /管理员/); assert.equal(getDraftRecord().revision, rev);
  const coded = applyPageTemplate({ expectedRevision: rev, templateId: captured.id, newPageId: 'code-copy', title: 'Code copy', slug: '/code-copy', includeCode: true }, true);
  assert.equal(coded.state.customCode!.pages['code-copy'].jsEnabled, false); assert.ok(coded.state.customCode!.pages['code-copy'].js.includes('/code-copy'));
  const edits = structuredClone(getDraftRecord().content.editorData), edited = edits['copied-page'] as typeof data; edited.content[0].props.text = 'Only this copy'; save({ editorData: edits });
  assert.equal((getDraftRecord().content.editorData.home as typeof data).content[0].props.text, 'Source text'); assert.equal(getDraftRecord().content.pageTemplates![0].data.content[0].props.text, 'Source text');
  const revised = structuredClone(getDraftRecord().content.editorData); (revised.home as typeof data).content[0].props.text = 'Source revised'; save({ editorData: revised });
  savePageAsTemplate({ expectedRevision: getDraftRecord().revision, templateId: captured.id, pageId: 'home', name: 'Updated layout', replaceExisting: true });
  assert.equal(getDraftRecord().content.pageTemplates![0].data.content[0].props.text, 'Source revised'); assert.equal((getDraftRecord().content.editorData['copied-page'] as typeof data).content[0].props.text, 'Only this copy');
  const snapshot = getDraftSiteSnapshot(), preview = readTemplatePreview(snapshot, captured.id); assert.ok(preview && !('error' in preview));
  if (preview && !('error' in preview)) { assert.equal(preview.snapshot.customCode!.global.jsEnabled, false); assert.equal(preview.snapshot.customCode!.pages[captured.id].jsEnabled, false); }
  assert.equal(snapshot.pageTemplates![0].code!.jsEnabled, true);
});

test('详情模板应用必须明确目标且只保留一个默认详情页，未知来源组件拒绝复制而不丢原数据', () => {
  savePageAsTemplate({ expectedRevision: getDraftRecord().revision, pageId: 'product-detail', templateId: 'detail-layout', name: 'Product detail copy' });
  const count = getDraftRecord().content.pages.length;
  assert.throws(() => applyPageTemplate({ expectedRevision: getDraftRecord().revision, templateId: 'detail-layout', newPageId: 'second-detail', title: 'Second', slug: '/products/:slug' }), /明确选择/);
  const applied = applyPageTemplate({ expectedRevision: getDraftRecord().revision, templateId: 'detail-layout', targetPageId: 'product-detail' });
  assert.equal(applied.state.pages.length, count); assert.equal(applied.state.pages.filter(p => p.slug === '/products/:slug').length, 1);
  const draft = getDraftRecord().content; save({ editorData: { ...draft.editorData, home: { root: { props: {} }, content: [{ type: 'UnknownWidget', props: { id: 'unavailable' } }] } } }); const revision = getDraftRecord().revision;
  assert.throws(() => savePageAsTemplate({ expectedRevision: revision, pageId: 'home', templateId: 'unknown-copy', name: 'Unknown copy' }), /未知组件/);
  assert.equal(getDraftRecord().revision, revision); assert.equal((getDraftRecord().content.editorData.home as { content: { type: string }[] }).content[0].type, 'UnknownWidget');
});


test('CSS资源值按语法映射JPEG/url/image-set/片段；同名content文字和颜色保持原样',()=>{
 const css='a{background-image:image-set("/images/chair.jpg" 1x,url(/api/media/old) 2x);content:"/images/chair.jpg";filter:url(#fff);color:#fff}';
 const result=remapCss(css,{paths:new Map([['/images/chair.jpg','/api/media/new-jpeg'],['/api/media/old','/api/media/new']]),nodes:new Map([['fff','new-node']])});
 assert.match(result,/image-set\("\/api\/media\/new-jpeg" 1x,url\(\/api\/media\/new\) 2x\)/);assert.ok(result.includes('content:"/images/chair.jpg"'));assert.ok(result.includes('color:#fff'));assert.ok(result.includes('filter:url(#new-node)'));
});
test('关系及条件资源显式发布、未选草稿隔离、回退恢复，强引用失败无写入',()=>{
 const base=getDraftRecord().content,model={id:'related-goods',name:'Related goods',target:'product',description:'',updated:'',fields:[{id:'related-work',key:'work',label:'Work',type:'relation',required:false,relation:{source:'entry',modelId:'related-cases',multiple:true,onDelete:'restrict'}}]},cases={id:'related-cases',name:'Related cases',description:'',target:'content',fields:[],updated:''},entries=['case-a','case-b'].map(id=>({id,title:id,modelId:cases.id,customFields:{},status:'draft',updated:''}));
 const detail={id:'related-detail',title:'Case detail',slug:'/related-cases/:slug',type:'内容详情模板',contentModelId:cases.id,status:'draft',updated:''},template={id:'conditional-layout',name:'Conditional layout',description:'',kind:'product',updated:'',data:textData(),detailRule:{enabled:true,priority:20,recordIds:['p1']}};
 save({contentModels:[model,cases],contentEntries:entries,products:base.products.map((p,i)=>i? p:{...p,modelId:model.id,customFields:{'related-work':['case-b','case-a']}}),pages:[...base.pages,detail],editorData:{...base.editorData,[detail.id]:textData()},pageTemplates:[template]});
 const partial=selection({pageIds:['home','product-detail',detail.id],productIds:['p1'],contentModelIds:[model.id,cases.id],includeTemplates:true});
 assert.ok(previewPublication(partial).errors.some(e=>/未选择发布|未在发布/.test(e)),'未选关联记录必须阻止发布');
 const first=publishSite({...partial,contentEntryIds:entries.map(e=>e.id)},actor),snapshot=readRelease(first.releaseId);assert.equal(resolveSitePage(snapshot,['products','p1'])?.detailTemplateId,template.id);
 const beforeRevision=getDraftRecord().revision;assert.throws(()=>save({contentEntries:entries.slice(0,1)}),/引用/);assert.equal(getDraftRecord().revision,beforeRevision);
 const current=getDraftRecord().content;save({pageTemplates:current.pageTemplates!.map(t=>({...t,data:{...t.data,content:[{type:'Text',props:{id:'updated-layout',text:'Changed conditional draft'}}]}})),products:current.products.map(p=>p.id==='p1'?{...p,customFields:{'related-work':['case-a','case-b']}}:p)});
 const unselected=publishSite(selection({pageIds:[],includeTheme:false,includeSettings:true}),actor);assert.equal(readRelease(unselected.releaseId).pageTemplates![0].data.content[0].props.text,'Independent template');assert.deepEqual(readRelease(unselected.releaseId).products[0].customFields?.['related-work'],['case-b','case-a']);
 const second=publishSite(selection({pageIds:[],productIds:['p1'],includeTemplates:true,includeTheme:false,includeSettings:false}),actor);assert.equal(resolveSitePage(readRelease(second.releaseId),['products','p1'])?.data.content[0].props.text,'Changed conditional draft');
 activateRelease(first.releaseId,{expectedActiveReleaseId:second.releaseId},actor);assert.deepEqual(readRelease(getStudioEnvelope().activeReleaseId!).products[0].customFields?.['related-work'],['case-b','case-a']);
 restoreDraft(first.releaseId,{expectedRevision:getDraftRecord().revision,pageIds:[],productIds:['p1'],includeTemplates:true},actor);assert.deepEqual(getDraftRecord().content.products[0].customFields?.['related-work'],['case-b','case-a']);assert.equal(getDraftRecord().content.pageTemplates![0].data.content[0].props.text,'Independent template');
});
test('真实S14-A协议12结构可读/切换/恢复，缺关系与条件规则保持默认模板',()=>{
 // 来源为提交10cdf68的原starter生成器，SHA记录在fixture说明；没有用新payload改版本数字。
 const snapshot=structuredClone(legacyV12) as SiteSnapshot,id='actual-v12-starter',raw=JSON.stringify({...snapshot,releaseId:id});
 getDatabase().prepare('INSERT INTO cms_release(id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES(?,?,?,?,12,12,?,?,?,?)').run(id,'Actual old starter',raw,'fixture',actor.id,actor.name,new Date().toISOString(),'{}');
 activateRelease(id,{expectedActiveReleaseId:null},actor);assert.equal(readRelease(id).schemaVersion,12);assert.equal(resolveSitePage(readRelease(id),['products',snapshot.products[0].slug||snapshot.products[0].id])?.detailTemplateId,undefined);
 save({pages:[],products:[],media:[],editorData:{},contentModels:[],contentEntries:[],sharedBlocks:[],forms:[],pageTemplates:[]});
 restoreDraft(id,{expectedRevision:getDraftRecord().revision,pageIds:snapshot.pages.map(p=>p.id),productIds:snapshot.products.map(p=>p.id),sharedBlockIds:snapshot.sharedBlocks!.map(b=>b.id),includeLayout:true,includeForms:true,includeTemplates:true},actor);
 assert.equal(getDraftRecord().content.pages.length,5);assert.equal(readRelease(id).schemaVersion,12);assert.equal(JSON.stringify(readRelease(id)),raw);
});

test('真实协议13关系及条件模板快照在多语言渲染器可激活且保留默认无前缀网址',()=>{
 const snapshot=structuredClone(legacyV13) as SiteSnapshot,id='actual-v13-starter',raw=JSON.stringify({...snapshot,releaseId:id});
 getDatabase().prepare('INSERT INTO cms_release(id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES(?,?,?,?,13,13,?,?,?,?)').run(id,'Actual protocol 13',raw,'fixture',actor.id,actor.name,new Date().toISOString(),'{}');
 activateRelease(id,{expectedActiveReleaseId:null},actor);const live=readRelease(id);assert.equal(live.schemaVersion,13);assert.equal(live.settings.locales,undefined);assert.equal(resolveSitePage(live,['products',snapshot.products[0].slug||snapshot.products[0].id])?.detailTemplateId,'legacy-layout');assert.deepEqual(live.products[0].customFields?.['legacy-work'],['legacy-case']);assert.equal(JSON.stringify(live),raw);
});
