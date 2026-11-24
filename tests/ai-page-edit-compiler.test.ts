import test from 'node:test';
import assert from 'node:assert/strict';
import type { Data } from '@puckeditor/core';
import { createEmptyDraft } from '../src/server/seed';
import { prepareAiPageEdit, compileAiPageEdit, sameAiPageData } from '../src/lib/ai-page-edit';
import type { AiPageEditRequest } from '../src/lib/ai-page-edit-types';

function fixture() {
  const content = createEmptyDraft();
  content.editorData.home = { root:{props:{title:'Home',showChrome:'no'}}, content:[{type:'Container',props:{content:[
    {type:'Heading',props:{id:'title',text:'Furniture for projects',level:'h1',size:48}},
    {type:'Text',props:{id:'copy',text:'Wooden furniture made for commercial spaces. Missing data: confirm all project specifications.'}},
    {type:'Image',props:{id:'photo',src:'/images/chair.jpg',alt:'Illustrative chair'}},
    {type:'Heading',props:{id:'bound',text:'DYNAMIC_FALLBACK_PRIVATE',level:'h2',bindings:{text:{source:'product',field:'builtin:name'}}}},
    {type:'ActionButton',props:{id:'cta',text:'Contact us',href:'mailto:public@example.invalid'}},
  ],id:'hero',layout:'column',columns:1,mobileColumns:1,gap:24,design:{desktop:{backgroundImage:'/images/chair.jpg',color:'#172033'}}}},
  {type:'Container',props:{id:'footer',content:[{type:'Text',props:{id:'footer-copy',text:'UNSELECTED_FOOTER_PRIVATE'}}]}}],zones:{} } as Data;
  content.settings.email='PRIVATE_EMAIL_DO_NOT_SEND';content.products=[{id:'private-product',name:'PRIVATE_PRODUCT_DO_NOT_SEND',sku:'P1',category:'Private',description:'Private product details',material:'Private material',status:'draft',image:''}];
  return content;
}
const request = (extra:Partial<AiPageEditRequest>={}):AiPageEditRequest => ({pageId:'home',targetId:'hero',expectedRevision:0,instruction:'调整图文结构，手机保持单列',mode:'design',preserveText:true,lockedIds:[],...extra});
const output=(operations:unknown[])=>({summary:'调整本区块结构，Missing data: confirm specifications.',operations,warnings:[]});

