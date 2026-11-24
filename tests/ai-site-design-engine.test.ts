import test from 'node:test';
import assert from 'node:assert/strict';
import type { Data } from '@puckeditor/core';
import type { AiSiteDesignRequest } from '../src/lib/ai-site-design-types';
import { analyzeAiSiteDesignImpact, compileAiSiteDesign, prepareAiSiteDesign } from '../src/lib/ai-site-design';
import { createEmptyDraft } from '../src/server/seed';
import { validateDraft } from '../src/server/validation';
import { createStarterSnapshot } from '../src/lib/starter-kits';
import type { DraftContent } from '../src/server/types';
import { prepareAiPageEdit } from '../src/lib/ai-page-edit';

function fixture() {
  const source=createEmptyDraft();source.settings={...source.settings,name:'Actual Factory',description:'Manufacturing recorded products for project buyers.',email:'factory@example.test',language:'en',locales:[{code:'en',label:'English'},{code:'de',label:'Deutsch'}]};
  source.pages=['home','about','contact'].map((id,index)=>({id,title:['Home','About factory','Contact'][index],slug:index?`/${id}`:'/',status:'draft',type:'普通页面',updated:'2026-11-12'}));
  source.editorData=Object.fromEntries(source.pages.map(page=>[page.id,{root:{props:{title:page.title,brand:'',showChrome:'yes'}},content:[{type:'Container',props:{id:`${page.id}-frame`,layout:'column',columns:1,mobileColumns:1,gap:24,padding:24,inset:24,content:[{type:'Heading',props:{id:`${page.id}-title`,level:'h1',text:page.title,size:40,mobileSize:28}},{type:'Text',props:{id:`${page.id}-copy`,text:'Confirmed factory information.',size:16}}]}}],zones:{}}]));
  source.siteLayout={header:{mode:'default',blockId:''},footer:{mode:'default',blockId:''},menus:[]};return source;
}
const request=(source=fixture(),extra:Partial<AiSiteDesignRequest>={}):AiSiteDesignRequest=>({expectedRevision:0,instruction:'统一网站的页眉页脚、导航和各页风格，保留已有真实企业资料。',targets:{pageIds:source.pages.map(page=>page.id),header:true,footer:true,navigation:true,style:true},preserveText:false,...extra});
const result=(operations:unknown[])=>({summary:'依据真实资料统一网站设计。',intent:{goal:'让采购客户容易了解公司并找到产品',decisions:['统一头尾与字体节奏'],preserve:['真实企业资料'],assumptions:[]},operations,warnings:[]});

test('头尾影响按普通页语言和动态记录实际覆盖语言判断，隐藏映射仍不冒充可见变化', () => {
  const before = fixture(); before.pages.push({ id: 'german-home', title: 'Deutsch', slug: '/de', locale: 'de', status: 'draft', type: '普通页面', updated: '' }, { id: 'dynamic-products', title: 'Products detail', slug: '/products/:slug', status: 'draft', type: 'product-detail', updated: '' });
  before.editorData['german-home'] = structuredClone(before.editorData.home); before.editorData['dynamic-products'] = structuredClone(before.editorData.home);
  before.products = [{ id: 'de-product', name: 'German product', locale: 'de', sku: '', material: '', category: '', description: '', image: '', status: 'draft' }];
  const block = (id: string, text: string) => ({ id, name: id, updated: '', data: { root: { props: {} }, content: [{ type: 'Text', props: { id: `${id}-text`, text } }] } });
  before.sharedBlocks = [block('en-header', 'English header'), block('de-header', 'Deutscher Kopf')]; before.siteLayout!.header = { mode: 'block', blockId: 'en-header', localeBlockIds: { de: 'de-header' } };
  let after = structuredClone(before); after.sharedBlocks![0].data.content[0].props.text = 'New English header';
  assert.deepEqual(analyzeAiSiteDesignImpact(before, after).map(item => item.pageId).sort(), ['home', 'about', 'contact'].sort());
  after = structuredClone(before); after.sharedBlocks![1].data.content[0].props.text = 'Neuer deutscher Kopf'; assert.deepEqual(analyzeAiSiteDesignImpact(before, after).map(item => item.pageId).sort(), ['german-home', 'dynamic-products'].sort());
  before.products.push({ ...before.products[0], id: 'en-product', locale: 'en' }); after = structuredClone(before); after.sharedBlocks![0].data.content[0].props.text = 'English update'; assert.ok(analyzeAiSiteDesignImpact(before, after).some(item => item.pageId === 'dynamic-products'));
  before.siteLayout!.header.mode = 'default'; after = structuredClone(before); after.sharedBlocks![1].data.content[0].props.text = 'Visible German default variant'; assert.ok(analyzeAiSiteDesignImpact(before, after).some(item => item.pageId === 'german-home'));
  before.siteLayout!.header.mode = 'hidden'; after = structuredClone(before); after.sharedBlocks![1].data.content[0].props.text = 'Hidden map backup'; assert.deepEqual(analyzeAiSiteDesignImpact(before, after), []);
});

