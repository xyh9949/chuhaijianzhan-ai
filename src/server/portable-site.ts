import {extensionFor,normalizeExtensionProps,type LocalExtension} from '../extensions/registry';
import type { SiteSnapshot } from './types';
import type { CodeSnippet, LinkTarget, MenuItem } from '../lib/types';
import { createHash } from 'node:crypto';
import { getProductPath, getContentEntryPath } from '../lib/content-routes';
import { namespaceBlockData } from '../lib/shared-blocks';
import type { Data } from '@puckeditor/core';
import { remapCodeUrl, remapSnippet } from './portable-code';
import { ApiError } from './http';
import { EMPTY_CODE } from './site-code';
import {parseRelatedField,isRelationLoop} from '../lib/content-relations';
import {localeOf,localizedPath,stripLocalePath,localeAtPath,type LocaleSettings} from '../lib/localization';
import {rebaseLocaleMenus,rebaseNavigationLocales} from '../lib/site-navigation';
import { layoutBlockIds } from '../lib/site-layout-locales';
import protocol from '../lib/protocol.json';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** 声明与引用按种类/作用域映射，字段ID允许在不同模型中重复；不改写恰好同名的业务文案。 */
export function remapPortableSite(source: SiteSnapshot, options: { namespace: string; prefix: string; merge: boolean; productTemplateId?: string; skuPrefix: string; enableJs: boolean;targetSettings?:LocaleSettings }) {
  const site = structuredClone(source), warnings = new Set<string>();
  site.schemaVersion=protocol.snapshot;delete site.urlState;
  const targetSettings=options.targetSettings||source.settings;
  if(options.targetSettings){site.settings.language=targetSettings.language||source.settings.language;if(targetSettings.locales)site.settings.locales=targetSettings.locales;else delete site.settings.locales;}
  // 数据标识排序/子串查询依赖原ID本身的字面含义，换实例命名后必须由管理员核对。
  if (/\"(?:sort|field)\":\"builtin:id\"/.test(JSON.stringify(source))) warnings.add('来源使用内部ID排序或查询；ID将重命名，结果顺序或文本子串匹配可能变化，请在草稿核对查询条件。');
  const id = (kind: string, old: string, scope = '') => `pkg-${options.namespace}-${createHash('sha256').update(`${kind}:${scope}:${old}`).digest('hex').slice(0, 24)}`;
  const ids = (kind: string, old: unknown) => typeof old === 'string' && old ? id(kind, old) : old;
  const paths = new Map<string, string>(), nodes = new Map<string, string>(), queryKeys = new Map<string,string>(), terms = new Map<string,string>(), attributes = new Map<string,Map<string,string[]>>();
  const attribute = (key:string,from:string,to:string) => { const values = attributes.get(key) || new Map<string,string[]>(), existing = values.get(from) || []; if (!existing.includes(to)) existing.push(to); values.set(from,existing); attributes.set(key,values); };
  // 语言前缀位于命名空间之外，不能把 /de/about 错写为 /prefix/de/about。
  const pathFor = (path:string)=>!options.merge?path:path==='/products/:slug'?path:path.includes(':')?`/${options.prefix}${path}`:localizedPath(targetSettings,{locale:localeAtPath(source.settings,path)},`/${options.prefix}${stripLocalePath(source.settings,path)==='/'?'':stripLocalePath(source.settings,path)}`);
  for (const page of source.pages) paths.set(page.slug, pathFor(page.slug));
  for(const rule of source.redirects||[])paths.set(rule.from,pathFor(rule.from));
  for (const media of source.media) paths.set(media.url, `/api/media/${id('media', media.id)}`);
  const pageId = (old: string) => options.productTemplateId && source.pages.some(p => p.id === old && p.slug === '/products/:slug') ? options.productTemplateId : id('page', old);
  const target = (v: LinkTarget): LinkTarget => ({ ...v, id: v.kind === 'page' ? source.pageTemplates?.some(t => t.id === v.id) ? id('template', v.id) : pageId(v.id) : id(v.kind, v.id) });
  const field = (value:string,model?:string) => { const related=parseRelatedField(value);return model&&related?`related:${id('field',related.fieldId,model)}:${related.property}`:value.startsWith('field:')&&model?`field:${id('field',value.slice(6),model)}`:value; };
  function gather(v: unknown) {
    if (Array.isArray(v)) { v.forEach(gather); return; } if (!record(v)) return;
    if (record(v.props) && typeof v.type === 'string') for (const key of ['id', 'anchor']) if (typeof v.props[key] === 'string' && v.props[key]) { nodes.set(v.props[key], id('node', v.props[key])); if (key === 'id') for (const suffix of ['-fields', '-submit']) nodes.set(v.props[key] + suffix, id('node', v.props[key]) + suffix); }
    Object.values(v).forEach(gather);
  }
  Object.values(source.editorData).forEach(gather); source.sharedBlocks?.forEach(b => gather(b.data)); source.pageTemplates?.forEach(t => gather(t.data));
  // 产品默认详情是实例固定入口；合并时只保留一个，导入设计另存页面模板资源。
  for (const p of site.products) {
    const before = source.products.find(v => v.id === p.id)!;
    p.id = id('product', p.id); p.slug = options.merge ? `${options.namespace}-${before.slug || before.id}`.slice(0, 100) : before.slug || (/^[a-z0-9][a-z0-9_-]{0,99}$/.test(before.id) ? before.id : undefined);
    p.sku = options.skuPrefix + p.sku; p.status = 'draft';p.locale=localeOf(source.settings,before);
    const from = getProductPath(source, before), to = getProductPath({ ...site, pages: source.pages }, p); if (from && to) paths.set(from, to);
  }
  for (const e of site.contentEntries || []) {
    const before = source.contentEntries!.find(v => v.id === e.id)!;
    const template = source.pages.find(p => p.contentModelId === before.modelId);
    e.id = id('entry', e.id); e.slug = before.slug || (/^[a-z0-9][a-z0-9_-]{0,99}$/.test(before.id) ? before.id : undefined); e.status = 'draft';e.locale=localeOf(source.settings,before);
    const from = getContentEntryPath(source, before); if (template && from) paths.set(from, localizedPath(targetSettings,e,pathFor(template.slug).replace(':slug', e.slug || e.id)));
  }
  for (const p of source.pages) attribute('data-page-id', p.id, pageId(p.id));
  for (const t of source.pageTemplates || []) attribute('data-page-id', t.id, id('template', t.id));
  for (const b of source.sharedBlocks || []) for (const key of ['data-shared-block','data-shared-block-id']) attribute(key,b.id,id('block',b.id));
  for (const m of source.contentModels || []) {attribute('data-content-model',m.id,id('model',m.id));for(const f of m.fields) attribute('data-product-field',f.id,id('field',f.id,m.id));}
  for (const [kind,records] of [['product',source.products],['entry',source.contentEntries || []]] as const) for(const r of records) for(const key of ['data-content-record','data-loop-record']) attribute(key,r.id,id(kind,r.id));
  for(const t of source.taxonomies || []) for(const term of t.terms) terms.set(term.id,id('term',term.id));
  const url = (value: string) => value.startsWith('#') ? `#${nodes.get(value.slice(1)) || value.slice(1)}` : remapCodeUrl(value, { paths, nodes, queryKeys, terms });
  function design(v: unknown, model?: string,extension?:LocalExtension): unknown {
    if (Array.isArray(v)) return v.map(x => design(x, model)); if (!record(v)) return v;
    const oldModel = typeof v.modelId === 'string' ? v.modelId : model;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(v)) {
      if(key==='props'&&typeof v.type==='string'&&extensionFor(v.type))result[key]=design(normalizeExtensionProps(v.type,value),oldModel,extensionFor(v.type));
      else if(extension?.schema[key]?.kind==='product'&&typeof value==='string')result[key]=ids('product',value);
      else if(extension?.schema[key]?.kind==='document'&&typeof value==='string')result[key]=url(value);
      else if(key==='localeBlockIds'&&record(value))result[key]=Object.fromEntries(Object.entries(value).map(([locale,id])=>[locale,ids('block',id)]));
      else if(key==='localeMenuIds'&&record(value))result[key]=Object.fromEntries(Object.entries(value).map(([locale,id])=>[locale,ids('menu',id)]));
      else if(key==='relation'&&isRelationLoop(value))result[key]={...value,modelId:id('model',value.modelId),fieldId:id('field',value.fieldId,value.modelId)};
      else if (key === 'bindings' && record(value)) result[key] = Object.fromEntries(Object.entries(value).map(([target, binding]) => { const mapped = design(binding, oldModel) as Record<string, unknown>; if (['src', 'href'].includes(target) && record(binding) && typeof binding.fallback === 'string') mapped.fallback = url(binding.fallback); return [target, mapped]; }));
      else if (key === 'linkTarget' && record(value)) result[key] = target(value as unknown as LinkTarget);
      else if (['blockId', 'itemBlockId', 'formId', 'menuId', 'stylePresetId', 'modelId', 'contentModelId', 'recordId', 'productId'].includes(key) && typeof value === 'string') result[key] = ids(({ blockId: 'block', itemBlockId: 'block', formId: 'form', menuId: 'menu', stylePresetId: 'preset', modelId: 'model', contentModelId: 'model', productId: 'product', recordId: v.source === 'entry' ? 'entry' : 'product' } as Record<string, string>)[key], value);
      else if (key === 'id' && typeof value === 'string') result[key] = id('node', value);
      else if (key === 'anchor' && typeof value === 'string' && value) result[key] = nodes.get(value) || value;
      else if (key === 'wideFields' && Array.isArray(value) && typeof v.formId === 'string') result[key] = value.map(x => typeof x === 'string' ? id('form-field', x, v.formId as string) : x);
      else if (key === 'value' && v.field === 'builtin:id' && ['eq','in'].includes(String(v.op))) { const kind = source.contentModels?.find(m=>m.id===oldModel)?.target === 'content' ? 'entry' : 'product'; result[key] = Array.isArray(value) ? value.map(x=>ids(kind,x)) : ids(kind,value); }
      else if (key === 'termIds' && Array.isArray(value)) result[key] = value.map(x => ids('term', x));
      else if (['field', 'sort', 'titleField', 'descriptionField', 'imageField', 'linkField'].includes(key) && typeof value === 'string') result[key] = field(value, oldModel);
      else if (key === 'tokenBindings' && record(value)) result[key] = Object.fromEntries(Object.entries(value).map(([device, bindings]) => [device, record(bindings) ? Object.fromEntries(Object.entries(bindings).map(([name, token]) => [name, ids('token', token)])) : bindings]));
      else if (typeof value === 'string' && ['href', 'src', 'url', 'poster', 'image', 'seoImage', 'backgroundImage', 'videoUrl', 'fileUrl'].includes(key)) result[key] = url(value);
      else if (key === 'zones' && record(value)) result[key] = Object.fromEntries(Object.entries(value).map(([zone, content]) => { const colon = zone.indexOf(':'); return [colon < 0 ? zone : `${id('node', zone.slice(0, colon))}${zone.slice(colon)}`, design(content, oldModel)]; }));
      else result[key] = design(value, oldModel);
    }
    return result;
  }
  function values(v: { modelId?: string; customFields?: Record<string, unknown>;richTextFields?:Record<string,import('../lib/presentation-content').RichNode>;detailContent?:import('../lib/presentation-content').RichNode; termIds?: string[]; image?: string; images?:string[]; seoImage?: string;translationGroupId?:string },kind:'product'|'entry') {
    const model = source.contentModels?.find(m => m.id === v.modelId), old = v.modelId;
    if (v.customFields) v.customFields = Object.fromEntries(Object.entries(v.customFields).map(([key, value]) => { const definition=model?.fields.find(f=>f.id===key),type=definition?.type; if(type==='relation'&&definition?.relation){const kind=definition.relation.source;return [old?id('field',key,old):key,Array.isArray(value)?value.map(x=>ids(kind,x)):ids(kind,value)];} return [old ? id('field', key, old) : key, ['image', 'gallery', 'url'].includes(type || '') ? Array.isArray(value) ? value.map(x => typeof x === 'string' ? url(x) : x) : typeof value === 'string' ? url(value) : value : value]; }));
    // 排版字段键与正文图片/链接必须一起重映射；文字投影本身仍是普通文字，不重写URL字样。
    // 产品长详情和文章正文使用相同安全URL重映射，不把已上传图片留在来源实例。
    if(v.detailContent)v.detailContent=design(v.detailContent,old) as import('../lib/presentation-content').RichNode;
    if(v.richTextFields)v.richTextFields=Object.fromEntries(Object.entries(v.richTextFields).map(([key,doc])=>[old?id('field',key,old):key,design(doc,old) as import('../lib/presentation-content').RichNode]));
    if (v.modelId) v.modelId = id('model', v.modelId); if (v.termIds) v.termIds = v.termIds.map(x => id('term', x));
    if (v.image) v.image = url(v.image); if(v.images)v.images=v.images.map(url); if (v.seoImage) v.seoImage = url(v.seoImage);
    if(v.translationGroupId)v.translationGroupId=id('translation-group',v.translationGroupId,kind);
  }
  site.products.forEach(v=>values(v,'product')); site.contentEntries?.forEach(v=>values(v,'entry'));
  for (const m of site.contentModels || []) { const old = m.id; m.id = id('model', old); m.fields = m.fields.map(f => ({ ...f, id: id('field', f.id, old),...(f.relation?{relation:{...f.relation,...(f.relation.modelId?{modelId:id('model',f.relation.modelId)}:{})}}:{}) })); }
  if(site.settings.discovery?.mappings)site.settings.discovery.mappings=site.settings.discovery.mappings.map(m=>({...m,modelId:id('model',m.modelId),...(m.authorFieldId?{authorFieldId:id('field',m.authorFieldId,m.modelId)}:{}),...(m.descriptionFieldId?{descriptionFieldId:id('field',m.descriptionFieldId,m.modelId)}:{})}));
  for (const t of site.taxonomies || []) { t.id = id('taxonomy', t.id); if (t.modelId) t.modelId = id('model', t.modelId); t.terms = t.terms.map(x => ({ ...x, id: id('term', x.id), ...(x.parentId ? { parentId: id('term', x.parentId) } : {}) })); }
  for (const f of site.forms || []) { const old = f.id; f.id = id('form', old); f.fields = f.fields.map(x => ({ ...x, id: id('form-field', x.id, old), ...(x.options ? { options: x.options.map(o => ({ ...o, id: id('option', o.id, `${old}:${x.id}`) })) } : {}) })); }
  for (const m of site.media) { m.url = paths.get(m.url)!; m.id = id('media', m.id); }
  // 公开DOM的共享区块实例ID由渲染器编号；成对展开源/目标声明，补齐CSS/JS可引用的真实作用域。
  let runtimeBudget = 0;
  function runtimeData(old: unknown, mapped: unknown, path: string[] = [], oldNs = '', newNs = '') {
    if (Array.isArray(old) && Array.isArray(mapped)) { old.forEach((v,i)=>runtimeData(v,mapped[i],path,oldNs,newNs)); return; }
    if (!record(old) || !record(mapped)) return;
    if (typeof old.type === 'string' && record(old.props) && record(mapped.props)) {
      if (++runtimeBudget > 200000) throw new ApiError(422,'分发包DOM作用域超过200000项，请拆分站点资源');
      const props=old.props; const from=String(props.id),to=String(mapped.props.id); nodes.set(from,to);
      for(const suffix of ['-fields','-submit']) nodes.set(from+suffix,to+suffix);
      if(old.type==='ProductDetail')for(let index=0;index<20;index++)nodes.set(`${from}-photo-${index}`,`${to}-photo-${index}`);
      if (typeof old.props.anchor === 'string' && old.props.anchor) nodes.set(oldNs ? `${oldNs}--${old.props.anchor}` : old.props.anchor, newNs ? `${newNs}--${mapped.props.anchor}` : String(mapped.props.anchor));
      if (old.type === 'Form') for(const f of source.forms?.find(f=>f.id===props.formId)?.fields || []) { const fieldId=id('form-field',f.id,String(old.props.formId)); nodes.set(`${from}_${f.id}`,`${to}_${fieldId}`);nodes.set(`${from}-${f.id}`,`${to}-${fieldId}`); attribute('name',f.id,fieldId); }
      if (old.type === 'SharedBlock' && typeof old.props.blockId === 'string') expand(old.props.blockId,from,to,path);
      if (old.type === 'ContentLoop' && typeof old.props.itemBlockId === 'string') { for (let i=1;i<=Math.min(50,Number(old.props.count)||6);i++) expand(old.props.itemBlockId,`${from}-item-${i}`,`${to}-item-${i}`,path); for(const key of ['page','search','term'])queryKeys.set(`${key}_${from}`,`${key}_${to}`); }
    }
    for(const [key,value] of Object.entries(old)) runtimeData(value,mapped[key],path,oldNs,newNs);
  }
  function expand(blockId:string,from:string,to:string,path:string[]) {
    if (path.includes(blockId) || path.length>=8) return; const b=source.sharedBlocks?.find(b=>b.id===blockId); if(!b)return;
    const oldNs=`shared-${from}`,newNs=`shared-${to}`;nodes.set(`${oldNs}--block-root`,`${newNs}--block-root`);
    runtimeData(namespaceBlockData(b.data,oldNs),namespaceBlockData(design(b.data) as Data,newNs),[...path,blockId],oldNs,newNs);
  }
  for(const value of Object.values(source.editorData)) runtimeData(value,design(value));
  for(const b of source.sharedBlocks || []) runtimeData(b.data,design(b.data),[b.id]);
  for(const t of source.pageTemplates || []) runtimeData(t.data,design(t.data));
  for(const slot of ['header','footer'] as const) for(const blockId of layoutBlockIds(source.siteLayout?.[slot]))expand(blockId,`site-${slot}`,`site-${slot}`,[]);
  const references = { nodes, paths, attributes, queryKeys, terms };
  const snippet = (code: CodeSnippet) => { const result = remapSnippet(code, references, options.enableJs); result.warnings.forEach(w => warnings.add(w)); return result.code; };
  const sourceGlobal = snippet(source.customCode?.global || EMPTY_CODE);
  site.customCode = { global: options.merge ? { ...EMPTY_CODE } : sourceGlobal, pages: {} };
  const templates = (site.pageTemplates || []).map(t => ({ ...t, id: id('template', t.id), ...(t.modelId ? { modelId: id('model', t.modelId) } : {}), ...(t.sourcePath ? { sourcePath: url(t.sourcePath) } : {}), ...(t.detailRule?{detailRule:{...t.detailRule,...(t.detailRule.modelId?{modelId:id('model',t.detailRule.modelId)}:{}),...(t.detailRule.recordIds?{recordIds:t.detailRule.recordIds.map(r=>id(t.kind==='product'?'product':'entry',r))}:{}),...(t.detailRule.termIds?{termIds:t.detailRule.termIds.map(r=>id('term',r))}:{})}}:{}), data: design(t.data) as typeof t.data, ...(t.code ? { code: snippet(t.code) } : {}) }));
  site.editorData = {};
  site.pages = source.pages.flatMap(p => {
    const code = snippet(source.customCode?.pages[p.id] || EMPTY_CODE), imported = { ...p, id: id('page', p.id), slug: pathFor(p.slug), status: 'draft' as const,...(!p.slug.includes(':')?{locale:localeOf(source.settings,p)}:{}),...(p.translationGroupId?{translationGroupId:id('translation-group',p.translationGroupId,'page')}:{}), ...(p.contentModelId ? { contentModelId: id('model', p.contentModelId) } : {}), ...(p.seoImage ? { seoImage: url(p.seoImage) } : {}) };
    // 合并时全站代码变成导入页面代码，避免改变既有页面；仍需管理员检查动态程序语义。
    const wrapJs = (value: string, enabled: boolean) => value.trim() ? `${enabled ? '' : 'if (false) '}(function () {\n${value.replace(/^#!/, '//')}\n}).call(window);` : '';
    const wrapCss = (value: string, enabled: boolean) => enabled ? value : value.trim() ? `@media not all {\n${value}\n}` : '';
    const combined = options.merge ? { css: `${wrapCss(sourceGlobal.css, sourceGlobal.cssEnabled)}\n${wrapCss(code.css, code.cssEnabled)}`, js: `${wrapJs(sourceGlobal.js, !!source.customCode?.global.jsEnabled)}\n${wrapJs(code.js, !!source.customCode?.pages[p.id]?.jsEnabled)}`, cssEnabled: sourceGlobal.cssEnabled || code.cssEnabled, jsEnabled: options.enableJs && (!!source.customCode?.global.jsEnabled || !!source.customCode?.pages[p.id]?.jsEnabled) } : code;
    if (options.productTemplateId && p.slug === '/products/:slug') { templates.push({ id: id('template-page', p.id), name: `${p.title} · 导入详情设计`, description: '合并时保留原产品默认详情；可在资源库明确应用此设计。', kind: 'product', sourcePath: p.slug, data: design(source.editorData[p.id]) as never, code: combined, updated: p.updated }); return []; }
    site.editorData[imported.id] = design(source.editorData[p.id]); site.customCode!.pages[imported.id] = combined; return [imported];
  });
  if (source.editorData.__themeControls !== undefined) site.editorData.__themeControls = design(source.editorData.__themeControls);
  site.pageTemplates = templates;
  site.sharedBlocks = source.sharedBlocks?.map(b => ({ ...b, id: id('block', b.id), data: design(b.data) as typeof b.data }));
  site.theme = design(source.theme) as typeof site.theme;
  site.theme.tokens = source.theme.tokens?.map(t => ({ ...t, id: id('token', t.id) }));
  site.theme.presets = source.theme.presets?.map(p => ({ ...design(p) as typeof p, id: id('preset', p.id) }));
  function menu(items: MenuItem[]): MenuItem[] { return items.map(m => ({ ...m, id: id('menu-item', m.id), ...(m.target ? { target: target(m.target) } : {}), ...(m.href ? { href: url(m.href) } : {}), ...(m.children ? { children: menu(m.children) } : {}) })); }
  if (source.siteLayout) site.siteLayout = { header: design(source.siteLayout.header) as typeof source.siteLayout.header, footer: design(source.siteLayout.footer) as typeof source.siteLayout.footer, menus: source.siteLayout.menus?.map(m => ({ ...m, id: id('menu', m.id), items: menu(m.items) })) };
  site.redirects = source.redirects?.map(r => ({ ...r, id: id('redirect', r.id), from: url(r.from), target: target(r.target) }));
  if(options.merge&&source.settings.language!==site.settings.language){
    site.editorData=rebaseNavigationLocales(site.editorData,source.settings,site.settings);
    site.sharedBlocks=site.sharedBlocks?.map(b=>({...b,data:rebaseNavigationLocales(b.data,source.settings,site.settings)}));
    site.pageTemplates=site.pageTemplates?.map(t=>({...t,data:rebaseNavigationLocales(t.data,source.settings,site.settings)}));
    if(site.siteLayout){site.siteLayout.header=rebaseLocaleMenus(site.siteLayout.header,source.settings,site.settings);site.siteLayout.footer=rebaseLocaleMenus(site.siteLayout.footer,source.settings,site.settings);}
  }
  delete site.releaseId; delete site.publicRedirects;
  return { site, warnings: [...warnings], id, paths };
}
