import {getContentEntryPath,getProductPath,type ContentRouteSource} from './content-routes';
import {localeOf,siteLocales,translationPeers,type TranslationKind} from './localization';
import type {ContentEntry,PageItem,Product} from './types';
/** 只列同组且有实际入口的译文；缺失保留为空，切换器不能跳去无关首页。 */
export function translationLinks(source:ContentRouteSource,kind:TranslationKind,record:PageItem|Product|ContentEntry,{preview=false}={}){
 const peers=translationPeers({...source,pages:source.pages},kind,record);
 return siteLocales(source.settings).map(language=>{const peer=peers.find(p=>localeOf(source.settings,p)===language.code&&(preview||p.status==='published'));
  const href=peer?kind==='page'?(peer as PageItem).slug:kind==='product'?getProductPath(source,peer as Product):getContentEntryPath(source,peer as ContentEntry):undefined;
  const defaultPage=kind==='page'?peer as PageItem|undefined:source.pages.find(p=>kind==='product'?p.slug==='/products/:slug':p.contentModelId===(peer as ContentEntry|undefined)?.modelId);
  return {locale:language.code,label:language.label,href,current:language.code===localeOf(source.settings,record),indexable:!!href&&!peer?.noindex&&!defaultPage?.noindex};
 });
}
