import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { canReplaceAiEmptyHome, compileAiSitePlan, normalizeAiSiteBrief, normalizeAiSitePlan } from '../src/lib/ai-site-generator';
import type { AiSiteBrief, AiSitePlan } from '../src/lib/ai-builder-types';
import { AI_SITE_LAYOUTS, type AiSiteLayout, type AiSectionLayout } from '../src/lib/ai-builder-types';
import { createEmptyDraft } from '../src/server/seed';
import { collectReferences, pageTemplateErrors, validateDraft, validatePageData } from '../src/server/validation';
import { componentCompatibilityErrors } from '../src/lib/component-contract';
import { contentBindingErrors } from '../src/lib/content-binding';
import { getProductPath } from '../src/lib/content-routes';
import { siteLinkErrors } from '../src/lib/site-links';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, patchStudio } from '../src/server/studio';
import { getActiveSiteSnapshot, previewPublication, publishSite } from '../src/server/publication';
import type { DraftContent } from '../src/server/types';
import { createFormDefinition } from '../src/lib/form-content';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core';
import { createSiteConfig } from '../src/lib/site-render-config';
import { getLegacyDesign, resolveDesign } from '../src/lib/responsive-style';
import { loopParam, type QueryParams } from '../src/lib/content-query';
import { hasInvalidLoopPage } from '../src/lib/loop-pages';
import { siteMetadata } from '../src/lib/site-metadata';
import { resolveSitePage } from '../src/lib/site-routing';
import protocol from '../src/lib/protocol.json';

const brief: AiSiteBrief = { companyName: 'Example Factory', description: 'Factory information supplied by the customer.', industry: 'Industrial products', audience: 'Importers', market: 'Europe', language: 'en', styleNotes: 'Clear and restrained.' };
test('导入技术资料允许数学比较符，实际HTML与不完整脚本标签仍拒绝', () => {
  assert.match(normalizeAiSiteBrief({ ...brief, description: 'Tolerance < 0.1 mm, width > 2 mm, Count 0; enabled false.' }).description, /< 0.1 mm/);
  for (const description of ['<img src=x onerror=alert(1)>', '<script src=x', '<!-- comment -->', '<?xml test?>', '<b>Factory</b>']) assert.throws(() => normalizeAiSiteBrief({ ...brief, description }));
});
function plan(): AiSitePlan {
  return {
    summary: 'A structured company website based on the supplied business description.',
    directions: [
      { id: 'clear', name: 'Editorial', rationale: 'Explain company context before the product catalogue.', primary: '#164b55', background: '#faf8f2', text: '#162b35', headingFont: 'serif', layout: 'editorial' },
      { id: 'precise', name: 'Catalogue', rationale: 'Bring products closer to the top and use compact information groups.', primary: '#2454a8', background: '#ffffff', text: '#15202c', headingFont: 'sans', layout: 'catalog' },
      { id: 'visual', name: 'Showcase', rationale: 'Use larger centered titles and a vertical visual sequence.', primary: '#ead45c', background: '#172520', text: '#f6f6eb', headingFont: 'mono', layout: 'showcase' },
    ],
    pages: [
      { key: 'home', title: 'Home', path: '/', purpose: 'Introduce the company and connect visitors to its products.', seoTitle: 'Example Factory — Company and products', seoDescription: 'Read the customer supplied company information and explore its products.', sections: [{ kind: 'hero', heading: 'Products with a clear purpose', body: 'Company information supplied by the customer.' }, { kind: 'features', heading: 'What we do', body: 'Learn about the company.', items: [{ title: 'Product information', body: 'Explore the available product records.' }, { title: 'Speak to the team', body: 'Discuss your requirements.' }] }, { kind: 'products', heading: 'Products', body: 'Browse available products.' }] },
      { key: 'products', title: 'Products', path: '/products', purpose: 'Browse the existing products.', seoTitle: 'Product catalogue — Example Factory', seoDescription: 'Explore the available product descriptions and details.', sections: [{ kind: 'hero', heading: 'Product catalogue', body: 'Find product information in one place.' }, { kind: 'products', heading: 'Available products', body: 'Products are added by the company.' }] },
      { key: 'detail', title: 'Product information', path: '/products/:slug', purpose: 'Read the actual product record.', seoTitle: 'Product information — Example Factory', seoDescription: 'Read the information maintained in the company product record.', sections: [{ kind: 'hero', heading: 'Product information', body: 'Details are read from the current product record.' }, { kind: 'text', heading: 'Discuss requirements', body: 'Contact the company to clarify project requirements.' }] },
      { key: 'contact', title: 'Contact', path: '/contact', purpose: 'Contact the company.', seoTitle: 'Contact Example Factory', seoDescription: 'Contact Example Factory to discuss your product requirements.', sections: [{ kind: 'hero', heading: 'Start a conversation', body: 'Tell us what you need.' }, { kind: 'contact', heading: 'Contact the team', body: 'Use the available contact details.' }] },
    ],
  };
}
function nodes(value: unknown): { type: string; props: Record<string, any> }[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const node = value as { type: string; props: Record<string, any> };
  return [...(node.type && node.props ? [node] : []), ...Object.values(value).flatMap(nodes)];
}
function content(): DraftContent {
  const draft = createEmptyDraft();
  draft.settings.email = 'sales@example.test'; draft.settings.publicUrl = 'https://example.test';
  return draft;
}
function layoutPlan(layout: AiSiteLayout): AiSitePlan {
  const value = plan(), alternatives = AI_SITE_LAYOUTS.filter(item => item !== layout);
  value.directions = value.directions.map((direction, index) => ({ ...direction, id: index ? `other-${index}` : 'chosen', layout: index ? alternatives[index - 1] : layout, primary: '#164b55', background: '#faf8f2', text: '#162b35', headingFont: 'sans' }));
  return value;
}
function imageContent(): DraftContent {
  const value = content(); value.media = [{ id: 'recorded-image', name: 'Existing image', url: '/images/interior.jpg', kind: 'image', folder: '', size: '', alt: 'Company supplied visual' }]; return value;
}

/** 三行业共享配色/字体/基础区块，只有已确认目标与普通页不同，避免用颜色差异凑结构验收。 */
function industryPlan(siteType: NonNullable<AiSitePlan['intent']>['siteType']): AiSitePlan {
  const value = layoutPlan('editorial'), home = value.pages[0], contact = value.pages.find(page => page.path === '/contact')!;
  value.intent = { siteType, primaryGoal: 'Discuss the supplied business requirements', audienceTasks: ['Understand the supplied offer', 'Choose a useful next step'], constraints: ['Keep supplied business records intact'], missingFacts: ['PRIVATE_MISSING_PROOF_ONLY'] };
  home.sections = [
    { ...home.sections[0], mediaId: 'recorded-image' },
    { ...home.sections[1] },
    { kind: 'text', heading: 'Supplied company context', body: 'Only the business description supplied for this controlled example.' },
  ];
  if (siteType === 'professional-services') {
    value.pages = [home, { ...value.pages[1], key: 'services', path: '/services', title: 'Advisory services', sections: [{ kind: 'hero', heading: 'Find a useful scope', body: 'Discuss the supplied service requirements.' }, { kind: 'features', heading: 'Supplied service capabilities', body: '', items: [{ title: 'Scope discussion', body: 'Review the information provided by the client.' }, { title: 'Advisory approach', body: 'Discuss the next steps with the team.' }] }] }, contact];
    home.sections[0].cta = { label: 'Explore advisory scope', pageKey: 'services' };
  } else if (siteType === 'brand-showcase') {
    value.pages = [home, { ...value.pages[1], key: 'about', path: '/about', title: 'Brand story', sections: [{ kind: 'hero', heading: 'The supplied brand story', body: 'A visual presentation of the information supplied by this example company.' }, { kind: 'text', heading: 'Materials and everyday use', body: 'Ask the team about the actual supplied collection.', mediaId: 'recorded-image' }] }, contact];
    home.sections[0].cta = { label: 'Read the brand story', pageKey: 'about' };
  } else home.sections[0].cta = { label: 'Open the maintained catalogue', pageKey: 'products' };
  return value;
}

/** 按真实断点继承/顺序折叠单列包装，不把色、字、字号、ID或仅有边框的包装当结构差异。 */
function effectiveMobileShape(data: unknown,device:'desktop'|'tablet'|'mobile'='mobile'): unknown[] {
  const shape = (item: {type:string;props:Record<string,any>}): unknown[] => {
    const style=resolveDesign(item.props.design,device,getLegacyDesign(item.type,item.props,device));
    if(style.display==='none'||style.opacity===0)return [];
    const index=item.props.nodeLabel==='条目编号'||item.props.size===15&&item.props.maxWidth===120&&item.props.design?.desktop?.fontFamily==='mono'&&item.props.design?.desktop?.fontWeight===600;
    if(item.type!=='Container')return [{type:item.type,role:item.type==='Heading'?item.props.level:item.type==='Text'&&index?'item-index':undefined}];
    const children=(item.props.content||[]).map((child:{type:string;props:Record<string,any>},index:number)=>({child,index,style:resolveDesign(child.props.design,device,getLegacyDesign(child.type,child.props,device))})).filter((row:{style:Record<string,unknown>})=>row.style.display!=='none'&&row.style.opacity!==0).sort((a:{style:Record<string,any>;index:number},b:{style:Record<string,any>;index:number})=>Number(a.style.order||0)-Number(b.style.order||0)||a.index-b.index);
    const columns=Number(style.columns||1),expanded=children.map((row:{child:{type:string;props:Record<string,any>};style:Record<string,unknown>})=>({span:Number(row.style.columnSpan||1),children:shape(row.child)}));
    if(columns<=1||!expanded.some((row:{span:number})=>row.span<columns))return expanded.flatMap((row:{children:unknown[]})=>row.children);
    return [{type:'visible-grid',columns,children:expanded}];
  };
  return (data as {content:{type:string;props:Record<string,any>}[]}).content.filter(item=>!['AI生成品牌与页面导航','AI生成页面页脚'].includes(item.props.nodeLabel)).flatMap(shape);
}
function assertEffectiveSpans(data: unknown) {
  for(const parent of nodes(data).filter(item=>item.type==='Container'))for(const device of ['tablet','mobile'] as const){
    const columns=Number(resolveDesign(parent.props.design,device,getLegacyDesign(parent.type,parent.props,device)).columns||1);
    for(const child of parent.props.content||[]){const style=resolveDesign(child.props.design,device,getLegacyDesign(child.type,child.props,device));assert.ok(Number(style.columnSpan||1)<=columns,`${device}跨度必须落在真实${columns}列内，不能产生隐式溢出列`);}
  }
}
function mobileLeaves(item:{type:string;props:Record<string,any>},device:'desktop'|'tablet'|'mobile'='mobile'):{type:string;props:Record<string,any>}[]{
  const style=resolveDesign(item.props.design,device,getLegacyDesign(item.type,item.props,device));if(style.display==='none'||style.opacity===0)return [];
  if(item.type!=='Container')return [item];
  return [...item.props.content].map((child,index)=>({child,index,order:Number(resolveDesign(child.props.design,device,getLegacyDesign(child.type,child.props,device)).order||0)})).sort((a,b)=>a.order-b.order||a.index-b.index).flatMap(row=>mobileLeaves(row.child,device));
}