test('所选范围上下文只含白名单/语言，绑定、图片URL、未选页和业务原文不外发',()=>{
  const content=fixture(),prepared=prepareAiPageEdit(content,request()),encoded=JSON.stringify(prepared.context);
  assert.match(encoded,/Furniture for projects/);assert.equal(prepared.context.page.language,'en');
  assert.doesNotMatch(encoded,/PRIVATE_EMAIL|PRIVATE_PRODUCT|UNSELECTED_FOOTER|DYNAMIC_FALLBACK|\/images\/chair.jpg|mailto:/);
  assert.equal(prepared.context.nodes.find(node=>node.id==='bound')?.editableText,false);
});
test('普通容器新增/移动/重排产生可编辑结构，原图片链接绑定和外部范围逐字保持',()=>{
  const content=fixture(),before=structuredClone(content),result=compileAiPageEdit(content,request(),output([
    {kind:'insert',parentId:'hero',index:0,node:{tempId:'new-copy',type:'Container',design:{mobile:{columnSpan:1}}}},
    {kind:'move',id:'title',parentId:'new-copy',index:0},{kind:'move',id:'copy',parentId:'new-copy',index:1},
    {kind:'layout',id:'hero',layout:'grid',columns:2,gap:32},{kind:'design',id:'photo',design:{desktop:{columnSpan:1},mobile:{columnSpan:1,width:'100%'}}},
  ]),'unit');
  const hero=result.data.content[0],children=hero.props.content;assert.equal(children[0].type,'Container');assert.deepEqual(children[0].props.content.map((node:{props:{id:string}})=>node.props.id),['title','copy']);
  assert.equal(hero.props.design.mobile.columns,1);assert.deepEqual(result.data.content[1],(before.editorData.home as Data).content[1]);assert.deepEqual(content,before);
  for(const id of ['photo','bound','cta']){const old=(before.editorData.home as Data).content[0].props.content.find((node:{props:{id:string}})=>node.props.id===id),next=children.find((node:{props:{id:string}})=>node.props.id===id);for(const key of ['src','href','bindings'])assert.deepEqual(next.props[key],old.props[key]);}
});
test('自动锁/人工锁保护子树、位置、祖先样式和继承布局，不通过父容器绕过',()=>{
  const content=fixture(),data=content.editorData.home as Data;data.content[0].props.content[0].props.locked=true;
  for(const operations of [[{kind:'design',id:'title',design:{desktop:{fontSize:30}}}],[{kind:'layout',id:'hero',layout:'grid',columns:2}],[{kind:'reorder',id:'hero',children:['copy','title','photo','bound','cta']}]]) assert.throws(()=>compileAiPageEdit(content,request(),output(operations),'unit'),/锁定/);
  assert.throws(()=>compileAiPageEdit(fixture(),request({lockedIds:['copy']}),output([{kind:'move',id:'copy',parentId:'hero',index:5}]),'unit'),/锁定/);
  assert.throws(()=>prepareAiPageEdit(content,request({lockedIds:['footer']})),/范围/);
});
test('修改只在所选范围，不能操作外部元素、替换图片绑定或删除已有元素',()=>{
  for(const op of [{kind:'design',id:'footer-copy',design:{desktop:{fontSize:30}}},{kind:'text',id:'bound',text:'Fake product'},{kind:'image',id:'photo',src:'https://example.invalid'},{kind:'reorder',id:'hero',children:['title']},{kind:'design',id:'photo',design:{desktop:{backgroundImage:'/images/chair.jpg'}}}])assert.throws(()=>compileAiPageEdit(fixture(),request({mode:'mixed',preserveText:false}),output([op]),'unit'));
});
test('保留文字和只改文字模式约束明确；真实比较符和Missing data不误拦',()=>{
  assert.throws(()=>compileAiPageEdit(fixture(),request(),output([{kind:'text',id:'copy',text:'Changed'}]),'unit'),/保留文字/);
  assert.throws(()=>compileAiPageEdit(fixture(),request({mode:'copy',preserveText:false}),output([{kind:'layout',id:'hero',layout:'grid'}]),'unit'),/只改文字/);
  const result=compileAiPageEdit(fixture(),request({mode:'copy',preserveText:false}),output([{kind:'text',id:'copy',text:'Tolerance < 0.1 mm; Missing data: confirm material.'}]),'unit');assert.match(result.data.content[0].props.content[1].props.text,/< 0.1/);
  assert.throws(()=>compileAiPageEdit(fixture(),request({mode:'copy',preserveText:false}),output([{kind:'text',id:'title',text:''}]),'unit'),/新文字/);
});
test('不可插执行元素、HTML、无效断点、隐藏/定位、越界尺寸与多余操作属性',()=>{
  const invalid=[{kind:'insert',parentId:'hero',index:0,node:{tempId:'new-script',type:'Script'}},{kind:'text',id:'copy',text:'<img src=x onerror=alert(1)>'},{kind:'design',id:'copy',design:{tablet2:{fontSize:20}}},{kind:'design',id:'copy',design:{mobile:{display:'none'}}},{kind:'design',id:'copy',design:{desktop:{position:'absolute'}}},{kind:'design',id:'photo',design:{mobile:{width:2000}}},{kind:'layout',id:'hero',layout:'grid',columns:12},{kind:'layout',id:'hero',layout:'grid',script:'alert(1)'}];
  for(const op of invalid)assert.throws(()=>compileAiPageEdit(fixture(),request({mode:'mixed',preserveText:false}),output([op]),'unit'));
});
test('空变更、移动环路、移动范围根和旧非空zones在调用前后清楚拒绝',()=>{
  assert.throws(()=>compileAiPageEdit(fixture(),request(),output([]),'unit'),/1–80/);
  assert.throws(()=>compileAiPageEdit(fixture(),request(),output([{kind:'move',id:'hero',parentId:'hero',index:0}]),'unit'),/根节点|自身/);
  const c=fixture();(c.editorData.home as Data).zones={'hero:legacy':[{type:'Text',props:{id:'legacy',text:'Keep'}}]};assert.throws(()=>prepareAiPageEdit(c,request()),/旧插槽/);
  assert.throws(()=>compileAiPageEdit(fixture(),request(),output([{kind:'design',id:'copy',design:{}}]),'unit'),/不能为空/);
});
test('新增副本不会更换原节点ID，纯文字新增仅混合模式，限制插入层数与数量',()=>{
  const result=compileAiPageEdit(fixture(),request({mode:'mixed',preserveText:false}),output([{kind:'insert',parentId:'hero',index:1,node:{tempId:'new-note',type:'Heading',level:'h3',text:'Discuss your project'}}]),'unit');
  assert.equal(result.data.content[0].props.content[1].props.id,'aie-unit-1');assert.equal(result.data.content[0].props.content[0].props.id,'title');
  assert.throws(()=>compileAiPageEdit(fixture(),request(),output([{kind:'insert',parentId:'hero',index:0,node:{tempId:'new-note',type:'Text',text:'Fake certification'}}]),'unit'),/保留文字/);
  assert.throws(()=>compileAiPageEdit(fixture(),request(),output(Array.from({length:25},(_,i)=>({kind:'insert',parentId:'hero',index:0,node:{tempId:`new-${i}`,type:'Spacer'}}))),'unit'),/数量/);
});
test('锁定原文不出上下文，200节点/40000字符明确拒绝，不静默裁切',()=>{
  const encoded=JSON.stringify(prepareAiPageEdit(fixture(),request({lockedIds:['copy']})).context);assert.doesNotMatch(encoded,/Wooden furniture made/);
  const c=fixture(),hero=(c.editorData.home as Data).content[0];hero.props.content=Array.from({length:201},(_,i)=>({type:'Text',props:{id:`large-${i}`,text:'Text'}}));assert.throws(()=>prepareAiPageEdit(c,request()),/1–200/);
  hero.props.content=Array.from({length:10},(_,i)=>({type:'Text',props:{id:`large-${i}`,text:'A'.repeat(5000)}}));assert.throws(()=>prepareAiPageEdit(c,request()),/上下文上限/);
});
test('稳定结构比较忽略键顺序，保留真实数组重排与0/false差异',()=>{
  assert.equal(sameAiPageData({a:0,b:false},{b:false,a:0}),true);assert.equal(sameAiPageData([1,2],[2,1]),false);assert.equal(sameAiPageData({a:0},{a:false}),false);
});
test('锁定范围根在调用前拒绝，锁图alt和动态文字范围标签都不泄漏原文',()=>{
  const c=fixture(),hero=(c.editorData.home as Data).content[0];hero.props.content[2].props.locked=true;hero.props.content[2].props.alt='PRIVATE_LOCKED_IMAGE_ALT';
  assert.doesNotMatch(JSON.stringify(prepareAiPageEdit(c,request()).context),/PRIVATE_LOCKED_IMAGE_ALT/);
  assert.throws(()=>prepareAiPageEdit(c,request({targetId:'photo'})),/锁定/);
  assert.doesNotMatch(JSON.stringify(prepareAiPageEdit(c,request({targetId:'bound'})).context),/DYNAMIC_FALLBACK_PRIVATE/);
});

