import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createEmptyDraft} from '../src/server/seed';
import {inspectAiBuildLayout,matchAiInspectionPage,aiLayoutDeviceForWidth} from '../src/lib/ai-build-layout-inspection';
import {AiBuildDirectionFacts,aiLayoutColumnLabel,aiLayoutNumberedLabel} from '../src/components/AiBuildLayoutFacts';
type Node={type:string;props:Record<string,unknown>};
const node=(type:string,id:string,props:Record<string,unknown>={}):Node=>({type,props:{id,...props}});
const box=(id:string,content:Node[],extra:Record<string,unknown>={})=>node('Container',id,{content,layout:'grid',columns:1,mobileColumns:1,...extra});
function source(content:Node[]){const draft=createEmptyDraft();draft.editorData.home={root:{props:{}},content};return draft;}

test('原生事实不采纳方向想象：无图首区、后续配图、未生成编号均按实际节点分开',()=>{
  const draft=source([box('hero',[node('Heading','title',{text:'Actual title',level:'h1'}),node('Text','copy',{text:'Supplied copy'})],{nodeLabel:'Actual title'}),box('later',[node('Image','photo',{src:'/images/chair.jpg'})],{nodeLabel:'Later photograph'})]);
  const result=inspectAiBuildLayout(draft,['home']);assert.deepEqual(result.pages[0].sections[0].desktop.flow,['title','copy']);assert.equal(result.pages[0].sections[0].desktop.numberedItems,0);assert.deepEqual(result.pages[0].sections[1].desktop.flow,['image']);
});
test('区分外层与内层网格，并使用desktop/tablet/mobile最终继承而非只读显式mobile',()=>{
  const draft=source([box('outer',[box('inner',[node('Heading','h',{text:'Heading',level:'h1',design:{desktop:{columnSpan:2},mobile:{columnSpan:1}}}),node('Image','i',{src:'/images/chair.jpg'})],{columns:3,design:{desktop:{columns:3},tablet:{columns:2},mobile:{}}})])]);
  const value=inspectAiBuildLayout(draft,['home']).pages[0].sections[0];assert.equal(value.desktop.columns,1);assert.deepEqual(value.desktop.innerGrids,[{columns:3,spans:[2,1]}]);assert.equal(value.mobile.columns,1);assert.deepEqual(value.mobile.innerGrids,[{columns:2,spans:[1,1]}]);
});
test('主题预设、令牌与节点样式按真实优先级解析，隐藏和手机重排不被当作可见原顺序',()=>{
  const draft=source([box('hero',[node('Image','photo',{src:'/images/chair.jpg',design:{desktop:{order:-1},mobile:{order:2}}}),node('Heading','title',{level:'h1',text:'Title',design:{mobile:{order:0}}}),node('Text','hidden',{text:'Hidden',design:{mobile:{display:'none'}}})],{stylePresetId:'two-columns',tokenBindings:{tablet:{columns:'three'}},design:{mobile:{columns:1}}})]);
  draft.theme.presets=[{id:'two-columns',name:'Two columns',design:{desktop:{columns:2}}}];draft.theme.tokens=[{id:'three',name:'Three',value:3}];
  const value=inspectAiBuildLayout(draft,['home']).pages[0].sections[0];assert.equal(value.desktop.columns,2);assert.equal(value.tablet.columns,3);assert.equal(value.mobile.columns,1);assert.deepEqual(value.desktop.flow,['image','title','copy']);assert.deepEqual(value.mobile.flow,['title','image']);
});
test('CTA只显示真实引用目标，动态链接不伪装静态地址，目录字段不凭空声称SKU',()=>{
  const draft=source([box('hero',[node('ActionButton','a',{text:'Discuss',href:'/wrong',linkTarget:{kind:'page',id:'contact'}}),node('ActionButton','dynamic',{text:'Record',href:'/wrong',bindings:{href:{source:'product',field:'builtin:url'}}}),node('ContentList','products',{source:'product',columns:3,mobileColumns:1,titleField:'builtin:name',descriptionField:'builtin:description',imageField:'builtin:image',linkField:'builtin:url'})])]);draft.pages.push({...draft.pages[0],id:'contact',title:'Contact',slug:'/new-site/contact'});
  const value=inspectAiBuildLayout(draft,['home']).pages[0].sections[0];assert.equal(value.desktop.actions[0].path,'/new-site/contact');assert.equal(value.desktop.actions[1].path,undefined);assert.equal(value.desktop.actions[1].dynamic,true);assert.equal(value.desktop.lists[0].columns,3);assert.equal(value.mobile.lists[0].columns,1);assert.ok(!value.desktop.lists[0].fields.includes('builtin:sku'));
});
test('详情与未采用模板分开，匹配真实动态地址而不误配额外尾段',()=>{
  const draft=source([box('hero',[node('Heading','h',{level:'h1',text:'Home'})])]);draft.pages.push({...draft.pages[0],id:'detail',title:'Detail',slug:'/products/:slug'});draft.editorData.detail={root:{props:{}},content:[node('ProductDetail','details')]};draft.pageTemplates=[{id:'new-template',name:'Unapplied detail',description:'',kind:'product',sourcePath:'/products/:slug',updated:'2026-11-17T00:00:00Z',data:{root:{props:{}},content:[node('ProductDetail','template-details')]}}];
  const result=inspectAiBuildLayout(draft,['home','detail'],['new-template']);assert.equal(result.pages.filter(page=>page.kind==='template').length,1);assert.equal(matchAiInspectionPage(result,'/products/actual-product')?.id,'detail');assert.equal(matchAiInspectionPage(result,'/products/actual-product/extra'),undefined);assert.deepEqual(result.pages.find(page=>page.id==='detail')!.sections[0].mobile.flow,['details']);
});
test('没有可用src的Image不能充作已生成图片；编号只计算实际编号节点',()=>{
  const value=inspectAiBuildLayout(source([box('hero',[node('Image','empty',{src:''}),node('Text','number',{text:'01',nodeLabel:'条目编号'}),node('Text','body',{text:'Use a numbered process in future'})])]),['home']).pages[0].sections[0];assert.ok(!value.desktop.flow.includes('image'));assert.equal(value.desktop.numberedItems,1);
});
test('卡片首个内容区分别按各尺寸真实排序，不能把桌面首区当作手机首区',()=>{
  const result=inspectAiBuildLayout(source([box('desktop-first',[node('Heading','h',{level:'h1',text:'Title'})],{design:{mobile:{order:2}}}),box('mobile-first',[node('Image','i',{src:'/images/chair.jpg'})],{design:{mobile:{order:-1}}})]),['home']);
  const markup=renderToStaticMarkup(React.createElement(AiBuildDirectionFacts,{inspection:result}));const phone=markup.slice(markup.indexOf('手机'));assert.ok(phone.includes('图片'));assert.ok(!phone.includes('主标题'),'手机先出现的应该是图片区，不能套用桌面标题区');
});
test('实际视口断点700/1024与原生容器查询一致，不把窄桌面预览强称桌面',()=>{assert.equal(aiLayoutDeviceForWidth(700),'mobile');assert.equal(aiLayoutDeviceForWidth(701),'tablet');assert.equal(aiLayoutDeviceForWidth(1024),'tablet');assert.equal(aiLayoutDeviceForWidth(1025),'desktop');});

