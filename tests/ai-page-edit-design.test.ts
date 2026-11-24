import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentData, Data } from '@puckeditor/core';
import { compileAiPageEdit, prepareAiPageEdit, sameAiPageData } from '../src/lib/ai-page-edit';
import type { AiPageEditRequest } from '../src/lib/ai-page-edit-types';
import { getLegacyDesign, resolveDesign, type Device } from '../src/lib/responsive-style';
import { resolveThemeDesign } from '../src/lib/theme-design';
import { EDITOR_ROOT_DEFAULT_PROPS, withEditorRootDefaults } from '../src/lib/editor-root-defaults';
import { createEmptyDraft } from '../src/server/seed';
import { validateDraft } from '../src/server/validation';

const request = (extra: Partial<AiPageEditRequest> = {}): AiPageEditRequest => ({ pageId:'home', expectedRevision:0, instruction:'保留真实产品资料，重新组织图文和产品卡片，让工程买家更容易阅读。', mode:'mixed', preserveText:true, lockedIds:[], ...extra });
const output = (operations: unknown[]) => ({ summary:'调整布局，保留产品动态数据来源。', operations, warnings:[] });
function fixture(existingCard = false) {
  const content = createEmptyDraft();
  content.pages.push({...content.pages[0],id:'product-detail',slug:'/products/:slug',title:'Product detail'});
  content.editorData['product-detail']={root:{props:{}},content:[]};
  content.media=[{id:'factory-photo',name:'Factory production hall',alt:'Existing factory photograph',url:'/images/interior.jpg',kind:'image',folder:'Company',size:'100 KB',width:1600,height:900}];
  content.products=[{id:'real-product',name:'PRIVATE_REAL_PRODUCT_NAME',description:'PRIVATE_REAL_PRODUCT_DESCRIPTION',sku:'PRIVATE_SKU',category:'Industrial',material:'Steel',status:'published',image:'/images/chair.jpg'}];
  const nodes: ComponentData[]=[{type:'Heading',props:{id:'hero-title',text:'Engineering for real projects',level:'h1',size:48}},{type:'Image',props:{id:'hero-image',src:'/images/chair.jpg',alt:'Existing product photograph'}},{type:'ProductList',props:{id:'products',title:'Product families',eyebrow:'Explore products',category:'Industrial',count:4,columns:2,mobileColumns:1,padding:48}}];
  content.editorData.home={root:{props:{showChrome:'no'}},content:nodes,zones:{}} as Data;
  if(existingCard){
    nodes[2]={type:'ContentLoop',props:{id:'products',source:'product',modelId:'',itemBlockId:'original-card',title:'Product families',count:4,columns:2,mobileColumns:1,gap:24,padding:48}};
    content.sharedBlocks=[{id:'original-card',name:'Shared product card',updated:'2026-11-12T00:00:00Z',data:{root:{props:{showChrome:'no'}},content:[{type:'Container',props:{id:'card-frame',content:[{type:'Image',props:{id:'card-image',src:'',alt:'',bindings:{src:{source:'product',mode:'current',field:'builtin:image'},alt:{source:'product',mode:'current',field:'builtin:name'}}}},{type:'Heading',props:{id:'card-title',text:'PRIVATE_BOUND_FALLBACK',level:'h3',size:24,bindings:{text:{source:'product',mode:'current',field:'builtin:name'}}}}],layout:'column',gap:16,columns:1,mobileColumns:1}}]} as Data}];
  }
  return content;
}
function find(data: Data,id:string):ComponentData {
  let result:ComponentData|undefined;
  const walk=(value:unknown)=>{if(Array.isArray(value)){value.forEach(walk);return;}if(!value||typeof value!=='object')return;const node=value as ComponentData;if(node.props?.id===id)result=node;Object.values(value).forEach(walk);};walk(data);
  assert.ok(result,`missing ${id}`);return result;
}

