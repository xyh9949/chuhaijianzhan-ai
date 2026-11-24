import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentData, Data } from '@puckeditor/core';
import type { DraftContent } from '../src/server/types';
import type { SeoDataReport, SeoKeywordReport, SeoSearchReport } from '../src/lib/seo-types';
import { createEmptyDraft } from '../src/server/seed';
import { diagnoseSeo, enumerateSeoTargets, getSeoEffectiveMetadata, getSeoTargetMetadata, matchSeoTargetUrl } from '../src/lib/seo-diagnostics';

const node=(type:string,id:string,props:Record<string,unknown>={}):ComponentData=>({type,props:{id,...props}} as ComponentData);
const data=(nodes:ComponentData[]):Data=>({root:{props:{showChrome:'no'}},content:nodes,zones:{}} as Data);
function fixture(){const c=createEmptyDraft();c.settings={...c.settings,name:'Example Factory',publicUrl:'https://factory.example',description:'Company supplied website introduction.'};c.pages[0]={...c.pages[0],seoTitle:'Furniture for projects',seoDescription:'Current company information supplied by the site owner.'};c.editorData.home=data([node('Heading','h1',{text:'Project furniture',level:'h1'}),node('Text','body',{text:'Wooden furniture for commercial projects, described using supplied material information.'})]);return c;}
function addPage(c:DraftContent,id:string,slug=`/${id}`,props:Record<string,unknown>={},nodes?:ComponentData[]){c.pages.push({id,title:id,slug,type:'普通页面',status:'draft',updated:'2026-11-10',...props});c.editorData[id]=data(nodes||[node('Heading',`${id}-h1`,{level:'h1',text:id})]);}
function search(extra:Partial<SeoSearchReport>={}):SeoSearchReport{return {id:'gsc-report',kind:'search',provider:'gsc',connectionRevision:1,createdAt:'2026-11-10T00:00:00.000Z',source:{name:'Google Search Console',url:'https://developers.google.com/webmaster-tools/v1/searchanalytics/query',sourceMock:false},scope:{property:'sc-domain:factory.example',startDate:'2026-10-01',endDate:'2026-10-28',timeZone:'America/Los_Angeles',country:'usa',device:'MOBILE'},coverage:{partial:true,reasons:['Google不保证返回所有查询，隐私查询可能省略。'],rowCount:1,pagesFetched:1},rows:[{rowNumber:1,page:'https://factory.example/',query:'project furniture',clicks:0,impressions:150,ctr:0,position:8.2}],warnings:[],...extra};}
function keywords(extra:Partial<SeoKeywordReport>={}):SeoKeywordReport{return {id:'keyword-report',kind:'keywords',provider:'dataforseo',connectionRevision:1,createdAt:'2026-11-10T00:00:00.000Z',source:{name:'DataForSEO',url:'https://docs.dataforseo.com/v3/keywords_data-google_ads-search_volume-live/',sourceMock:false},scope:{startDate:'2025-11-01',endDate:'2026-10-31',timeZone:'provider',locationCode:2840,languageCode:'en',currency:'USD'},coverage:{partial:false,reasons:[],rowCount:3},rows:[{rowNumber:1,keyword:'wooden furniture',searchVolume:1200,cpc:1.5,competition:'HIGH',competitionIndex:90,monthlySearches:[]},{rowNumber:2,keyword:'zero volume term',searchVolume:0,cpc:null,competition:null,competitionIndex:null,monthlySearches:[]},{rowNumber:3,keyword:'missing volume term',searchVolume:null,cpc:null,competition:null,competitionIndex:null,monthlySearches:[]}],warnings:[],...extra};}

