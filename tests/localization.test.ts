import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createInitialDraft} from '../src/server/seed';
import {localeOf,localePrefix,localizedPath,stripLocalePath,localizationErrors} from '../src/lib/localization';
import {getProductPath,getContentEntryPath,contentRouteErrors} from '../src/lib/content-routes';
import {resolveSitePage} from '../src/lib/site-routing';
import {siteMetadata} from '../src/lib/site-metadata';
import {translationLinks} from '../src/lib/translation-links';
import {queryContent,queryErrors} from '../src/lib/content-query';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Render} from '@puckeditor/core/rsc';
import {createSiteConfig} from '../src/lib/site-render-config';
import {chooseDetailTemplate,detailTemplateErrors} from '../src/lib/detail-templates';
import {rebaseLocaleMenus,defaultLanguageMenuErrors} from '../src/lib/site-navigation';
import type {SiteSnapshot} from '../src/server/types';
function fixture():SiteSnapshot{
 const d=createInitialDraft(),home={...d.pages[0],translationGroupId:'home-group',locale:'en',status:'published' as const},german={...home,id:'de-home',slug:'/de',locale:'de',title:'Startseite',seoTitle:'German title',translationState:'reviewed' as const};
 const p={...d.products[0],id:'chair-en',slug:'chair',locale:'en',translationGroupId:'chair',status:'published' as const},de={...p,id:'chair-de',slug:'stuhl',sku:'CHAIR-DE',name:'Stuhl',locale:'de'};
 return {...d,schemaVersion:14,pages:[home,german,...d.pages.slice(1).map(p=>({...p,status:'published' as const}))],products:[p,de],settings:{...d.settings,publicUrl:'https://locale.example.invalid',language:'en',locales:[{code:'en',label:'English'},{code:'de',label:'Deutsch'}]},editorData:{...d.editorData,'de-home':d.editorData.home}};
}
test('默认语言保留原路径，前缀只剥离已配置语言，不猜测未知目录',()=>{const s=fixture();assert.equal(localeOf(s.settings,s.products[1]),'de');assert.equal(localePrefix(s.settings,s.products[0]),'');assert.equal(localizedPath(s.settings,s.products[1],'/'),'/de');assert.equal(stripLocalePath(s.settings,'/de/products/stuhl'),'/products/stuhl');assert.equal(stripLocalePath(undefined,'/english'),'/english');assert.equal(getProductPath(s,s.products[0]),'/products/chair');assert.equal(getProductPath(s,s.products[1]),'/de/products/stuhl');assert.equal(resolveSitePage(s,['de','products','stuhl'])?.product?.id,'chair-de');assert.equal(resolveSitePage(s,['products','stuhl']),null);assert.equal(resolveSitePage(s,['fr','products','chair']),null);assert.equal(resolveSitePage(s,['de'])?.page.id,'de-home');});
test('翻译组唯一、语言配置/路径目录与待核对发布严格校验，缺译不跳无关首页',()=>{const s=fixture();assert.deepEqual(localizationErrors(s,true),[]);s.products[1].translationState='needs-review';assert.match(localizationErrors(s,true).join(),/待核对/);assert.deepEqual(localizationErrors(s),[]);s.products[1].translationState='reviewed';s.products[1].locale='en';assert.match(localizationErrors(s).join(),/重复/);s.products[1].locale='de';s.pages[1].slug='/wrong';assert.match(localizationErrors(s).join(),/前缀/);s.pages[1].slug='/de';const links=translationLinks(s,'product',s.products[0]);assert.equal(links.find(l=>l.locale==='de')?.href,'/de/products/stuhl');s.products[1].status='draft';assert.equal(translationLinks(s,'product',s.products[0]).find(l=>l.locale==='de')?.href,undefined);assert.equal(translationLinks(s,'product',s.products[0],{preview:true}).find(l=>l.locale==='de')?.href,'/de/products/stuhl');});
test('自指canonical与hreflang只使用实际公开同组，列表不混其他语言',()=>{const s=fixture(),resolved=resolveSitePage(s,['de','products','stuhl'])!,meta=siteMetadata(s,resolved);assert.equal(meta.alternates?.canonical,'https://locale.example.invalid/de/products/stuhl');assert.deepEqual(meta.alternates?.languages,{en:'https://locale.example.invalid/products/chair',de:'https://locale.example.invalid/de/products/stuhl'});assert.equal(siteMetadata(s,resolved,true).alternates,undefined);assert.deepEqual(queryContent({...s,locale:'de'},'product',undefined,undefined,'loop').records.map(p=>p.id),['chair-de']);assert.deepEqual(queryContent({...s,locale:'en'},'product',undefined,undefined,'loop').records.map(p=>p.id),['chair-en']);});
test('同模型相同标识可分语言，内容详情共用默认路由模板而不合并正文',()=>{const s=fixture();s.contentModels=[{id:'cases',name:'Cases',description:'',target:'content',updated:'',fields:[]}];s.pages.push({id:'case-detail',title:'Cases',slug:'/cases/:slug',type:'内容详情模板',contentModelId:'cases',status:'published',updated:''});s.editorData['case-detail']=s.editorData.home;s.contentEntries=[{id:'en-case',modelId:'cases',title:'Case',locale:'en',translationGroupId:'case-group',slug:'case',customFields:{},status:'published',updated:''},{id:'de-case',modelId:'cases',title:'Fall',locale:'de',translationGroupId:'case-group',slug:'case',customFields:{},status:'published',updated:''}];assert.deepEqual(contentRouteErrors(s),[]);assert.equal(getContentEntryPath(s,s.contentEntries[1]),'/de/cases/case');assert.equal(resolveSitePage(s,['de','cases','case'])?.entry?.title,'Fall');assert.equal(resolveSitePage(s,['cases','case'])?.entry?.title,'Case');});

