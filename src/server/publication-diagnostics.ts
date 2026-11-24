import {effectiveLayoutBlockId,layoutBlockIds} from '../lib/site-layout-locales';
import type { DraftContent,SiteSnapshot } from './types';
import type { Screen } from '../lib/types';
import { affectedSharedPages,collectReferences } from './validation';
import {localeOf,siteLocales} from '../lib/localization';
import { queryContent } from '../lib/content-query';
import { publicSettings } from './public-settings';
import type { ContentQuery } from '../lib/types';

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const stable=(v:unknown):string=>Array.isArray(v)?`[${v.map(stable).join(',')}]`:object(v)?`{${Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`:JSON.stringify(v)??'null';
const clean=(v:unknown)=>object(v)?Object.fromEntries(Object.entries(v).filter(([k])=>!['updated','status'].includes(k))):v;
export type ChangeScope='page'|'product'|'model'|'entry'|'block'|'theme'|'layout'|'code'|'catalog'|'redirects'|'forms'|'templates'|'settings';
export type Dependency={kind:'page'|'product'|'entry'|'model'|'block'|'layout'|'forms'|'theme'|'catalog'|'settings';id:string;label:string;reason:string};
type Unit={scope:ChangeScope;id:string;label:string;value:unknown};
export type PublicationDiagnostics={changes:{scope:ChangeScope;id:string;label:string;change:'add'|'update'|'remove'}[];pendingDraftCount:number;dependencies:Dependency[];issues:{message:string;screen:Screen;pageId?:string}[];impact:{mode:'exact'|'conservative';reason:string;pages:{id:string;title:string;removed:boolean}[]};lists:{pageId:string;pageTitle:string;nodeId:string;before:number|null;after:number|null;beforeState:'absent'|'available'|'invalid';afterState:'absent'|'available'|'invalid'}[]};
function units(s:SiteSnapshot|DraftContent|null):Unit[]{
 if(!s)return [];const rows:Unit[]=[];
 const add=(scope:ChangeScope,values:{id:string;name?:string;title?:string}[],value?:(r:{id:string})=>unknown)=>values.forEach(r=>rows.push({scope,id:r.id,label:r.title||r.name||r.id,value:value?value(r):clean(r)}));
 add('page',s.pages,r=>({page:clean(s.pages.find(p=>p.id===r.id)),data:s.editorData[r.id]}));add('product',s.products);add('model',s.contentModels||[]);add('entry',s.contentEntries||[]);add('block',s.sharedBlocks||[]);
 const settings=publicSettings(s.settings);
 for(const [scope,label,value] of [['theme','主题与复用样式',{theme:{...s.theme,tokens:s.theme.tokens||[],presets:s.theme.presets||[]},controls:s.editorData.__themeControls}],['layout','页眉页脚与菜单',s.siteLayout||null],['code','全站与页面代码',s.customCode||{global:{css:'',js:'',cssEnabled:false,jsEnabled:false},pages:{}}],['catalog','分类标签',s.taxonomies||[]],['redirects','网址重定向',s.redirects||[]],['forms','网站表单',s.forms||[]],['templates','页面模板资源库及详情条件',s.pageTemplates||[]],['settings','公开网站资料',settings]] as const){if(value===null||Array.isArray(value)&&!value.length)continue;if(scope==='code'&&!['global',...Object.keys(s.customCode?.pages||{})].some(k=>{const c=k==='global'?s.customCode?.global:s.customCode?.pages[k];return c&&(c.css.trim()||c.js.trim()||c.cssEnabled||c.jsEnabled);}))continue;rows.push({scope,id:scope,label,value});}
 return rows;
}
/** 已生成正文显式继承新头尾时，部分发布不能退回旧版外壳；未选页面和纯手工头尾照原规则。 */
export function needsGeneratedChrome(draft: DraftContent, candidate: SiteSnapshot, pageIds: readonly string[]): boolean {
 const header = draft.siteLayout?.header, footer = draft.siteLayout?.footer;
 const run = header?.mode === 'block' && /^ai-([a-f0-9]{12})-header$/.exec(header.blockId)?.[1];
 if(!run || footer?.mode !== 'block' || footer.blockId !== `ai-${run}-footer`)return false;
 const selected = new Set(pageIds);
 return candidate.pages.some(page=>{
  if(!selected.has(page.id))return false;
  const data=candidate.editorData[page.id],root=object(data)&&object(data.root)&&object(data.root.props)?data.root.props:{};
  if(root.showChrome!=='yes')return false;
  const locale=localeOf(candidate.settings,page);
  return (['header','footer'] as const).some(slot=>root[`${slot}Mode`]!=='hidden' && effectiveLayoutBlockId(candidate.siteLayout?.[slot],candidate.settings,locale)!==effectiveLayoutBlockId(draft.siteLayout?.[slot],draft.settings,locale));
 });
}