test('目标不编造缺失详情URL，显式与实际fallback分开且不写草稿',()=>{
  const c=fixture();c.products.push({id:'chair',name:'Project chair',sku:'C1',category:'Chairs',description:'Supplied chair description',material:'Wood',image:'',status:'draft'});const before=structuredClone(c),targets=enumerateSeoTargets(c);assert.equal(targets.find(target=>target.id==='chair')?.url,null);
  assert.deepEqual(getSeoTargetMetadata(c,{kind:'product',id:'chair'}),{seoTitle:'',seoDescription:''});assert.deepEqual(getSeoEffectiveMetadata(c,{kind:'product',id:'chair'}),{seoTitle:'Project chair',seoDescription:'Supplied chair description'});
  const report=diagnoseSeo(c);assert.ok(report.issues.some(issue=>issue.code==='missing-detail-route'&&issue.target?.id==='chair'));assert.deepEqual(c,before);
});
test('真实标题描述fallback不误报空，重复/空正文主标题/图片说明与坏内链有可读提示',()=>{
  const c=fixture();c.pages[0].seoTitle=undefined;c.pages[0].seoDescription=undefined;c.editorData.home=data([node('Heading','empty',{text:'',level:'h1'}),node('Image','image',{src:'/images/chair.jpg',alt:''}),node('ActionButton','bad',{text:'Go',href:'/does-not-exist'})]);addPage(c,'about','/about',{seoTitle:'Home',seoDescription:c.settings.description});
  const issues=diagnoseSeo(c).issues;assert.equal(issues.some(issue=>issue.code==='empty-title'&&issue.target?.id==='home'),false);assert.equal(issues.some(issue=>issue.code==='empty-description'&&issue.target?.id==='home'),false);
  for(const code of ['title-fallback','description-fallback','empty-h1','image-alt','broken-internal-link','duplicate-title','duplicate-description'])assert.ok(issues.some(issue=>issue.code===code),code);
});
test('当前产品和条件模板先解析真实绑定，不把动态标题空值当H1缺失',()=>{
  const c=fixture();addPage(c,'detail','/products/:slug');c.products=[{id:'chair',slug:'project-chair',name:'Actual chair',sku:'C01',category:'Chairs',description:'Actual supplied description',material:'Wood',image:'',status:'draft'}];
  c.editorData.detail=data([node('Heading','bound',{text:'',level:'h1',bindings:{text:{source:'product',mode:'current',field:'builtin:name'}}})]);
  c.pageTemplates=[{id:'conditional',name:'Chair layout',kind:'product',sourcePath:'/products/:slug',description:'',updated:'2026-11-10',detailRule:{enabled:true,priority:10,recordIds:['chair']},data:data([node('ProductDetail','dynamic',{layout:'stacked'})])}];
  const report=diagnoseSeo(c);assert.equal(report.targets.find(target=>target.kind==='product')?.url,'/products/project-chair');assert.equal(report.issues.some(issue=>issue.target?.kind==='product'&&['missing-h1','empty-h1','multiple-h1'].includes(issue.code)),false);
});
test('独立内容真实记录优先于模板样本，动态富文本与共享区块的H1可识别',()=>{
  const c=fixture();c.contentModels=[{id:'news',name:'News',description:'',target:'content',updated:'2026-11-10',fields:[{id:'body',key:'body',label:'Body',type:'textarea',required:false}]}];addPage(c,'news-template','/news/:slug',{contentModelId:'news'});
  c.contentEntries=[{id:'story',modelId:'news',title:'Actual story',slug:'actual-story',status:'draft',updated:'2026-11-10',customFields:{body:'Actual body text'}}];
  c.sharedBlocks=[{id:'story-heading',name:'Heading',updated:'2026-11-10',data:data([node('Heading','entry-h1',{level:'h1',text:'',bindings:{text:{source:'entry',mode:'current',modelId:'news',field:'builtin:title'}}})])}];
  c.editorData['news-template']={...data([node('SharedBlock','reference',{blockId:'story-heading'}),node('Text','entry-body',{text:'',bindings:{text:{source:'entry',mode:'current',modelId:'news',field:'field:body'}}})]),root:{props:{showChrome:'no',bindingContext:{source:'entry',recordId:'wrong-sample',modelId:'news'}}}} as Data;
  const report=diagnoseSeo(c);assert.equal(report.targets.find(target=>target.kind==='entry')?.url,'/news/actual-story');assert.equal(report.issues.some(issue=>issue.target?.kind==='entry'&&['missing-h1','empty-h1'].includes(issue.code)),false);
});
test('孤立页检查读取导航/按钮与story别名，不把动态分页第二页产品误判孤立',()=>{
  const c=fixture();addPage(c,'about');addPage(c,'products','/products');addPage(c,'detail','/products/:slug');addPage(c,'orphan');
  (c.editorData.home as Data).content.push(node('ActionButton','story',{text:'Story',href:'#story'}));c.editorData.products=data([node('Heading','products-h1',{text:'Products',level:'h1'}),node('ContentList','listing',{source:'product',count:1,titleField:'builtin:name',linkField:'builtin:url'})]);
  c.products=Array.from({length:3},(_,i)=>({id:`p${i}`,name:`Chair ${i}`,sku:`C${i}`,category:'Chairs',description:'Chair description',material:'Wood',image:'',status:'draft' as const}));c.editorData.detail=data([node('ProductDetail','product')]);
  const report=diagnoseSeo(c);assert.equal(report.issues.some(issue=>issue.code==='orphan-page'&&issue.target?.id==='about'),false);assert.ok(report.issues.some(issue=>issue.code==='orphan-page'&&issue.target?.id==='orphan'));assert.equal(report.issues.some(issue=>issue.code==='orphan-page'&&issue.target?.kind==='product'),false);
});
test('明确noindex保留为信息，不自动解除且不产生数据驱动索引建议',()=>{
  const c=fixture();c.pages[0].noindex=true;const result=diagnoseSeo(c,[search()]);assert.ok(result.issues.some(issue=>issue.code==='intentional-noindex'&&issue.severity==='info'));assert.equal(result.issues.some(issue=>issue.code.startsWith('gsc-')),false);assert.equal(c.pages[0].noindex,true);
});
test('语言切换器的同组真实译文计入内链，不把其他语言首页误判孤立',()=>{
  const c=fixture();c.settings.locales=[{code:'en',label:'English'},{code:'de',label:'Deutsch'}];c.pages[0].locale='en';c.pages[0].translationGroupId='home-group';
  addPage(c,'home-de','/de',{locale:'de',translationGroupId:'home-group'},[node('Heading','de-h1',{level:'h1',text:'Startseite'}),node('LanguageSwitcher','de-switch')]);
  (c.editorData.home as Data).content.push(node('LanguageSwitcher','en-switch'));
  assert.equal(diagnoseSeo(c).issues.some(issue=>issue.code==='orphan-page'&&issue.target?.id==='home-de'),false);
});
test('GSC建议引用真实行号、日期、时区、partial，点击/平均位置不是访客或排名承诺',()=>{
  const c=fixture(),result=diagnoseSeo(c,[search()]),issue=result.issues.find(issue=>issue.code==='gsc-no-clicks')!;assert.ok(issue);assert.equal(issue.target?.id,'home');assert.deepEqual(issue.evidence[0].rowNumbers,[1]);assert.equal(issue.evidence[0].timeZone,'America/Los_Angeles');assert.equal(issue.evidence[0].startDate,'2026-10-01');assert.equal(issue.evidence[0].partial,true);assert.match(issue.message,/不是CTR行业基准/);
  const ranked=search({rows:[{rowNumber:4,page:'https://factory.example/',query:'wood furniture',clicks:3,impressions:90,ctr:3/90,position:12.7}]});assert.match(diagnoseSeo(c,[ranked]).issues.find(issue=>issue.code==='gsc-near-front')!.message,/不代表当前固定排名/);
});
test('跨host/参数页不强行映射，只用相同范围最新报告，不累加重叠日期',()=>{
  const c=fixture();assert.equal(matchSeoTargetUrl(c,'https://other.example/'),undefined);assert.equal(matchSeoTargetUrl(c,'https://factory.example/?search=chairs'),undefined);assert.equal(matchSeoTargetUrl(c,'https://factory.example/#section'),undefined);
  const old=search({id:'old-report',createdAt:'2026-11-01T00:00:00.000Z'}),latest=search({id:'latest',rows:[{rowNumber:1,page:'https://other.example/',query:'wrong host',clicks:0,impressions:1000,ctr:0,position:8}]});
  const result=diagnoseSeo(c,[old,latest]);assert.equal(result.issues.some(issue=>issue.code==='gsc-no-clicks'),false);assert.ok(result.coverage.notes.some(note=>note.includes('最新一份')));assert.ok(result.coverage.notes.some(note=>note.includes('未匹配')));
});
test('同一查询多页仅建议人工核对用途，不断言关键词蚕食',()=>{
  const c=fixture();addPage(c,'about');const r=search({rows:[{rowNumber:1,page:'https://factory.example/',query:'project furniture',clicks:1,impressions:10,ctr:0.1,position:3},{rowNumber:2,page:'https://factory.example/about',query:'project furniture',clicks:1,impressions:10,ctr:0.1,position:3}]});const issue=diagnoseSeo(c,[r]).issues.find(issue=>issue.code==='gsc-multiple-pages')!;assert.match(issue.message,/可能是正常/);assert.deepEqual(issue.evidence[0].rowNumbers,[1,2]);
});
test('关键词估计与GSC实绩分开，null不当0、广告竞争不是自然难度，相关度仅推断',()=>{
  const c=fixture(),result=diagnoseSeo(c,[keywords()]),scope=result.issues.find(issue=>issue.code==='keyword-metric-scope')!,fit=result.issues.find(issue=>issue.code==='keyword-page-fit')!;assert.match(scope.message,/1词缺失搜索量、1词明确为0/);assert.match(scope.message,/广告竞争不代表自然SEO难度/);assert.equal(fit.target?.id,'home');assert.deepEqual(fit.evidence[0].rowNumbers,[1]);assert.match(fit.evidence[0].description,/1200/);assert.match(fit.message,/只是推断/);assert.equal(fit.evidence[0].languageCode,'en');
});
test('关键词只匹配相同基础语言，不从国家或英文产品词猜目标语言，GSC不受影响',()=>{
  const c=fixture();c.settings.language='de-DE';c.pages[0].locale='de-DE';const result=diagnoseSeo(c,[keywords(),search()]);assert.equal(result.issues.some(issue=>issue.code==='keyword-page-fit'),false);assert.ok(result.coverage.notes.some(note=>note.includes('跳过异语言')));assert.ok(result.issues.some(issue=>issue.code==='gsc-no-clicks'));
  c.settings.language='en-GB';c.pages[0].locale='en-GB';assert.ok(diagnoseSeo(c,[keywords()]).issues.some(issue=>issue.code==='keyword-page-fit'));
});
test('CSV和模拟来源如实标注，零行报告不被认成全站零流量',()=>{
  const c=fixture(),csv=keywords({provider:'csv',source:{name:'Customer exported metrics',url:'https://example.invalid/export',sourceMock:true}});const issue=diagnoseSeo(c,[csv]).issues.find(issue=>issue.code==='keyword-metric-scope')!;assert.equal(issue.evidence[0].source,'csv');assert.match(issue.evidence[0].description,/模拟资料/);assert.match(issue.evidence[0].description,/未联网核验/);assert.ok(diagnoseSeo(c,[search({rows:[]})]).coverage.notes.some(note=>note.includes('不推断为全站零流量')));
});
test('扩展或旧插槽不作为确定性空H1，目标/文本限制和重复长文覆盖明确',()=>{
  const c=fixture();c.editorData.home=data([node('UnknownExtension','extension')]);assert.equal(diagnoseSeo(c).issues.some(issue=>issue.code==='missing-h1'),false);
  c.editorData.home={...data([]),zones:{'legacy:content':[node('Heading','legacy',{text:'Keep',level:'h1'})]}} as Data;assert.equal(diagnoseSeo(c).issues.some(issue=>issue.code==='missing-h1'),false);
  const d=fixture(),repeated='Supplied information stays factual and should be reviewed for each distinct page. '.repeat(4);d.editorData.home=data([node('Heading','h1',{text:'Home',level:'h1'}),node('Text','body',{text:repeated})]);addPage(d,'about','/about',{},[node('Heading','h2',{text:'About',level:'h1'}),node('Text','body2',{text:repeated})]);assert.equal(diagnoseSeo(d).issues.filter(issue=>issue.code==='duplicate-body').length,2);
  for(let i=0;i<501;i++)addPage(d,`large-${i}`);const result=diagnoseSeo(d);assert.equal(result.coverage.checkedTargets,500);assert.equal(result.coverage.truncated,true);assert.equal(result.targets.length,500);
});