test('0.36服务三方向有图和无图均有真实手机结构，不能把桌面差异压成同一阅读流',()=>{
  for(const withImage of [false,true])for(const path of ['/','/services']){
    const shapes=new Set<string>();
    for(const layout of ['editorial','catalog','minimal'] as const){
      const current=imageContent(),value=industryPlan('professional-services');value.directions=layoutPlan(layout).directions;
      if(!withImage)for(const page of value.pages)for(const section of page.sections)delete section.mediaId;
      const result=compileAiSitePlan(value,'chosen',current),page=result.patch.pages!.find(item=>item.slug===path)!;
      shapes.add(JSON.stringify(effectiveMobileShape(result.patch.editorData![page.id])));
    }
    assert.equal(shapes.size,3,`${path}/${withImage?'有图':'无图'}：须比较最终grid/span/order，不能靠单列wrapper、颜色或换文字`);
  }
});

test('0.36制造与品牌的三方向在无图时也保留可见条目组织差异',()=>{
  for(const [siteType,layouts]of [['product-catalog',['catalog','split','minimal']],['brand-showcase',['editorial','catalog','minimal']]] as const){
    const shapes=new Set<string>();
    for(const layout of layouts){
      const value=industryPlan(siteType);value.directions=layoutPlan(layout).directions;for(const page of value.pages)for(const section of page.sections)delete section.mediaId;
      const result=compileAiSitePlan(value,'chosen',imageContent());shapes.add(JSON.stringify(effectiveMobileShape(result.patch.editorData!.home)));
    }
    assert.equal(shapes.size,3,`${siteType}不能把无图退化成三份相同手机结构`);
  }
});

test('0.36服务整段长正文无条目时只用合理阅读流，完整原文不拆或加假索引凑三向',()=>{
  const shapes=new Set<string>();
  for(const layout of ['editorial','minimal','bento'] as const){
    const value=industryPlan('professional-services');value.directions=layoutPlan(layout).directions;
    value.pages[1].sections=[{kind:'hero',heading:'Supplied service scope',body:'Read the supplied service context.',cta:{label:'Discuss supplied scope',pageKey:'contact'}},...Array.from({length:3},(_,index)=>({kind:'text' as const,heading:`Supplied scope ${index+1}`,body:(`Unchanged service paragraph ${index+1}. `+'Long original supplied information remains complete. '.repeat(12)).trim()}))];
    const result=compileAiSitePlan(value,'chosen',imageContent()),page=result.patch.pages!.find(item=>item.slug==='/services')!,data=result.patch.editorData![page.id];
    shapes.add(JSON.stringify(effectiveMobileShape(data)));
    for(const section of value.pages[1].sections){assert.equal(nodes(data).filter(node=>node.props.text===section.heading).length,1);assert.equal(nodes(data).filter(node=>node.props.text===section.body).length,1);}
    assert.ok(!nodes(data).some(node=>node.type==='Text'&&/^\d{2}$/.test(String(node.props.text))));
  }
  assert.ok(shapes.size>=2,'资料不足时保留两种合理阅读流，不为三向差异造编号、拆长文或加空包装');
});

test('0.36手机catalog的编号正文同行，minimal标题编号同行而正文通栏，不改源条目内容',()=>{
  for(const layout of ['catalog','minimal'] as const){
    const value=industryPlan('professional-services');value.directions=layoutPlan(layout).directions;
    const section=value.pages[0].sections[1],result=compileAiSitePlan(value,'chosen',imageContent()),data=result.patch.editorData!.home;
    const title=nodes(data).find(node=>node.type==='Heading'&&node.props.text===section.items![0].title)!,body=nodes(data).find(node=>node.type==='Text'&&node.props.text===section.items![0].body)!;
    const card=nodes(data).find(node=>node.type==='Container'&&(node.props.content||[]).some((child:{type:string;props:Record<string,unknown>})=>child.type==='Text'&&child.props.text==='01'))!;
    const cardStyle=resolveDesign(card.props.design,'mobile',getLegacyDesign('Container',card.props,'mobile'));assert.equal(cardStyle.columns,8);
    if(layout==='catalog'){
      const copyGroup=card.props.content.find((child:{type:string})=>child.type==='Container');assert.ok(copyGroup);assert.equal(copyGroup.props.design.mobile.columnSpan,7);
      assert.ok(nodes(copyGroup).includes(title));assert.ok(nodes(copyGroup).includes(body));
    }else{
      assert.ok(card.props.content.includes(title));assert.ok(card.props.content.includes(body));assert.equal(title.props.design.mobile.columnSpan,7);assert.equal(body.props.design.mobile.columnSpan,8);
    }
    for(const item of section.items!)for(const text of [item.title,item.body])assert.equal(nodes(data).filter(node=>node.props.text===text).length,1);
    assertEffectiveSpans(data);assert.doesNotThrow(()=>validateDraft({...imageContent(),...result.patch}));
  }
});

test('0.36服务和制造minimal首CTA在图前，标题仍优先；品牌可保视觉先行',()=>{
  for(const siteType of ['professional-services','product-catalog','brand-showcase'] as const){
    const value=industryPlan(siteType);value.directions=layoutPlan('minimal').directions;
    const result=compileAiSitePlan(value,'chosen',imageContent()),hero=nodes(result.patch.editorData!.home).find(node=>node.props.nodeLabel===value.pages[0].sections[0].heading)!,flow=mobileLeaves(hero);
    const h=flow.findIndex(node=>node.type==='Heading'&&node.props.level==='h1'),cta=flow.findIndex(node=>node.type==='ActionButton'),image=flow.findIndex(node=>node.type==='Image'),body=flow.findIndex(node=>node.type==='Text'&&node.props.text===value.pages[0].sections[0].body);
    assert.equal(h,0);assert.ok(image>=0&&cta>=0&&body>=0);
    if(siteType!=='brand-showcase'){assert.ok(cta<image&&image<body,'采购/服务行动不能再次被图片和长说明推后');}else assert.ok(image<cta,'品牌可先看真实场景图');
    const target=result.patch.pages!.find(page=>page.id===flow[cta].props.linkTarget.id);assert.ok(target);assert.equal(flow[cta].props.href,target.slug);
  }
});

test('0.36手机双列仅用于真短条目，长文保持通栏且全部原文保留',()=>{
  const value=industryPlan('professional-services');value.directions=layoutPlan('split').directions;
  value.pages[0].sections[1].items=[{title:'Brief',body:'Supplied scope.'},{title:'International support services',body:'Long supplied service information. '.repeat(20).trim()}];
  const result=compileAiSitePlan(value,'chosen',imageContent()),data=result.patch.editorData!.home;
  const list=nodes(data).find(node=>node.type==='Container'&&node.props.content?.length===2&&node.props.content.every((child:{type:string})=>child.type==='Container')&&node.props.content.every((child:unknown)=>nodes(child).some(n=>n.type==='Heading'&&n.props.level==='h3')))!;
  assert.equal(list.props.design.mobile.columns,2);assert.equal(list.props.content[0].props.design.mobile.columnSpan,1);assert.equal(list.props.content[1].props.design.mobile.columnSpan,2);
  const longBody=nodes(list.props.content[1]).find(node=>node.type==='Text'&&node.props.text===value.pages[0].sections[1].items![1].body)!;assert.equal(longBody.props.design.mobile.columnSpan,8);
  for(const item of value.pages[0].sections[1].items!)for(const text of [item.title,item.body])assert.equal(nodes(data).filter(node=>node.props.text===text).length,1);
  assertEffectiveSpans(data);assert.doesNotThrow(()=>validateDraft({...imageContent(),...result.patch}));
});

test('0.36旧无intent与显式local布局不进入auto手机策略，动态产品字段和原CTA继续保留',()=>{
  for(const layout of AI_SITE_LAYOUTS){
    const legacy=compileAiSitePlan(layoutPlan(layout),'chosen',imageContent());assert.ok(!nodes(legacy.patch.editorData).some(node=>node.props.design?.mobile?.columns===8));
    const value=industryPlan('product-catalog');value.directions=layoutPlan(layout).directions;value.pages[0].sections[1].layout='cards';
    const productSection=value.pages.find(page=>page.path==='/products')!.sections.find(section=>section.kind==='products')!;productSection.cta={label:'Discuss a real product',pageKey:'contact'};
    const result=compileAiSitePlan(value,'chosen',imageContent()),section=nodes(result.patch.editorData!.home).find(node=>node.props.nodeLabel===value.pages[0].sections[1].heading)!;
    assert.ok(!nodes(section).some(node=>node.props.design?.mobile?.columns===8),'用户显式cards不能被整站方向改为编号轨');
    for(const list of nodes(result.patch.editorData).filter(node=>node.type==='ContentList')){assert.equal(list.props.descriptionField,'builtin:description');assert.equal(list.props.mobileColumns,1);}
    const cta=nodes(result.patch.editorData).find(node=>node.type==='ActionButton'&&node.props.text==='Discuss a real product')!;assert.ok(cta);assert.equal(result.patch.pages!.find(page=>page.id===cta.props.linkTarget.id)!.slug,'/contact');
  }
});

test('0.36真实两位数字正文不是资料索引，不改变原正文角色或产生桌面隐式跨列',()=>{
  assert.deepEqual(effectiveMobileShape({content:[{type:'Text',props:{text:'25',size:17}}]}),[{type:'Text',role:undefined}]);
  for(const layout of ['catalog','minimal','bento','showcase'] as const){
    const value=industryPlan('brand-showcase');value.directions=layoutPlan(layout).directions;value.pages[0].sections[1].items=[{title:'Recorded value',body:'25'}];
    const result=compileAiSitePlan(value,'chosen',imageContent()),data=result.patch.editorData!.home;
    const title=nodes(data).find(node=>node.type==='Heading'&&node.props.text==='Recorded value')!,body=nodes(data).find(node=>node.type==='Text'&&node.props.text==='25')!;
    assert.equal(nodes(data).filter(node=>node.type==='Text'&&node.props.text==='25').length,1);assert.ok(nodes(data).some(node=>node.type==='Text'&&node.props.text==='01'),'资料索引必须来自条目位置，不得借正文业务数字冒充');
    assert.equal(nodes(data).find(node=>node.type==='Text'&&node.props.text==='01')!.props.nodeLabel,'条目编号');assert.notEqual(body.props.nodeLabel,'条目编号');
    assert.equal(body.props.size,17);assert.equal(title.props.design.desktop.columnSpan,undefined);
    assertEffectiveSpans(data);assert.doesNotThrow(()=>validateDraft({...imageContent(),...result.patch}));
  }
});

