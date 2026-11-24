import type { ContentRouteSource } from './content-routes';
import type { MenuItem, SiteLayout, SiteMenu } from './types';
import { resolveLinkTarget } from './site-links';
import { safeLinkHref } from './site-safety';
import { localizedPath, localeOf, siteLocales, type LocaleSettings } from './localization';
import { rebaseLocaleBlocks } from './site-layout-locales';
export function menuAtLocale(menuId:string|undefined,localeMenuIds:Record<string,string>|undefined,settings:LocaleSettings|undefined,locale:string){return locale===(settings?.language||'en')?menuId:localeMenuIds?.[locale];}

/** 译文可分批发布。只从当前快照找语言首页，找不到时回已有的默认首页。 */
export function navigationHomePath(source: Pick<ContentRouteSource, 'pages' | 'settings'>, locale: string): string | undefined {
  const localizedHome = localizedPath(source.settings, { locale }, '/');
  if (source.pages.some(page => page.slug === localizedHome && localeOf(source.settings, page) === locale)) return localizedHome;
  return source.pages.some(page => page.slug === '/') ? '/' : undefined;
}
/** 切默认语言时保留原语言菜单；新默认缺映射则为空，不把原菜单重解释为译文。 */
export function rebaseLocaleMenus<T extends {menuId?:string;localeMenuIds?:Record<string,string>}>(value:T,from:LocaleSettings,to:LocaleSettings):T{
 if(!value.menuId&&!value.localeMenuIds)return rebaseLocaleBlocks(value,from,to);const variants={...value.localeMenuIds,...(value.menuId?{[from.language||'en']:value.menuId}:{})};
 return rebaseLocaleBlocks({...value,menuId:variants[to.language||'en']||'',localeMenuIds:Object.fromEntries(Object.entries(variants).filter(([locale])=>locale!==to.language))},from,to);
}
export function rebaseNavigationLocales<T>(value:T,from:LocaleSettings,to:LocaleSettings):T{
 const walk=(v:unknown):unknown=>{if(Array.isArray(v))return v.map(walk);if(!v||typeof v!=='object')return v;const node=v as Record<string,unknown>,next=Object.fromEntries(Object.entries(node).map(([k,x])=>[k,walk(x)]));if(node.type==='Navigation'&&next.props&&typeof next.props==='object')next.props=rebaseLocaleMenus(next.props as {menuId?:string;localeMenuIds?:Record<string,string>},from,to);return next;};return walk(value) as T;
}
export function defaultLanguageMenuErrors(previous:(NavigationSource&{pageTemplates?:{id:string;name:string;data:unknown}[]})|undefined,next:NavigationSource&{pageTemplates?:{id:string;name:string;data:unknown}[]}):string[]{
 if(!previous?.settings||!next.settings||previous.settings.language===next.settings.language||!previous.settings.locales&&!next.settings.locales)return [];
 const errors:string[]=[],same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),values=(v:{menuId?:string;localeMenuIds?:Record<string,string>;localeBlockIds?:Record<string,string>;mode?:string;blockId?:string})=>[v.menuId||'',Object.entries(v.localeMenuIds||{}).sort(),v.mode,v.blockId,Object.entries(v.localeBlockIds||{}).sort()];
 const stale=(before:{menuId?:string;localeMenuIds?:Record<string,string>},after:typeof before,label:string)=>{if(same(values(before),values(after))&&!same(values(before),values(rebaseLocaleMenus(before,previous.settings!,next.settings!))))errors.push(`默认语言迁移需要明确发布${label}的语言菜单配置`);};
 for(const slot of ['header','footer'] as const)if(previous.siteLayout?.[slot]&&next.siteLayout?.[slot])stale(previous.siteLayout[slot],next.siteLayout[slot],slot==='header'?'全站页眉':'全站页脚');
 const nodes=(data:unknown)=>{const map=new Map<string,{menuId?:string;localeMenuIds?:Record<string,string>}>();const walk=(v:unknown)=>{if(Array.isArray(v)){v.forEach(walk);return;}if(!v||typeof v!=='object')return;const n=v as {type?:string;props?:{id?:string;menuId?:string;localeMenuIds?:Record<string,string>}};if(n.type==='Navigation'&&n.props?.id)map.set(n.props.id,n.props);Object.values(v).forEach(walk);};walk(data);return map;};
 const inspect=(before:unknown,after:unknown,label:string)=>{const afterNodes=nodes(after);for(const [id,p] of nodes(before)){const current=afterNodes.get(id);if(current)stale(p,current,label);}};
 for(const page of previous.pages)if(next.pages.some(p=>p.id===page.id))inspect(previous.editorData?.[page.id],next.editorData?.[page.id],`页面“${page.title}”`);
 for(const [oldItems,newItems,label] of [[previous.sharedBlocks,next.sharedBlocks,'同步区块'],[previous.pageTemplates,next.pageTemplates,'页面模板']] as const)for(const item of oldItems||[]){const current=newItems?.find(i=>'id'in i&&'id'in item&&i.id===item.id);if(current)inspect(item.data,current.data,`${label}“${item.name}”`);}
 return errors;
}