test('图片替换只使用真实素材ID，新增图片和稳定内部链接保持原生可编辑',()=>{
  const source=fixture(),before=structuredClone(source);
  const context=JSON.stringify(prepareAiPageEdit(source,request()).context);
  assert.match(context,/factory-photo/);assert.doesNotMatch(context,/\/images\/interior.jpg|PRIVATE_REAL_PRODUCT|PRIVATE_SKU/);
  const result=compileAiPageEdit(source,request({preserveText:false}),output([
    {kind:'image',id:'hero-image',mediaId:'factory-photo',alt:'Factory production hall'},
    {kind:'insert',parentId:'$page',index:2,node:{tempId:'new-photo',type:'Image',mediaId:'factory-photo',design:{mobile:{height:240,width:'100%'}}}},
    {kind:'insert',parentId:'$page',index:3,node:{tempId:'new-cta',type:'ActionButton',text:'Explore the products',linkTarget:{kind:'page',id:'home'}}},
  ]),'media-test');
  assert.equal(find(result.data,'hero-image').props.src,'/images/interior.jpg');
  assert.equal(result.data.content[2].type,'Image');assert.deepEqual(result.data.content[3].props.linkTarget,{kind:'page',id:'home'});
  assert.deepEqual(source,before);assert.doesNotThrow(()=>validateDraft({...source,editorData:{...source.editorData,home:result.data}}));
  for(const op of [{kind:'image',id:'hero-image',mediaId:'missing'},{kind:'image',id:'hero-image',src:'https://example.invalid/image.png'},{kind:'link',id:'hero-title',target:{kind:'page',id:'home'}}])assert.throws(()=>compileAiPageEdit(source,request(),output([op]),'invalid'));
});

test('动态产品列表升级为自由卡片，保留筛选/标题/数量且卡片全部为原生当前产品绑定',()=>{
  const source=fixture(),result=compileAiPageEdit(source,request(),output([{kind:'productCard',id:'products',operations:[
    {kind:'layout',id:'card-products-frame',layout:'grid',columns:2,gap:28},
    {kind:'design',id:'card-products-image',design:{desktop:{height:300},mobile:{height:200}}},
    {kind:'insert',parentId:'card-products-frame',index:2,node:{tempId:'new-sku',type:'Text',bindings:{text:'builtin:sku'}}},
  ]}]),'card-test');
  const loop=find(result.data,'products'),card=result.sharedBlocks[0];
  assert.equal(loop.type,'ContentLoop');assert.equal(loop.props.title,'Product families');assert.equal(loop.props.eyebrow,'Explore products');assert.equal(loop.props.count,4);
  assert.deepEqual(loop.props.query.filters,[{field:'builtin:category',op:'contains',value:'Industrial'}]);assert.equal(loop.props.itemBlockId,card.id);
  assert.equal(find(card.data,'card-products-title').props.bindings.text.field,'builtin:name');assert.equal(find(card.data,'card-products-image').props.bindings.src.field,'builtin:image');
  assert.equal(find(card.data,'aie-card-test-card1-1').props.bindings.text.field,'builtin:sku');
  assert.equal(result.difference.structureChanged,true);assert.equal(source.sharedBlocks,undefined);
  assert.doesNotMatch(JSON.stringify(card.data),/PRIVATE_REAL_PRODUCT|PRIVATE_SKU/);
  assert.doesNotThrow(()=>validateDraft({...source,sharedBlocks:result.sharedBlocks,editorData:{...source.editorData,home:result.data}}));
});

test('已有共享卡片克隆为独立资产，内部样式变化进入差异结果并保留原卡片与绑定',()=>{
  const source=fixture(true),before=structuredClone(source),result=compileAiPageEdit(source,request(),output([{kind:'productCard',id:'products',operations:[{kind:'design',id:'card-title',design:{desktop:{color:'#123456',fontSize:35},mobile:{fontSize:24}}}]}]),'clone');
  assert.equal(result.sharedBlocks.length,1);assert.notEqual(result.sharedBlocks[0].id,'original-card');assert.equal(result.difference.typographyChanged,true);assert.equal(result.difference.colorsChanged,true);assert.equal(result.difference.structureChanged,false);
  assert.deepEqual(find(result.sharedBlocks[0].data,'card-title').props.bindings,find(source.sharedBlocks![0].data,'card-title').props.bindings);
  assert.deepEqual(source,before);assert.doesNotMatch(JSON.stringify(prepareAiPageEdit(source,request()).context),/PRIVATE_BOUND_FALLBACK|PRIVATE_REAL_PRODUCT/);
});