test('默认十页案例的紧凑上下文在真实模型预算内，包含实际可定位节点但没有产品库或链接地址',()=>{
  const snapshot=createStarterSnapshot('manufacturing'),source={...snapshot} as unknown as DraftContent;
  const prepared=prepareAiSiteDesign(source,request(source)),json=JSON.stringify(prepared.context);
  assert.equal(source.pages.length,10);assert.ok(json.length<120000,`default context ${json.length}`);assert.equal(prepared.context.pages.length,10);
  assert.ok(prepared.context.globalOperationsAllowed);assert.ok(prepared.context.chrome.header);assert.ok(prepared.context.pages.find(page=>page.slug==='/')?.editable);assert.doesNotMatch(json,/\/api\/media\//);assert.equal('products'in prepared.context,false);
});

test('默认头尾可生成有真实公司资料的原生独立区块，导航有效，原资料不改且候选能通过整站校验',()=>{
  const source=fixture(),before=structuredClone(source),compiled=compileAiSiteDesign(source,request(source),result([
    {kind:'chrome',slot:'header',operations:[{kind:'design',id:'site-header-frame',design:{desktop:{paddingTop:30,paddingBottom:30},mobile:{gap:12}}}]},
    {kind:'chrome',slot:'footer',operations:[]},
    {kind:'navigation',slot:'header',items:[{label:'Home',pageId:'home'},{label:'Our factory',pageId:'about'},{label:'Contact',pageId:'contact'}]},
    {kind:'theme',theme:{font:'Inter',headingFont:'Arial',radius:8,defaults:{desktop:{lineHeight:1.6},mobile:{fontSize:16}}}},
  ]),'aisd-site-test');
  assert.deepEqual(source,before);assert.equal(compiled.generatedBlockIds.length,2);assert.equal(compiled.candidate.siteLayout?.header.mode,'block');assert.equal(compiled.affectedPages.length,3);
  assert.match(JSON.stringify(compiled.candidate.sharedBlocks),/Actual Factory|factory@example.test/);assert.doesNotMatch(JSON.stringify(compiled.candidate.sharedBlocks),/Your company|Considered objects/);
  for(const block of compiled.candidate.sharedBlocks||[]){assert.equal((block.data.root?.props as Record<string,unknown>)?.showChrome,'no');assert.equal((block.data.root?.props as Record<string,unknown>)?.title,'新页面');assert.deepEqual(block.data.zones,{});}
  assert.doesNotThrow(()=>validateDraft(compiled.candidate));
});

test('部分页可用原生操作同步布局，不能通过全局主题/头尾/导航暗改范围外页面',()=>{
  const source=fixture(),input=request(source,{targets:{pageIds:['home','about'],header:false,footer:false,navigation:false,style:false}});
  const compiled=compileAiSiteDesign(source,input,result([{kind:'page',pageId:'home',operations:[{kind:'design',id:'home-frame',design:{desktop:{gap:40},mobile:{gap:18}}}]},{kind:'page',pageId:'about',operations:[{kind:'design',id:'about-title',design:{desktop:{fontSize:52},mobile:{fontSize:30}}}]}]),'aisd-pages');
  assert.deepEqual(compiled.affectedPages.map(page=>page.pageId),['home','about']);assert.deepEqual(compiled.candidate.editorData.contact,source.editorData.contact);assert.deepEqual(compiled.candidate.theme,source.theme);
  assert.throws(()=>prepareAiSiteDesign(source,{...input,targets:{...input.targets,style:true}}),/全部页面/);
  assert.throws(()=>compileAiSiteDesign(source,input,result([{kind:'theme',theme:{font:'Arial'}}]),'aisd-no'),/不在本次范围/);
  assert.throws(()=>compileAiSiteDesign(source,input,result([{kind:'page',pageId:'contact',operations:[]}]),'aisd-no'),/范围之外/);
});

test('锁定页面或共享区块阻止全局继承绕过，局部节点仍交由原编译器强制保护',()=>{
  const source=fixture();(source.editorData.about as Data).content[0].props.locked=true;
  assert.equal(prepareAiSiteDesign(source,request(source)).context.globalOperationsAllowed,false);
  for(const op of [{kind:'theme',theme:{font:'Arial'}},{kind:'chrome',slot:'header',operations:[]},{kind:'navigation',slot:'header',items:[]}])assert.throws(()=>compileAiSiteDesign(source,request(source),result([op]),'aisd-lock'),/锁定/);
  const page=compileAiSiteDesign(source,request(source),result([{kind:'page',pageId:'home',operations:[{kind:'design',id:'home-title',design:{mobile:{fontSize:24}}}]}]),'aisd-safe');assert.deepEqual(page.candidate.editorData.about,source.editorData.about);
  const shared=fixture();shared.sharedBlocks=[{id:'locked-card',name:'Locked asset',updated:'2026-11-12',data:{root:{props:{}},content:[{type:'Text',props:{id:'locked',text:'Protected',locked:true}}]}}];assert.equal(prepareAiSiteDesign(shared,request(shared)).context.globalOperationsAllowed,false);
});

test('逐页隐藏与空白画布覆盖保留，头尾变化影响清单不误称所有页面都已展示',()=>{
  const source=fixture();(source.editorData.about as Data).root={props:{showChrome:'no'} as Data['root']['props']};(source.editorData.contact as Data).root={props:{headerMode:'hidden'} as Data['root']['props']};
  const compiled=compileAiSiteDesign(source,request(source),result([{kind:'chrome',slot:'header',operations:[]}]),'aisd-overrides');
  assert.deepEqual(compiled.affectedPages.map(page=>page.pageId),['home']);assert.deepEqual(compiled.candidate.editorData,source.editorData);assert.ok(compiled.warnings.some(warning=>warning.includes('独立页眉')));
});

test('已有自定义头尾克隆为独立原生资产；独立导航不被全局菜单重组覆盖',()=>{
  const source=fixture();source.siteLayout!.menus=[{id:'main-menu',name:'Main',items:[{id:'old-home',label:'Home',target:{kind:'page',id:'home'}}]},{id:'special',name:'Special',items:[{id:'old-contact',label:'Contact',target:{kind:'page',id:'contact'}}]}];source.siteLayout!.header={mode:'block',blockId:'old-header',menuId:'main-menu'};
  const data={root:{props:{showChrome:'no'}},content:[{type:'Container',props:{id:'original-header-frame',layout:'column',gap:24,content:[{type:'Text',props:{id:'original-brand',text:'Actual Factory'}},{type:'Navigation',props:{id:'main-nav',menuId:'main-menu'}},{type:'Navigation',props:{id:'special-nav',menuId:'special'}}]}}]} as Data;
  source.sharedBlocks=[{id:'old-header',name:'Original shared header',data,updated:'2026-11-12'}];const original=structuredClone(source.sharedBlocks[0]);
  const compiled=compileAiSiteDesign(source,request(source),result([{kind:'navigation',slot:'header',items:[{existingId:'old-home'},{label:'Factory',pageId:'about'}]}]),'aisd-clone');
  assert.deepEqual(compiled.candidate.sharedBlocks?.find(block=>block.id==='old-header'),original);const next=compiled.candidate.sharedBlocks!.find(block=>compiled.generatedBlockIds.includes(block.id))!;const children=next.data.content[0].props.content;assert.equal(children[2].props.menuId,'special');assert.notEqual(children[1].props.menuId,'main-menu');assert.doesNotThrow(()=>validateDraft(compiled.candidate));
});

test('导航只接受真实同语言页面或保留既有链接，不接受模型新URL及不存在目标',()=>{
  const source=fixture();source.siteLayout!.header.menuId='source-menu';source.siteLayout!.menus=[{id:'source-menu',name:'Menu',items:[{id:'manual-external',label:'Existing supplier',href:'https://supplier.example.test'}]}];
  const compiled=compileAiSiteDesign(source,request(source),result([{kind:'navigation',slot:'header',items:[{existingId:'manual-external'},{label:'Factory',pageId:'about'}]}]),'aisd-nav');
  const menu=compiled.candidate.siteLayout!.menus!.find(menu=>compiled.generatedMenuIds.includes(menu.id))!;assert.equal(menu.items[0].href,'https://supplier.example.test');assert.notEqual(menu.items[0].id,'manual-external');
  for(const item of [{label:'Bad',pageId:'missing'},{label:'Injected',pageId:'home',href:'https://new.example.test'},{existingId:'missing'},{label:'Dynamic',pageId:'detail'}])assert.throws(()=>compileAiSiteDesign(source,request(source),result([{kind:'navigation',slot:'header',items:[item]}]),'aisd-bad'));
});

test('局部导航语言替换保留默认语言与其它映射，不能借导航改页面地址',()=>{
  const source=fixture();source.pages.push({...source.pages[1],id:'about-de',slug:'/de/about',title:'Fabrik',locale:'de'});source.editorData['about-de']={root:{props:{showChrome:'yes'}},content:[]};source.siteLayout!.header={mode:'default',blockId:'',menuId:'english',localeMenuIds:{de:'german'}};source.siteLayout!.menus=[{id:'english',name:'English',items:[{id:'en-home',label:'Home',target:{kind:'page',id:'home'}}]},{id:'german',name:'German',items:[{id:'de-about',label:'Fabrik',target:{kind:'page',id:'about-de'}}]}];
  const compiled=compileAiSiteDesign(source,request(source),result([{kind:'navigation',slot:'header',locale:'de',items:[{label:'Fabrik',pageId:'about-de'}]}]),'aisd-locales');assert.equal(compiled.candidate.siteLayout!.header.menuId,'english');assert.notEqual(compiled.candidate.siteLayout!.header.localeMenuIds!.de,'german');assert.deepEqual(compiled.candidate.pages,source.pages);
  assert.throws(()=>compileAiSiteDesign(source,request(source),result([{kind:'navigation',slot:'header',locale:'de',items:[{label:'Wrong language',pageId:'home'}]}]),'aisd-language'),/同语言/);
});

test('未读长正文只给明确摘录并拒绝全文改写，但允许同步原生样式',()=>{
  const source=fixture();(source.editorData.home as Data).content[0].props.content[1].props.text='Document evidence. '.repeat(50);const input=request(source,{preserveText:false}),context=prepareAiSiteDesign(source,input).context.pages.find(page=>page.pageId==='home')!;
  assert.match(JSON.stringify(context),/textIsExcerpt/);assert.throws(()=>compileAiSiteDesign(source,input,result([{kind:'page',pageId:'home',operations:[{kind:'text',id:'home-copy',text:'A replacement.'}]}]),'aisd-long'),/长正文/);
  assert.doesNotThrow(()=>compileAiSiteDesign(source,input,result([{kind:'page',pageId:'home',operations:[{kind:'design',id:'home-copy',design:{mobile:{fontSize:18}}}]}]),'aisd-style'));
});

test('主题安全字段保留手工样式库和局部覆盖，拒绝任意设置/执行代码与空变更',()=>{
  const source=fixture();source.theme.tokens=[{id:'brand-gap',name:'Gap',value:24}];source.theme.presets=[{id:'manual',name:'Manual',design:{desktop:{fontSize:28}}}];
  const compiled=compileAiSiteDesign(source,request(source),result([{kind:'theme',theme:{font:'Arial',defaults:{desktop:{lineHeight:1.7}}}}]),'aisd-theme');assert.deepEqual(compiled.candidate.theme.tokens,source.theme.tokens);assert.deepEqual(compiled.candidate.theme.presets,source.theme.presets);assert.deepEqual(compiled.candidate.editorData,source.editorData);
  for(const op of [{kind:'theme',theme:{tokens:[]}},{kind:'theme',theme:{primary:'red'}},{kind:'theme',theme:{defaults:{desktop:{display:'none'}}}},{kind:'theme',theme:{radius:100}},{kind:'theme',theme:{font:source.theme.font}},{kind:'settings',settings:{name:'Changed'}}])assert.throws(()=>compileAiSiteDesign(source,request(source),result([op]),'aisd-unsafe'));
});

test('累计影响按最初与最终实际资源重新计算，反向改回不留下旧影响',()=>{
  const before=fixture(),after=structuredClone(before);after.theme.font='Arial';assert.equal(analyzeAiSiteDesignImpact(before,after).length,3);after.theme.font=before.theme.font;assert.deepEqual(analyzeAiSiteDesignImpact(before,after),[]);
});

test('默认站全页上下文可紧凑读取，旧单页40k限制不能由请求字段绕过',()=>{
  const source=createStarterSnapshot('manufacturing') as unknown as DraftContent,pageId=source.pages.find(page=>page.slug==='/')!.id;
  const input={pageId,expectedRevision:0,instruction:'只调整标题字号',mode:'design',preserveText:true,lockedIds:[]};
  assert.throws(()=>prepareAiPageEdit(source,input),/上下文上限/);
  assert.ok(prepareAiPageEdit(source,input,undefined,120000).context.nodes.length>0);
  assert.throws(()=>prepareAiPageEdit(source,{...input,contextLimit:120000}),/不支持的字段/);
  assert.throws(()=>prepareAiPageEdit(source,input,undefined,Infinity),/预算/);
});

test('头尾设计不勾导航时保留既有导航，默认footer无菜单不偷偷新增，内置header不可忠实复制时拒绝',()=>{
  const source=fixture(),input=request(source,{targets:{pageIds:source.pages.map(page=>page.id),header:true,footer:true,navigation:false,style:false}});
  assert.throws(()=>compileAiSiteDesign(source,input,result([{kind:'chrome',slot:'header',operations:[]}]),'aisd-scope'),/同时选择导航/);
  const footer=compileAiSiteDesign(source,input,result([{kind:'chrome',slot:'footer',operations:[]}]),'aisd-footer-scope');assert.deepEqual(footer.generatedMenuIds,[]);assert.equal(footer.candidate.siteLayout!.footer.menuId,undefined);assert.doesNotMatch(JSON.stringify(footer.candidate.sharedBlocks),/Navigation/);
  source.settings.locales=[{code:'en',label:'English'}];source.siteLayout!.header.menuId='existing';source.siteLayout!.menus=[{id:'existing',name:'Actual navigation',items:[{id:'original-contact',label:'Contact us',target:{kind:'page',id:'contact'}}]}];
  const header=compileAiSiteDesign(source,input,result([{kind:'chrome',slot:'header',operations:[]}]),'aisd-preserve-navigation');assert.deepEqual(header.generatedMenuIds,[]);assert.deepEqual(header.candidate.siteLayout!.menus,source.siteLayout!.menus);assert.match(JSON.stringify(header.candidate.sharedBlocks),/"menuId":"existing"/);
});

test('默认页眉导航忠实沿用原fallback真实项，品牌可返回真实首页，默认footer不新增导航',()=>{
  const source=fixture(),compiled=compileAiSiteDesign(source,request(source),result([{kind:'chrome',slot:'header',operations:[]},{kind:'chrome',slot:'footer',operations:[]}]),'aisd-fallback');
  const menu=compiled.candidate.siteLayout!.menus!.find(menu=>menu.id===compiled.candidate.siteLayout!.header.menuId)!;
  assert.deepEqual(menu.items.map(item=>[item.label,item.target?.id]),[['About factory','about'],['Contact','contact']]);
  const header=compiled.candidate.sharedBlocks!.find(block=>block.id===compiled.candidate.siteLayout!.header.blockId)!;
  const brand=header.data.content[0].props.content[0];assert.equal(brand.type,'Navigation');const brandMenu=compiled.candidate.siteLayout!.menus!.find(menu=>menu.id===brand.props.menuId)!;assert.deepEqual(brandMenu.items[0].target,{kind:'page',id:'home'});assert.equal(brandMenu.items[0].label,'Actual Factory');assert.equal(brand.props.design.desktop.borderWidth,0);
  const footer=compiled.candidate.sharedBlocks!.find(block=>block.id===compiled.candidate.siteLayout!.footer.blockId)!;assert.doesNotMatch(JSON.stringify(footer.data),/Navigation/);assert.equal(footer.data.content[0].props.anchor,'contact');
});

test('明确要求空白页跟随单侧全站区域时只开启所选一侧，锁定页拒绝间接移动',()=>{
  const source=fixture();(source.editorData.about as Data).root={props:{showChrome:'no'} as Data['root']['props']};
  const input=request(source,{targets:{pageIds:['about'],header:false,footer:false,navigation:false,style:false}});
  const compiled=compileAiSiteDesign(source,input,result([{kind:'pageChrome',pageId:'about',header:'inherit'}]),'aisd-page-override');
  assert.deepEqual((compiled.candidate.editorData.about as Data).root.props,{showChrome:'yes',headerMode:'inherit',footerMode:'hidden'});assert.deepEqual((compiled.candidate.editorData.about as Data).content,(source.editorData.about as Data).content);
  assert.deepEqual(compiled.affectedPages.map(page=>page.pageId),['about']);(source.editorData.about as Data).content[0].props.locked=true;
  assert.throws(()=>compileAiSiteDesign(source,input,result([{kind:'pageChrome',pageId:'about',header:'inherit'}]),'aisd-override-locked'),/锁定/);
});

test('有条件详情模板中的锁定内容也阻止全局继承绕过，并保留独立模板提示',()=>{
  const source=fixture();source.pageTemplates=[{id:'detail-template',name:'Private detail design',description:'',kind:'product',sourcePath:'/products/:slug',updated:'2026-11-12',detailRule:{enabled:true,priority:1},data:{root:{props:{}},content:[{type:'Text',props:{id:'template-copy',text:'Protected template',locked:true}}]}}];
  const prepared=prepareAiSiteDesign(source,request(source));assert.equal(prepared.context.globalOperationsAllowed,false);assert.ok(prepared.scope.warnings.some(warning=>warning.includes('独立详情模板')));
  assert.throws(()=>compileAiSiteDesign(source,request(source),result([{kind:'theme',theme:{font:'Arial'}}]),'aisd-template-lock'),/锁定/);
});

test('整站继续调整只接收范围内最多五页的有界几何反馈，不能夹带正文或跨页数据',()=>{
  const source=fixture(),report={viewport:'mobile',width:390,horizontalOverflow:false,brokenImages:0,pendingImages:0,smallText:0,smallTargets:0,headingCount:1,inspectedElements:12,truncated:false,issues:[]};
  const valid=prepareAiSiteDesign(source,{...request(source),previewFeedback:[{pageId:'home',reports:[report]}]});assert.deepEqual(valid.context.browserMeasurements,[{pageId:'home',reports:[report]}]);
  for(const feedback of [[{pageId:'missing',reports:[report]}],[{pageId:'home',reports:[report]},{pageId:'home',reports:[report]}],[{pageId:'home',reports:[{...report,body:'private'}]}],Array.from({length:6},()=>({pageId:'home',reports:[report]}))])assert.throws(()=>prepareAiSiteDesign(source,{...request(source),previewFeedback:feedback}));
});

test('保留原文不能用资料种子替换内置动态文案，已有原生头尾保留和默认导航整理仍可用',()=>{
  const source=fixture(),input=request(source,{preserveText:true}),context=prepareAiSiteDesign(source,input).context;
  assert.equal(context.chrome.header.canReplaceBuiltIn,false);assert.match(context.chrome.header.restriction!,/保留原文/);
  for(const slot of ['header','footer'] as const){
    assert.throws(()=>compileAiSiteDesign(source,input,result([{kind:'chrome',slot,operations:[]}]),`aisd-copy-${slot}`),/保留原文/);
    const hidden=structuredClone(source);hidden.siteLayout![slot].mode='hidden';
    assert.throws(()=>compileAiSiteDesign(hidden,input,result([{kind:'navigation',slot,items:[{label:'Home',pageId:'home'}]}]),`aisd-hidden-${slot}`),/保留原文/);
  }
  const nav=compileAiSiteDesign(source,input,result([{kind:'navigation',slot:'header',items:[{label:'Home',pageId:'home'}]}]),'aisd-nav-preserved');
  assert.equal(nav.candidate.siteLayout!.header.mode,'default');assert.deepEqual(nav.generatedBlockIds,[]);
  const first=compileAiSiteDesign(source,request(source),result([{kind:'chrome',slot:'header',operations:[]}]),'aisd-original-native');
  const next=compileAiSiteDesign(first.candidate,request(first.candidate,{preserveText:true}),result([{kind:'chrome',slot:'header',operations:[{kind:'design',id:'site-header-frame',design:{desktop:{paddingTop:36}}}]}]),'aisd-native-preserve');
  const block=next.candidate.sharedBlocks!.find(block=>block.id===next.candidate.siteLayout!.header.blockId)!;const brandMenu=next.candidate.siteLayout!.menus!.find(menu=>menu.id===block.data.content[0].props.content[0].props.menuId)!;assert.equal(brandMenu.items[0].label,'Actual Factory');
});

test('整站导航的三级约束与真实渲染一致，复用既有分组不能叠出更深菜单',()=>{
  const source=fixture();
  const item=(label:string,children?:unknown[])=>({label,pageId:'home',...(children?{children}:{})});
  const legal=compileAiSiteDesign(source,request(source),result([{kind:'navigation',slot:'header',items:[item('One',[item('Two',[item('Three')])])]}]),'aisd-three-levels');
  assert.doesNotThrow(()=>validateDraft(legal.candidate));
  assert.throws(()=>compileAiSiteDesign(source,request(source),result([{kind:'navigation',slot:'header',items:[item('One',[item('Two',[item('Three',[item('Four')])])])]}]),'aisd-four-levels'),/三级/);
  const menu=legal.candidate.siteLayout!.menus!.find(menu=>menu.id===legal.candidate.siteLayout!.header.menuId)!;
  assert.throws(()=>compileAiSiteDesign(legal.candidate,request(legal.candidate),result([{kind:'navigation',slot:'header',items:[item('Wrapper',[{existingId:menu.items[0].id}])]}]),'aisd-reuse-too-deep'),/三级|层级/);
});

test('内置多语言页眉物化保持各语言fallback和品牌首页，整理主导航不改品牌或其他语言',()=>{
  const source=fixture();for(const page of [{id:'home-de',title:'Startseite',slug:'/de'},{id:'about-de',title:'Fabrik',slug:'/de/about'},{id:'contact-de',title:'Kontakt',slug:'/de/contact'}]){source.pages.push({...page,locale:'de',status:'draft',type:'普通页面',updated:'2026-11-12'});source.editorData[page.id]={root:{props:{showChrome:'yes'} as Data['root']['props']},content:[]};}
  const compiled=compileAiSiteDesign(source,request(source),result([{kind:'chrome',slot:'header',operations:[]},{kind:'chrome',slot:'footer',operations:[]}]),'aisd-multilingual-header');
  const layout=compiled.candidate.siteLayout!,menus=layout.menus!,block=compiled.candidate.sharedBlocks!.find(block=>block.id===layout.header.blockId)!;
  const [brand,navigation]=block.data.content[0].props.content;
  assert.equal(brand.type,'Navigation');assert.notEqual(brand.props.menuId,navigation.props.menuId);assert.notEqual(brand.props.localeMenuIds.de,navigation.props.localeMenuIds.de);
  assert.deepEqual(menus.find(menu=>menu.id===navigation.props.menuId)!.items.map(item=>item.target?.id),['about','contact']);
  assert.deepEqual(menus.find(menu=>menu.id===navigation.props.localeMenuIds.de)!.items.map(item=>item.target?.id),['about-de','contact-de']);
  assert.deepEqual(menus.find(menu=>menu.id===brand.props.menuId)!.items[0].target,{kind:'page',id:'home'});
  assert.deepEqual(menus.find(menu=>menu.id===brand.props.localeMenuIds.de)!.items[0].target,{kind:'page',id:'home-de'});
  assert.equal(layout.footer.menuId,undefined);assert.equal(compiled.generatedMenuIds.length,4);assert.doesNotThrow(()=>validateDraft(compiled.candidate));
  const manual=structuredClone(source),manualMenu={id:'manual-de',name:'Existing German menu',items:[{id:'manual-fabrik',label:'Unser Werk',target:{kind:'page' as const,id:'about-de'}}]};manual.siteLayout!.header.localeMenuIds={de:manualMenu.id};manual.siteLayout!.menus=[manualMenu];
  const retained=compileAiSiteDesign(manual,request(manual),result([{kind:'chrome',slot:'header',operations:[]}]),'aisd-keep-language-map');assert.equal(retained.candidate.siteLayout!.header.localeMenuIds!.de,manualMenu.id);assert.deepEqual(retained.candidate.siteLayout!.menus!.find(menu=>menu.id===manualMenu.id),manualMenu);
  const reordered=compileAiSiteDesign(compiled.candidate,request(compiled.candidate),result([{kind:'navigation',slot:'header',locale:'en',items:[{label:'Contact first',pageId:'contact'},{label:'Factory',pageId:'about'}]},{kind:'navigation',slot:'header',locale:'de',items:[{label:'Kontakt',pageId:'contact-de'}]}]),'aisd-reorder-languages');
  const next=reordered.candidate.sharedBlocks!.find(block=>block.id===reordered.candidate.siteLayout!.header.blockId)!.data.content[0].props.content;
  assert.equal(next[0].props.menuId,brand.props.menuId);assert.deepEqual(next[0].props.localeMenuIds,brand.props.localeMenuIds);
  assert.notEqual(next[1].props.menuId,navigation.props.menuId);assert.notEqual(next[1].props.localeMenuIds.de,navigation.props.localeMenuIds.de);
});
