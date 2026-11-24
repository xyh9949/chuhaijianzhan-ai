import {randomUUID,createHash} from 'node:crypto';
import type {ActorIdentity} from './types';
import type {ContentEntry,PageItem,Product} from '../lib/types';
import {localeOf,localizedPath,siteLocales,stripLocalePath,translationPeers,translationRecords,type TranslationKind} from '../lib/localization';
import {cloneTemplateData} from '../lib/page-templates';
import {isRelationDefinition,relationIds} from '../lib/content-relations';
import {remapSnippet} from './portable-code';
import {getDraftRecord,patchStudio,getActiveReleaseId} from './studio';
import {getDatabase} from './database';
import {ApiError} from './http';
import {identifier,object,revision,text,validateDraft} from './validation';
import {rebaseLocaleMenus,rebaseNavigationLocales} from '../lib/site-navigation';
import {actualSiteRoutes} from '../lib/site-redirects';

/** 原文与新译文在同一修订事务进入草稿；复制不等于翻译完成，更不会自动发布。 */
export function copyTranslation(value:unknown,actor:ActorIdentity){
 const input=object(value,'复制译文');if(Object.keys(input).some(k=>!['expectedRevision','kind','sourceId','locale','slug','sku'].includes(k)))throw new ApiError(422,'复制译文包含未知属性');
 const expected=revision(input.expectedRevision),current=getDraftRecord();if(current.revision!==expected)throw new ApiError(409,'工作区已变化，请保留输入并重新读取');
 const state=current.content,kind=input.kind as TranslationKind,sourceId=identifier(input.sourceId),locale=text(input.locale,'目标语言',35,true);
 if(!['page','product','entry'].includes(kind)||!siteLocales(state.settings).some(l=>l.code===locale))throw new ApiError(422,'请选择已配置的页面/产品/内容目标语言');
 const source=translationRecords(state,kind).find(r=>r.id===sourceId);if(!source)throw new ApiError(404,'来源内容不存在，默认详情模板应通过语言条件布局复用');
 if(localeOf(state.settings,source)===locale)throw new ApiError(422,'目标语言与来源相同');
 if(translationPeers(state,kind,source).some(r=>localeOf(state.settings,r)===locale))throw new ApiError(409,'同组已有该语言，请编辑已有译文');
 const group=source.translationGroupId||`translation-${randomUUID()}`,id=`${kind}-${randomUUID()}`,sourceLocale=localeOf(state.settings,source),warnings:string[]=[];
 const original={...source,locale:sourceLocale,translationGroupId:group,translationState:source.translationState||'source'};
 const copy={...structuredClone(source),id,status:'draft',locale,translationGroupId:group,translationState:'needs-review'};
 const patch:Record<string,unknown>={},meta=(r:{id:string})=>r.id===sourceId?original:r;
 if(kind==='page'){
  const page=source as PageItem,slug=input.slug===undefined?localizedPath(state.settings,{locale},stripLocalePath(state.settings,page.slug)):text(input.slug,'译文页面路径',200,true),cloned=cloneTemplateData(state.editorData[page.id],{fromPageId:page.id,toPageId:id,fromPath:page.slug,toPath:slug});
  patch.pages=[...state.pages.map(meta),{...copy,slug,updated:''}];patch.editorData={...state.editorData,[id]:cloned.data};
  const code=state.customCode?.pages[page.id];if(code){const mapped=remapSnippet(code,{nodes:cloned.nodeIds,paths:new Map([[page.slug,slug]])},false);patch.customCode={...state.customCode,pages:{...state.customCode!.pages,[id]:mapped.code}};warnings.push('已复制页面CSS，JavaScript保持关闭；请核对译文布局与代码。');}
 }else{
  const record=copy as Product|ContentEntry,model=state.contentModels?.find(m=>m.id===record.modelId);record.customFields={...record.customFields};
  // 源文关联不冒充译文关联；能找到同组目标时映射，否则留空交由编辑者核对。
  for(const field of model?.fields||[])if(field.type==='relation'&&isRelationDefinition(field.relation)){
   const relation=field.relation,mapped=relationIds(field,record.customFields[field.id]).flatMap(targetId=>{const target=translationRecords(state,relation.source).find(r=>r.id===targetId);if(!target)return [];const translated=localeOf(state.settings,target)===locale?target:translationPeers(state,relation.source,target).find(r=>localeOf(state.settings,r)===locale);return translated?[translated.id]:[];});
   if(mapped.length!==relationIds(field,record.customFields[field.id]).length)warnings.push(`关系“${field.label}”存在缺译目标，已清空缺失项，请补选。`);if(mapped.length)record.customFields[field.id]=relation.multiple?[...new Set(mapped)]:mapped[0];else delete record.customFields[field.id];
  }
  record.slug=input.slug===undefined?('slug'in source&&source.slug||source.id).toLowerCase():text(input.slug,'译文网址标识',100);
  if(kind==='product'){(record as Product).sku=input.sku===undefined?`${(source as Product).sku.slice(0,50)}-${locale}`:text(input.sku,'译文产品型号',64,true);patch.products=[...state.products.map(meta),record];}
  else patch.contentEntries=[...(state.contentEntries||[]).map(meta),{...record,updated:''}];
 }
 const result=patchStudio({expectedRevision:expected,patch},actor);
 return {...result,translationId:id,warnings:[...new Set(['源文字段已复制，尚未翻译。请核对文字、SEO、菜单、表单和关系，再明确确认译文。',...warnings])]};
}