test('新建和克隆卡片提前补齐Puck根缺省，正常打开不产生伪手改，真实根修改仍可辨别',()=>{
  for(const existing of [false,true]){
    const source=fixture(existing),original=structuredClone(source);
    if(existing)source.sharedBlocks![0].data.root={props:{showChrome:'no',title:'Custom product card',brand:'Brand for editor',design:{mobile:{paddingTop:7}}}} as Data['root'];
    const sourceBefore=structuredClone(source);
    const result=compileAiPageEdit(source,request(),output([{kind:'productCard',id:'products',operations:[{kind:'design',id:existing?'card-title':'card-products-title',design:{mobile:{fontSize:21}}}]}]),existing?'root-clone':'root-seed');
    const card=result.sharedBlocks[0].data;
    const rootProps=card.root.props as Record<string,unknown>;
    assert.equal(sameAiPageData(withEditorRootDefaults(card),card),true);
    assert.equal(JSON.stringify(withEditorRootDefaults(card)),JSON.stringify(card));assert.deepEqual(card.zones,{});
    assert.equal(rootProps.showChrome,'no');assert.equal(rootProps.brand,existing?'Brand for editor':EDITOR_ROOT_DEFAULT_PROPS.brand);
    assert.equal(rootProps.title,existing?'Custom product card':EDITOR_ROOT_DEFAULT_PROPS.title);
    if(existing)assert.deepEqual(rootProps.design,{mobile:{paddingTop:7}});
    assert.deepEqual(source,sourceBefore);assert.deepEqual(result.data.root,original.editorData.home&&(original.editorData.home as Data).root);
    const manual=structuredClone(card);(manual.root.props as Record<string,unknown>).title='Manual changed title';
    assert.equal(sameAiPageData(manual,card),false);
    const styled=structuredClone(card);(styled.root.props as Record<string,unknown>).design={mobile:{paddingTop:8}};
    assert.equal(sameAiPageData(styled,card),false);
  }
});

test('卡片动态字段校验组件用途和产品模型，不能把绑定产品图片替换成静态样本',()=>{
  const source=fixture(true);
  for(const op of [{kind:'image',id:'card-image',mediaId:'factory-photo'},{kind:'bind',id:'card-image',target:'src',field:'builtin:name'},{kind:'bind',id:'card-title',target:'text',field:'field:missing'},{kind:'bind',id:'card-title',target:'text',field:'builtin:sku'},{kind:'productCard',id:'card-frame',operations:[]}])assert.throws(()=>compileAiPageEdit(source,request(),output([{kind:'productCard',id:'products',operations:[op]}]),'invalid-binding'));
  const changed=compileAiPageEdit(source,request({preserveText:false}),output([{kind:'productCard',id:'products',operations:[{kind:'bind',id:'card-title',target:'text',field:'builtin:sku'}]}]),'rebind');
  assert.equal(find(changed.sharedBlocks[0].data,'card-title').props.bindings.text.field,'builtin:sku');
  assert.throws(()=>compileAiPageEdit(source,request({preserveText:false}),output([{kind:'bind',id:'hero-title',target:'text',field:'builtin:name'}]),'outside-card'),/卡片/);
});

test('手机卡片只修改mobile样式，原桌面/平板设计、产品字段与列表结构保持',()=>{
  const source=fixture(true),old=find(source.sharedBlocks![0].data,'card-title');
  const result=compileAiPageEdit(source,request({viewport:'mobile'}),output([{kind:'productCard',id:'products',operations:[{kind:'design',id:'card-title',design:{mobile:{fontSize:20,lineHeight:1.4}}}]}]),'mobile');
  const next=find(result.sharedBlocks[0].data,'card-title');
  for(const device of ['desktop','tablet'] as Device[])assert.deepEqual(resolveDesign(next.props.design,device,getLegacyDesign(next.type,next.props,device)),resolveDesign(old.props.design,device,getLegacyDesign(old.type,old.props,device)));
  assert.equal(next.props.design.mobile.fontSize,20);assert.deepEqual(next.props.bindings,old.props.bindings);
  for(const operation of [{kind:'text',id:'hero-title',text:'New'},{kind:'image',id:'hero-image',mediaId:'factory-photo'},{kind:'remove',id:'hero-image'},{kind:'design',id:'hero-title',design:{desktop:{fontSize:20}}},{kind:'productCard',id:'products',operations:[{kind:'layout',id:'card-frame',layout:'grid'}]}])assert.throws(()=>compileAiPageEdit(source,request({viewport:'mobile',preserveText:false}),output([operation]),'not-mobile'));
  assert.throws(()=>compileAiPageEdit(fixture(),request({viewport:'mobile'}),output([{kind:'productCard',id:'products',operations:[{kind:'design',id:'card-products-title',design:{mobile:{fontSize:20}}}]}]),'convert-mobile'),/全部设备/);
});