test('编号窄轨与正文宽区不能被说明成八个文字栏，全跨内容如实显示通栏',()=>{
  const actual=inspectAiBuildLayout(source([box('hero',[node('Heading','h',{level:'h1',text:'Title'})])]),['home']).pages[0].sections[0].mobile;
  assert.equal(aiLayoutColumnLabel({...actual,innerGrids:[{columns:8,spans:[1,7,8]}]}),'主区1列 · 内部宽窄分区');
  assert.equal(aiLayoutColumnLabel({...actual,innerGrids:[{columns:8,spans:[8,8]}]}),'主区1列 · 内部通栏排列');
  assert.equal(aiLayoutColumnLabel({...actual,innerGrids:[{columns:4,spans:[2,2]}]}),'主区1列 · 内部2列');
  assert.equal(aiLayoutColumnLabel({...actual,innerGrids:[{columns:2,spans:[1,1]}]}),'主区1列 · 内部2列');
  assert.equal(aiLayoutColumnLabel({...actual,visible:false,innerGrids:[{columns:8,spans:[1,7]}]}),'本尺寸隐藏');
});

test('只有手机显示的条目编号仍须计入方向说明，隐藏桌面不能被误报为全站没有编号',()=>{
  const inspection=inspectAiBuildLayout(source([box('hero',[node('Heading','h',{level:'h1',text:'Title'}),node('Text','number',{text:'01',nodeLabel:'条目编号',design:{desktop:{display:'none'},mobile:{display:'block'}}})])]),['home']);
  assert.equal(inspection.pages[0].sections[0].desktop.numberedItems,0);assert.equal(inspection.pages[0].sections[0].mobile.numberedItems,1);
  assert.equal(aiLayoutNumberedLabel(inspection),`编号条目位于：${inspection.pages[0].title}（桌面0项 / 手机1项）`);
});

test('正文恰为两位数字仍是正文；旧035真实编号形状保持可识别',()=>{
  const plain=inspectAiBuildLayout(source([box('hero',[node('Text','body',{text:'25',size:17,maxWidth:820})])]),['home']).pages[0].sections[0];
  assert.equal(plain.mobile.numberedItems,0);assert.deepEqual(plain.mobile.flow,['copy']);
  const legacy=inspectAiBuildLayout(source([box('hero',[node('Text','legacy-number',{text:'01',size:15,maxWidth:120,design:{desktop:{fontFamily:'mono',fontWeight:600}}})])]),['home']).pages[0].sections[0];
  assert.equal(legacy.mobile.numberedItems,1);
});