test('可新增有独立拖拽内容的折叠面板，并把旧面板正文原样转换成可编辑子节点',()=>{
  const content=fixture(), data=content.editorData.home as Data, hero=data.content[0];
  const oldBody='First paragraph.\n\nSecond paragraph.  ';
  hero.props.content.push({type:'Accordion',props:{id:'legacy-panel',items:[{id:'story',title:'Confirmed notes',body:oldBody}],firstOpen:true,design:{mobile:{gap:12}}}});
  assert.equal(prepareAiPageEdit(content,request()).context.nodes.find(node=>node.id==='legacy-panel')?.panelMode,'legacy');
  const result=compileAiPageEdit(content,request(),output([
    {kind:'accordionFree',id:'legacy-panel'},
    {kind:'insert',parentId:'hero',index:6,node:{type:'Accordion',tempId:'new-accordion',items:[{titleFrom:'title'},{}],firstOpen:true}},
    {kind:'move',id:'copy',parentId:'new-accordion',slot:'items[0].content',index:0},
    {kind:'move',id:'photo',parentId:'new-accordion',slot:'items[1].content',index:0},
    {kind:'insert',parentId:'legacy-panel',slot:'items[0].content',index:1,node:{type:'Divider',tempId:'new-divider'}},
  ]),'accordion');
  const children=result.data.content[0].props.content;
  const legacy=children.find((node:{props:{id:string}})=>node.props.id==='legacy-panel');
  const created=children.find((node:{props:{id:string}})=>node.props.id==='aie-accordion-2');
  assert.deepEqual([legacy.props.panelMode,legacy.props.firstOpen,legacy.props.items[0].id,legacy.props.items[0].title,legacy.props.items[0].content[0].props.text],['free',true,'story','Confirmed notes',oldBody]);
  assert.deepEqual(legacy.props.design,{mobile:{gap:12}});
  assert.equal(legacy.props.items[0].content[1].type,'Divider');
  assert.deepEqual(created.props.items.map((item:{title:string;content:Array<{props:{id:string}}>})=>[item.title,item.content.map(node=>node.props.id)]),[['Furniture for projects',['copy']],['Section 2',['photo']]]);
  assert.equal(children[0].props.level,'h1');
  assert.equal(hero.props.content[5].props.panelMode,undefined);

  const insert=(items:unknown[])=>({kind:'insert',parentId:'hero',index:6,node:{type:'Accordion',tempId:'new-panel',items}});
  for(const operation of [insert([{title:'Invented claims'}]),insert([{titleFrom:'bound'}]),insert([{titleFrom:'footer-copy'}]),insert([{content:[{type:'Text',props:{text:'arbitrary'}}]}])])assert.throws(()=>compileAiPageEdit(content,request(),output([operation]),'invalid'));
  for(const constraints of [{viewport:'mobile' as const},{mode:'copy' as const},{lockedIds:['legacy-panel']}])assert.throws(()=>compileAiPageEdit(content,request(constraints),output([{kind:'accordionFree',id:'legacy-panel'}]),'invalid'));
});