/** 迁移只准备当前草稿；固定所有原文语言后计算网址差异，不改公开指针或偷偷覆盖跳转。 */
function prepareDefaultMigration(value:unknown){
 const input=object(value,'默认语言迁移');if(Object.keys(input).some(k=>!['expectedRevision','baseReleaseId','language','includeRedirects','expectedChangeHash','acknowledgeUnavailableRedirects'].includes(k)))throw new ApiError(422,'语言迁移包含未知属性');
 const expected=revision(input.expectedRevision),current=getDraftRecord(),active=getActiveReleaseId();if(expected!==current.revision||input.baseReleaseId!==active)throw new ApiError(409,'草稿或公开版本已变化，请重新检查迁移方案');
 const language=text(input.language,'新默认语言',35,true),previous=current.content;if(language===previous.settings.language||!siteLocales(previous.settings).some(l=>l.code===language))throw new ApiError(422,'请选择其他已启用语言，先准备对应首页与译文');
 if(typeof input.includeRedirects!=='boolean'||input.acknowledgeUnavailableRedirects!==undefined&&typeof input.acknowledgeUnavailableRedirects!=='boolean')throw new ApiError(422,'请明确是否添加可用重定向并核对不可跳转地址');
 const next=structuredClone(previous);next.settings.language=language;
 next.pages=previous.pages.map(page=>page.slug.includes(':')?structuredClone(page):{...page,locale:localeOf(previous.settings,page),slug:localizedPath(next.settings,{locale:localeOf(previous.settings,page)},stripLocalePath(previous.settings,page.slug))});
 next.products=previous.products.map(r=>({...r,locale:localeOf(previous.settings,r)}));if(previous.contentEntries)next.contentEntries=previous.contentEntries.map(r=>({...r,locale:localeOf(previous.settings,r)}));
 if(next.siteLayout){next.siteLayout.header=rebaseLocaleMenus(next.siteLayout.header,previous.settings,next.settings);next.siteLayout.footer=rebaseLocaleMenus(next.siteLayout.footer,previous.settings,next.settings);}
 next.editorData=rebaseNavigationLocales(next.editorData,previous.settings,next.settings);if(next.sharedBlocks)next.sharedBlocks=next.sharedBlocks.map(b=>({...b,data:rebaseNavigationLocales(b.data,previous.settings,next.settings)}));if(next.pageTemplates)next.pageTemplates=next.pageTemplates.map(t=>({...t,data:rebaseNavigationLocales(t.data,previous.settings,next.settings)}));
 const target=new Map(actualSiteRoutes(next).map(r=>[`${r.target.kind}:${r.target.id}`,r.path])),occupied=new Set(target.values()),existing=new Set((next.redirects||[]).map(r=>r.from));
 const changes=actualSiteRoutes(previous).flatMap(r=>{const to=target.get(`${r.target.kind}:${r.target.id}`);return to&&to!==r.path?[{from:r.path,to,target:r.target}]:[];});
 const unavailable=changes.filter(r=>occupied.has(r.from)||existing.has(r.from)||r.from==='/'||r.from.length>200).map(r=>({...r,reason:occupied.has(r.from)?'旧地址已由其他语言内容占用，无法同时重定向':existing.has(r.from)?'已有规则，需在重定向管理核对':'旧地址超出内置跳转格式，需另行配置'}));
 if(input.includeRedirects)next.redirects=[...next.redirects||[],...changes.filter(r=>!unavailable.some(u=>u.from===r.from)).map(r=>({id:`redirect-locale-${createHash('sha256').update(r.from).digest('hex').slice(0,24)}`,from:r.from,target:r.target,status:301 as const}))];
 const errors:string[]=[];if(!next.pages.some(p=>p.slug==='/'&&!p.contentModelId))errors.push('目标语言尚无首页，请先建立该语言的首页译文');
 try{validateDraft(next);}catch(e){if(e instanceof ApiError)errors.push(e.message);else throw e;}
 const changeHash=createHash('sha256').update(JSON.stringify({expected,active,next,includeRedirects:input.includeRedirects})).digest('hex');
 return {input,expected,next,changes,unavailable,errors,changeHash,baseReleaseId:active};
}
export function previewDefaultLocaleMigration(value:unknown){return getDatabase().transaction(()=>{const p=prepareDefaultMigration(value);return {expectedRevision:p.expected,baseReleaseId:p.baseReleaseId,changeHash:p.changeHash,changes:p.changes,unavailableRedirects:p.unavailable,errors:p.errors,addedRedirects:(p.next.redirects?.length||0)-(getDraftRecord().content.redirects?.length||0),warnings:['这里只修改草稿。发布时需明确包含语言设置与所有受影响原文元数据/页面；未选译文不会自动上线。导航默认项也切换为新语言的已配菜单，缺映射时隐藏，原默认项保留在原语言映射；请核对并选择相关全站布局/同步区块/模板。']};})();}
export function commitDefaultLocaleMigration(value:unknown,actor:ActorIdentity){
 return getDatabase().transaction(()=>{const p=prepareDefaultMigration(value);if(p.errors.length)throw new ApiError(422,p.errors.join('；'));
 if(p.input.expectedChangeHash!==p.changeHash)throw new ApiError(409,'请先检查当前方案，并按完全相同的范围确认迁移');
 if(p.unavailable.length&&p.input.acknowledgeUnavailableRedirects!==true)throw new ApiError(422,'部分旧网址无法重定向，请先核对占用原因并明确确认');
 return patchStudio({expectedRevision:p.expected,patch:{settings:p.next.settings,pages:p.next.pages,products:p.next.products,editorData:p.next.editorData,...(p.next.siteLayout?{siteLayout:p.next.siteLayout}:{}),...(p.next.sharedBlocks?{sharedBlocks:p.next.sharedBlocks}:{}),...(p.next.pageTemplates?{pageTemplates:p.next.pageTemplates}:{}),...(p.next.contentEntries?{contentEntries:p.next.contentEntries}:{}),...(p.next.redirects?{redirects:p.next.redirects}:{})}},actor,'draft.update',{allowDefaultLocaleMigration:true});}).immediate();
}