const html=(s:SiteSnapshot,id:string,extra:object={})=>renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...s,pageId:id,...extra}),data:s.editorData[id] as never}));
test('切换器使用实际页面/URL记录，同组缺译隐藏；德语列表控件可显式覆盖',()=>{
 const s=fixture();s.editorData['de-home']={root:{props:{showChrome:'no',bindingContext:{source:'product',recordId:'chair-en'}}},content:[{type:'LanguageSwitcher',props:{id:'languages'}},{type:'Breadcrumb',props:{id:'crumb'}}]};
 let output=html(s,'de-home');assert.ok(output.includes('href="/"'),'普通页应切换页面翻译组而非模板产品样本');assert.ok(!output.includes('/products/chair'),'不借用产品样本翻译链接');assert.ok(output.includes('href="/de"'),'面包屑首页在当前语言');
 s.editorData['product-detail']={root:{props:{showChrome:'no',bindingContext:{source:'product',recordId:'chair-en'}}},content:[{type:'LanguageSwitcher',props:{id:'product-languages'}}]};
 output=html(s,'product-detail',{previewProductId:'chair-de'});assert.ok(output.includes('/de/products/stuhl'),'真实URL德语记录优先');assert.ok(output.includes('/products/chair'),'产品互译目标');
 s.sharedBlocks=[{id:'card',name:'Card',updated:'',data:{root:{props:{}},content:[{type:'Heading',props:{id:'name',text:'',bindings:{text:{source:'product',mode:'current',field:'builtin:name'}}}}]}}];
 s.editorData['de-home']={root:{props:{showChrome:'no'}},content:[{type:'ContentLoop',props:{id:'german-loop',source:'product',itemBlockId:'card',query:{paginate:true,controls:true,pageSize:1,labels:{de:{apply:'Produkte suchen'}}}}}]};
 output=html(s,'de-home',{currentPath:'/de'});assert.ok(output.includes('Produkte suchen')&&output.includes('Suche')&&output.includes('Ergebnisse'),'德语系统控件及作者覆盖');assert.ok(output.includes('data-loop-record="chair-de"')&&!output.includes('data-loop-record="chair-en"'),'语言在查询分页前隔离');
 assert.ok(queryErrors({labels:{fr:{search:'Search'}}},s,'product').length,'未启用语言覆盖应拒绝');
});
test('两语言同优先级模板互斥且各自命中，切默认语言菜单需显式发布',()=>{
 const s=fixture();s.pageTemplates=['en','de'].map(locale=>({id:`layout-${locale}`,name:locale,kind:'product' as const,description:'',updated:'',data:{root:{props:{}},content:[]},detailRule:{enabled:true,priority:80,locale}}));
 assert.deepEqual(detailTemplateErrors(s,true),[]);assert.equal(chooseDetailTemplate(s,'product',s.products[1]).template?.id,'layout-de');s.pageTemplates[1].detailRule!.locale=undefined;assert.ok(detailTemplateErrors(s,true).some(e=>e.includes('同时命中')),'不限语言与英文模板可能重叠');
 const from=s.settings,to={...from,language:'de'},menus={menuId:'en-menu',localeMenuIds:{de:'de-menu'}};
 assert.deepEqual(rebaseLocaleMenus(menus,from,to),{menuId:'de-menu',localeMenuIds:{en:'en-menu'}});
 s.siteLayout={header:{mode:'default',blockId:'',...menus},footer:{mode:'hidden',blockId:''}};
 assert.ok(defaultLanguageMenuErrors(s,{...s,settings:to}).length,'仅发布设置不能重解释旧默认菜单');
 const next=structuredClone(s);next.settings=to;next.siteLayout!.header=rebaseLocaleMenus(s.siteLayout.header,from,to);assert.deepEqual(defaultLanguageMenuErrors(s,next),[]);
});
