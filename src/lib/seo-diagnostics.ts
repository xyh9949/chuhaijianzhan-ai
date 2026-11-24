import type { ComponentData, Data } from '@puckeditor/core';
import type { DraftContent, SiteSnapshot } from '../server/types';
import type { BindingContext, ContentEntry, ContentQuery, FieldBinding, MenuItem, PageItem, Product } from './types';
import type { SeoDataReport, SeoDiagnosticIssue, SeoDiagnosticReport, SeoEvidence, SeoMetadata, SeoTarget } from './seo-types';
import { publicSiteOrigin } from './site-seo';
import { getContentEntryPath, getContentTemplate, getProductPath } from './content-routes';
import { resolveSitePage, type ResolvedSitePage } from './site-routing';
import { resolveLinkTarget } from './site-links';
import { resolveBindingValue, resolveGalleryBinding, resolveRichTextBinding } from './content-binding';
import { componentSlots } from './editor-slots';
import { CORE_COMPONENT_TYPES } from './component-contract';
import { queryContent } from './content-query';
import { relationLoopIds } from './content-relations';
import { localeOf, stripLocalePath } from './localization';
import { getPageKind } from './page-data';
import { menuAtLocale, navigationHomePath } from './site-navigation';
import { effectiveLayoutBlockId } from './site-layout-locales';
import { translationLinks } from './translation-links';
import protocol from './protocol.json';

const MAX_TARGETS = 500, MAX_ISSUES = 1200, MAX_NODES_PER_TARGET = 1500, MAX_TOTAL_NODES = 100_000, MAX_REPORT_ROWS = 20_000;
const plain = (value: unknown) => typeof value === 'string' ? value : '';
const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en');
const targetKey = (target: Pick<SeoTarget,'kind'|'id'>) => `${target.kind}:${target.id}`;
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 目标来自当前实例记录；模板自身和缺少详情模板的记录不编造可访问URL。 */
export function enumerateSeoTargets(content: DraftContent): SeoTarget[] {
  return [
    ...content.pages.map(page => ({kind:'page' as const,id:page.id,url:page.slug.includes(':')?null:page.slug,label:page.title})),
    ...content.products.map(product => ({kind:'product' as const,id:product.id,url:getProductPath(content,product)||null,label:product.name})),
    ...(content.contentEntries||[]).map(entry => ({kind:'entry' as const,id:entry.id,url:getContentEntryPath(content,entry)||null,label:entry.title})),
  ];
}
function entity(content: DraftContent, target: Pick<SeoTarget,'kind'|'id'>) {
  return target.kind==='page'?content.pages.find(page=>page.id===target.id):target.kind==='product'?content.products.find(product=>product.id===target.id):content.contentEntries?.find(entry=>entry.id===target.id);
}
/** 显式字段用于精确预览/撤销；缺省字段不擅自写成全站或记录名称的fallback。 */
export function getSeoTargetMetadata(content: DraftContent, target: Pick<SeoTarget,'kind'|'id'>): SeoMetadata | undefined {
  const value=entity(content,target);return value?{seoTitle:plain(value.seoTitle),seoDescription:plain(value.seoDescription)}:undefined;
}
/** 与siteMetadata相同的实际展示优先级；返回的标题尚未追加全站品牌后缀。 */
export function getSeoEffectiveMetadata(content: DraftContent, target: Pick<SeoTarget,'kind'|'id'>): SeoMetadata | undefined {
  const value=entity(content,target);if(!value)return;
  if(target.kind==='page'){const page=value as PageItem;return {seoTitle:page.seoTitle||page.title,seoDescription:page.seoDescription||content.settings.description};}
  if(target.kind==='product'){const product=value as Product,page=content.pages.find(page=>page.slug==='/products/:slug');return {seoTitle:product.seoTitle||product.name||page?.seoTitle||page?.title||'',seoDescription:product.seoDescription||product.description||page?.seoDescription||content.settings.description};}
  const entry=value as ContentEntry,page=getContentTemplate(content,entry.modelId);return {seoTitle:entry.seoTitle||entry.title||page?.seoTitle||page?.title||'',seoDescription:entry.seoDescription||page?.seoDescription||content.settings.description};
}
/** Google绝对网址只映射本站正式源地址和真实路径，带参数/跨域数据不能归错单页。 */
export function matchSeoTargetUrl(content: DraftContent, value: string, targets=enumerateSeoTargets(content)): SeoTarget | undefined {
  const origin=publicSiteOrigin(content.settings.publicUrl);if(!origin)return;
  try{const url=new URL(value);if(url.origin!==origin||url.username||url.password||url.search||url.hash)return;return targets.find(target=>target.url===url.pathname);}catch{return;}
}