test('0.36留存制造方案整页有图时minimal手机为标题图说明，catalog保标题说明图，桌面和显式选择不变',()=>{
  const supplied=JSON.parse(readFileSync(resolve('tests/fixtures/ai-quality-plans.json'),'utf8')).find((value:{id:string})=>value.id==='manufacturing') as {plan:AiSitePlan;products:DraftContent['products'];media:DraftContent['media']};
  const current={...content(),products:supplied.products,media:supplied.media},source=structuredClone(current),plan=supplied.plan;
  const target=plan.pages.find(page=>page.path==='/')!.sections.find(section=>section.kind==='text'&&section.mediaId)!,shapes=new Set<string>();
  for(const direction of plan.directions){
    const result=compileAiSitePlan(plan,direction.id,current),data=result.patch.editorData!.home;shapes.add(JSON.stringify(effectiveMobileShape(data)));
    if(!['catalog','minimal'].includes(direction.layout))continue;
    const section=nodes(data).find(node=>node.props.nodeLabel===target.heading)!,flow=mobileLeaves(section),desktop=mobileLeaves(section,'desktop');
    const imageIndex=flow.findIndex(node=>node.type==='Image'),bodyIndex=flow.findIndex(node=>node.props.text===target.body),headingIndex=flow.findIndex(node=>node.props.text===target.heading);
    assert.ok(headingIndex<imageIndex&&headingIndex<bodyIndex);
    if(direction.layout==='minimal'){assert.ok(imageIndex<bodyIndex,'minimal必须通过已有真实图的手机顺序形成差异');assert.equal(flow[imageIndex].props.design.mobile.height,200);}else assert.ok(bodyIndex<imageIndex);
    assert.ok(desktop.findIndex(node=>node.props.text===target.body)<desktop.findIndex(node=>node.type==='Image'),'桌面仍说明后配图');
    assert.equal(nodes(section).filter(node=>node.props.text===target.body).length,1);assert.equal(nodes(section).filter(node=>node.type==='Image').length,1);
    const original=current.media.find(media=>media.id===target.mediaId)!;assert.equal(flow[imageIndex].props.src,original.url);assert.equal(flow[imageIndex].props.alt,original.alt||target.heading);
    if(direction.layout==='minimal'){
      const explicit=structuredClone(plan);explicit.pages.find(page=>page.path==='/')!.sections.find(section=>section.heading===target.heading)!.layout='cards';
      const explicitResult=compileAiSitePlan(explicit,direction.id,current),explicitSection=nodes(explicitResult.patch.editorData!.home).find(node=>node.props.nodeLabel===target.heading)!,explicitFlow=mobileLeaves(explicitSection);
      assert.ok(explicitFlow.findIndex(node=>node.props.text===target.body)<explicitFlow.findIndex(node=>node.type==='Image'),'显式cards不受auto规则改动');
    }
  }
  assert.equal(shapes.size,3,'例外只限材料不足的局部，真实整页有图不能仍两向同构');assert.deepEqual(current,source);
});

test('0.37同一份服务内容在普通内页形成真实选择双区，首页仍保036而非换色复用首页树',()=>{
  const value=industryPlan('professional-services');value.pages[1].sections=structuredClone(value.pages[0].sections);
  const current=imageContent(),source=structuredClone(current),result=compileAiSitePlan(value,'chosen',current),next={...current,...result.patch},inner=next.pages.find(page=>page.slug==='/services')!,home=next.editorData.home,data=next.editorData[inner.id];
  assert.notDeepEqual(effectiveMobileShape(data,'desktop'),effectiveMobileShape(home,'desktop'),'同内容必须产生内页实际桌面结构，不能仅改名字/颜色');
  assert.notDeepEqual(effectiveMobileShape(data),effectiveMobileShape(home),'手机服务选择条目也需有真实分组差别');
  const feature=nodes(data).find(node=>node.props.nodeLabel===value.pages[1].sections[1].heading)!;assert.equal(feature.props.columns,3);assert.ok(feature.props.content.some((node:{props:Record<string,any>})=>node.props.design?.desktop?.columnSpan===2));
  for(const section of value.pages[1].sections)for(const text of [section.heading,section.body,...(section.items||[]).flatMap(item=>[item.title,item.body])].filter(Boolean))assert.equal(nodes(data).filter(node=>node.props.text===text).length,1);
  assert.equal(nodes(data).filter(node=>node.type==='Heading'&&node.props.level==='h1').length,1);assertEffectiveSpans(data);assert.doesNotThrow(()=>validateDraft(next));assert.deepEqual(current,source);
});

test('0.37目录说明与真实动态列表形成宽窄区，手机单列保全文和稳定CTA，长标题有完整宽度',()=>{
  const value=industryPlan('product-catalog');value.directions=layoutPlan('catalog').directions;
  value.pages[1].sections[0].heading='Furniture components with a supplied reference';value.pages[1].sections[1].cta={label:'Discuss a supplied requirement',pageKey:'contact'};
  const result=compileAiSitePlan(value,'chosen',imageContent(),'new-inner'),page=result.patch.pages!.find(page=>page.slug==='/new-inner/products')!,data=result.patch.editorData![page.id],section=nodes(data).find(node=>node.props.nodeLabel===value.pages[1].sections[1].heading)!;
  assert.equal(section.props.columns,4);const list=nodes(section).find(node=>node.type==='ContentLoop')!;assert.equal(list.props.design.desktop.columnSpan,3);assert.equal(list.props.mobileColumns,1);assert.equal(nodes(section).filter(node=>node.type==='ContentLoop').length,1);
  const card=result.patch.sharedBlocks!.find(block=>block.id===list.props.itemBlockId)!;
  assert.ok(nodes(card.data).some(node=>node.props.bindings?.text?.field==='builtin:description'));
  const title=nodes(data).find(node=>node.type==='Heading'&&node.props.level==='h1')!;assert.equal(title.props.design.desktop.columnSpan,3);assert.ok(title.props.size<=52);
  const action=nodes(section).find(node=>node.type==='ActionButton')!;assert.equal(action.props.href,'/new-inner/contact');assert.equal(result.patch.pages!.find(page=>page.id===action.props.linkTarget.id)!.slug,'/new-inner/contact');assertEffectiveSpans(data);
});

test('0.37已规划案例式普通页用整段限宽正文与原图，不捏造案例记录/指标；联系页用真实Form双区',()=>{
  const value=industryPlan('brand-showcase');value.pages[1]={...value.pages[1],key:'case-story',path:'/case-story',title:'Supplied demonstration',sections:[{kind:'hero',heading:'A supplied demonstration story',body:'Fictional illustrative story; no client outcome is claimed.',mediaId:'recorded-image'},{kind:'text',heading:'Supplied context',body:'The whole supplied narrative remains editable without invented metrics.',mediaId:'recorded-image'}]};value.pages[0].sections[0].cta={label:'Read the supplied story',pageKey:'case-story'};
  const result=compileAiSitePlan(value,'chosen',imageContent()),page=result.patch.pages!.find(page=>page.slug==='/case-story')!,data=result.patch.editorData![page.id],body=nodes(data).find(node=>node.type==='Text'&&node.props.text===value.pages[1].sections[1].body)!;
  assert.equal(body.props.maxWidth,760);assert.equal(nodes(data).filter(node=>node.type==='Image').length,2);assert.equal(result.patch.contentEntries,undefined);assert.equal(result.patch.contentModels,undefined);assert.ok(!nodes(data).some(node=>['ProductDetail','ContentList','ContentLoop'].includes(node.type)));
  const contact=result.patch.pages!.find(page=>page.slug==='/contact')!,contactData=result.patch.editorData![contact.id],form=nodes(contactData).find(node=>node.type==='Form')!,contactSection=nodes(contactData).find(node=>node.props.nodeLabel===value.pages.find(page=>page.path==='/contact')!.sections[1].heading)!;
  assert.equal(contactSection.props.columns,3);assert.equal(form.props.design.desktop.columnSpan,2);assert.equal(form.props.formId,result.patch.forms![0].id);assert.ok(result.patch.forms![0].fields.some(field=>field.mapTo==='email'&&field.label));assertEffectiveSpans(contactData);
});

test('0.37详情按选型/概览/图片任务选择原生模式，旧无intent与显式局部选择保identity合同',()=>{
  for(const siteType of ['product-catalog','brand-showcase'] as const)for(const layout of AI_SITE_LAYOUTS){
    const value=layoutPlan(layout);value.intent={siteType,primaryGoal:'Read supplied records',audienceTasks:['Choose the next step'],constraints:[],missingFacts:[]};
    const result=compileAiSitePlan(value,'chosen',imageContent()),detail=result.patch.pages!.find(page=>page.slug==='/products/:slug')!,node=nodes(result.patch.editorData![detail.id]).find(node=>node.type==='ProductDetail')!;
    const expected=siteType==='product-catalog'&&['catalog','minimal'].includes(layout)?'specifications-first':['editorial','split'].includes(layout)&&siteType==='product-catalog'||layout==='editorial'&&siteType==='brand-showcase'?'overview-first':'identity-first';
    assert.equal(node.props.mobileOrder,expected);if(expected!=='identity-first')assert.equal(node.props.layout,'split');assert.ok(node.props.linkTarget?.id);
    value.pages.find(page=>page.path==='/products/:slug')!.sections[0].layout='cards';const explicit=compileAiSitePlan(value,'chosen',imageContent());assert.equal(nodes(explicit.patch.editorData).find(node=>node.type==='ProductDetail')!.props.mobileOrder,'identity-first');
    delete value.intent;const legacy=compileAiSitePlan(value,'chosen',imageContent());assert.equal(nodes(legacy.patch.editorData).find(node=>node.type==='ProductDetail')!.props.mobileOrder,'identity-first');
  }
});

test('0.37同一内页角色的布局家族由真实宽度和分组区分，功能区DOM保持导读在链接表单前',()=>{
  for(const role of ['catalogue','services','narrative','contact'] as const){
    const shapes=new Set<string>();
    for(const layout of role==='contact'?['editorial','minimal','split'] as const:['editorial','catalog','minimal'] as const){
      const value=industryPlan(role==='catalogue'?'product-catalog':role==='services'?'professional-services':'brand-showcase');value.directions=layoutPlan(layout).directions;
      const result=compileAiSitePlan(value,'chosen',imageContent()),path=role==='catalogue'?'/products':role==='services'?'/services':role==='contact'?'/contact':'/about',page=result.patch.pages!.find(page=>page.slug===path)!,data=result.patch.editorData![page.id];
      shapes.add(JSON.stringify(effectiveMobileShape(data,'desktop')));assertEffectiveSpans(data);
      for(const section of (data as {content:{type:string;props:Record<string,any>}[]}).content){
        const children=section.props.content||[],functional=children.findIndex((child:unknown)=>nodes(child).some(node=>['Form','ContentList','ContentLoop'].includes(node.type)));
        if(functional>=0)assert.ok(children.slice(0,functional).some((child:unknown)=>nodes(child).some(node=>node.type==='Heading')),'真实字段/产品链接之前保留本区标题，不能只靠CSS手机重排弥补DOM反序');
      }
    }
    assert.equal(shapes.size,3,`${role}的三家族不能仅换颜色或文字`);
  }
});

