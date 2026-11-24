import {LOCAL_EXTENSIONS,extensionFor,normalizeExtensionProps} from '../extensions/registry';
/** 核心类型与扩展共用兼容清单；未知JSON保留原始数据，禁止交给Puck有损重写。 */
export const TRADE_COMPONENT_LABELS = { ComparisonTable: '产品型号对比表', ProjectTimeline: '项目时间线', ImageComparison: '图片前后对比' } as const;
export const CORE_COMPONENT_TYPES=['CompanyFacts','Container','Heading','Text','Image','ActionButton','ProductList','ProductDetail','Spacer','SharedBlock','ContentList','ContentLoop','Navigation','Breadcrumb','LanguageSwitcher','Form','Download','RichText','Icon','Divider','Gallery','Accordion','Tabs','Video','Carousel',...Object.keys(TRADE_COMPONENT_LABELS)];
export const KNOWN_COMPONENT_TYPES=[...CORE_COMPONENT_TYPES,...LOCAL_EXTENSIONS.map(e=>e.type)];
export function componentCompatibilityErrors(data:unknown,known:readonly string[]=KNOWN_COMPONENT_TYPES):string[]{
 const errors=new Set<string>();let budget=0;
 const walk=(v:unknown,depth=0):void=>{if(++budget>200000||depth>40){errors.add('组件检查超过安全预算，请拆分布局');return;}if(Array.isArray(v)){v.forEach(x=>walk(x,depth+1));return;}if(!v||typeof v!=='object')return;const node=v as Record<string,unknown>;if(typeof node.type==='string'&&node.props&&typeof node.props==='object'){
  if(!known.includes(node.type))errors.add(`未知组件 ${node.type}，请安装对应本地扩展并重新构建`);
  else if(extensionFor(node.type))try{normalizeExtensionProps(node.type,node.props);}catch(e){errors.add((e as Error).message);}
 }Object.values(v).forEach(x=>walk(x,depth+1));};walk(data);return [...errors].slice(0,30);
}

export function snapshotComponentErrors(source:{pages:{id:string;title:string}[];editorData:Record<string,unknown>;sharedBlocks?:{name:string;data:unknown}[];pageTemplates?:{name:string;data:unknown}[]}){
 return [...source.pages.flatMap(p=>componentCompatibilityErrors(source.editorData[p.id]).map(e=>`页面“${p.title}”：${e}`)),...(source.sharedBlocks||[]).flatMap(b=>componentCompatibilityErrors(b.data).map(e=>`区块“${b.name}”：${e}`)),...(source.pageTemplates||[]).flatMap(t=>componentCompatibilityErrors(t.data).map(e=>`模板“${t.name}”：${e}`))].slice(0,100);
}

/** Puck用namespace/type生成节点ID；仅节点允许分段斜线，记录/媒体ID仍沿用严格标识，且不允许冒号/路径回退。 */
export function isComponentNodeId(value:unknown):value is string{return typeof value==='string'&&value.length<=100&&/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);}