type Scan = {h1:number;emptyH1:number;missingAlt:number;links:Set<string>;brokenLinks:Set<string>;body:string[];uncertain:boolean;bounded:boolean;dynamicKinds:Set<string>};
type Runtime = {bindingContext?:BindingContext;productId?:string;loop?:boolean};

function previewSource(content:DraftContent):SiteSnapshot {
  // 当前草稿用与预览相同的真实数据诊断；不修改发布状态，也不声称这些内容已上线。
  return {...content,schemaVersion:protocol.snapshot,pages:content.pages.map(page=>({...page,status:'published'})),products:content.products.map(product=>({...product,status:'published'})),contentEntries:content.contentEntries?.map(entry=>({...entry,status:'published'}))};
}
function localPath(value:string,origin:string|undefined):string|undefined {
  if(!value||value.startsWith('#')||/^mailto:|^tel:/i.test(value))return;
  try{const url=new URL(value,origin||'https://diagnostic.invalid');if(url.origin!==(origin||'https://diagnostic.invalid')||url.username||url.password)return;if(/^\/(?:api|admin|preview|_next|images|fonts)(?:\/|$)/.test(url.pathname))return;return url.pathname;}catch{return;}
}
function scanTarget(source:SiteSnapshot,resolved:ResolvedSitePage,budget:{visits:number}):Scan {
  const result:Scan={h1:0,emptyH1:0,missingAlt:0,links:new Set(),brokenLinks:new Set(),body:[],uncertain:false,bounded:false,dynamicKinds:new Set()},origin=publicSiteOrigin(source.settings.publicUrl),locale=localeOf(source.settings,resolved.entry||resolved.product||resolved.page);
  const root:Record<string,any>=isObject(resolved.data.root?.props)?resolved.data.root.props:{},initial:Runtime={productId:resolved.product?.id,bindingContext:resolved.entry?{source:'entry',recordId:resolved.entry.id,modelId:resolved.entry.modelId}:root.bindingContext};
  let visits=0,textChars=0;
  const body=(value:unknown,main:boolean)=>{if(main&&typeof value==='string'&&value.trim()){if(textChars+value.length>50_000){result.bounded=true;return;}textChars+=value.length;result.body.push(value);}};
  const image=(src:unknown,alt:unknown)=>{if(typeof src==='string'&&src&&!plain(alt).trim())result.missingAlt++;};
  function link(value:unknown){if(typeof value!=='string')return;if(value==='#story'){const page=source.pages.filter(page=>localeOf(source.settings,page)===locale).find(page=>page.id==='about'||getPageKind({...page,slug:stripLocalePath(source.settings,page.slug)})==='about');if(page&&!page.slug.includes(':'))result.links.add(page.slug);return;}const path=localPath(value,origin);if(path)result.links.add(path);}
  function menu(id:unknown){const current=source.siteLayout?.menus?.find(menu=>menu.id===id);function walk(items:MenuItem[]){for(const item of items){link(item.target?resolveLinkTarget(source,item.target):item.href);if(item.target&&!resolveLinkTarget(source,item.target))result.brokenLinks.add(`导航${item.label}`);if(item.children)walk(item.children);}}if(current)walk(current.items);}
  function rich(value:unknown,main:boolean,depth=0){if(!isObject(value)||depth>24){if(depth>24)result.bounded=true;return;}if(value.type==='heading'&&value.attrs?.level===1){result.h1++;const text=(value.content||[]).map((item:any)=>plain(item.text)).join('');if(!text.trim())result.emptyH1++;}if(value.type==='image')image(value.attrs?.src,value.attrs?.alt);if(value.type==='text')body(value.text,main);for(const mark of value.marks||[])if(mark.type==='link')link(mark.attrs?.href);for(const child of value.content||[])rich(child,main,depth+1);}
  function walk(nodes:ComponentData[],runtime:Runtime,main:boolean,path:string[]=[]) {
    for(const node of nodes){if(++visits>MAX_NODES_PER_TARGET||++budget.visits>MAX_TOTAL_NODES||path.length>8){result.bounded=true;return;}if(!node||!isObject(node.props))continue;
      const p=node.props,props={...p};
      for(const field of ['text','src','alt','href'] as const)if(isObject(p.bindings?.[field]))props[field]=resolveBindingValue(p.bindings[field] as FieldBinding,field,source,runtime);
      if(!CORE_COMPONENT_TYPES.includes(node.type))result.uncertain=true;
      if(node.type==='Heading'){if(p.level==='h1'){result.h1++;if(!plain(props.text).trim())result.emptyH1++;}}
      else if(node.type==='Text'){const doc=p.bindings?.text?resolveRichTextBinding(p.bindings.text,source,runtime):undefined;if(doc)rich(doc,main);else body(props.text,main);}
      else if(node.type==='Image')image(props.src,props.alt);
      // 公开 HTML 中的参数、阶段及对比图片同样参与站点诊断。
      else if(node.type==='ComparisonTable'){
        body(p.title,main);
        for(const column of p.modelColumns||[])body(column,main);
        for(const row of p.rows||[]){body(row.label,main);for(const value of row.values||[])body(value,main);}
      }else if(node.type==='ProjectTimeline'){
        body(p.title,main);
        for(const item of p.items||[]){body(item.label,main);body(item.title,main);body(item.description,main);}
      }else if(node.type==='ImageComparison'){
        body(p.title,main);
        for(const item of [p.before,p.after])if(isObject(item)){image(item.src,item.alt);body(item.label,main);}
      }
      else if(node.type==='ActionButton'){if(p.linkTarget){const href=resolveLinkTarget(source,p.linkTarget);if(!href)result.brokenLinks.add(plain(p.id));link(href);}else link(props.href);}
      else if(node.type==='RichText')rich(p.doc,main);
      else if(node.type==='Gallery'||node.type==='Carousel'&&p.panelMode!=='free'){
        const pictures = node.type==='Gallery' && p.bindings?.images ? resolveGalleryBinding(p.bindings.images,source,runtime) : p.images || [];
        for(const picture of pictures) image(picture.src,picture.alt);
      }
      else if(node.type==='Navigation')menu(menuAtLocale(p.menuId,p.localeMenuIds,source.settings,locale));
      else if(node.type==='Breadcrumb')link(navigationHomePath(source,locale));
      else if(node.type==='LanguageSwitcher'){
        const record=(resolved.product||runtime.loop)&&runtime.productId?source.products.find(product=>product.id===runtime.productId):(resolved.entry||runtime.loop)&&runtime.bindingContext?.source==='entry'?source.contentEntries?.find(entry=>entry.id===runtime.bindingContext?.recordId):resolved.page;
        if(record)for(const translated of translationLinks(source,'name'in record?'product':'customFields'in record?'entry':'page',record,{preview:true}))link(translated.href);
      }
      else if(node.type==='ProductDetail'){
        const product=source.products.find(product=>product.id===(runtime.productId||p.productId))||(!runtime.productId&&!p.productId?source.products[0]:undefined);
        if(product){result.h1++;if(!product.name.trim())result.emptyH1++;body(product.description,main);body(product.material,main);if(product.detailContent)rich(product.detailContent,main);}
      }else if(node.type==='ProductList'){
        result.dynamicKinds.add('product:*');for(const product of source.products.filter(product=>localeOf(source.settings,product)===locale&&(!p.category||product.category.toLocaleLowerCase().includes(String(p.category).toLocaleLowerCase()))).slice(0,Math.max(0,Math.min(50,Number(p.count)||6))))link(getProductPath(source,product));
      }else if(node.type==='ContentList'){
        const kind:'entry'|'product'=p.source==='entry'?'entry':'product';result.dynamicKinds.add(`${kind}:${p.modelId||'*'}`);
        const records=(kind==='product'?source.products:p.modelId?source.contentEntries||[]:[]).filter(record=>(!p.modelId||record.modelId===p.modelId)&&localeOf(source.settings,record)===locale).slice(0,Math.max(1,Math.min(12,Number(p.count)||6)));
        for(const record of records){const bound={source:kind,mode:'fixed' as const,recordId:record.id,modelId:p.modelId||undefined},title=resolveBindingValue({...bound,field:p.titleField||''},'text',source),src=resolveBindingValue({...bound,field:p.imageField||''},'src',source);image(src,title);link(resolveBindingValue({...bound,field:p.linkField||''},'href',source));}
      }else if(node.type==='ContentLoop'){
        const kind=p.source==='product'?'product':'entry';result.dynamicKinds.add(`${kind}:${p.modelId||'*'}`);const block=source.sharedBlocks?.find(block=>block.id===p.itemBlockId);
        if(block&&!path.includes(block.id)){const queried=queryContent({...source,locale},kind,p.modelId,p.query as ContentQuery|undefined,p.id,{},p.count,relationLoopIds(source,p.relation,runtime));for(const record of queried.records)walk(block.data.content,kind==='product'?{productId:record.id,loop:true}:{bindingContext:{source:'entry',recordId:record.id,modelId:record.modelId},loop:true},false,[...path,block.id]);}
      }else if(node.type==='SharedBlock'){
        const block=source.sharedBlocks?.find(block=>block.id===p.blockId);if(block&&!path.includes(block.id))walk(block.data.content,runtime,main,[...path,block.id]);else if(block)result.uncertain=true;
      }
      for(const slot of componentSlots(node))walk(slot.content,runtime,main,path);
      if(['Tabs','Accordion'].includes(node.type)&&p.panelMode!=='free')for(const item of p.items||[])body(item.body,main);
    }
  }
  walk(resolved.data.content,initial,true);
  if(Object.values(resolved.data.zones||{}).some(value=>Array.isArray(value)&&value.length))result.uncertain=true;
  for(const slot of ['header','footer'] as const){
    const setting=source.siteLayout?.[slot];
    if(root.showChrome==='no'||root[`${slot}Mode`]==='hidden'||setting?.mode==='hidden')continue;
    // 与真实渲染用同一个语言区块规则，包括默认布局上配置了译文区块的情况。
    const blockId=effectiveLayoutBlockId(setting,source.settings,locale);
    if(blockId){
      const block=source.sharedBlocks?.find(block=>block.id===blockId);
      if(block)walk(block.data.content,initial,false,[block.id]);
      continue;
    }
    const id=menuAtLocale(setting?.menuId,setting?.localeMenuIds,source.settings,locale);
    if(id)menu(id);
    if(slot!=='header')continue;
    link(navigationHomePath(source,locale));
    if(id)continue;
    const localizedPages=source.pages.filter(page=>localeOf(source.settings,page)===locale);
    for(const kind of ['products','about','contact']){
      const page=localizedPages.find(page=>page.id===kind)||localizedPages.find(page=>getPageKind({...page,slug:stripLocalePath(source.settings,page.slug)})===kind);
      if(page&&!page.slug.includes(':'))link(page.slug);
    }
  }
  return result;
}