test('0.35保留家居真实标题在catalog配图栏中有足够排版宽度与字号预算', () => {
  // 复用0.34真实供稿的断词标题；测试不依赖未随源码发行的work私有记录。
  const value = industryPlan('brand-showcase'); value.directions = layoutPlan('catalog').directions; value.directions[0].headingFont = 'serif';
  value.pages[0].sections[0].heading = 'Furniture for quiet everyday spaces';
  const result = compileAiSitePlan(value, 'chosen', imageContent()), data = result.patch.editorData!.home;
  const hero = nodes(data).find(item => item.props.nodeLabel === value.pages[0].sections[0].heading)!, title = nodes(hero).find(item => item.type === 'Heading' && item.props.level === 'h1')!;
  const intro = hero.props.content.find((item: unknown) => nodes(item).some(node => node.props.id === title.props.id));
  const fraction = Number(intro.props.design?.desktop?.columnSpan || 1) / hero.props.columns;
  const style = resolveDesign(title.props.design, 'desktop', getLegacyDesign('Heading', title.props, 'desktop'));
  assert.ok(fraction >= 0.5 && Number(style.fontSize) <= 56, `真实76px标题曾被塞进1/3栏：当前宽度${fraction}、字号${style.fontSize}`);
  assert.equal(title.props.text, value.pages[0].sections[0].heading); assert.equal(nodes(hero).filter(item => item.type === 'Image').length, 1);
  assert.doesNotThrow(() => validateDraft({ ...imageContent(), ...result.patch }));
});

test('0.35三行业hero标题正文按钮的实际手机留白统一20，不叠加legacy24px', () => {
  const samples = [['product-catalog','catalog'],['professional-services','editorial'],['professional-services','bento'],['brand-showcase','editorial'],['brand-showcase','catalog'],['brand-showcase','minimal']] as const;
  for (const [siteType,layout] of samples) {
    const value = industryPlan(siteType); value.directions = layoutPlan(layout).directions;
    const result = compileAiSitePlan(value, 'chosen', imageContent()), hero = nodes(result.patch.editorData!.home).find(item => item.props.nodeLabel === value.pages[0].sections[0].heading)!;
    const pathTo = (item: { type: string; props: Record<string, any> }, text: string, ancestors: { type: string; props: Record<string, any> }[] = []): typeof ancestors | undefined => {
      const path = [...ancestors,item]; if (item.props.text === text) return path;
      for (const child of item.props.content || []) { const found = pathTo(child,text,path); if (found) return found; }
    };
    for (const text of [value.pages[0].sections[0].heading,value.pages[0].sections[0].body,value.pages[0].sections[0].cta!.label]) {
      const path = pathTo(hero,text)!; assert.ok(path, `${siteType}/${layout}: 真实文字或CTA保留`);
      for (const side of ['paddingLeft','paddingRight'] as const) {
        const total = path.filter(item => item.type === 'Container').reduce((sum,item) => sum + Number(resolveDesign(item.props.design,'mobile',getLegacyDesign('Container',item.props,'mobile'))[side] || 0),0);
        assert.equal(total,20, `${siteType}/${layout}/${side}: 不能让内层默认24px把20变成44/68`);
      }
    }
  }
});

test('0.35统一内层留白时页眉页脚仍有外边距，装饰卡片仍有自己的可读内边距', () => {
  for (const layout of AI_SITE_LAYOUTS) {
    const current = imageContent(), result = compileAiSitePlan(layoutPlan(layout),'chosen',current), generated = nodes(result.patch.editorData!.home);
    const chrome = nodes(result.patch.sharedBlocks);
    for (const label of ['AI生成品牌与页面导航','AI生成页面页脚']) {
      const root = chrome.find(item => item.props.nodeLabel === label)!;
      const style = resolveDesign(root.props.design,'mobile',getLegacyDesign('Container',root.props,'mobile'));
      assert.equal(style.paddingLeft,20); assert.equal(style.paddingRight,20);
    }
    const navigation = chrome.find(item => item.type === 'Navigation')!;
    assert.equal(resolveDesign(navigation.props.design,'mobile',getLegacyDesign('Navigation',navigation.props,'mobile')).paddingLeft || 0,0);
    const cards = generated.filter(item => item.type === 'Container' && item.props.design?.desktop?.borderWidth === 1 && item.props.content?.some((child: {type:string;props:Record<string,unknown>}) => child.type === 'Heading' && child.props.level === 'h3'));
    for (const card of cards) {
      const style = resolveDesign(card.props.design,'mobile',getLegacyDesign('Container',card.props,'mobile'));
      assert.ok(Number(style.paddingLeft) >= 16 && Number(style.paddingRight) >= 16,'卡片边框内文字不能因为归零修复而贴边');
    }
  }
});

test('0.35详情先呈现唯一真实动态产品，原通用hero作为紧凑次要说明保留且SSR只有一个h1', () => {
  for (const layout of AI_SITE_LAYOUTS) for (const withIntent of [false,true]) {
    const current = imageContent(), value = layoutPlan(layout);
    if (withIntent) value.intent = { siteType:'product-catalog',primaryGoal:'Identify the maintained product',audienceTasks:['Read its true reference'],constraints:[],missingFacts:[] };
    current.products = [{ id:'actual-product',sku:'REAL-REF-01',name:'Maintained product identity',category:'Components',material:'Only supplied material',description:'Only supplied product facts.',image:'/images/interior.jpg',status:'draft' }];
    const source = structuredClone(current), result = compileAiSitePlan(value,'chosen',current), next = { ...current,...result.patch }, detail = next.pages.find(page => page.slug === '/products/:slug')!, data = next.editorData[detail.id], rendered = nodes(data), generic = value.pages.find(page => page.path === '/products/:slug')!.sections[0];
    const product = rendered.findIndex(item => item.type === 'ProductDetail'), explanation = rendered.findIndex(item => item.type === 'Heading' && item.props.text === generic.heading);
    assert.ok(product >= 0 && product < explanation, `${layout}: 采购先识别实际商品，不能先读通用介绍`);
    const title = rendered[explanation]; assert.equal(title.props.level,'h2'); assert.ok(title.props.size <= 32 && title.props.mobileSize <= 28);
    assert.equal(rendered.filter(item => item.type === 'ProductDetail').length,1);
    assert.equal(rendered.filter(item => item.props.text === generic.heading).length,1); assert.equal(rendered.filter(item => item.props.text === generic.body).length,1);
    assert.ok(!rendered.some(item => item.props.text === current.products[0].name || item.props.text === current.products[0].sku));
    // 与真实私有候选snapshot一致：仅渲染投影标为published，原草稿和产品状态不变。
    const html = renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({ ...next,products:next.products.map(product => ({ ...product,status:'published' as const })),pageId:detail.id,previewProductId:'actual-product' }),data:data as never}));
    assert.equal((html.match(/<h1(?:\s|>)/g) || []).length,1); assert.ok(html.indexOf(current.products[0].name) < html.indexOf(generic.heading));
    assert.deepEqual(current,source); assert.doesNotThrow(() => validateDraft(next)); assert.deepEqual(componentCompatibilityErrors(data),[]);
  }
});

test('0.35固定根详情与未激活模板都明确询盘目标，不串到已有旧Contact页', () => {
  for (const hasExistingDetail of [false,true]) {
    const base = imageContent();
    base.products = [{ id:'actual-product',sku:'REAL-REF-01',name:'Maintained product identity',category:'Components',material:'Supplied material',description:'Supplied product facts.',image:'/images/interior.jpg',status:'draft' }];
    const current = hasExistingDetail ? { ...base,...compileAiSitePlan(plan(),'clear',base).patch } : base;
    if (!hasExistingDetail) {
      current.pages.push({ id:'contact',title:'Legacy contact',slug:'/contact',type:'普通页面',status:'draft',updated:new Date().toISOString() });
      current.editorData.contact = { root:{props:{title:'Legacy contact'}},content:[] };
    }
    const before = structuredClone(current), result = compileAiSitePlan(plan(),'clear',current,'ai-site'), next = { ...current,...result.patch };
    const contact = next.pages.find(page => page.slug === '/ai-site/contact')!, detail = next.pages.find(page => page.slug === '/products/:slug')!;
    const data = hasExistingDetail ? next.pageTemplates!.at(-1)!.data : next.editorData[detail.id];
    const product = nodes(data).find(node => node.type === 'ProductDetail')!;
    assert.deepEqual(product.props.linkTarget,{kind:'page',id:contact.id});
    assert.equal(detail.slug,'/products/:slug'); assert.ok(!next.pages.some(page => page.slug === '/ai-site/products/:slug'));
    // 预览与上线都从同一显式页面引用解析；真实详情根路径不能推断本次新站目录。
    for (const previewPrefix of ['', '/api/ai/build/previews/test-token']) {
      const html = renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({ ...next,products:next.products.map(item => ({...item,status:'published' as const})),pageId:detail.id,previewProductId:'actual-product',previewPrefix }),data:data as never}));
      const identity = html.split('editor-site-detail-identity\"')[1]!.split('editor-site-detail-body')[0];
      assert.ok(identity.includes(`href=\"${previewPrefix}/ai-site/contact\"`),'产品询盘必须指向本次生成联系页且支持真实预览前缀');
      assert.ok(!identity.includes(`href=\"${previewPrefix}/contact\"`),'不能误选旧Contact页');
    }
    assert.deepEqual(current,before); assert.deepEqual(siteLinkErrors(next),[]); assert.doesNotThrow(() => validateDraft(next));
    if (hasExistingDetail) assert.deepEqual(next.editorData[detail.id],before.editorData[detail.id]);
  }
});

test('行业意图让零产品服务站和品牌站生成三页，不强塞产品路由或空目录提示', () => {
  for (const siteType of ['professional-services', 'brand-showcase'] as const) {
    const current = imageContent(), source = structuredClone(current), value = industryPlan(siteType);
    assert.doesNotThrow(() => normalizeAiSitePlan(value, brief));
    const result = compileAiSitePlan(value, 'chosen', current), next = { ...current, ...result.patch };
    assert.equal(next.pages.length, 3); assert.equal(next.pages.some(page => page.slug.startsWith('/products')), false);
    assert.equal(nodes(next.editorData).some(node => ['ProductDetail', 'ContentList', 'ContentLoop', 'ProductList'].includes(node.type)), false);
    assert.equal(result.seoIssues.some(issue => issue.code === 'missing-products'), false);
    assert.equal(result.warnings.some(warning => warning.includes('产品目录为空')), false);
    assert.ok(result.warnings.some(warning => warning.includes('PRIVATE_MISSING_PROOF_ONLY')));
    assert.ok(!JSON.stringify(next.editorData).includes('PRIVATE_MISSING_PROOF_ONLY'));
    for (const page of next.pages) assert.equal(nodes(next.editorData[page.id]).filter(node => node.type === 'Heading' && node.props.level === 'h1').length, 1);
    assert.deepEqual(current, source); assert.deepEqual(next.products, source.products); assert.deepEqual(siteLinkErrors(next), []); assert.doesNotThrow(() => validateDraft(next));
  }
});

