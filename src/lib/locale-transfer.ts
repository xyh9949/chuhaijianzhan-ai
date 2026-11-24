import type {LocalizedContent} from './types';
import {localeOf,localizedPath,stripLocalePath,type LocaleSettings,type TranslationKind} from './localization';
/** 跨默认语言复制/恢复时保留正文原语言；静态页转换实际前缀，默认详情设计仍全语言共用。 */
export function transferRecordLocale<T extends LocalizedContent&{slug?:string}>(record:T,kind:TranslationKind,from:LocaleSettings,to:LocaleSettings):T{
 if(kind==='page'&&record.slug?.includes(':')||!from.locales&&!to.locales&&!record.locale)return record;
 const locale=localeOf(from,record);return {...record,locale,...(kind==='page'&&record.slug?{slug:localizedPath(to,{locale},stripLocalePath(from,record.slug))}:{})};
}
/** 只改已知站内路径，保留查询与锚点；不把任意文案、资源路径或动态代码当作URL。 */
export function rebaseLayoutPaths<T>(value:T,paths:Map<string,string>):T{
 const path=(v:string)=>{if(!v.startsWith('/')||v.startsWith('//'))return v;const index=v.search(/[?#]/),base=index<0?v:v.slice(0,index);return paths.has(base)?paths.get(base)!+(index<0?'':v.slice(index)):v;};
 const walk=(v:unknown,href=false):unknown=>{if(Array.isArray(v))return v.map(x=>walk(x,href));if(!v||typeof v!=='object')return v;return Object.fromEntries(Object.entries(v).map(([key,x])=>[key,typeof x==='string'&&(key==='href'||href&&key==='fallback')?path(x):walk(x,href||key==='href')]));};return walk(value) as T;
}