test('桌面和平板单端调整固定原有向下继承，避免间接改掉手机效果',()=>{
  for(const viewport of ['desktop','tablet'] as const){
    const source=fixture(),old=find(source.editorData.home as Data,'hero-title');old.props.design={desktop:{fontSize:50},mobile:{lineHeight:1.2}};
    const result=compileAiPageEdit(source,request({viewport}),output([{kind:'design',id:'hero-title',design:{[viewport]:{fontSize:viewport==='desktop'?62:35}}}]),viewport);
    const next=find(result.data,'hero-title');
    for(const device of (viewport==='desktop'?['tablet','mobile']:['desktop','mobile']) as Device[])assert.deepEqual(resolveDesign(next.props.design,device,getLegacyDesign(next.type,next.props,device)),resolveDesign(old.props.design,device,getLegacyDesign(old.type,old.props,device)));
    assert.equal(next.props.design[viewport].fontSize,viewport==='desktop'?62:35);
  }
});

test('单端隔离使用真实样式库与令牌有效值，不把手机已有设计覆盖成旧组件缺省值',()=>{
  for(const useToken of [false,true]){
    const source=fixture(),old=find(source.editorData.home as Data,'hero-title');delete old.props.design;
    source.theme.presets=[{id:'type-preset',name:'Brand title',design:{desktop:{fontSize:52},mobile:{fontSize:24,lineHeight:1.5}}}];
    old.props.stylePresetId='type-preset';
    if(useToken){source.theme.tokens=[{id:'mobile-title-size',name:'Mobile title size',value:26}];old.props.tokenBindings={mobile:{fontSize:'mobile-title-size'}};}
    const beforeMobile=resolveDesign(resolveThemeDesign(source.theme,old.props as Parameters<typeof resolveThemeDesign>[1]),'mobile',getLegacyDesign(old.type,old.props,'mobile'));
    const result=compileAiPageEdit(source,request({viewport:'desktop'}),output([{kind:'design',id:'hero-title',design:{desktop:{fontSize:64}}}]),useToken?'token':'preset');
    const next=find(result.data,'hero-title'),afterMobile=resolveDesign(resolveThemeDesign(source.theme,next.props as Parameters<typeof resolveThemeDesign>[1]),'mobile',getLegacyDesign(next.type,next.props,'mobile'));
    assert.deepEqual(afterMobile,beforeMobile);assert.equal(next.props.design.mobile.fontSize,useToken?26:24);
    const prepared=prepareAiPageEdit(source,request({viewport:'desktop'}));assert.equal(prepared.context.nodes.find(node=>node.id==='hero-title')!.design.mobile.fontSize,useToken?26:24);
  }
});

test('设计上下文包含基础属性加样式库令牌的有界真实基线，保持绑定原文和图片URL隔离',()=>{
  const source=fixture(true),hero=find(source.editorData.home as Data,'hero-title'),image=find(source.editorData.home as Data,'hero-image');
  hero.props.size=56;hero.props.mobileSize=30;image.props.height=510;
  source.theme.presets=[{id:'card-type',name:'Card heading',design:{mobile:{fontSize:23}}}];
  find(source.sharedBlocks![0].data,'card-title').props.stylePresetId='card-type';
  const prepared=prepareAiPageEdit(source,request()),heading=prepared.context.nodes.find(node=>node.id==='hero-title')!,photo=prepared.context.nodes.find(node=>node.id==='hero-image')!;
  assert.equal(heading.actualComputedStyle.desktop.fontSize,56);assert.equal(heading.actualComputedStyle.mobile.fontSize,30);
  assert.equal(photo.actualComputedStyle.desktop.height,510);assert.equal(photo.actualComputedStyle.mobile.height,400);
  const collection=prepared.context.nodes.find(node=>node.id==='products')!;assert.ok('productCard' in collection);
  const cardTitle=collection.productCard.nodes.find(node=>node.id==='card-title')!;assert.equal(cardTitle.actualComputedStyle.mobile.fontSize,23);
  const encoded=JSON.stringify(prepared.context);assert.doesNotMatch(encoded,/PRIVATE_BOUND_FALLBACK|PRIVATE_REAL_PRODUCT|\/images\/chair.jpg/);assert.ok(encoded.length<40000);
});