test('同色同字体同方向的制造、服务和家居品牌首页具有不同真实编排及显式手机回流', () => {
  const signatures = new Set<string>();
  for (const siteType of ['product-catalog', 'professional-services', 'brand-showcase'] as const) {
    const current = imageContent(), result = compileAiSitePlan(industryPlan(siteType), 'chosen', current), data = result.patch.editorData!.home, rendered = nodes(data);
    signatures.add(JSON.stringify(rendered.map(node => ({ type: node.type, columns: node.props.columns, layout: node.props.layout, span: node.props.design?.desktop?.columnSpan, size: node.props.size, children: node.props.content?.map((child: { type: string }) => child.type) }))));
    const hero = rendered.find(node => node.props.nodeLabel === 'Products with a clear purpose')!;
    assert.equal(hero.props.design.mobile.columns, 1);
    for (const node of rendered.filter(node => Number(node.props.design?.desktop?.columnSpan || 1) > 1)) assert.equal(node.props.design.mobile.columnSpan, 1);
    assert.doesNotThrow(() => validateDraft({ ...current, ...result.patch })); assert.deepEqual(componentCompatibilityErrors(data), []);
  }
  assert.equal(signatures.size, 3, '行业差异必须进入Puck树，不能只体现在文字、主题或说明');
});

test('行业CTA只沿已规划普通页稳定key解析，前缀预览与真实链接保持一致', () => {
  const current = imageContent(), value = industryPlan('professional-services'), result = compileAiSitePlan(value, 'chosen', current, 'new-advisory'), next = { ...current, ...result.patch };
  const target = next.pages.find(page => page.slug === '/new-advisory/services')!, action = nodes(next.editorData).find(node => node.type === 'ActionButton' && node.props.text === 'Explore advisory scope')!;
  assert.equal(action.props.href, '/new-advisory/services'); assert.deepEqual(action.props.linkTarget, { kind: 'page', id: target.id });
  assert.ok(!nodes(next.editorData).some(node => node.type === 'ActionButton' && String(node.props.href).includes('/products')));
  for (const pageKey of ['unknown-page', 'detail']) { const invalid = industryPlan('product-catalog'); invalid.pages[0].sections[0].cta = { label: 'Supplied next step', pageKey }; assert.throws(() => normalizeAiSitePlan(invalid, brief), /行动按钮|普通页/); }
  const invalid = industryPlan('professional-services'); (invalid.pages[0].sections[0].cta as unknown as Record<string, unknown>).href = 'https://unreviewed.example.test/'; assert.throws(() => normalizeAiSitePlan(invalid, brief), /未知字段/);
});

test('服务和品牌各六种方向保持不同原生槽位、事实原文与发布级兼容，手机跨度服从有效网格', () => {
  for (const siteType of ['professional-services', 'brand-showcase'] as const) {
    const signatures = new Set<string>();
    for (const layout of AI_SITE_LAYOUTS) {
      const current = imageContent(), value = industryPlan(siteType); value.directions = layoutPlan(layout).directions;
      const source = structuredClone(current), result = compileAiSitePlan(value, 'chosen', current), next = { ...current, ...result.patch }, data = next.editorData.home, rendered = nodes(data);
      // 相同素材/字体/配色，排除文字、ID与字号后仍能区分六种编排。
      signatures.add(JSON.stringify(rendered.map(node => ({ type: node.type, columns: node.props.columns, layout: node.props.layout, span: node.props.design?.desktop?.columnSpan, children: node.props.content?.map((child: { type: string }) => child.type) }))));
      for (const section of value.pages[0].sections) for (const text of [section.heading, section.body, ...(section.items || []).flatMap(item => [item.title, item.body])].filter(Boolean)) assert.equal(rendered.filter(node => node.props.text === text).length, 1, `${siteType}/${layout}: ${text}`);
      assert.equal(rendered.filter(node => node.type === 'Image').length, 1);
      assertEffectiveSpans(data);
      for (const page of next.pages) { assert.doesNotThrow(() => validatePageData(next.editorData[page.id], page.title, true)); assert.deepEqual(componentCompatibilityErrors(next.editorData[page.id]), []); }
      assert.doesNotThrow(() => validateDraft(next)); assert.deepEqual(siteLinkErrors(next), []); assert.deepEqual(contentBindingErrors(next, true), []); assert.deepEqual(current, source);
    }
    assert.equal(signatures.size, 6, siteType);
  }
});

test('行业自动编排缺图时仅用真实文字，局部左右布局仍优先于行业默认', () => {
  for (const siteType of ['professional-services', 'brand-showcase'] as const) {
    const current = imageContent(), value = industryPlan(siteType), hero = value.pages[0].sections[0]; delete hero.mediaId;
    const noImage = compileAiSitePlan(value, 'chosen', current);
    assert.equal(nodes(noImage.patch.editorData!.home).some(node => node.type === 'Image'), false);
    assert.deepEqual([...collectReferences({ ...current, ...noImage.patch }).urls], siteType === 'brand-showcase' ? ['/images/interior.jpg'] : []);
    assert.doesNotThrow(() => validateDraft({ ...current, ...noImage.patch }));
    hero.mediaId = 'recorded-image'; hero.layout = 'split-right';
    const explicit = compileAiSitePlan(value, 'chosen', current), section = nodes(explicit.patch.editorData!.home).find(node => node.props.nodeLabel === hero.heading)!;
    assert.equal(section.props.columns, 3); assert.equal(section.props.content[1].type, 'Image');
    assert.deepEqual(section.props.content.map((node: { props: Record<string, any> }) => node.props.design.desktop.columnSpan), [2, 1]);
    assert.doesNotThrow(() => validateDraft({ ...current, ...explicit.patch }));
  }
});

test('行业目标严格校验且仅私有记录约束和缺口，服务不能夹带假产品子页', () => {
  const invalids: AiSitePlan[] = [];
  const noTasks = industryPlan('professional-services'); noTasks.intent!.audienceTasks = []; invalids.push(noTasks);
  const extraFact = industryPlan('brand-showcase'); (extraFact.intent as unknown as Record<string, unknown>).certification = 'Unsupported claim'; invalids.push(extraFact);
  const script = industryPlan('professional-services'); script.intent!.missingFacts = ['<script>alert(1)</script>']; invalids.push(script);
  const implicitProduct = industryPlan('professional-services'); implicitProduct.pages.push({ ...implicitProduct.pages[1], key: 'fake-product', path: '/products/fake', sections: [{ kind: 'hero', heading: 'Fake product route', body: '' }] }); invalids.push(implicitProduct);
  for (const invalid of invalids) assert.throws(() => normalizeAiSitePlan(invalid, brief));
  const value = industryPlan('brand-showcase'); value.intent!.primaryGoal = 'PRIVATE_GOAL_ONLY'; value.intent!.audienceTasks = ['PRIVATE_TASK_ONLY']; value.intent!.constraints = ['PRIVATE_CONSTRAINT_ONLY'];
  const result = compileAiSitePlan(value, 'chosen', imageContent()), publicData = JSON.stringify(result.patch.editorData);
  for (const privateText of ['PRIVATE_GOAL_ONLY', 'PRIVATE_TASK_ONLY', 'PRIVATE_CONSTRAINT_ONLY', 'PRIVATE_MISSING_PROOF_ONLY']) assert.ok(!publicData.includes(privateText));
  assert.ok(result.warnings.some(warning => warning.includes('PRIVATE_CONSTRAINT_ONLY'))); assert.ok(result.warnings.some(warning => warning.includes('PRIVATE_MISSING_PROOF_ONLY')));
});

test('新目录意图允许Components和Collections普通路径，CTA与SEO沿真实目录定位，原生产品详情仍保持根路径', () => {
  for (const [siteType, directoryPath] of [['product-catalog', '/components'], ['brand-showcase', '/collections']] as const) {
    const current = imageContent(), value = industryPlan('product-catalog'); value.intent!.siteType = siteType;
    const directory = value.pages.find(page => page.path === '/products')!; directory.path = directoryPath; directory.title = directoryPath === '/components' ? 'Components' : 'Collections'; delete value.pages[0].sections[0].cta;
    const result = compileAiSitePlan(value, 'chosen', current, 'new-site'), next = { ...current, ...result.patch }, target = next.pages.find(page => page.slug === `/new-site${directoryPath}`)!;
    const actions = nodes(next.editorData).filter(node => node.type === 'ActionButton' && node.props.kind === 'theme' && node.props.href === `/new-site${directoryPath}`);
    assert.ok(actions.length); assert.ok(actions.every(action => action.props.text === directory.title && action.props.linkTarget.id === target.id));
    assert.equal(result.seoIssues.find(issue => issue.code === 'missing-products')!.path, `/new-site${directoryPath}`);
    assert.ok(next.pages.some(page => page.slug === '/products/:slug')); assert.ok(!next.pages.some(page => page.slug === '/new-site/products'));
    assert.equal(nodes(next.editorData[target.id]).filter(node => node.type === 'ContentLoop' && node.props.source === 'product').length, 1);
    assert.deepEqual(siteLinkErrors(next), []); assert.doesNotThrow(() => validateDraft(next));
  }
  const legacy = plan(); legacy.pages.find(page => page.path === '/products')!.path = '/components'; assert.throws(() => normalizeAiSitePlan(legacy, brief), /产品目录/);
  const noDirectory = industryPlan('product-catalog'); noDirectory.pages.find(page => page.path === '/products')!.sections[1].kind = 'text'; assert.throws(() => normalizeAiSitePlan(noDirectory, brief), /真实产品列表/);
});

for (const [branch, layouts] of [['旧布局', ['editorial', 'catalog', 'showcase']], ['现代布局', ['split', 'bento', 'minimal']]] as const) {
  test(`${branch}产品区只生成真实动态列表，不复制模型静态商品条目；其他区块items保留`, () => {
    for (const layout of layouts) {
      const current = content(), value = layoutPlan(layout), catalogue = value.pages.find(page => page.path === '/products')!, section = catalogue.sections.find(item => item.kind === 'products')!;
      current.products = [{ id: 'supplied-product', name: 'Backend current product', sku: 'BACKEND-SKU-01', category: 'Supplied', material: 'Supplied material', description: 'Current maintained product facts.', image: '', status: 'draft' }];
      section.items = [{ title: 'MODEL_STATIC_PRODUCT_COPY', body: 'MODEL_STATIC_SKU_COPY' }];
      catalogue.sections.push({ kind: 'features', heading: 'Supplied selection guidance', body: '', items: [{ title: 'PRESERVED_FEATURE_TITLE', body: 'PRESERVED_FEATURE_BODY' }] });
      catalogue.sections.push({ kind: 'text', heading: 'Supplied further explanation', body: '', items: [{ title: 'PRESERVED_TEXT_ITEM_TITLE', body: 'PRESERVED_TEXT_ITEM_BODY' }] });
      const before = structuredClone(current), result = compileAiSitePlan(value, 'chosen', current), next = { ...current, ...result.patch }, page = next.pages.find(item => item.slug === '/products')!, generated = nodes(next.editorData[page.id]);
      assert.equal(generated.filter(node => node.type === 'ContentLoop' && node.props.source === 'product').length, 1, layout);
      const text = generated.map(node => node.props.text).filter((text): text is string => typeof text === 'string').join('\n');
      for (const copy of ['MODEL_STATIC_PRODUCT_COPY', 'MODEL_STATIC_SKU_COPY', current.products[0].name, current.products[0].sku]) assert.ok(!text.includes(copy), layout);
      for (const copy of [section.heading, section.body, 'PRESERVED_FEATURE_TITLE', 'PRESERVED_FEATURE_BODY', 'PRESERVED_TEXT_ITEM_TITLE', 'PRESERVED_TEXT_ITEM_BODY']) assert.ok(text.includes(copy), layout);
      assert.ok(result.warnings.some(warning => warning.includes('未采用额外静态条目') && warning.includes(catalogue.title)), layout);
      assert.deepEqual(current, before); assert.deepEqual(next.products, before.products); assert.doesNotThrow(() => validateDraft(next));
    }
  });
}

