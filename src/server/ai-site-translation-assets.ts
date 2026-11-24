import { randomUUID, createHash } from 'node:crypto';
import type { Data } from '@puckeditor/core';
import type { DraftContent } from './types';
import type { PageItem, SiteMenu, SharedBlock, FormDefinition, MenuItem } from '../lib/types';
import { localeOf, localizedPath, stripLocalePath, translationPeers } from '../lib/localization';
import { menuAtLocale } from '../lib/site-navigation';
import { getPageKind } from '../lib/page-data';
import { getSharedBlockReferences } from '../lib/shared-blocks';
import { cloneTemplateData } from '../lib/page-templates';
import { remapSnippet } from './portable-code';
import type { NativeSiteTranslationAsset } from '../lib/ai-site-translation';
import { requireCompatibleSiteTranslationData, materializeSiteTranslationText } from '../lib/ai-site-translation';
import type { SiteTranslationAssetKind } from '../lib/ai-site-translation-types';

export const assetKey = (kind: SiteTranslationAssetKind, id: string) => `${kind}:${id}`;
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (object(value)) return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`; return JSON.stringify(value) ?? 'undefined'; }
export const same = (a: unknown, b: unknown) => stable(a) === stable(b);
export function comparable<T>(value: T): T { if(!object(value))return value;const copy:Record<string,unknown>={...value};delete copy.status;delete copy.updated;if(object(copy.record)){copy.record={...copy.record};delete (copy.record as Record<string,unknown>).status;delete (copy.record as Record<string,unknown>).updated;}return copy as T; }
export const fingerprint = (value: unknown) => createHash('sha256').update(stable(comparable(value))).digest('hex');
const builtin = (slot: 'header' | 'footer') => `builtin-default-${slot}`;
const defaultMenuId = 'builtin-default-header-menu';
export interface AssetPlan extends NativeSiteTranslationAsset { textSource: Record<string, unknown>; targetId: string; targetBefore: Record<string, unknown> | null; seed: Record<string, unknown>; after: Record<string, unknown>; dependencies: string[]; }
export interface PreservedChromeAsset { kind: 'block'|'menu'; sourceId: string; id: string; before: Record<string,unknown>|null; after: Record<string,unknown>; }
export interface TranslationAssetPlan { assets: AssetPlan[]; preservedChrome: PreservedChromeAsset[]; sourceChromeSlots: Partial<Record<'header'|'footer',{blockId:string;menuId?:string;beforeBlockId?:string;beforeMenuId?:string}>>; pageKeys: Record<string,string[]>; chromeKeys: string[]; chromeSlots: Partial<Record<'header'|'footer', { sourceId: string; targetId: string; beforeBlockId?: string; beforeMenuId?: string; menuId?: string }>>; warnings: string[]; }

function defaultMenu(content: DraftContent, sourceLocale: string): SiteMenu {
  const choices = content.pages.filter(page => localeOf(content.settings,page) === sourceLocale && !page.slug.includes(':'));
  const items: MenuItem[] = [];
  for (const [kind,label] of [['products','Collection'],['about','Our story'],['contact','Contact']]) { const page = choices.find(item => item.id === kind) || choices.find(item => getPageKind({...item,slug:stripLocalePath(content.settings,item.slug)}) === kind); if(page) items.push({id:`default-${kind}`,label:content.settings.locales?page.title:label,target:{kind:'page',id:page.id}}); }
  return { id: defaultMenuId, name: 'Default header navigation', items };
}
/** 默认头尾转换为可拖拽的原生块，文字逐项来自当前渲染器，不生成公司事实。 */
function defaultBlock(content: DraftContent, slot: 'header'|'footer', sourceLocale: string): SharedBlock {
  const active = content.pages.filter(page=>localeOf(content.settings,page)===sourceLocale&&!page.slug.includes(':')).map(page=>(content.editorData[page.id] as Data)?.root?.props as Record<string,unknown>|undefined).filter(props=>props?.showChrome!=='no'&&props?.[`${slot}Mode`]!=='hidden');
  const brands = [...new Set(active.map(props=>typeof props?.brand==='string'&&props.brand.trim()?props.brand:content.settings.name))];
  if(brands.length>1)throw new Error('默认头尾在各页面使用不同品牌名称，请先统一品牌或取消头尾翻译；现有品牌不会被覆盖');
  const brand=brands[0]||content.settings.name, menuId=menuAtLocale(content.siteLayout?.[slot].menuId,content.siteLayout?.[slot].localeMenuIds,content.settings,sourceLocale);
  const node=(type:string,id:string,props:Record<string,unknown>)=>({type,props:{id,...props}});
  const heading=node('Heading',`builtin-${slot}-brand`,{text:brand,level:'h2',size:32,mobileSize:24,spacing:8});
  const items=slot==='header'?[heading,node('Navigation','builtin-header-navigation',{menuId:menuId||defaultMenuId,label:'Website navigation'}),node('Text','builtin-header-note',{text:'Objects for a slower life.',size:14})]:[heading,node('Text','builtin-footer-note',{text:'Considered objects. Everyday living.',size:16}),...(menuId?[node('Navigation','builtin-footer-navigation',{menuId,label:'Footer navigation'})]:[]),node('ActionButton','builtin-footer-contact',{text:'Let’s make something meaningful',href:`mailto:${content.settings.email}`,kind:'outline'}),node('Text','builtin-footer-copyright',{text:`© ${new Date().getFullYear()} ${brand}`,size:14})];
  return {id:builtin(slot),name:`Default ${slot}`,updated:'',data:{root:{props:{brand:'',showChrome:'no'}},content:[node('Container',`builtin-${slot}-layout`,{layout:'column',columns:1,mobileColumns:1,gap:16,padding:24,inset:20,background:content.theme.background,content:items})]} as Data};
}
export function readNativeTranslationAsset(content: DraftContent, kind: SiteTranslationAssetKind, id: string, sourceLocale: string): NativeSiteTranslationAsset | undefined {
  if(kind==='page'){const page=content.pages.find(item=>item.id===id&&!item.slug.includes(':')&&!item.contentModelId);if(page)return{kind,id,label:page.title,value:{record:structuredClone(page),data:structuredClone(content.editorData[id]),...(content.customCode?.pages[id]?{code:structuredClone(content.customCode.pages[id])}:{})}};}
  const item=kind==='block'?(id===builtin('header')?defaultBlock(content,'header',sourceLocale):id===builtin('footer')?defaultBlock(content,'footer',sourceLocale):content.sharedBlocks?.find(item=>item.id===id)):kind==='menu'?(id===defaultMenuId?defaultMenu(content,sourceLocale):content.siteLayout?.menus?.find(item=>item.id===id)):content.forms?.find(item=>item.id===id);
  return item?{kind,id,label:item.name,value:structuredClone(item) as unknown as Record<string,unknown>}:undefined;
}
/** 从原生页面成对引用、语言菜单和头尾映射重建关系；分发包不需要携带私有跟踪表。 */
function nativeMappings(content: DraftContent, sourceLocale: string, targetLocale: string): Map<string,string> {
  const mappings=new Map<string,string>(),pairs:[unknown,unknown][]=[];
  for(const page of content.pages.filter(item=>!item.slug.includes(':')&&localeOf(content.settings,item)===sourceLocale)){const peer=translationPeers(content,'page',page).find(item=>localeOf(content.settings,item)===targetLocale) as PageItem|undefined;if(peer){mappings.set(assetKey('page',page.id),peer.id);pairs.push([content.editorData[page.id],content.editorData[peer.id]]);}}
  const slots=['header','footer'] as const;
  for(const slot of slots){const source=content.siteLayout?.[slot];if(!source||source.mode==='hidden')continue;const sourceId=sourceLocale!==content.settings.language&&source.localeBlockIds?.[sourceLocale]|| (source.mode==='block'?source.blockId:builtin(slot));const targetId=source.localeBlockIds?.[targetLocale];if(targetId){mappings.set(assetKey('block',sourceId),targetId);pairs.push([readNativeTranslationAsset(content,'block',sourceId,sourceLocale)?.value.data,content.sharedBlocks?.find(block=>block.id===targetId)?.data]);}const from=menuAtLocale(source.menuId,source.localeMenuIds,content.settings,sourceLocale)|| (slot==='header'&&source.mode==='default'?defaultMenuId:'');const to=menuAtLocale(source.menuId,source.localeMenuIds,content.settings,targetLocale);if(from&&to)mappings.set(assetKey('menu',from),to);}
  const seen=new Set<string>();
  const pair=(a:unknown,b:unknown)=>{if(Array.isArray(a)&&Array.isArray(b)){a.forEach((value,index)=>pair(value,b[index]));return;}if(!object(a)||!object(b))return;if(typeof a.type==='string'&&a.type===b.type&&object(a.props)&&object(b.props)){for(const [kind,key] of [['block','blockId'],['block','itemBlockId'],['form','formId']] as const){const sourceId=a.props[key],targetId=b.props[key];if(typeof sourceId==='string'&&typeof targetId==='string'&&sourceId&&targetId!==sourceId){mappings.set(assetKey(kind,sourceId),targetId);if(kind==='block'&&!seen.has(sourceId)){seen.add(sourceId);pair(content.sharedBlocks?.find(item=>item.id===sourceId)?.data,content.sharedBlocks?.find(item=>item.id===targetId)?.data);}}}if(a.type==='Navigation'){const from=menuAtLocale(a.props.menuId as string|undefined,a.props.localeMenuIds as Record<string,string>|undefined,content.settings,sourceLocale),to=menuAtLocale(b.props.menuId as string|undefined,b.props.localeMenuIds as Record<string,string>|undefined,content.settings,targetLocale);if(from&&to&&from!==to)mappings.set(assetKey('menu',from),to);}}for(const key of Object.keys(a))if(typeof a[key]==='object')pair(a[key],b[key]);};pairs.forEach(([a,b])=>pair(a,b));return mappings;
}
export function prepareNativeTranslationAssets(content: DraftContent, sourceLocale: string, targetLocale: string, pageIds: string[], includeChrome: boolean, remembered: Map<string,string> = new Map()): TranslationAssetPlan {
  const inferred=nativeMappings(content,sourceLocale,targetLocale), assets=new Map<string,AssetPlan>(),warnings:string[]=[];
  const targetFor=(key:string)=>inferred.get(key)||remembered.get(key);
  const add=(kind:SiteTranslationAssetKind,id:string):string=>{
    const key=assetKey(kind,id);if(assets.has(key))return key;
    const source=readNativeTranslationAsset(content,kind,id,sourceLocale);if(!source)throw new Error('待翻译的页面、区块、导航或表单已不存在');
    const mappedId=targetFor(key),targetId=mappedId&&mappedId!==id?mappedId:`${kind}-${randomUUID()}`,nativeTarget=readNativeTranslationAsset(content,kind,targetId,targetLocale),targetBefore=nativeTarget?.value||null;
    let seed=targetBefore?structuredClone(targetBefore):structuredClone(source.value);
    if(kind==='page'){
      const page=source.value.record as unknown as PageItem,existing=targetBefore?.record as unknown as PageItem|undefined;
      if(existing&&localeOf(content.settings,existing)!==targetLocale)throw new Error('页面译文语言不匹配，未覆盖现有记录');
      if(targetBefore)requireCompatibleSiteTranslationData(source.value.data,targetBefore.data);
      const group=page.translationGroupId||`translation-${randomUUID()}`,slug=existing?.slug||localizedPath(content.settings,{locale:targetLocale},stripLocalePath(content.settings,page.slug));
      seed={...seed,record:{...(existing||page),id:targetId,slug,locale:targetLocale,translationGroupId:group,translationState:'needs-review',status:'draft',updated:''},data:targetBefore?structuredClone(targetBefore.data):cloneTemplateData(source.value.data,{fromPageId:page.id,toPageId:targetId,fromPath:page.slug,toPath:slug,preserveNodeIds:true}).data};
      if(!targetBefore&&source.value.code)seed.code=remapSnippet(source.value.code as never,{nodes:new Map(),paths:new Map([[page.slug,slug]])},false).code;
    }else {seed.id=targetId;if(kind==='block'&&targetBefore)requireCompatibleSiteTranslationData(source.value.data,targetBefore.data);if(kind==='block')seed.updated='';}
    if(kind==='form'&&targetBefore){const shape=(v:Record<string,unknown>)=>(v.fields as {id:string;type:string;options?:{id:string}[]}[]).map(field=>({id:field.id,type:field.type,options:field.options?.map(option=>option.id)}));if(!same(shape(source.value),shape(targetBefore)))throw new Error('已有译文表单字段顺序或选项结构不同，请先在表单编辑器核对，不会错配字段说明');}
    if([...assets.values()].some(asset=>asset.kind===kind&&asset.targetId===targetId))throw new Error('不同原文共用同一目标语言对象，请先拆分对应关系，避免覆盖现有设计');
    // 跟踪哈希仍使用未经显式化的真实原文；仅给模型的可译视图补缺省控件文字和SEO介绍。
    const textSource=materializeSiteTranslationText(source.value,sourceLocale,targetLocale,kind==='page'?content.settings.description:undefined);
    seed=materializeSiteTranslationText(seed,targetBefore?targetLocale:sourceLocale,targetLocale,kind==='page'?content.settings.description:undefined);
    const plan:AssetPlan={...source,textSource,targetId,targetBefore,seed,after:structuredClone(seed),dependencies:[]};assets.set(key,plan);
    const inspect=(value:unknown)=>{if(Array.isArray(value)){value.forEach(inspect);return;}if(!object(value))return;const props=object(value.props)?value.props:null;if(props){if(value.type==='SharedBlock'&&typeof props.blockId==='string'&&props.blockId)plan.dependencies.push(add('block',props.blockId));if(value.type==='ContentLoop'&&typeof props.itemBlockId==='string'&&props.itemBlockId)plan.dependencies.push(add('block',props.itemBlockId));if(value.type==='Navigation'){const menu=menuAtLocale(props.menuId as string|undefined,props.localeMenuIds as Record<string,string>|undefined,content.settings,sourceLocale);if(menu)plan.dependencies.push(add('menu',menu));}if(value.type==='Form'&&typeof props.formId==='string'&&props.formId)plan.dependencies.push(add('form',props.formId));}Object.values(value).forEach(inspect);};
    if(kind==='page'||kind==='block')inspect(source.value.data);
    plan.dependencies=[...new Set(plan.dependencies)];return key;
  };
  const pageKeys:Record<string,string[]>={};for(const id of pageIds)pageKeys[id]=[add('page',id)];
  const chromeSlots:TranslationAssetPlan['chromeSlots']={},chromeKeys:string[]=[],preservedChrome:PreservedChromeAsset[]=[],sourceChromeSlots:TranslationAssetPlan['sourceChromeSlots']={};
  if(includeChrome)for(const slot of ['header','footer'] as const){const layout=content.siteLayout?.[slot]||{mode:'default',blockId:''};if(layout.mode==='hidden')continue;const sourceId=sourceLocale!==content.settings.language&&layout.localeBlockIds?.[sourceLocale]||(layout.mode==='block'?layout.blockId:builtin(slot));const key=add('block',sourceId),menuId=menuAtLocale(layout.menuId,layout.localeMenuIds,content.settings,sourceLocale)||(slot==='header'&&layout.mode==='default'?defaultMenuId:undefined),menuKey=menuId?add('menu',menuId):undefined;chromeKeys.push(key,...(menuKey?[menuKey]:[]));chromeSlots[slot]={sourceId,targetId:assets.get(key)!.targetId,beforeBlockId:layout.localeBlockIds?.[targetLocale],beforeMenuId:layout.localeMenuIds?.[targetLocale],...(menuKey?{menuId:assets.get(menuKey)!.targetId}:{})};
    if(sourceId===builtin(slot)&&sourceLocale===content.settings.language){
      const sourceBlock=defaultBlock(content,slot,sourceLocale),blockId=layout.localeBlockIds?.[sourceLocale]||`block-${randomUUID()}`,oldBlock=content.sharedBlocks?.find(item=>item.id===blockId);let sourceMenuId=menuId;
      if(menuId===defaultMenuId){sourceMenuId=layout.localeMenuIds?.[sourceLocale]||`menu-${randomUUID()}`;const oldMenu=content.siteLayout?.menus?.find(item=>item.id===sourceMenuId);preservedChrome.push({kind:'menu',sourceId:defaultMenuId,id:sourceMenuId,before:oldMenu?structuredClone(oldMenu) as unknown as Record<string,unknown>:null,after:{...defaultMenu(content,sourceLocale),id:sourceMenuId} as unknown as Record<string,unknown>});}
      const data=structuredClone(sourceBlock.data);const nav=(value:unknown)=>{if(Array.isArray(value)){value.forEach(nav);return;}if(!object(value))return;if(value.type==='Navigation'&&object(value.props)&&value.props.menuId===defaultMenuId)value.props.menuId=sourceMenuId;Object.values(value).forEach(nav);};nav(data);
      preservedChrome.push({kind:'block',sourceId:builtin(slot),id:blockId,before:oldBlock?structuredClone(oldBlock) as unknown as Record<string,unknown>:null,after:{...sourceBlock,id:blockId,data} as unknown as Record<string,unknown>});sourceChromeSlots[slot]={blockId,beforeBlockId:layout.localeBlockIds?.[sourceLocale],beforeMenuId:layout.localeMenuIds?.[sourceLocale],...(sourceMenuId?{menuId:sourceMenuId}:{})};
    }
  }
  // 源文已有独立译文后再手工挪动结构时拒绝重建，翻译不会把目标布局换回母版。
  if(assets.size>100)throw new Error('关联翻译对象超过100项，请分批选择页面');
  return{assets:[...assets.values()],preservedChrome,sourceChromeSlots,pageKeys,chromeKeys:[...new Set(chromeKeys)],chromeSlots,warnings};
}
export function selectedNativeTranslationAssets(plan:TranslationAssetPlan,pageIds:string[],includeChrome:boolean):AssetPlan[]{const byKey=new Map(plan.assets.map(asset=>[assetKey(asset.kind,asset.id),asset])),keys=new Set<string>();const visit=(key:string)=>{if(keys.has(key))return;const asset=byKey.get(key);if(!asset)throw new Error('翻译依赖已缺失');keys.add(key);asset.dependencies.forEach(visit);};pageIds.forEach(id=>{if(!plan.pageKeys[id])throw new Error('只能选择本次请求的页面');plan.pageKeys[id].forEach(visit);});if(includeChrome)plan.chromeKeys.forEach(visit);return plan.assets.filter(asset=>keys.has(assetKey(asset.kind,asset.id)));}