test('面板已有内容插槽支持原生插入与移动，拒绝任意路径及移动环路',()=>{
  const source=fixture(),data=source.editorData.home as Data;
  data.content.push({type:'Tabs',props:{id:'tabs',items:[{id:'one',title:'Overview',content:[]},{id:'two',title:'Details',content:[]}]}});
  const result=compileAiPageEdit(source,request(),output([{kind:'insert',parentId:'tabs',slot:'items[0].content',index:0,node:{tempId:'new-column',type:'Container'}},{kind:'move',id:'hero-image',parentId:'new-column',index:0},{kind:'move',id:'new-column',parentId:'tabs',slot:'items[1].content',index:0}]),'slots');
  assert.equal(find(result.data,'tabs').props.items[0].content.length,0);assert.equal(find(result.data,'tabs').props.items[1].content[0].props.content[0].props.id,'hero-image');
  assert.throws(()=>compileAiPageEdit(source,request(),output([{kind:'move',id:'hero-image',parentId:'tabs',slot:'__proto__.content',index:0}]),'bad-slot'),/插槽/);
  find(data,'tabs').props.locked=true;
  assert.doesNotMatch(JSON.stringify(prepareAiPageEdit(source,request()).context),/"label":"Overview"|"label":"Details"/);
  assert.throws(()=>compileAiPageEdit(source,request(),output([{kind:'move',id:'hero-image',parentId:'tabs',slot:'items[0].content',index:0}]),'locked-slot'),/锁定/);
});

test('显式删除遵守保留文字、锁定子树和选区根保护，调用前后不改原稿',()=>{
  const source=fixture(),before=structuredClone(source);
  assert.throws(()=>compileAiPageEdit(source,request(),output([{kind:'remove',id:'hero-title'}]),'preserved'),/保留文字/);
  assert.throws(()=>compileAiPageEdit(source,request(),output([{kind:'remove',id:'products'}]),'preserved-products'),/保留文字/);
  const shared=fixture();(shared.editorData.home as Data).content.push({type:'SharedBlock',props:{id:'reference',blockId:'external-copy'}});
  assert.throws(()=>compileAiPageEdit(shared,request(),output([{kind:'remove',id:'reference'}]),'preserved-reference'),/保留文字/);
  const spacer=fixture();(spacer.editorData.home as Data).content.push({type:'Spacer',props:{id:'empty-space',height:40}});
  assert.equal(compileAiPageEdit(spacer,request(),output([{kind:'remove',id:'empty-space'}]),'empty-space').changes[0].kind,'remove');
  assert.throws(()=>compileAiPageEdit(source,request({targetId:'hero-image'}),output([{kind:'remove',id:'hero-image'}]),'root'),/根节点/);
  const result=compileAiPageEdit(source,request({preserveText:false}),output([{kind:'remove',id:'hero-title'}]),'remove');
  assert.equal(result.data.content.some(node=>node.props.id==='hero-title'),false);assert.equal(result.changes[0].kind,'remove');assert.ok(result.warnings.some(warning=>warning.includes('0个一级标题')));assert.deepEqual(source,before);
});

test('设计意图可审阅且严格校验，继续调整标识与断点保持可选兼容',()=>{
  const source=fixture(),value={...output([{kind:'design',id:'hero-title',design:{mobile:{fontSize:28}}}]),intent:{goal:'让工程采购更容易理解产品',decisions:['先突出产品分类和应用'],preserve:['保留真实产品字段'],assumptions:['暂用现有照片']}};
  const result=compileAiPageEdit(source,request({baseEditId:'aie-existing',viewport:'mobile'}),value,'intent');
  assert.deepEqual(result.intent,value.intent);assert.equal(prepareAiPageEdit(source,request({baseEditId:'aie-existing'})).request.baseEditId,'aie-existing');
  assert.throws(()=>compileAiPageEdit(source,request(),{...value,intent:{...value.intent,arbitrary:'execute'}},'intent'),/不支持/);
  assert.throws(()=>prepareAiPageEdit(source,{...request(),viewport:'watch'}),/设备/);
  assert.equal(sameAiPageData(source.editorData.home,fixture().editorData.home),true);
});