/** 当前草稿的可验证检查与有来源的机会提示；无外网请求、无模型调用、无数据写入。 */
export function diagnoseSeo(content:DraftContent,reports:SeoDataReport[]=[]):SeoDiagnosticReport {
  const targets=enumerateSeoTargets(content),checked=targets.slice(0,MAX_TARGETS),issues:SeoDiagnosticIssue[]=[],notes=new Set<string>(['检查当前草稿预览，不代表公开网站已经更新或被Google收录。','未联网检查外链状态；复杂自定义代码/扩展组件的最终可见内容需人工核对。']),source=previewSource(content),origin=publicSiteOrigin(content.settings.publicUrl),budget={visits:0};let truncated=targets.length>MAX_TARGETS;
  const push=(issue:Omit<SeoDiagnosticIssue,'id'>,suffix='')=>{const next={...issue,id:`${issue.target?targetKey(issue.target):'site'}:${issue.code}${suffix?`:${suffix}`:''}`};if(issues.length>=MAX_ISSUES){truncated=true;notes.add('最多展示1200项问题，优先保留错误、警告和搜索机会，其余为部分覆盖。');const rank={info:0,opportunity:2,warning:2,error:3},lowest=issues.reduce((at,item,index)=>rank[item.severity]<rank[issues[at].severity]?index:at,0);if(rank[issue.severity]>rank[issues[lowest].severity])issues[lowest]=next;return;}issues.push(next);};
  const siteEvidence=(description:string):SeoEvidence[]=>[{source:'site',description}];
  if(!origin)push({code:'missing-public-url',severity:'warning',message:'请填写有效的正式网址，才能准确生成规范地址并匹配搜索报表。',action:'settings',evidence:siteEvidence('当前未设置不带路径、参数和账号信息的http/https正式源地址。')});
  const titleGroups=new Map<string,SeoTarget[]>(),descriptionGroups=new Map<string,SeoTarget[]>(),bodyGroups=new Map<string,SeoTarget[]>(),scans=new Map<string,Scan>(),indexable=new Map<string,boolean>(),incoming=new Set<string>(),dynamicKinds=new Set<string>();
  const addGroup=(map:Map<string,SeoTarget[]>,key:string,target:SeoTarget)=>{if(key)map.set(key,[...(map.get(key)||[]),target]);};
  for(const target of checked){const value=entity(content,target)!,explicit=getSeoTargetMetadata(content,target)!,meta=getSeoEffectiveMetadata(content,target)!;const page=target.kind==='page'?value as PageItem:target.kind==='product'?content.pages.find(page=>page.slug==='/products/:slug'):getContentTemplate(content,(value as ContentEntry).modelId);const allowed=!(value.noindex||page?.noindex);indexable.set(targetKey(target),allowed);
    const current={title:meta.seoTitle,description:meta.seoDescription};
    if(!target.url){push({target,code:target.kind==='page'?'template-no-own-url':'missing-detail-route',severity:'info',message:target.kind==='page'?'这是详情模板，本身没有独立网址；实际记录会分别检查。':'此记录尚无有效详情网址；先设置详情模板，再评估搜索展示。',action:'review',evidence:siteEvidence('网址只按当前页面、模板、语言及记录生成，不为缺少模板的内容造链接。'),current});continue;}
    if(!allowed)push({target,code:'intentional-noindex',severity:'info',message:'当前设置为不参与搜索索引；本次保留这一意图，不会自动解除。',action:'review',evidence:siteEvidence(value.noindex?'该记录显式设置noindex。':'所属详情模板显式设置noindex。'),current});
    if(!meta.seoTitle.trim())push({target,code:'empty-title',severity:'error',message:'当前可展示的搜索标题为空，请补充准确标题。',action:'metadata',evidence:siteEvidence('按实际标题后备顺序检查，未找到有效文字。'),current});
    else if(!explicit.seoTitle.trim())push({target,code:'title-fallback',severity:'info',message:'未单独设置搜索标题，目前使用页面或记录名称；可以按真实用途核对。',action:'metadata',evidence:siteEvidence('名称后备是有效展示，不把它当成没有标题。'),current});
    if(!meta.seoDescription.trim())push({target,code:'empty-description',severity:'warning',message:'当前搜索描述为空，可补充本页独有且有依据的简介。',action:'metadata',evidence:siteEvidence('记录、模板和网站简介的实际后备内容均为空。'),current});
    else if(!explicit.seoDescription.trim())push({target,code:'description-fallback',severity:'info',message:'搜索描述正沿用产品介绍、模板或网站简介，请核对是否能准确概括本页。',action:'metadata',evidence:siteEvidence('使用真实后备内容，不自动生成企业事实。'),current});
    if([...meta.seoTitle].length+[...content.settings.name].length+3>70)push({target,code:'long-title',severity:'warning',message:'标题连同品牌后缀较长，建议预览阅读效果；70字是本工具提醒线，不是Google排名规则。',action:'metadata',evidence:siteEvidence(`当前标题及品牌后缀合计约${[...meta.seoTitle].length+[...content.settings.name].length+3}个字符。`),current});
    if([...meta.seoDescription].length>180)push({target,code:'long-description',severity:'warning',message:'搜索描述较长，可考虑精简；搜索引擎可能改写或截取展示，不保证完整显示。',action:'metadata',evidence:siteEvidence(`当前描述约${[...meta.seoDescription].length}个字符；180仅为阅读提醒线。`),current});
    if(allowed){addGroup(titleGroups,normalized(meta.seoTitle),target);addGroup(descriptionGroups,normalized(meta.seoDescription),target);}
    let resolved:ResolvedSitePage|null=null;try{resolved=resolveSitePage(source,target.url==='/'?[]:target.url.slice(1).split('/'));}catch{notes.add('部分布局缺失、条件模板不明确或无法解析；这些页面未作完整正文判断。');}
    if(!resolved){push({target,code:'unresolved-layout',severity:'error',message:'该网址的布局尚不能正常解析，请先在原编辑器检查。',action:'content',evidence:siteEvidence('使用与站点相同的实际路由和条件模板选择，未用默认演示布局代替。')});continue;}
    const scan=scanTarget(source,resolved,budget);scans.set(targetKey(target),scan);
    // 页面上的自链接不能让外部访客找到这个页面，所以不计为进入该页的内链。
    for(const link of scan.links)if(link!==target.url)incoming.add(link);for(const kind of scan.dynamicKinds)dynamicKinds.add(kind);
    if(scan.bounded){truncated=true;notes.add('部分页面达到1500节点、正文5万字符、共享深度8或总10万节点限制，相关正文判断为部分覆盖。');}
    if(scan.uncertain)notes.add('含未知扩展、旧插槽或递归同步区块的页面可能有额外语义，未把未知动态内容当作空。');
    if(scan.h1===0&&!scan.uncertain&&!scan.bounded)push({target,code:'missing-h1',severity:'warning',message:'当前可检查内容没有一级标题，可在标题控件选择H1；不要只把字号放大。',action:'content',evidence:siteEvidence('包含真实产品/内容绑定、同步区块与当前列表卡片后的语义检查。')});
    if(scan.h1>1)push({target,code:'multiple-h1',severity:'warning',message:`检测到${scan.h1}个一级标题，请核对主标题层级；这不是排名扣分或收录判定。`,action:'content',evidence:siteEvidence('按已解析实际记录及组件语义计数，不按视觉字号推断。')});
    if(scan.emptyH1)push({target,code:'empty-h1',severity:'warning',message:`有${scan.emptyH1}个一级标题没有可显示文字，请检查绑定来源或标题。`,action:'content',evidence:siteEvidence('动态绑定先取真实记录/明确fallback，再判断为空。')});
    if(scan.missingAlt)push({target,code:'image-alt',severity:'warning',message:`有${scan.missingAlt}处图片未填写替代说明；内容图片建议补充，纯装饰图可有意保留空alt。`,action:'content',evidence:siteEvidence('检查普通图片、富文本、画廊/轮播和可解析列表卡片；不把CSS背景图当作缺alt。')});
    const routePaths=new Set(targets.flatMap(target=>target.url?[target.url]:[]));for(const path of scan.links)if(!routePaths.has(path)&&!content.redirects?.some(redirect=>redirect.enabled!==false&&redirect.from===path&&resolveLinkTarget(content,redirect.target)))scan.brokenLinks.add(path);
    if(scan.brokenLinks.size)push({target,code:'broken-internal-link',severity:'warning',message:`发现${scan.brokenLinks.size}个无法对应当前页面或有效重定向的站内链接，请核对按钮和导航目标。`,action:'content',evidence:siteEvidence(`本机引用检查；目标示例：${[...scan.brokenLinks].slice(0,3).join('、')}。未通过联网HTTP状态猜测。`)});
    if(allowed&&!scan.uncertain&&!scan.bounded){const body=normalized(scan.body.join(' '));if(body.length>=160)addGroup(bodyGroups,body,target);}
  }
  for(const [groups,code,label] of [[titleGroups,'duplicate-title','搜索标题'],[descriptionGroups,'duplicate-description','搜索描述'],[bodyGroups,'duplicate-body','大段正文']] as const)for(const values of groups.values())if(values.length>1)for(const target of values)push({target,code,severity:'warning',message:`有${values.length}个可索引页面使用相同${label}，请核对各自用途；共用规格等真实内容不必为了去重而改写事实。`,action:code==='duplicate-body'?'content':'metadata',evidence:siteEvidence(`相同内容出现在：${values.slice(0,6).map(target=>target.label).join('、')}。`) });
  for(const target of checked){if(!target.url||!indexable.get(targetKey(target))||target.url==='/'||incoming.has(target.url))continue;const value=entity(content,target);if(target.kind!=='page'&&(dynamicKinds.has(`${target.kind}:*`)||dynamicKinds.has(`${target.kind}:${(value as Product|ContentEntry).modelId||'*'}`)))continue;push({target,code:'orphan-page',severity:'warning',message:'未在本次可解析的站内导航、按钮或列表中找到指向此页的入口，请核对是否需要内链。',action:'content',evidence:siteEvidence('这不是全网外链或Google发现状态检查；动态筛选/分页及自定义JS可能提供额外入口。')});}
  if(dynamicKinds.size)notes.add('动态筛选/分页列表按条件覆盖处理，不把默认首屏未展示的产品/内容记录直接判为孤立页。');

  // 每种相同来源/范围只用最新报表，机会逐份计算，禁止把重叠日期或不同国家合并成虚假总量。
  const latest=new Map<string,SeoDataReport>();for(const report of [...reports].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))){const s=report.scope,key=JSON.stringify([report.provider,report.source.url,s.property||'',s.country||'',s.device||'',s.locationCode??null,s.languageCode||'']);if(!latest.has(key))latest.set(key,report);}
  if(latest.size<reports.length)notes.add('同一来源/属性/国家/设备或语言范围的历史报告只选最新一份，避免重复计数。');let reportRows=0,keywordRowsUsed=0;
  const keywordCandidates=checked.filter(target=>target.url&&indexable.get(targetKey(target))).map(target=>{const meta=getSeoEffectiveMetadata(content,target)!,value=entity(content,target)!,body=target.kind==='product'?(value as Product).description:(scans.get(targetKey(target))?.body||[]).join(' ');const text=`${meta.seoDescription} ${body}`;if(text.length>8000){truncated=true;notes.add('关键词文本相关匹配每页最多检查前8000字符；完整原文未改变，未匹配不代表没有相关内容。');}return {target,meta,language:(value.locale||content.settings.language).toLocaleLowerCase('en').split(/[-_]/)[0],title:normalized(`${target.label} ${meta.seoTitle}`),body:normalized(text.slice(0,8000))};});
  const evidence=(report:SeoDataReport,rowNumbers:number[],description:string):SeoEvidence=>({source:report.provider==='gsc'?'gsc':report.provider,reportId:report.id,rowNumbers,description:`${report.source.sourceMock?'模拟资料，仅供流程验证；':''}${report.source.name}：${description}；${report.kind==='search'?`属性${report.scope.property||'未注明'}，国家${report.scope.country||'未限定'}，设备${report.scope.device||'未限定'}`:`地区编码${report.scope.locationCode??'未注明'}，语言${report.scope.languageCode||'未注明'}`}${report.provider==='csv'?'；CSV来源由用户提供，未联网核验':''}`,startDate:report.scope.startDate,endDate:report.scope.endDate,timeZone:report.scope.timeZone,...(report.scope.country?{country:report.scope.country}:{}),...(report.scope.languageCode?{languageCode:report.scope.languageCode}:{}),partial:report.coverage.partial});
  for(const report of [...latest.values()].slice(0,20)){const remaining=Math.max(0,MAX_REPORT_ROWS-reportRows),rows=report.rows.slice(0,remaining);reportRows+=rows.length;if(rows.length<report.rows.length){truncated=true;notes.add('搜索机会分析最多处理最近20份报告、合计20000行，超出未参与建议，原报告数据仍保留。');}if(report.coverage.partial)notes.add(`${report.source.name}报告${report.id}为部分覆盖：${report.coverage.reasons.join('；')||'来源可能省略部分行'}。`);
    if(report.kind==='search'){
      const queries=new Map<string,{target:SeoTarget;rowNumber:number}[]>();let unmatched=0;
      for(const row of rows as typeof report.rows){const target=matchSeoTargetUrl(content,row.page,checked);if(!target){unmatched++;continue;}if(!indexable.get(targetKey(target)))continue;if(![row.clicks,row.impressions,row.ctr,row.position].every(Number.isFinite)||row.impressions<0||row.clicks<0)continue;
        if(row.impressions>=100&&row.clicks===0)push({target,code:'gsc-no-clicks',severity:'opportunity',message:`查询“${row.query}”在该报告中展示${row.impressions}次、点击0次，可核对标题描述是否回应搜索意图；不是CTR行业基准。`,action:'metadata',evidence:[evidence(report,[row.rowNumber],`100次展示是工具筛选门槛，非Google标准；点击率${(row.ctr*100).toFixed(2)}%，平均位置${row.position.toFixed(2)}。`)]},`${report.id}:${row.rowNumber}`);
        else if(row.impressions>=50&&row.position>=5&&row.position<=20)push({target,code:'gsc-near-front',severity:'opportunity',message:`查询“${row.query}”的报告平均位置为${row.position.toFixed(2)}，可核对本页是否完整回应需求；不代表当前固定排名或必然提升。`,action:'content',evidence:[evidence(report,[row.rowNumber],`点击${row.clicks}、展示${row.impressions}、CTR ${(row.ctr*100).toFixed(2)}%；5–20仅为工具筛选范围。`)]},`${report.id}:${row.rowNumber}`);
        const query=normalized(row.query);if(query&&row.impressions>0)queries.set(query,[...(queries.get(query)||[]),{target,rowNumber:row.rowNumber}]);
      }
      for(const values of queries.values()){const byTarget=new Map(values.map(value=>[targetKey(value.target),value.target]));if(byTarget.size>1){const target=values[0].target;push({target,code:'gsc-multiple-pages',severity:'opportunity',message:`同一查询关联${byTarget.size}个本站页面，可能是正常的不同用途；请核对内容定位和内部链接，不直接判为关键词冲突。`,action:'review',evidence:[evidence(report,values.slice(0,20).map(value=>value.rowNumber),`对应页面：${[...byTarget.values()].slice(0,6).map(target=>target.label).join('、')}。`)]},`${report.id}:${values[0].rowNumber}`);}}
      if(unmatched)notes.add(`报告${report.id}有${unmatched}行未匹配当前正式源地址下的无参数实际页面，未强行生成修改建议。`);
      if(!report.rows.length)notes.add(`报告${report.id}已读取但没有返回行，不推断为全站零流量；Google可能无可返回的查询或省略隐私数据。`);
    }else{
      const available=rows as typeof report.rows,keywordRows=available.slice(0,Math.max(0,1000-keywordRowsUsed));keywordRowsUsed+=keywordRows.length;if(keywordRows.length<available.length){truncated=true;notes.add('关键词机会最多检查1000条指标；其余保留于原报告，没有参与匹配。');}const missing=keywordRows.filter(row=>row.searchVolume===null).length,zero=keywordRows.filter(row=>row.searchVolume===0).length;
      // 语言只按来源和目标声明比较基础代码，不从国家、产品名称或英文品牌猜测页面语言。
      const reportLanguage=plain(report.scope.languageCode).toLocaleLowerCase('en').split(/[-_]/)[0],candidates=reportLanguage?keywordCandidates.filter(candidate=>candidate.language===reportLanguage):[];
      if(!reportLanguage)notes.add(`报告${report.id}未注明关键词语言，未据此匹配页面优化机会。`);else if(candidates.length<keywordCandidates.length)notes.add(`报告${report.id}只匹配基础语言${reportLanguage}，已跳过异语言目标的关键词建议；原报告与站点语言保持。`);
      push({code:'keyword-metric-scope',severity:'info',message:`关键词数据为供应商或用户提供的月均估计，不是本站点击；本次${missing}词缺失搜索量、${zero}词明确为0，广告竞争不代表自然SEO难度。`,action:'review',evidence:[evidence(report,keywordRows.slice(0,10).map(row=>row.rowNumber),`范围按报告国家/地区、语言和日期；CPC如有值，币种为${report.scope.currency||'报告未注明'}。`)]},report.id);
      for(const row of keywordRows){if(row.searchVolume===null||row.searchVolume<=0||!Number.isFinite(row.searchVolume))continue;const term=normalized(row.keyword);if(term.length<4)continue;
        const matches=candidates.map(candidate=>({...candidate,score:candidate.title.includes(term)?2:candidate.body.includes(term)?1:0})).filter(match=>match.score>0).sort((a,b)=>b.score-a.score);
        if(!matches.length||matches.filter(match=>match.score===matches[0].score).length>1||normalized(matches[0].meta.seoTitle).includes(term))continue;const match=matches[0];push({target:match.target,code:'keyword-page-fit',severity:'opportunity',message:`资料中出现“${row.keyword}”，可人工评估是否适合本页标题；文本相关只是推断，请避免堆词或改变产品事实。`,action:'metadata',evidence:[evidence(report,[row.rowNumber],`估计月均搜索量${row.searchVolume}；付费广告竞争${row.competition??'缺失'}，不是自然排名难度。`)]},`${report.id}:${row.rowNumber}`);
      }
    }
  }
  if(latest.size>20){truncated=true;notes.add('来源/范围超过20份，仅分析最新20份；未合并其余范围。');}
  return {issues,targets:checked,coverage:{checkedTargets:checked.length,totalTargets:targets.length,truncated,notes:[...notes]},generatedAt:new Date().toISOString()};
}
