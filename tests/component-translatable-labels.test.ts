import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import type { Data } from '@puckeditor/core';
import { createSiteConfig } from '../src/lib/site-render-config';
import { createEmptyDraft } from '../src/server/seed';
import { validateDraft } from '../src/server/validation';
import { componentTranslatableLabelErrors, componentTranslatableLabels, COMPONENT_TRANSLATABLE_LABELS } from '../src/lib/component-translatable-labels';
import { componentLabelsField } from '../src/components/editor/ComponentLabelsField';

function fixture(){const content=createEmptyDraft();content.settings={...content.settings,name:'Real Factory',email:'factory@example.invalid',language:'en',locales:[{code:'en',label:'English'},{code:'de',label:'Deutsch'}],discovery:{organization:{legalName:'Original Legal Factory',alternateName:'Original Alias',address:'Original Address 25',telephone:'+86 12345',role:'Manufacturer',sameAs:['https://example.invalid/company']},facts:[{id:'supplied',title:'Original Fact',value:'Original supplied value 25 mm',scope:'Original scope',sourceUrl:'https://example.invalid/evidence',reviewedAt:'2026-11-16',validUntil:'2027-11-16',status:'reviewed'}]}};content.pages=[{id:'home',title:'Home',slug:'/',locale:'en',translationGroupId:'homepage-language',status:'draft',type:'普通页面',updated:''},{id:'home-de',title:'Start',slug:'/de',locale:'de',translationGroupId:'homepage-language',status:'draft',type:'普通页面',updated:''}];content.siteLayout={header:{mode:'hidden',blockId:''},footer:{mode:'hidden',blockId:''},menus:[{id:'main',name:'Main',items:[{id:'home-item',label:'Home',target:{kind:'page',id:'home'}}]}]};content.products=[{id:'product',name:'Original product',sku:'ORIGINAL-25',category:'Original category',material:'Original steel',description:'Original supplied description',image:'/images/chair.jpg',images:['/images/chair.jpg','/images/interior.jpg'],status:'published'}];content.forms=[{id:'inquiry',name:'Inquiry',enabled:true,submitLabel:'Send',successMessage:'Thank you',fields:[{id:'option',label:'Choose',type:'select',options:[{id:'first',label:'One'}],required:false}]}];content.editorData={home:{root:{props:{showChrome:'no'}},content:[]},'home-de':{root:{props:{showChrome:'no'}},content:[]}};return content;}
function node(type:string,props:Record<string,unknown>={}){return{type,props:{id:`test-${type.toLowerCase()}`,...props}};}
function render(nodes:Data['content'],source=fixture(),demo=false){const data={root:{props:{showChrome:'no'}},content:nodes} as Data;source.editorData.home=data;return renderToStaticMarkup(React.createElement(Render,{data,config:createSiteConfig({...source,pageId:'home',...(demo?{previewPrefix:'/preview/label-test'}:{})})}));}

test('公司事实的说明标签独立本地化，企业值、证据URL、日期和原事实原样展示',()=>{
 const labels=Object.fromEntries(Object.keys(COMPONENT_TRANSLATABLE_LABELS.CompanyFacts).map(key=>[key,`LABEL-${key}`]));const html=render([node('CompanyFacts',{title:'Facts',labels})]);
 for(const value of Object.values(labels))assert.ok(html.includes(value),value);for(const value of ['Original Legal Factory','Original Alias','Original Address 25','+86 12345','Manufacturer','Original Fact','Original supplied value 25 mm','Original scope','2026-11-16','2027-11-16','https://example.invalid/evidence'])assert.ok(html.includes(value));
});

test('下载、导航、位置导航、语言和空列表的覆盖真实进入SSR，旧缺省兼容',()=>{
 const html=render([node('Download',{fileUrl:'',labels:{download:'Katalog öffnen'}}),node('Navigation',{menuId:'main',labels:{navigation:'Hauptnavigation',open:'Öffnen'}}),node('Breadcrumb',{labels:{home:'Startseite',navigation:'Brotkrumen'}}),node('LanguageSwitcher',{labels:{languages:'Sprachen'}}),node('ProductList',{category:'nonmatching',count:6,columns:3,mobileColumns:1,padding:20,labels:{countSuffix:'Artikel',empty:'Keine Produkte'}}),node('ContentList',{source:'entry',labels:{empty:'Keine Inhalte'}})]);
 for(const value of ['Katalog öffnen','Hauptnavigation','Öffnen Hauptnavigation','Startseite','Brotkrumen','Sprachen','Artikel','Keine Produkte','Keine Inhalte'])assert.ok(html.includes(value),value);
 assert.equal(render([node('Download',{fileUrl:''})]),render([node('Download',{fileUrl:'',labels:{}})]));assert.equal(componentTranslatableLabels('Download').download,'Download catalog (PDF)');
});

