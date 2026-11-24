import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Render} from '@puckeditor/core/rsc';
import {initialState} from '../src/lib/demo';
import {createPageData} from '../src/lib/page-data';
import {createSiteConfig} from '../src/lib/site-render-config';
import {productImages} from '../src/lib/product-images';
import {recordFieldValue,resolveBindingValue} from '../src/lib/content-binding';
import {compileDesignCss} from '../src/lib/responsive-style';
import {siteStructuredData} from '../src/lib/discovery';
import {resolveSitePage} from '../src/lib/site-routing';
import {createInitialDraft} from '../src/server/seed';
import {validateDraft,collectReferences} from '../src/server/validation';
import type {SiteSnapshot} from '../src/server/types';

const photos=['/images/chair.jpg','/images/studio.jpg'];
test('原生产品图兼容旧封面，显式清空不恢复旧图，返回顺序副本',()=>{
 assert.deepEqual(productImages({image:photos[0]}),[photos[0]]);
 assert.deepEqual(productImages({image:photos[0],images:[]}),[]);
 const p={image:photos[0],images:[...photos]},next=productImages(p);next.reverse();assert.deepEqual(p.images,photos);
});
test('无内容模型的产品多图严格校验、封面一致且全部加入引用保护',()=>{
 const d=createInitialDraft();assert.equal(d.contentModels?.length||0,0);validateDraft(d);
 const p=d.products[0];p.images=[...photos];p.image=photos[0];validateDraft(d);
 assert.ok(collectReferences(d).urls.has(photos[1]));
 for(const images of [[photos[0],photos[0]],['javascript:alert(1)'],Array.from({length:21},(_,i)=>`/api/media/photo${i}`),[42],null]){
  assert.throws(()=>validateDraft({...d,products:[{...p,images}]} as never));
 }
 assert.throws(()=>validateDraft({...d,products:[{...p,image:photos[1]}]}),/第一张/);
 const media={id:'native-pdf',url:'/api/media/native-pdf',name:'PDF',kind:'document',bytes:100,size:'100B',dimensions:'',folder:'',alt:''};
 assert.throws(()=>validateDraft({...d,media:[media],products:[{...p,images:[photos[0],media.url]}]} as never),/类型不符/);
});
test('原生相册SSR输出每张大图和缩略图，旧单图布局保留且无图不占位',()=>{
 const state=structuredClone(initialState),data=createPageData('blank');
 data.content=[{type:'ProductDetail',props:{id:'native-detail',productId:state.products[0].id}}];
 const context={...state,pageId:'home',editorData:{home:data}};
 const html=()=>renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig(context),data}));
 assert.doesNotMatch(html(),/editor-product-gallery-track/);
 Object.assign(state.products[0],{image:photos[0],images:[...photos]});
 const rendered=html();assert.match(rendered,/id="native-detail-photo-1"/);assert.match(rendered,/href="#native-detail-photo-1"/);assert.match(rendered,/src="\/images\/studio.jpg"/);
 Object.assign(state.products[0],{image:'',images:[]});assert.match(html(),/editor-site-detail-no-image/);
 const css=compileDesignCss('native-detail',{desktop:{imageHeight:480,objectFit:'contain'},mobile:{imageHeight:240}},'ProductDetail');
 assert.match(css,/editor-product-gallery-track img\{height:480px!important/);assert.match(css,/height:240px!important/);
});
test('无需模型可绑定原生产品首图，结构化产品资料保留完整相册',()=>{
 const state=structuredClone(initialState),p=state.products[0];p.image=photos[0];p.images=[...photos];p.status='published';
 assert.deepEqual(recordFieldValue(state,'product',p,'builtin:images').value,photos);
 assert.equal(resolveBindingValue({source:'product',mode:'fixed',recordId:p.id,field:'builtin:images'},'src',state),photos[0]);
 const snapshot={...state,schemaVersion:18,rendererVersion:18,releaseId:'native-gallery',createdAt:'',settings:{...state.settings,publicUrl:'https://factory.example.invalid'},pages:state.pages.map(p=>({...p,status:'published'}))} as SiteSnapshot;
 snapshot.editorData['product-detail']=createPageData('product');const r=resolveSitePage(snapshot,['products',p.slug||p.id])!;assert.ok(r);
 const image=()=>((siteStructuredData(snapshot,r) as {'@graph':Record<string,unknown>[]})['@graph'].find(n=>n['@type']==='Product')!).image;
 assert.deepEqual(image(),photos.map(p=>`https://factory.example.invalid${p}`));delete p.images;assert.equal(image(),`https://factory.example.invalid${photos[0]}`);
});