export type NavigationSource = ContentRouteSource & { siteLayout?: SiteLayout; sharedBlocks?: { name: string; data: unknown }[] };
export function menuItemHref(source: ContentRouteSource, item: MenuItem): string | undefined {
  return item.target ? resolveLinkTarget(source, item.target) : safeLinkHref(item.href);
}

/** 菜单是版本化的全站设计，最多三级/每菜单200项；明确目标失效时不退回旧静态网址。 */
export function navigationErrors(source: NavigationSource, publishing = false): string[] {
  const errors = new Set<string>(), menus = source.siteLayout?.menus || [];
  if (!Array.isArray(menus) || menus.length > 40) return ['菜单列表最多40个'];
  const menuIds = new Set<string>();
  const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  for (const menu of menus) {
    if (!menu || !validId(menu.id) || menuIds.has(menu.id) || typeof menu.name !== 'string' || !menu.name.trim() || menu.name.length > 120) { errors.add('菜单ID重复或名称无效'); continue; }
    menuIds.add(menu.id); let count = 0; const ids = new Set<string>();
    const visit = (items: MenuItem[], depth: number) => {
      if (!Array.isArray(items) || depth > 3) { errors.add(`菜单“${menu.name}”最多三级，子项必须是列表`); return; }
      for (const item of items) {
        if (++count > 200) { errors.add(`菜单“${menu.name}”最多200项`); return; }
        if (!item || !validId(item.id) || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120) { errors.add(`菜单“${menu.name}”的项目ID或文字无效`); continue; }
        ids.add(item.id);
        if (item.newTab !== undefined && typeof item.newTab !== 'boolean') errors.add('菜单打开方式必须为是/否');
        if (item.target && !resolveLinkTarget(source, item.target)) errors.add(`菜单“${menu.name}”项目“${item.label}”引用目标不可用`);
        if (!item.target && item.href && !safeLinkHref(item.href)) errors.add(`菜单“${menu.name}”项目“${item.label}”链接不安全`);
        if (!item.target && !item.href && publishing && !item.children?.length) errors.add(`菜单“${menu.name}”项目“${item.label}”没有链接或子项`);
        if (item.children !== undefined) visit(item.children, depth + 1);
      }
    }; visit(menu.items, 1);
  }
  const checkMenu = (id: unknown, label: string) => { if (id && !menuIds.has(String(id))) errors.add(`${label}引用了不存在的菜单`); };
  const checkLocales=(value:unknown,label:string)=>{if(value===undefined)return;if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>10){errors.add(`${label}的语言菜单映射无效`);return;}for(const [locale,id] of Object.entries(value)){if(!siteLocales(source.settings).some(l=>l.code===locale)||typeof id!=='string')errors.add(`${label}引用未配置语言或无效菜单标识`);else checkMenu(id,label);}};
  checkMenu(source.siteLayout?.header.menuId, '页眉'); checkMenu(source.siteLayout?.footer.menuId, '页脚');
  checkLocales(source.siteLayout?.header.localeMenuIds,'页眉');checkLocales(source.siteLayout?.footer.localeMenuIds,'页脚');
  function visitDesign(value: unknown, label: string) {
    if (Array.isArray(value)) { value.forEach(child => visitDesign(child, label)); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as { type?: string; props?: { menuId?: unknown; anchor?: unknown;localeMenuIds?:unknown } };
    if (node.type === 'Navigation') {
      checkLocales(node.props?.localeMenuIds,label);
      checkMenu(node.props?.menuId, label);
      if (publishing && !node.props?.menuId && (!node.props?.localeMenuIds||typeof node.props.localeMenuIds!=='object'||!Object.values(node.props.localeMenuIds).some(id=>typeof id==='string'&&menuIds.has(id)))) errors.add(`${label}导航没有选择菜单`);
    }
    Object.values(value).forEach(child => visitDesign(child, label));
  }
  for (const page of source.pages) visitDesign(source.editorData?.[page.id], page.title);
  for (const block of source.sharedBlocks || []) visitDesign(block.data, block.name);
  return [...errors];
}

/** 拖放按ID移动，先移除再定位，拒绝移动到自己的后代；最终校验限定三级。 */
export function moveMenuItem(items: MenuItem[], sourceId: string, targetId: string, placement: 'before' | 'after' | 'inside'): MenuItem[] {
  const result = structuredClone(items); let moving: MenuItem | undefined;
  function remove(list: MenuItem[]): boolean { const i = list.findIndex(item => item.id === sourceId); if (i >= 0) { moving = list.splice(i, 1)[0]; return true; } return list.some(item => remove(item.children || [])); }
  if (sourceId === targetId || !remove(result)) throw new Error('不能移动到自身');
  function insert(list: MenuItem[]): boolean { const i = list.findIndex(item => item.id === targetId); if (i >= 0) { if (placement === 'inside') (list[i].children ||= []).push(moving!); else list.splice(i + (placement === 'after' ? 1 : 0), 0, moving!); return true; } return list.some(item => insert(item.children || [])); }
  if (!insert(result)) throw new Error('不能移动到自身后代或已删除的项目');
  const check = (list: MenuItem[], depth: number): void => { if (list.length && depth > 3) throw new Error('菜单最多三级'); list.forEach(item => check(item.children || [], depth + 1)); }; check(result, 1);
  return result;
}