test('生成目录可跨12条分页、按型号搜索及按导入分类筛选；原首页与偏好保留', () => {
  const current = imageContent(), value = industryPlan('product-catalog');
  value.pages[0].sections.push({ kind: 'products', heading: 'Featured products', body: 'Browse the maintained selection.' });
  current.editorData.home = { root: { props: { title: 'Existing homepage' } }, content: [{ type: 'Text', props: { id: 'existing-home-copy', text: 'Keep the existing homepage.' } }] };
  current.siteLayout = {
    header: { mode: 'default', blockId: '', menuId: 'original-menu' }, footer: { mode: 'hidden', blockId: '' },
    menus: [{ id: 'original-menu', name: 'Original navigation', items: [{ id: 'original-item', label: 'Original home', target: { kind: 'page', id: 'home' } }] }],
  };
  current.products = Array.from({ length: 15 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return {
      id: `imported-${number}`, name: `Component ${number}`, sku: `CAT-SKU-${number}`, sortOrder: index,
      category: index >= 12 ? 'Precision & Test' : 'Standard', description: `Supplied description ${number}`, material: '',
      image: '', status: 'draft' as const,
    };
  });
  const before = structuredClone(current), result = compileAiSitePlan(value, 'chosen', current, 'new-catalogue'), draft = { ...current, ...result.patch };
  assert.deepEqual(current, before);
  assert.deepEqual(draft.editorData.home, before.editorData.home);
  assert.deepEqual(draft.siteLayout!.header, before.siteLayout!.header);
  assert.deepEqual(draft.siteLayout!.footer, before.siteLayout!.footer);
  assert.deepEqual(draft.siteLayout!.menus![0], before.siteLayout!.menus![0]);
  assert.deepEqual(draft.products, before.products);
  assert.doesNotThrow(() => validateDraft(draft));

  // 用原生组件渲染正式视图；编号、分类和介绍的值来自真实循环卡片绑定。
  const snapshot = {
    ...draft, schemaVersion: protocol.snapshot, pages: draft.pages.map(page => ({ ...page, status: 'published' as const })),
    products: draft.products.map(product => ({ ...product, status: 'published' as const })),
  };
  const resolved = resolveSitePage(snapshot, ['new-catalogue', 'products'])!;
  const home = resolveSitePage(snapshot, ['new-catalogue'])!;
  const list = nodes(resolved.data).find(node => node.type === 'ContentLoop')!;
  const card = draft.sharedBlocks!.find(block => block.id === list.props.itemBlockId)!;
  assert.ok(nodes(card.data).every(item => !item.props.locked));
  assert.ok(nodes(home.data).some(node => node.type === 'ContentList') && nodes(home.data).every(node => node.type !== 'ContentLoop'), '首页精选保留独立短列表');
  const chrome = (data: unknown) => nodes(data).filter(node => node.type === 'SharedBlock').map(node => node.props.blockId);
  assert.equal(chrome(resolved.data).length, 2);
  assert.deepEqual(chrome(resolved.data), chrome(home.data));
  const path = resolved.page.slug;
  const key = (part: 'page' | 'search' | 'term') => loopParam(list.props.id, part);
  const render = (queryParams: QueryParams = {}, previewPrefix = '') => renderToStaticMarkup(React.createElement(Render, {
    config: createSiteConfig({ ...snapshot, pageId: resolved.page.id, currentPath: path, queryParams, previewPrefix }),
    data: resolved.data,
  }));
  const records = (html: string) => [...html.matchAll(/data-loop-record="([^"]+)"/g)].map(match => match[1]);
  const first = render(), second = render({ [key('page')]: '2' });
  assert.deepEqual([...records(first), ...records(second)], current.products.map(product => product.id));
  assert.equal(records(first).length, 12);
  assert.ok(first.includes(`href="${path}?${key('page')}=2"`));
  assert.ok(first.includes(`name="${key('term')}"`) && first.includes('value="category:Precision &amp; Test"'));
  assert.ok(second.includes('Supplied description 13') && second.includes('href="/products/imported-13"'));

  const search = { [key('search')]: 'cat-sku-14' };
  const category = { [key('term')]: 'category:Precision & Test' };
  assert.deepEqual(records(render(search)), ['imported-14']);
  assert.deepEqual(records(render(category)), ['imported-13', 'imported-14', 'imported-15']);
  assert.ok(render(search, '/preview/~ai/fixture').includes(`action="/preview/~ai/fixture${path}"`));
  assert.ok(render(search, '/preview/~ai/fixture').includes('href="/preview/~ai/fixture/products/imported-14"'));
  assert.deepEqual(siteMetadata(snapshot, resolved, false, search).robots, { index: false, follow: true });
  assert.equal(hasInvalidLoopPage(snapshot, resolved, { [key('page')]: '3' }), true);
});

test('六种方向产生实际不同的原生结构，统一配色仍有布局差异且均通过发布级校验', () => {
  const signatures = new Set<string>();
  for (const layout of AI_SITE_LAYOUTS) {
    const current = imageContent(), value = layoutPlan(layout); value.pages[0].sections[0].mediaId = 'recorded-image'; value.pages[0].sections[1].items!.push({ title: 'Supplied third item', body: 'Another reviewed description.' });
    const result = compileAiSitePlan(value, 'chosen', current), next = { ...current, ...result.patch }, home = next.editorData.home;
    assert.doesNotThrow(() => validateDraft(next), layout); assert.deepEqual(contentBindingErrors(next, true), [], layout); assert.deepEqual(siteLinkErrors(next), [], layout); assert.deepEqual(componentCompatibilityErrors(home), [], layout);
    for (const page of next.pages) assert.doesNotThrow(() => validatePageData(next.editorData[page.id], page.title, true), layout);
    const generated = nodes(home); assert.equal(generated.filter(item => item.type === 'Heading' && item.props.level === 'h1').length, 1); assert.ok(generated.every(item => !item.props.locked)); assert.ok(generated.some(item => item.type === 'ContentList' && item.props.source === 'product'));
    // 排除随机ID、文字和配色，比较组件/容器/跨列与顺序，不能拿颜色差异冒充设计差异。
    signatures.add(JSON.stringify(generated.map(item => ({ type: item.type, layout: item.props.layout, columns: item.props.columns, span: item.props.design?.desktop?.columnSpan, rowSpan: item.props.design?.desktop?.rowSpan, children: item.props.content?.map((child: any) => child.type) }))));
    assert.deepEqual([...collectReferences(next).urls], ['/images/interior.jpg']); assert.equal((home as any).zones && Object.keys((home as any).zones).length, 0);
    for (const item of generated.filter(item => item.type === 'Container')) assert.equal(Object.keys(item.props)[0], 'content', 'Puck槽字段应保持原规范顺序');
  }
  assert.equal(signatures.size, 6);
});

test('区块图片左右意图改变真实顺序和不等宽分栏，移动端显式归一列且不继承跨列', () => {
  for (const intent of ['split-left', 'split-right'] as AiSectionLayout[]) {
    const current = imageContent(), value = layoutPlan('editorial'); value.pages[0].sections[0].mediaId = 'recorded-image'; value.pages[0].sections[0].layout = intent;
    const result = compileAiSitePlan(value, 'chosen', current), section = nodes(result.patch.editorData!.home).find(item => item.props.nodeLabel === value.pages[0].sections[0].heading)!;
    assert.equal(section.props.columns, 3); assert.equal(section.props.content[0].type === 'Image', intent === 'split-left');
    assert.deepEqual(section.props.content.map((item: any) => item.props.design.desktop.columnSpan), intent === 'split-left' ? [1, 2] : [2, 1]);
    assert.equal(section.props.design.mobile.columns, 1);
    for (const item of section.props.content) { assert.equal(item.props.design.tablet.columnSpan, 1); assert.equal(item.props.design.mobile.columnSpan, 1); assert.equal(item.props.design.mobile.rowSpan, 1); }
    assert.doesNotThrow(() => validateDraft({ ...current, ...result.patch }));
  }
});

test('Bento卡片有跨列层次，编号条目仅增加顺序并保留原文，局部意图不需要更换整站方向', () => {
  const current = content(), value = layoutPlan('bento'); value.pages[0].sections[1].items!.push({ title: 'Third source title', body: 'Third source body.' });
  const bento = compileAiSitePlan(value, 'chosen', current), feature = nodes(bento.patch.editorData!.home).find(item => item.props.nodeLabel === value.pages[0].sections[1].heading)!;
  const cards = nodes(feature).filter(item => item.type === 'Container' && item.props.design?.desktop?.minHeight === 220);
  assert.deepEqual(cards.map(item => item.props.design.desktop.columnSpan), [2, 1, 1]);
  value.directions = layoutPlan('editorial').directions; value.pages[0].sections[1].layout = 'steps';
  const numbered = compileAiSitePlan(value, 'chosen', current), numberedFeature = nodes(numbered.patch.editorData!.home).find(item => item.props.nodeLabel === value.pages[0].sections[1].heading)!;
  assert.deepEqual(nodes(numberedFeature).filter(item => item.type === 'Text' && /^\d{2}$/.test(item.props.text)).map(item => item.props.text), ['01', '02', '03']);
  for (const item of value.pages[0].sections[1].items!) { assert.ok(nodes(numberedFeature).some(node => node.props.text === item.title)); assert.ok(nodes(numberedFeature).some(node => node.props.text === item.body)); }
  assert.doesNotThrow(() => validateDraft({ ...current, ...numbered.patch }));
  value.pages[0].sections[1].layout = 'stacked';
  const stacked = compileAiSitePlan(value, 'chosen', current), stackedFeature = nodes(stacked.patch.editorData!.home).find(item => item.props.nodeLabel === value.pages[0].sections[1].heading)!;
  const itemGroup = nodes(stackedFeature).find(item => item.type === 'Container' && item.props.content?.length === 3 && item.props.content.every((child: any) => child.type === 'Container'))!;
  assert.equal(itemGroup.props.columns, 1, 'stacked应把条目逐个纵排，不能仍沿用cards双列');
});