test('动态产品详情及多图相册只换说明，产品事实、型号和图片地址保持',()=>{
 const labels=Object.fromEntries(Object.keys(COMPONENT_TRANSLATABLE_LABELS.ProductDetail).map(key=>[key,`DETAIL-${key}`])),html=render([node('ProductDetail',{productId:'product',cta:'Contact',labels})]);
 for(const key of ['collection','reference','material','contactNote','gallery','chooseImage','viewImage','thumbnail'])assert.ok(html.includes(`DETAIL-${key}`),key);for(const value of ['Original product','ORIGINAL-25','Original category','Original steel','Original supplied description','/images/chair.jpg','/images/interior.jpg'])assert.ok(html.includes(value));const empty=fixture();empty.products=[];assert.ok(render([node('ProductDetail',{labels})],empty).includes('DETAIL-unavailable'));
});

test('相册、旧版和自由面板的按钮及辅助说明都使用原生labels，表单演示选择提示可译',()=>{
 const image={id:'sample',src:'/images/chair.jpg',alt:'',caption:''};const labels=Object.fromEntries(Object.keys(COMPONENT_TRANSLATABLE_LABELS.Carousel).map(key=>[key,`CAROUSEL-${key}`]));
 const html=render([node('Gallery',{images:[image],labels:{open:'Bild öffnen',image:'Bild',close:'Schließen',closeImage:'Bild schließen'}}),node('Tabs',{items:[{id:'tab',title:'A',body:'Original content'}],labels:{sections:'Abschnitte'}}),node('Carousel',{images:[image],labels}),node('Video',{videoUrl:'',title:'Film',labels:{unavailable:'Video auswählen'}}),node('Form',{formId:'inquiry',labels:{select:'Bitte wählen'}})],fixture(),true);
 for(const value of ['Bild öffnen','Bild schließen','Schließen','Abschnitte','CAROUSEL-images','CAROUSEL-slide','CAROUSEL-controls','CAROUSEL-previous','CAROUSEL-next','CAROUSEL-previousSlide','CAROUSEL-nextSlide','Video auswählen','Bitte wählen'])assert.ok(html.includes(value),value);
 const free=render([node('Carousel',{panelMode:'free',slides:[{id:'slide',title:'Slide content',content:[node('Text',{id:'free-text',text:'Editable slide'})]}],labels}),node('Tabs',{id:'free-tabs',panelMode:'free',items:[{id:'tab',title:'Tab content',content:[node('Text',{id:'free-tab-text',text:'Editable tab'})]}],labels:{sections:'Freie Abschnitte'}})]);assert.ok(free.includes('CAROUSEL-content'));assert.ok(free.includes('CAROUSEL-next'));assert.ok(free.includes('Editable slide'));assert.ok(free.includes('Freie Abschnitte'));assert.ok(free.includes('Editable tab'));
});

test('原生草稿和发布校验仅接受known keys与有界纯文字，渲染使用React转义',()=>{
 const source=fixture(),data=source.editorData.home as Data;data.content=[node('Download',{fileUrl:'',labels:{download:'<img src=x onerror=bad>'}})];assert.doesNotThrow(()=>validateDraft(source));const html=render(data.content);assert.ok(html.includes('&lt;img src=x onerror=bad&gt;'));assert.ok(!html.includes('<img src="x"'));
 for(const invalid of [null,[],{href:'https://bad.invalid'},{download:25},{download:'x'.repeat(1001)},{download:'bad\u0000text'}]){data.content[0].props.labels=invalid;assert.throws(()=>validateDraft(source),/控件提示/);}assert.ok(componentTranslatableLabelErrors('Text',{download:'No'}).length);
});

test('后台覆盖字段使用Ant自定义控件，显示默认占位但打开不补写数据',()=>{
 const field=componentLabelsField('Download');assert.equal(field.type,'custom');let changes=0;if(field.type!=='custom')throw new Error('Ant custom field expected');const result=React.createElement(field.render,{field,name:'labels',value:undefined,onChange:()=>changes++,id:'download-labels',readOnly:false});const html=renderToStaticMarkup(React.createElement(React.Fragment,null,result));assert.ok(html.includes('控件提示文字（多语言）'));assert.equal(changes,0);
});
