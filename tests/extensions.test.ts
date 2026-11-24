import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Render} from '@puckeditor/core/rsc';
import {createInitialDraft} from '../src/server/seed';
import {normalizeExtensionProps,extensionReferences,extensionSourceErrors,migrateExtensionData,SPEC_TYPE} from '../src/extensions/registry';
import {CORE_COMPONENT_TYPES,componentCompatibilityErrors,isComponentNodeId} from '../src/lib/component-contract';
import {createSiteConfig} from '../src/lib/site-render-config';
import {remapPortableSite} from '../src/server/portable-site';
import {compileDesignCss,validateDesign,resolveDesign} from '../src/lib/responsive-style';
import {advancedLayoutErrors,usesAdvancedLayout} from '../src/lib/advanced-layout';
import {validatePageData} from '../src/server/validation';
import {outsideRect} from '../src/lib/layout-diagnostics';
import type {SiteSnapshot} from '../src/server/types';
const props=()=>({id:'spec',extensionVersion:2,title:'Verified <spec>',caption:'Synthetic only',rows:[{label:'Material',value:'Customer-provided'}, {label:'Text',value:'<script>alert(1)</script>'}],productId:'p1',fileUrl:''});
const data=(value=props())=>({root:{props:{showChrome:'no'}},content:[{type:SPEC_TYPE,props:value}]});
const snapshot=():SiteSnapshot=>{const s=createInitialDraft();return {...s,schemaVersion:15,products:s.products.map(p=>({...p,status:'published'})),pages:s.pages.map(p=>({...p,status:'published'})),editorData:{...s.editorData,home:data()}};};
test('规格schema与v1迁移不执行内容，未知版本/属性/超限行明确拒绝且不改原值',()=>{
 const old={id:'old-spec',extensionVersion:1,title:'Legacy',items:[{name:'Width',value:'120 cm'}]},before=structuredClone(old),normalized=normalizeExtensionProps(SPEC_TYPE,old);assert.equal(normalized.extensionVersion,2);assert.deepEqual(normalized.rows,[{label:'Width',value:'120 cm'}]);assert.deepEqual(old,before);assert.equal((migrateExtensionData({content:[{type:SPEC_TYPE,props:old}]}).content[0].props as unknown as {extensionVersion:number}).extensionVersion,2);
 for(const value of [{...props(),extensionVersion:3},{...props(),module:'https://attacker.invalid/source.js'},{...props(),rows:Array.from({length:51},()=>({label:'a',value:'b'}))},{...props(),rows:[{label:'a',value:'b',onclick:'x'}]},{...props(),fileUrl:'javascript:alert(1)'}])assert.throws(()=>normalizeExtensionProps(SPEC_TYPE,value));
 assert.ok(componentCompatibilityErrors(data(),CORE_COMPONENT_TYPES).some(e=>e.includes('未知组件')),'缺注册组件不能进入Puck');assert.ok(componentCompatibilityErrors(data({...props(),extensionVersion:99})).some(e=>e.includes('不支持')),'未来版本保留但阻止编辑');
 const s=snapshot(),html=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...s,pageId:'home'}),data:data() as never}));assert.ok(html.includes('data-extension="studio/SpecificationTable"'),'实际扩展渲染');assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),'纯业务文字转义');assert.ok(!html.includes('<script>alert(1)</script>'),'不能执行插入的JSON文字');
});
test('组件资源/产品引用按契约提取与映射，不误改规格业务值',()=>{
 const s=snapshot();s.media=[{id:'pdf',name:'Catalog',kind:'document',url:'/api/media/catalog',folder:'',alt:'',size:'1KB'}];s.editorData.home=data({...props(),fileUrl:'/api/media/catalog',rows:[{label:'Code',value:'p1 /api/media/catalog'}]});assert.deepEqual(extensionSourceErrors(s),[]);assert.deepEqual(extensionReferences(SPEC_TYPE,(s.editorData.home as ReturnType<typeof data>).content[0].props),{products:['p1'],media:['/api/media/catalog']});
 const mapped=remapPortableSite(s,{namespace:'spec-qa',prefix:'copy',merge:true,skuPrefix:'COPY-',enableJs:false}),node=(mapped.site.editorData[mapped.id('page','home')] as ReturnType<typeof data>).content[0];assert.equal(node.props.productId,mapped.id('product','p1'));assert.equal(node.props.fileUrl,mapped.site.media[0].url);assert.equal(node.props.rows[0].value,'p1 /api/media/catalog');assert.deepEqual(extensionSourceErrors(mapped.site),[]);assert.ok(extensionSourceErrors({...s,products:[]}).some(e=>e.includes('产品')),'强引用目标必须明确存在');assert.ok(extensionSourceErrors({...s,media:[]}).some(e=>e.includes('PDF')),'文档类型和依赖不可省略');
});
test('高级定位白名单/容器边界/三端覆盖/有限交互位移与旧布局隔离',()=>{
 assert.deepEqual(validateDesign({desktop:{position:'absolute',top:12,left:20,zIndex:4,translateX:-10,overflow:'clip'},mobile:{position:'flow',top:'auto',left:'auto',translateX:0}}),[]);for(const design of [{desktop:{position:'fixed'}},{desktop:{zIndex:9999}},{desktop:{zIndex:1.2}},{mobile:{translateX:'calc(1px)'}}])assert.ok(validateDesign(design).length,'不允许逃出受控属性');
 const child={type:'Heading',props:{id:'floating',text:'Badge',design:{desktop:{position:'absolute',top:8,right:8},mobile:{position:'flow',top:'auto',right:'auto'}}}},contained={root:{props:{}},content:[{type:'Container',props:{id:'bounds',content:[child],design:{desktop:{minHeight:180}}}}]};assert.doesNotThrow(()=>validatePageData(contained,'Contained',true));assert.throws(()=>validatePageData({root:{props:{}},content:[child]},'Unbounded',true),/显式容器/);
 const s=snapshot();s.editorData.home={root:{props:{}},content:[{type:'Heading',props:{id:'token-abs',text:'Float',stylePresetId:'absolute'}}]};s.theme.presets=[{id:'absolute',name:'Absolute',design:{desktop:{position:'absolute'}}}];assert.ok(advancedLayoutErrors(s).length,'复用样式不能绕过显式容器规则');assert.equal(usesAdvancedLayout({content:[{type:'Text',props:{id:'old',text:'old'}}]},s.theme),false);assert.equal(usesAdvancedLayout(s.editorData.home,s.theme),true);
 const css=compileDesignCss('badge',child.props.design,'Heading');assert.ok(css.includes('position:absolute')&&css.includes('@container form-site (max-width:700px)')&&css.includes('position:static'),'三端由统一编译器生成');const shift=compileDesignCss('shift',{desktop:{translateX:10},mobile:{translateY:-8}},'Text');assert.ok(shift.includes('--fs-shift-x:10px')&&shift.includes('--fs-shift-y:-8px'),'独立位移轴避免覆盖继承');assert.equal(resolveDesign(child.props.design,'mobile').position,'flow');
 const rect={left:10,right:100,top:10,bottom:100,width:90,height:90},bounds={left:0,right:390,top:0,bottom:600,width:390,height:600};assert.equal(outsideRect(rect,bounds,true),false);assert.equal(outsideRect({...rect,right:410},bounds),true);
});
test('无照片产品不输出空img或破图，详情使用无图布局',()=>{const s=snapshot();s.products[0].image='';const html=renderToStaticMarkup(React.createElement(Render,{config:createSiteConfig({...s,pageId:'product-detail',previewProductId:'p1'}),data:{root:{props:{showChrome:'no'}},content:[{type:'ProductDetail',props:{id:'detail',productId:'p1'}}]}}));assert.ok(html.includes('editor-site-detail-no-image'),'无图详情布局');assert.ok(!html.includes('<img'),'不输出空src的图片');});

test('Puck命名空间类型生成的节点ID可保存，其他路径和属性标识边界不放宽',()=>{
 const id='studio/SpecificationTable-00000000-0000-4000-a000-000000000000';assert.equal(isComponentNodeId(id),true);assert.doesNotThrow(()=>validatePageData(data({...props(),id}),'Namespaced node',true));for(const value of ['../node','a:b','a//b','__proto__','a\\b'])assert.equal(isComponentNodeId(value),false,'节点ID不能含路径回退、区域分隔符或原型键');
});