test('新布局无素材时不生成空图片或假事实，旧站锁定内容和业务资料逐字保持', () => {
  for (const layout of ['split', 'bento', 'minimal'] as AiSiteLayout[]) {
    const current = content(); current.editorData.home = { root: { props: { title: 'Existing Home' } }, content: [{ type: 'Text', props: { id: 'locked-source', text: 'Retain exact source copy.', locked: true } }] } as any;
    const before = structuredClone(current), result = compileAiSitePlan(layoutPlan(layout), 'chosen', current, '/new-direction'), next = { ...current, ...result.patch };
    assert.deepEqual(current, before); assert.deepEqual(next.editorData.home, before.editorData.home); assert.deepEqual(next.products, before.products); assert.deepEqual(next.settings, before.settings); assert.deepEqual(next.theme, before.theme);
    for (const id of result.pageIds) { const generated = nodes(next.editorData[id]); assert.equal(generated.some(item => item.type === 'Image'), false); assert.ok(generated.every(item => !item.props.locked)); assert.doesNotThrow(() => validatePageData(next.editorData[id], id, true)); }
    assert.doesNotThrow(() => validateDraft(next));
  }
});

test('未知方向/区块布局及重复方向仍在编译前拒绝，旧方案不填局部layout仍原样可读', () => {
  assert.deepEqual(normalizeAiSitePlan(plan(), brief), plan());
  const badDirection = plan(); (badDirection.directions[0] as any).layout = 'custom-html'; assert.throws(() => normalizeAiSitePlan(badDirection, brief), /布局方向/);
  const badSection = plan(); (badSection.pages[0].sections[0] as any).layout = { css: 'position:absolute' }; assert.throws(() => normalizeAiSitePlan(badSection, brief), /区块布局/);
  const duplicate = layoutPlan('bento'); duplicate.directions[1].layout = 'bento'; assert.throws(() => normalizeAiSitePlan(duplicate, brief), /布局方向不能重复/);
});

test('同业三企业合成样本以统一字体配色验证18种布局产物，结构矩阵不冒充真实模型效果', t => {
  const samples = [
    { name: 'Meridian Joinery Lab', description: 'Synthetic furniture component company focused on reviewing customer drawings and material requirements.', audience: 'OEM furniture procurement teams', heading: 'Furniture components from your drawings', focus: ['Drawing review', 'Material discussion', 'Project requirements'], order: ['text', 'features', 'products'] },
    { name: 'Harbour Contract Furnishings', description: 'Synthetic contract furniture company focused on coordinating product information for hospitality projects.', audience: 'Hospitality project buyers', heading: 'Plan furniture around the guest experience', focus: ['Room applications', 'Furniture coordination', 'Project discussion'], order: ['features', 'products', 'text'] },
    { name: 'Atlas Trade Furniture', description: 'Synthetic furniture catalogue company focused on making product categories easier for importers to browse.', audience: 'Furniture importers and distributors', heading: 'Find the right furniture category', focus: ['Product categories', 'Available descriptions', 'Catalogue requests'], order: ['products', 'features', 'text'] },
  ];
  const matrix: { company: string; layout: AiSiteLayout; nodes: number; heroColumns: number; heroOrder: string; wideSpans: number; numbered: number; sectionOrder: string[] }[] = [];
  for (const sample of samples) {
    const signatures = new Set<string>();
    const companyBrief = { ...brief, companyName: sample.name, description: sample.description, industry: 'Furniture', audience: sample.audience, market: 'Synthetic global sample', styleNotes: 'Controlled same-palette and same-font structural test.' };
    for (const layout of AI_SITE_LAYOUTS) {
      const current = imageContent(), value = layoutPlan(layout); current.settings.name = sample.name;
      const hero = { ...value.pages[0].sections[0], heading: sample.heading, body: sample.description, mediaId: 'recorded-image' };
      const parts = { text: { kind: 'text' as const, heading: sample.focus[0], body: sample.description }, features: { ...value.pages[0].sections[1], heading: sample.focus[1], items: sample.focus.map(title => ({ title, body: `Review ${title.toLowerCase()} with the team; synthetic example only.` })) }, products: { ...value.pages[0].sections[2], heading: sample.focus[2] } };
      value.pages[0].sections = [hero, ...sample.order.map(kind => parts[kind as keyof typeof parts])];
      assert.doesNotThrow(() => normalizeAiSitePlan(value, companyBrief));
      const result = compileAiSitePlan(value, 'chosen', current), next = { ...current, ...result.patch }, rendered = nodes(next.editorData.home), heroNode = rendered.find(node => node.props.nodeLabel === sample.heading)!;
      assert.doesNotThrow(() => validateDraft(next)); assert.deepEqual(contentBindingErrors(next, true), []); assert.deepEqual(siteLinkErrors(next), []);
      signatures.add(JSON.stringify(rendered.map(node => [node.type, node.props.columns, node.props.layout, node.props.design?.desktop?.columnSpan, node.props.content?.map((child: any) => child.type)])));
      matrix.push({ company: sample.name, layout, nodes: rendered.length, heroColumns: heroNode.props.columns, heroOrder: nodes(heroNode).filter(node => node.type === 'Image' || node.type === 'Heading' && node.props.level === 'h1').map(node => node.type === 'Image' ? 'I' : 'H').join('→'), wideSpans: rendered.filter(node => Number(node.props.design?.desktop?.columnSpan || 1) > 1).length, numbered: rendered.filter(node => node.type === 'Text' && /^\d{2}$/.test(node.props.text)).length, sectionOrder: ((next.editorData.home as any).content as any[]).map(node => node.props.nodeLabel).filter(label => label && !label.startsWith('AI生成')) });
    }
    assert.equal(signatures.size, 6, `${sample.name}同配色/字体仍应保留六种不同组件结构`);
  }
  assert.equal(matrix.length, 18); t.diagnostic(`AI_LAYOUT_MATRIX ${JSON.stringify({ kind: 'local-synthetic-compiler-matrix', modelCalls: 0, samePaletteAndFont: true, samples: 3, variants: matrix })}`);
});

test('AI建站输入只接受声明式字段、标准语言与有限纯文字', () => {
  assert.deepEqual(normalizeAiSiteBrief(brief), brief);
  assert.deepEqual(normalizeAiSitePlan(plan(), brief), plan());
  for (const input of [{ ...brief, apiKey: 'private' }, { ...brief, description: '<script>alert(1)</script>' }, { ...brief, language: 'English' }, { ...brief, description: 'x'.repeat(6001) }]) assert.throws(() => normalizeAiSiteBrief(input));
  const withHtml = plan(); withHtml.pages[0].sections[0].body = '<img src=x onerror=alert(1)>';
  const withCode = plan() as unknown as Record<string, unknown>; withCode.customCode = {};
  const withHref = plan(); (withHref.pages[0].sections[0] as any).href = 'https://attacker.test';
  const withUnknown = plan(); (withUnknown.directions[0] as any).css = 'body{}';
  for (const input of [withHtml, withCode, withHref, withUnknown]) assert.throws(() => normalizeAiSitePlan(input, brief));
});

test('普通data冒号说明可生成，实际data URL和脚本协议仍被拒绝', () => {
  const source = { ...brief, description: 'Product data: supplied by the company.' }, p = plan();
  p.summary = 'Missing data: production capacity and certification need human review.';
  assert.equal(normalizeAiSiteBrief(source).description, source.description);
  assert.equal(normalizeAiSitePlan(p, source).summary, p.summary);
  for (const payload of ['data:text/plain;base64,SGVsbG8=', 'data:image/png;base64,iVBORw0KGgo=', 'data:,secret', 'data:;charset=utf-8,Hello', 'javascript:alert(1)', 'vbscript:run']) {
    const bad = plan(); bad.summary = `Embedded resource ${payload}`;
    assert.throws(() => normalizeAiSitePlan(bad, brief), /HTML、脚本/);
  }
});

test('不完整、重复、系统路径与伪多方向方案在编译前被拒绝', () => {
  const invalids: AiSitePlan[] = [];
  const missing = plan(); missing.pages.pop(); invalids.push(missing);
  const repeatedPath = plan(); repeatedPath.pages[1].path = '/'; invalids.push(repeatedPath);
  const system = plan(); system.pages[0].path = '/admin'; invalids.push(system);
  const duplicateLayout = plan(); duplicateLayout.directions[1].layout = 'editorial'; invalids.push(duplicateLayout);
  const missingHero = plan(); missingHero.pages[0].sections[0].kind = 'text'; invalids.push(missingHero);
  const noProducts = plan(); noProducts.pages[1].sections[1].kind = 'text'; invalids.push(noProducts);
  for (const input of invalids) assert.throws(() => normalizeAiSitePlan(input, brief));
});

test('首次空白首页可复用；生成结果通过真实草稿和发布级组件校验且不修改来源', () => {
  const current = content(), before = structuredClone(current), result = compileAiSitePlan(plan(), 'clear', current);
  const next = { ...current, ...result.patch };
  assert.deepEqual(current, before);
  assert.equal(next.pages.length, 4); assert.ok(result.pageIds.includes('home'));
  assert.equal(next.pages.find(page => page.slug === '/')!.id, 'home');
  assert.ok(result.warnings.some(message => message.includes('空白Home')));
  assert.doesNotThrow(() => validateDraft(next));
  for (const page of next.pages) { assert.doesNotThrow(() => validatePageData(next.editorData[page.id], page.title, true)); assert.deepEqual(componentCompatibilityErrors(next.editorData[page.id]), []); }
  assert.deepEqual(contentBindingErrors(next, true), []); assert.deepEqual(siteLinkErrors(next), []);
  assert.deepEqual([...collectReferences(next).urls], []);
  const headings = nodes(next.editorData.home).filter(node => node.type === 'Heading');
  assert.equal(headings.filter(node => node.props.level === 'h1').length, 1);
  assert.ok(nodes(next.editorData.home).some(node => node.props.design?.mobile?.paddingLeft === 20));
});

test('首建前已准备产品与图片仍使用根首页，并完整保留这些资料', () => {
  const current = content();
  current.products.push({ id: 'prepared-product', name: 'Prepared product', sku: 'PRE-1', category: 'Parts', description: 'Customer supplied product.', material: 'Recorded material', image: '/images/interior.jpg', status: 'draft' });
  current.media.push({ id: 'prepared-image', name: 'Prepared image', url: '/images/interior.jpg', kind: 'image', folder: '', size: '', alt: 'Customer supplied image' });
  const before = structuredClone(current);
  assert.equal(canReplaceAiEmptyHome(current), true);
  const result = compileAiSitePlan(plan(), 'clear', current), next = { ...current, ...result.patch };
  assert.deepEqual(current, before); assert.deepEqual(next.products, before.products); assert.deepEqual(next.media, before.media);
  assert.equal(next.pages.find(page => page.slug === '/')!.id, 'home');
  assert.doesNotThrow(() => validateDraft(next));
  const protectedHome = structuredClone(current);
  protectedHome.customCode = { global: { css: 'body{color:#123456}', js: '', cssEnabled: false, jsEnabled: false }, pages: {} };
  assert.equal(canReplaceAiEmptyHome(protectedHome), false);
  assert.throws(() => compileAiSitePlan(plan(), 'clear', protectedHome), /已存在/);
});

