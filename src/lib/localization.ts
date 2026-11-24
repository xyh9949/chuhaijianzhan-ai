import type {ContentEntry,LocalizedContent,PageItem,Product,SiteSettings} from './types';
export type LocaleSettings=Partial<Pick<SiteSettings,'language'|'locales'>>;
export type LocalizedSource={settings?:LocaleSettings;pages:PageItem[];products?:Product[];contentEntries?:ContentEntry[]};
export type TranslationKind='page'|'product'|'entry';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const identifier=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v);
export function validLocale(v:unknown):v is string {if(typeof v!=='string'||!/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-\d{3})?$/.test(v))return false;try{return Intl.getCanonicalLocales(v)[0]===v;}catch{return false;}}
export const localeOf=(settings:LocaleSettings|undefined,record?:LocalizedContent)=>record?.locale||settings?.language||'en';
export const siteLocales=(settings?:LocaleSettings)=>settings?.locales||[{code:settings?.language||'en',label:settings?.language||'en'}];
/** 默认语言无前缀，其他语言用小写URL段；不在正文里静默回退其他语言。 */
export function localePrefix(settings:LocaleSettings|undefined,record?:LocalizedContent){const code=localeOf(settings,record);return settings&&code!==(settings.language||'en')?`/${code.toLowerCase()}`:'';}
export function localizedPath(settings:LocaleSettings|undefined,record:LocalizedContent,path:string){const prefix=localePrefix(settings,record);return prefix?`${prefix}${path==='/'?'':path}`:path;}
export function localeAtPath(settings:LocaleSettings|undefined,path:string){return siteLocales(settings).find(l=>l.code!==settings?.language&&(path===`/${l.code.toLowerCase()}`||path.startsWith(`/${l.code.toLowerCase()}/`)))?.code||settings?.language||'en';}
export function stripLocalePath(settings:LocaleSettings|undefined,path:string){const prefix=localePrefix(settings,{locale:localeAtPath(settings,path)});return prefix&&path.startsWith(prefix)?path.slice(prefix.length)||'/':path;}
export function translationRecords(source:LocalizedSource,kind:TranslationKind){return kind==='page'?source.pages.filter(p=>!p.slug.includes(':')):kind==='product'?source.products||[]:source.contentEntries||[];}
export function translationPeers(source:LocalizedSource,kind:TranslationKind,record:(PageItem|Product|ContentEntry)){
 if(!record.translationGroupId)return [record];return translationRecords(source,kind).filter(r=>r.translationGroupId===record.translationGroupId&&(kind!=='entry'||'modelId' in r&&r.modelId===('modelId' in record?record.modelId:undefined)));
}
/** 语言/翻译组元数据同草稿和最终候选检查；记录发布独立于其他语言。 */
export function localizationErrors(source:LocalizedSource,publishing=false):string[]{
 const errors:string[]=[],settings=source.settings,languages=siteLocales(settings),configured=settings?.locales!==undefined;
 if(configured){if(!Array.isArray(settings.locales)||!settings.locales.length||settings.locales.length>10||settings.locales.some(l=>!object(l)||Object.keys(l).some(k=>!['code','label'].includes(k))||!validLocale(l.code)||typeof l.label!=='string'||!l.label.trim()||l.label.length>80)||new Set(settings.locales.map(l=>l.code)).size!==settings.locales.length||!settings.locales.some(l=>l.code===settings.language))return ['网站语言需为1–10个不重复的标准语言代码/名称，并包含默认语言'];}
 const available=new Set(languages.map(l=>l.code)),seen=new Set<string>(),entryGroups=new Map<string,string>();
 if(configured&&languages.some(l=>l.code!==settings?.language&&['api','admin','preview','images','fonts','products'].includes(l.code.toLowerCase())))errors.push('新增语言代码不能占用系统保留目录');
 for(const kind of ['page','product','entry'] as const)for(const r of translationRecords(source,kind)){
  const label='name' in r?r.name:r.title,locale=localeOf(settings,r);
  if(r.locale!==undefined&&(!validLocale(r.locale)||!available.has(r.locale)))errors.push(`“${label}”的语言未在网站配置中启用，请明确包含语言设置发布`);
  if(r.translationState!==undefined&&!['source','needs-review','reviewed'].includes(r.translationState))errors.push(`“${label}”的翻译状态无效`);
  if(publishing&&r.translationState==='needs-review')errors.push(`“${label}”仍为源文复制的待核对译文，请编辑并明确确认后再发布`);
  if(r.translationGroupId!==undefined){if(!identifier(r.translationGroupId))errors.push(`“${label}”的翻译组标识无效`);else{const key=`${kind}:${r.translationGroupId}:${locale}`;if(seen.has(key))errors.push(`翻译组 ${r.translationGroupId} 在 ${locale} 有重复${kind==='page'?'页面':'记录'}`);seen.add(key);if(kind==='entry'&&'modelId'in r){const previous=entryGroups.get(r.translationGroupId);if(previous&&previous!==r.modelId)errors.push(`翻译组 ${r.translationGroupId} 不能跨内容模型`);entryGroups.set(r.translationGroupId,r.modelId||'');}}}
  if(kind==='page'&&'slug'in r&&configured){const actual=r.slug||'/',prefix=localePrefix(settings,r),other=languages.filter(l=>l.code!==settings?.language).map(l=>`/${l.code.toLowerCase()}`);if(prefix&&actual!==prefix&&!actual.startsWith(`${prefix}/`)||!prefix&&other.some(p=>actual===p||actual.startsWith(`${p}/`)))errors.push(`页面“${label}”路径必须位于自身语言前缀，默认语言不能占用其他语言目录`);}
 }
 for(const page of source.pages.filter(p=>p.slug.includes(':')))if(page.locale||page.translationGroupId||page.translationState)errors.push(`默认详情模板“${page.title}”共用于各语言，请用语言限定的条件布局，不能给默认模板分配翻译组`);
 return [...new Set(errors)];
}
/** 默认语言迁移必须显式携带原来缺省的记录语言，不能把旧英文正文重新解释为德文。 */
export function defaultLanguagePublicationErrors(previous:LocalizedSource|undefined,next:LocalizedSource):string[]{
 if(!previous||localeOf(previous.settings)===localeOf(next.settings)||!previous.settings?.locales&&!next.settings?.locales)return [];
 const errors:string[]=[];
 for(const kind of ['page','product','entry'] as const){const byId=new Map(translationRecords(next,kind).map(r=>[r.id,r]));for(const record of translationRecords(previous,kind)){const candidate=byId.get(record.id);if(candidate&&!record.locale&&candidate.locale!==localeOf(previous.settings))errors.push(`默认语言迁移需要明确选择原${kind==='page'?'页面':kind==='product'?'产品':'内容'} ${record.id}，保留其原始语言 ${localeOf(previous.settings)}`);}}
 return errors;
}
export function localeRecordEvolutionErrors(previous:LocalizedSource,next:LocalizedSource):string[]{const errors:string[]=[];for(const kind of ['page','product','entry'] as const){const old=new Map(translationRecords(previous,kind).map(r=>[r.id,r]));for(const record of translationRecords(next,kind))if(old.get(record.id)?.translationState==='needs-review'&&!['needs-review','reviewed'].includes(record.translationState||''))errors.push(`复制译文 ${record.id} 需要显式核对，不能清空状态或冒充原文`);}return errors;}

/** 恢复缓存允许未完成字符串，拒绝会让表单渲染崩溃的对象值。 */
export function editableLocaleShape(v:LocalizedContent){return (v.locale===undefined||typeof v.locale==='string'&&v.locale.length<=35)&&(v.translationGroupId===undefined||typeof v.translationGroupId==='string'&&v.translationGroupId.length<=100)&&(v.translationState===undefined||['source','needs-review','reviewed'].includes(v.translationState));}