/** 只提出有草稿来源的明确依赖；选择动作在UI由发布者发起，预检从不自行扩大范围。 */
function dependencies(draft:DraftContent,candidate:SiteSnapshot,pageIds: readonly string[]):Dependency[]{
 const result=new Map<string,Dependency>(),visited=new Set<string>();
 const add=(kind:Dependency['kind'],id:string,label:string,reason:string)=>{const key=`${kind}:${id}`;if(result.has(key))return false;result.set(key,{kind,id,label,reason});return true;};
 const model=(id:string)=>{const source=draft.contentModels?.find(m=>m.id===id);if(source&&!candidate.contentModels?.some(m=>m.id===id))add('model',id,source.name,'引用的模型尚未进入最终公开版本');};
 const page=(id:string,reason:string)=>{const p=draft.pages.find(p=>p.id===id);if(p&&!candidate.pages.some(p=>p.id===id)){if(add('page',id,p.title,reason))scan(draft.editorData[id],p.contentModelId);}};
 const detail=(kind:string,modelId?:string)=>{const p=draft.pages.find(p=>kind==='product'?p.slug==='/products/:slug':modelId&&p.contentModelId===modelId);if(p)page(p.id,'动态内容链接需要相应详情入口');};
 const record=(kind:string,id:string)=>{if(kind==='page'){page(id,'稳定链接目标尚未进入最终公开版本');return;}if(kind==='product'){const p=draft.products.find(p=>p.id===id);if(p){if(!candidate.products.some(x=>x.id===id))add('product',id,p.name,'页面/菜单固定引用此产品');if(p.modelId)model(p.modelId);detail('product');}}else{const e=draft.contentEntries?.find(e=>e.id===id);if(e){if(!candidate.contentEntries?.some(x=>x.id===id))add('entry',id,e.title,'页面/菜单固定引用此内容');model(e.modelId);detail('entry',e.modelId);}}};
 const block=(id:string,context?:string)=>{const b=candidate.sharedBlocks?.find(b=>b.id===id)||draft.sharedBlocks?.find(b=>b.id===id);if(!b)return;const key=`block:${id}:${context||''}`;if(visited.has(key))return;visited.add(key);if(!candidate.sharedBlocks?.some(b=>b.id===id))add('block',id,b.name,'页面、卡片或全站头尾需要此同步区块');scan(b.data,context);};
 function scan(v:unknown,context?:string,depth=0){
  if(depth>32)return;if(Array.isArray(v)){v.forEach(x=>scan(x,context,depth+1));return;}if(!object(v))return;
  let modelId=typeof v.modelId==='string'&&v.modelId?v.modelId:context;
  if(object(v.root)&&object(v.root.props)&&object(v.root.props.bindingContext)&&typeof v.root.props.bindingContext.modelId==='string')modelId=v.root.props.bindingContext.modelId;
  if(typeof v.recordId==='string'&&['product','entry'].includes(String(v.source))){const r=v.source==='entry'?draft.contentEntries?.find(e=>e.id===v.recordId):draft.products.find(p=>p.id===v.recordId);modelId=typeof v.modelId==='string'&&v.modelId?v.modelId:r?.modelId||modelId;if(v.mode==='fixed')record(String(v.source),v.recordId);}
  if(modelId)model(modelId);
  if(['page','product','entry'].includes(String(v.kind))&&typeof v.id==='string'&&!candidate.pageTemplates?.some(t=>t.id===v.id))record(String(v.kind),v.id);
  if(v.mode&&object(v.localeBlockIds))for(const id of layoutBlockIds(v as unknown as import('../lib/types').SiteLayoutSlot))block(id,modelId);
  if(typeof v.blockId==='string'&&v.blockId)block(v.blockId,modelId);if(typeof v.itemBlockId==='string'&&v.itemBlockId)block(v.itemBlockId,modelId);
  if(typeof v.productId==='string'&&v.productId)record('product',v.productId);
  if(typeof v.menuId==='string'&&v.menuId&&!candidate.siteLayout?.menus?.some(m=>m.id===v.menuId)&&draft.siteLayout?.menus?.some(m=>m.id===v.menuId)){if(add('layout','layout','全站头尾与菜单','页面需要草稿中新建的菜单；此选项包含整套头尾/菜单'))scan(draft.siteLayout);}
  if(typeof v.formId==='string'&&v.formId&&!candidate.forms?.some(f=>f.id===v.formId)&&draft.forms?.some(f=>f.id===v.formId))add('forms','forms','全部网站表单定义','页面引用了未发布表单；定义按整套发布');
  if(typeof v.stylePresetId==='string'&&v.stylePresetId&&!candidate.theme.presets?.some(p=>p.id===v.stylePresetId))add('theme','theme','全站主题与复用样式','页面需要尚未发布的复用样式');
  if(object(v.tokenBindings))for(const values of Object.values(v.tokenBindings))if(object(values)&&Object.values(values).some(id=>typeof id==='string'&&!candidate.theme.tokens?.some(t=>t.id===id)))add('theme','theme','全站主题与复用样式','页面需要尚未发布的设计令牌');
  for(const key of ['field','titleField','descriptionField','imageField','linkField','sort'])if(typeof v[key]==='string'&&(/^(field:|related:)/.test(v[key]))&&modelId){const fieldId=v[key].startsWith('related:')?v[key].split(':')[1]:v[key].slice(6),source=draft.contentModels?.find(m=>m.id===modelId);if(source?.fields.some(f=>f.id===fieldId)&&!candidate.contentModels?.find(m=>m.id===modelId)?.fields.some(f=>f.id===fieldId))add('model',source.id,source.name,'绑定/查询需要草稿模型中的新增字段');}
  if(v.field==='builtin:url')detail(String(v.source),modelId);
  if(Array.isArray(v.termIds)&&v.termIds.some(id=>!candidate.taxonomies?.some(t=>t.terms.some(term=>term.id===id))&&draft.taxonomies?.some(t=>t.terms.some(term=>term.id===id)))){if(add('catalog','catalog','全部分类/标签定义','内容/查询使用未发布的分类；定义按整套发布'))for(const tax of draft.taxonomies||[])if(tax.modelId)model(tax.modelId);}
  for(const value of Object.values(v))scan(value,modelId,depth+1);
 }
 // 新语言配置及默认语言迁移都是显式依赖，按钮仅勾选建议，服务端不扩大发布范围。
 const configured=new Set(siteLocales(candidate.settings).map(l=>l.code));
 for(const [kind,records] of [['page',candidate.pages],['product',candidate.products],['entry',candidate.contentEntries||[]]] as const)for(const item of records){
  if(!configured.has(localeOf(draft.settings,item))&&siteLocales(draft.settings).some(l=>l.code===localeOf(draft.settings,item)))add('settings','settings','公开网站资料与语言配置','所选记录的语言尚未进入公开设置');
  const original=kind==='page'?draft.pages.find(r=>r.id===item.id):kind==='product'?draft.products.find(r=>r.id===item.id):draft.contentEntries?.find(r=>r.id===item.id);
  if(original?.locale&&original.locale!==localeOf(candidate.settings,item))add(kind,item.id,'title'in original?original.title:original.name,'默认语言迁移必须保留该记录的原文语言');
 }
 const refs=collectReferences(candidate);for(const id of refs.productIds)record('product',id);for(const id of refs.entryIds)record('entry',id);for(const id of refs.modelIds)model(id);
 if(needsGeneratedChrome(draft,candidate,pageIds)&&add('layout','layout','页眉页脚与导航','所选AI页面需要本次共享的头尾和导航'))scan(draft.siteLayout);
 for(const p of candidate.pages)scan(candidate.editorData[p.id],p.contentModelId);for(const t of candidate.pageTemplates||[]){scan(t.data,t.modelId);if(t.detailRule?.enabled){detail(t.kind,t.modelId);scan(t.detailRule,t.modelId);}}scan(candidate.siteLayout);scan(candidate.redirects);scan(candidate.products);scan(candidate.contentEntries);
 return [...result.values()];
}
function listCounts(s:SiteSnapshot|null){
 const result=new Map<string,{pageId:string;pageTitle:string;nodeId:string;total:number|null}>();if(!s)return result;
 function walk(v:unknown,p:SiteSnapshot['pages'][number],path:string[]=[]){if(Array.isArray(v)){v.forEach(x=>walk(x,p,path));return;}if(!object(v))return;const props=v.props;if(object(props)){
  if(v.type==='ContentLoop'){let total:number|null=null;try{if(props.relation===undefined&&!p.slug.includes(':'))total=queryContent({...s!,locale:localeOf(s!.settings,p)},props.source==='product'?'product':'entry',typeof props.modelId==='string'?props.modelId:undefined,props.query as ContentQuery|undefined,String(props.id),{},Number(props.count)||6).total;}catch{/* 无效查询不能伪造为0条。 */}result.set(`${p.id}:${props.id}`,{pageId:p.id,pageTitle:p.title,nodeId:String(props.id),total});}
  if(v.type==='SharedBlock'&&typeof props.blockId==='string'&&!path.includes(props.blockId)&&path.length<8){const b=s!.sharedBlocks?.find(b=>b.id===props.blockId);if(b)walk(b.data,p,[...path,props.blockId]);}}
  Object.values(v).forEach(x=>walk(x,p,path));}
 for(const p of s.pages){walk(s.editorData[p.id],p);const data=s.editorData[p.id],root=object(data)&&object(data.root)&&object(data.root.props)?data.root.props:{};if(root.showChrome==='no')continue;for(const slot of ['header','footer'] as const){const blockId=effectiveLayoutBlockId(s.siteLayout?.[slot],s.settings,localeOf(s.settings,p));if(blockId&&root[`${slot}Mode`]!=='hidden'){const b=s.sharedBlocks?.find(b=>b.id===blockId);if(b)walk(b.data,p,[b.id]);}}}return result;
}
/** 差异比较忽略服务端状态/更新时间；保守影响与确定的直接页面/区块影响分开标识。 */
export function publicationDiagnostics(draft:DraftContent,active:SiteSnapshot|null,candidate:SiteSnapshot,errors:string[],pageIds:readonly string[]=[]):PublicationDiagnostics{
 const old=new Map(units(active).map(u=>[`${u.scope}:${u.id}`,u])),next=new Map(units(candidate).map(u=>[`${u.scope}:${u.id}`,u])),pending=units(draft),keys=new Set([...old.keys(),...next.keys()]);
 const changes:PublicationDiagnostics['changes']=[];for(const key of keys){const before=old.get(key),after=next.get(key);if(stable(before?.value)!==stable(after?.value)){const u=after||before!;changes.push({scope:u.scope,id:u.id,label:u.label,change:!before?'add':!after?'remove':'update'});}}
 const draftUnits=new Map(pending.map(u=>[`${u.scope}:${u.id}`,u]));const pendingDraftCount=[...new Set([...draftUnits.keys(),...next.keys()])].filter(key=>stable(draftUnits.get(key)?.value)!==stable(next.get(key)?.value)).length;
 const affected=[...affectedSharedPages(candidate,new Set(changes.filter(c=>c.scope==='block').map(c=>c.id))),...(active?affectedSharedPages(active,new Set(changes.filter(c=>c.scope==='block').map(c=>c.id))):[])];
 const conservative=changes.some(c=>c.scope==='templates'?[...(active?.pageTemplates||[]),...(candidate.pageTemplates||[])].some(t=>t.detailRule?.enabled):!['page','block'].includes(c.scope)),direct=new Set(changes.filter(c=>c.scope==='page').map(c=>c.id)),impactIds=new Set([...direct,...affected.map(p=>p.id)]);
 const pages=[...new Map([...(active?.pages||[]),...candidate.pages].map(p=>[p.id,p])).values()].filter(p=>conservative||impactIds.has(p.id)).map(p=>({id:p.id,title:p.title,removed:!candidate.pages.some(x=>x.id===p.id)}));
 const beforeLists=listCounts(active),afterLists=listCounts(candidate),lists=[...new Set([...beforeLists.keys(),...afterLists.keys()])].map(key=>{const before=beforeLists.get(key),after=afterLists.get(key),r=after||before!;return {pageId:r.pageId,pageTitle:r.pageTitle,nodeId:r.nodeId,before:before?.total??null,after:after?.total??null,beforeState:!before?'absent' as const:before.total===null?'invalid' as const:'available' as const,afterState:!after?'absent' as const:after.total===null?'invalid' as const:'available' as const};});
 const issues=errors.map(message=>{const matches=candidate.pages.filter(p=>message.includes(`页面“${p.title}”`)),page=matches.length===1?matches[0]:undefined;const screen:Screen=/表单|页眉|页脚|菜单|导航|区块|代码|CSS|JavaScript/.test(message)?'global-design':/素材|图片|视频|PDF/.test(message)?'media':/模型|字段|独立内容/.test(message)?'content-models':/产品/.test(message)?'products':'pages';return {message,screen,...(page?{pageId:page.id}:{})};});
 return {changes,pendingDraftCount,dependencies:dependencies(draft,candidate,pageIds),issues,impact:{mode:conservative?'conservative':'exact',reason:conservative?'模型、内容集合或全站配置可间接改变展示，以下为保守影响范围，包含可能使用它们的页面。':'直接修改及已知同步区块引用的页面范围；模板资源复制不会改变已复制页面。',pages},lists};
}