test('三种布局的附加产品按钮直接沿用AI目录标题，不插入硬编码英文', () => {
  const current = content(), p = plan(); current.settings.language = 'zh-CN';
  p.pages.find(page => page.path === '/products')!.title = '产品目录';
  for (const direction of p.directions) {
    const result = compileAiSitePlan(p, direction.id, current);
    const actions = nodes(result.patch.editorData!.home).filter(node => node.type === 'ActionButton' && node.props.kind === 'theme' && node.props.href === '/products');
    assert.ok(actions.length); assert.ok(actions.every(node => node.props.text === '产品目录'));
    assert.ok(!nodes(result.patch.editorData!.home).some(node => ['View products', 'Explore products'].includes(node.props.text)));
  }
});

test('三方向具有不同信息次序与真实组件结构，不只替换颜色', () => {
  const current = content(), p = plan();
  const layouts = p.directions.map(direction => {
    const result = compileAiSitePlan(p, direction.id, current), home = result.patch.editorData!.home;
    assert.doesNotThrow(() => validateDraft({ ...current, ...result.patch }));
    return nodes(home).map(node => ({ type: node.type, text: node.props.text, columns: node.props.columns, align: node.props.align, font: node.props.design?.desktop?.fontFamily }));
  });
  assert.notDeepEqual(layouts[0], layouts[1]); assert.notDeepEqual(layouts[1], layouts[2]);
  assert.ok(layouts[1].findIndex(node => node.type === 'Heading' && node.text === 'Products') < layouts[1].findIndex(node => node.text === 'What we do'));
  assert.ok(layouts[0].findIndex(node => node.type === 'Heading' && node.text === 'Products') > layouts[0].findIndex(node => node.text === 'What we do'));
});

test('已有内容不能被无前缀覆盖；真实素材、产品、配置与模板均原样保留', () => {
  const current = content();
  current.editorData.home = { root: { props: { title: 'Customer home', brand: 'Customer brand' } }, content: [{ type: 'Text', props: { id: 'customer-copy', text: 'Keep this content' } }] };
  current.products.push({ id: 'customer-product', name: 'Existing product', sku: 'EX-1', category: 'Parts', description: 'Real fixture description.', material: 'Recorded material', image: '/images/interior.jpg', status: 'draft' });
  current.media.push({ id: 'customer-image', name: 'Customer image', url: '/images/interior.jpg', kind: 'image', folder: '', size: '', alt: 'Customer supplied image' });
  current.customCode = { global: { css: '', js: '', cssEnabled: false, jsEnabled: false }, pages: {} };
  const before = structuredClone(current);
  assert.throws(() => compileAiSitePlan(plan(), 'clear', current), /已存在/);
  const p = plan(); p.pages[0].sections[0].mediaId = 'customer-image';
  const result = compileAiSitePlan(p, 'clear', current, '/new-site'), next = { ...current, ...result.patch };
  assert.deepEqual(current, before); assert.deepEqual(next.editorData.home, before.editorData.home);
  for (const key of ['products', 'media', 'settings', 'theme', 'customCode'] as const) assert.deepEqual(next[key], before[key]);
  assert.ok(next.pages.some(page => page.slug === '/new-site')); assert.ok(next.pages.some(page => page.slug === '/products/:slug'));
  assert.equal(getProductPath(next, current.products[0]), '/products/customer-product');
  assert.deepEqual([...collectReferences(next).urls], ['/images/interior.jpg']);
  assert.doesNotThrow(() => validateDraft(next));
  assert.ok(result.warnings.some(message => message.includes('系统根路径')));
});

test('已有动态产品页保留，新设计保存为未激活模板，不伪造前缀动态路由', () => {
  const base = content(), generated = compileAiSitePlan(plan(), 'clear', base), current = { ...base, ...generated.patch };
  const before = structuredClone(current), result = compileAiSitePlan(plan(), 'visual', current, 'alternative'), next = { ...current, ...result.patch };
  const oldDetail = current.pages.find(page => page.slug === '/products/:slug')!;
  assert.deepEqual(current, before); assert.deepEqual(next.editorData[oldDetail.id], before.editorData[oldDetail.id]);
  assert.equal(result.pageIds.length, 3); assert.equal(next.pages.filter(page => page.slug === '/products/:slug').length, 1);
  assert.ok(!next.pages.some(page => page.slug.includes('/alternative/products/:slug')));
  const template = next.pageTemplates!.at(-1)!;
  assert.equal(template.kind, 'product'); assert.equal(template.sourcePath, '/products/:slug'); assert.equal(template.detailRule, undefined);
  assert.deepEqual(pageTemplateErrors(next, true), []); assert.doesNotThrow(() => validateDraft(next));
  assert.ok(result.warnings.some(message => message.includes('未激活')));
});

test('素材仅可通过当前图片ID解析；失效、远程、文档素材及危险目录均拒绝', () => {
  for (const media of [undefined, { id: 'chosen', name: 'Remote', url: 'https://remote.test/image.jpg', kind: 'image' as const, folder: '', size: '', alt: '' }, { id: 'chosen', name: 'PDF', url: '/api/media/chosen', kind: 'document' as const, folder: '', size: '', alt: '' }]) {
    const current = content(), p = plan(); p.pages[0].sections[0].mediaId = 'chosen'; if (media) current.media.push(media);
    assert.throws(() => compileAiSitePlan(p, 'clear', current, 'media-check'), /图片素材/);
  }
  for (const prefix of ['/admin', '/products', '/a/../../b', '//example.test', '/has space']) assert.throws(() => compileAiSitePlan(plan(), 'clear', content(), prefix));
});

test('缺失业务资料与重复SEO以可审阅问题返回，不生成假产品、联系方式或排名分', () => {
  const current = createEmptyDraft(), p = plan(); p.pages[1].seoTitle = p.pages[0].seoTitle; p.pages[2].seoDescription = p.pages[0].seoDescription;
  const result = compileAiSitePlan(p, 'clear', current);
  assert.deepEqual(current.products, []); assert.equal(result.patch.products, undefined); assert.equal(result.patch.settings, undefined);
  for (const code of ['duplicate-title', 'duplicate-description', 'missing-products', 'missing-public-url']) assert.ok(result.seoIssues.some(issue => issue.code === code), code);
  assert.equal(result.patch.forms!.length, 1);
  assert.equal(nodes(Object.values(result.patch.editorData!)).filter(node => node.type === 'Form').length, 1);
  assert.ok(result.warnings.some(message => message.includes('SMTP')));
  assert.doesNotThrow(() => validateDraft({ ...current, ...result.patch }));
});

test('已有表单优先复用；禁用表单保留且新增表单只追加，不改变通知配置', () => {
  const current = content(), disabled = { ...createFormDefinition('old-disabled'), enabled: false }, enabled = createFormDefinition('current-inquiry');
  current.forms = [disabled, enabled];
  const before = structuredClone(current), reused = compileAiSitePlan(plan(), 'clear', current);
  assert.equal(reused.patch.forms, undefined);
  assert.ok(nodes(Object.values(reused.patch.editorData!)).filter(node => node.type === 'Form').every(node => node.props.formId === enabled.id));
  assert.deepEqual(current, before);
  const withoutEnabled = { ...current, forms: [disabled] }, appended = compileAiSitePlan(plan(), 'clear', withoutEnabled);
  assert.equal(appended.patch.forms!.length, 2); assert.deepEqual(appended.patch.forms![0], disabled);
  assert.ok(appended.patch.forms![1].enabled); assert.doesNotThrow(() => validateDraft({ ...withoutEnabled, ...appended.patch }));
  assert.equal(appended.patch.settings, undefined);
});

test('自定义过的空首页仍受保护；手机导航重置桌面跨列避免创建隐式溢出列', () => {
  const altered = content();
  (altered.editorData.home as any).root.props.design = { desktop: { backgroundColor: '#eeeeee' } };
  assert.throws(() => compileAiSitePlan(plan(), 'clear', altered), /已存在/);
  const current = content(), generated = compileAiSitePlan(plan(), 'clear', current), home = generated.patch.editorData!.home as any;
  assert.equal(home.root.props.showChrome, 'yes');
  assert.ok(!nodes(home).some(node => node.props.nodeLabel === 'AI生成品牌与页面导航' || node.props.nodeLabel === 'AI生成页面页脚'));
  const header = generated.patch.sharedBlocks!.find(block => block.id === generated.patch.siteLayout!.header.blockId)!;
  const nav = nodes(header.data).find(node => node.type === 'Navigation')!;
  assert.equal(nav.props.design.desktop.columnSpan, 3);
  assert.equal(resolveDesign(nav.props.design,'mobile',getLegacyDesign('Navigation',nav.props,'mobile')).columnSpan, 1);
  assert.equal(nav.props.mobileMode, 'collapse');
  assert.equal(nav.props.menuId, generated.patch.siteLayout!.header.menuId);
  assert.ok(nodes(header.data).some(node => node.type === 'Text' && node.props.text === current.settings.name));
});

test('生成草稿可沿用真实发布预检与快照流程，不自动发布或携带账号询盘', () => {
  const previous = process.env.FORM_STUDIO_DATA_DIR, directory = mkdtempSync(join(tmpdir(), 'form-studio-ai-build-'));
  process.env.FORM_STUDIO_DATA_DIR = directory;
  try {
    const current = content(), result = compileAiSitePlan(plan(), 'clear', current);
    const first = getDraftRecord();
    patchStudio({ expectedRevision: first.revision, patch: { ...current, ...result.patch, products: [{ id: 'real-product', name: 'Fixture product', sku: 'FIX-1', category: 'Fixtures', description: 'Test product supplied by the fixture.', material: 'Test material', image: '', status: 'draft' }] } });
    assert.equal(getActiveSiteSnapshot(), null);
    const draft = getDraftRecord(), selection = { expectedRevision: draft.revision, baseReleaseId: null, pageIds: result.pageIds, productIds: ['real-product'], includeTheme: true, includeSettings: true, includeLayout: true, includeForms: true, includeTemplates: true, sharedBlockIds: result.patch.sharedBlocks!.map(block => block.id) };
    assert.ok(previewPublication({ ...selection, sharedBlockIds: [] }).errors.some(error => error.includes('缺少') || error.includes('同步区块')));
    const preview = previewPublication(selection);
    assert.deepEqual(preview.errors, []);
    publishSite(selection, { id: 'ai-builder-test-admin', name: 'AI建站测试管理员' });
    const snapshot = getActiveSiteSnapshot()!;
    assert.ok(snapshot); assert.equal(snapshot.pages.length, 4); assert.equal(snapshot.products.length, 1);
    assert.equal(getProductPath(snapshot, snapshot.products[0]), '/products/real-product');
    assert.equal((snapshot as any).inquiries, undefined); assert.equal((snapshot as any).accounts, undefined);
    snapshot.pages.forEach(page => assert.doesNotThrow(() => validatePageData(snapshot.editorData[page.id], page.title, true)));
  } finally {
    getDatabase().close();
    // 仅清理由本用例创建并核对前缀的临时实例，不能触及正式数据目录。
    if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-ai-build-`)) rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.FORM_STUDIO_DATA_DIR; else process.env.FORM_STUDIO_DATA_DIR = previous;
  }
});
