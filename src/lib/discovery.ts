import {productImages} from './product-images';
import {formatFieldValue,isEmptyFieldValue} from './content-models';
import type { MetadataRoute } from 'next';
import type { SiteSnapshot } from '../server/types';
import type { ResolvedSitePage } from './site-routing';
import { actualSiteRoutes } from './site-redirects';
import { resolveSitePage } from './site-routing';
import { publicSiteOrigin } from './site-seo';
import { getProductPath, getContentEntryPath } from './content-routes';
import { localeOf } from './localization';

export interface PublicFact { id:string; title:string; value:string; scope:string; sourceUrl:string; reviewedAt:string; validUntil:string; status:'pending'|'reviewed'; }
/** 这里只保存可发布资料；平台账号、验证凭据、日志和提交任务属于实例运行数据。 */
export interface DiscoverySettings {
  organization?: { legalName?:string; alternateName?:string; telephone?:string; address?:string; role?:string; sameAs?:string[] };
  facts?:PublicFact[];
  search?:{openai?:boolean;claude?:boolean;perplexity?:boolean};
  training?:{openai?:'inherit'|'allow'|'deny';claude?:'inherit'|'allow'|'deny';googleExtended?:'inherit'|'allow'|'deny'};
  llms?:boolean;
  mappings?:{modelId:string;type:'WebPage'|'Article'|'TechArticle';authorFieldId?:string;descriptionFieldId?:string}[];
}
export const DISCOVERY_POLICY_DATE='2026-11-09';
export const DISCOVERY_SOURCES=[
  {name:'Google AI搜索',url:'https://developers.google.com/search/docs/fundamentals/ai-optimization-guide'},
  {name:'OpenAI搜索与训练',url:'https://developers.openai.com/api/docs/bots'},
  {name:'Claude爬虫',url:'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler'},
  {name:'Perplexity爬虫',url:'https://docs.perplexity.ai/docs/resources/perplexity-crawlers'},
  {name:'Google AI表现',url:'https://support.google.com/webmasters/answer/16984139'},
  {name:'Bing AI引用',url:'https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/'},
  {name:'Bing 2027偏好迁移',url:'https://blogs.bing.com/search/2026/10/your-content-your-choice-clearer-preferences-for-training-and-grounding/'},
];
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const text=(v:unknown,n:number)=>typeof v==='string'&&v.length<=n;
export function publicEvidenceUrl(v:unknown):v is string {if(typeof v!=='string'||v.length>2048)return false;try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}
const date=(v:unknown)=>v===''||typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
/** 白名单和容量约束同时用于保存、历史激活与分发包，未知字段不能偷带凭据。 */
export function discoveryErrors(value:unknown,models?:SiteSnapshot['contentModels']):string[]{
  if(value===undefined)return [];const errors:string[]=[];
  if(!record(value)||!keys(value,['organization','facts','search','training','llms','mappings']))return ['搜索可见性配置包含未知字段或类型错误'];
  if(value.llms!==undefined&&typeof value.llms!=='boolean')errors.push('机器目录开关必须为是/否');
  if(value.organization!==undefined){const o=value.organization;if(!record(o)||!keys(o,['legalName','alternateName','telephone','address','role','sameAs']))errors.push('企业公开资料字段无效');else{
    for(const [k,n] of Object.entries({legalName:200,alternateName:200,telephone:80,address:1000,role:300}))if(o[k]!==undefined&&!text(o[k],n))errors.push(`企业${k}超过长度或类型无效`);
    if(o.sameAs!==undefined&&(!Array.isArray(o.sameAs)||o.sameAs.length>12||o.sameAs.some(u=>!publicEvidenceUrl(u))))errors.push('企业身份链接最多12个无认证信息的HTTPS网址');
  }}
  for(const [section,allowed] of [['search',['openai','claude','perplexity']],['training',['openai','claude','googleExtended']]] as const){const v=value[section];if(v!==undefined&&(!record(v)||!keys(v,[...allowed])||Object.values(v).some(x=>section==='search'?typeof x!=='boolean':!['inherit','allow','deny'].includes(String(x)))))errors.push('机器人偏好无效');}
  if(value.facts!==undefined){if(!Array.isArray(value.facts)||value.facts.length>100)errors.push('公开事实最多100项');else {const ids=new Set();for(const f of value.facts){if(!record(f)||!keys(f,['id','title','value','scope','sourceUrl','reviewedAt','validUntil','status'])||!text(f.id,100)||!/^[-a-zA-Z0-9_]+$/.test(String(f.id))||ids.has(f.id)||!text(f.title,200)||!String(f.title).trim()||!text(f.value,4000)||!text(f.scope,1000)||!(f.sourceUrl===''||publicEvidenceUrl(f.sourceUrl))||!date(f.reviewedAt)||!date(f.validUntil)||!['pending','reviewed'].includes(String(f.status)))errors.push('公开事实标识、文字、证据日期或网址无效');else {ids.add(f.id);if(f.status==='reviewed'&&(!String(f.value).trim()||!f.reviewedAt))errors.push('已核对事实需要实际内容和核对日期');if(f.validUntil&&f.reviewedAt&&String(f.validUntil)<String(f.reviewedAt))errors.push('有效期不能早于核对日期');}}}}
  if(value.mappings!==undefined){if(!Array.isArray(value.mappings)||value.mappings.length>100)errors.push('结构化映射最多100项');else{const ids=new Set();for(const m of value.mappings){if(!record(m)||!keys(m,['modelId','type','authorFieldId','descriptionFieldId'])||typeof m.modelId!=='string'||!['WebPage','Article','TechArticle'].includes(String(m.type))||ids.has(m.modelId)){errors.push('模型结构化映射无效或重复');continue;}ids.add(m.modelId);const model=models?.find(x=>x.id===m.modelId);if(models&&!model)errors.push('结构化映射引用不存在的模型');for(const k of ['authorFieldId','descriptionFieldId'])if(m[k]!==undefined&&(typeof m[k]!=='string'||m[k]!==''&&model&&!model.fields.some(f=>f.id===m[k]&&['text','textarea'].includes(f.type))))errors.push('结构化映射只能绑定当前模型的文字字段');}}}
  return [...new Set(errors)];
}
export function reviewedFacts(settings:DiscoverySettings|undefined){return (settings?.facts||[]).filter(f=>f.status==='reviewed');}
/** 每个具体UA组都带上基础禁区；robots组之间不能假定会继承通配组。 */
export function discoveryRobots(snapshot:SiteSnapshot|null):MetadataRoute.Robots {
  if(!snapshot)return {rules:{userAgent:'*',disallow:['/']}};
  const policy=snapshot.settings.discovery,base={allow:['/','/_next/static/','/_next/image','/api/media/','/api/site-code/','/api/discovery-key'],disallow:['/admin','/api/','/preview','/_next/']};
  const rules:MetadataRoute.Robots['rules']=[{userAgent:'*',...base}];
  for(const [key,ua] of [['openai','OAI-SearchBot'],['claude','Claude-SearchBot'],['perplexity','PerplexityBot']] as const)rules.push(policy?.search?.[key]===false?{userAgent:ua,disallow:['/']}:{userAgent:ua,...base});
  for(const [key,ua] of [['openai','GPTBot'],['claude','ClaudeBot'],['googleExtended','Google-Extended']] as const){const pref=policy?.training?.[key];if(pref&&pref!=='inherit')rules.push(pref==='deny'?{userAgent:ua,disallow:['/']}:{userAgent:ua,...base});}
  const origin=publicSiteOrigin(snapshot.settings.publicUrl);return {rules,...(origin?{sitemap:`${origin}/sitemap.xml`}:{})};
}
export function indexableRoutes(snapshot:SiteSnapshot){return actualSiteRoutes(snapshot).flatMap(r=>{const resolved=resolveSitePage(snapshot,r.path==='/'?[]:r.path.slice(1).split('/'));return resolved&&!resolved.page.noindex&&!resolved.entry?.noindex&&!resolved.product?.noindex?[{...r,resolved}]:[];});}
/** 目录只由当前公开白名单生成，不含私人草稿/运营数据；控制字符和Markdown边界需清理。 */
export function llmsText(snapshot:SiteSnapshot):string {if(!publicSiteOrigin(snapshot.settings.publicUrl))return '';const clean=(s:string)=>s.replace(/[\r\n\[\]<>\\]/g,' ').slice(0,500),origin=publicSiteOrigin(snapshot.settings.publicUrl);return [`# ${clean(snapshot.settings.name)}`,`> ${clean(snapshot.settings.description)}`,'','This directory describes published content. Follow each source page for current facts and scope.','','## Published pages',...indexableRoutes(snapshot).slice(0,1000).map(({path,resolved:r})=>`- [${clean(r.product?.name||r.entry?.title||r.page.title)}](${origin}${encodeURI(path).replace(/[()]/g,c=>c==='('?'%28':'%29')}): ${localeOf(snapshot.settings,r.entry||r.product||r.page)}`),''].join('\n');}
/** 结构化资料不创造价格/评分；企业与正文共用已发布字段，只有已核对事实进入输出。 */
export function siteStructuredData(snapshot:SiteSnapshot,r:ResolvedSitePage){
  const origin=publicSiteOrigin(snapshot.settings.publicUrl),o=snapshot.settings.discovery?.organization||{},orgId=origin?`${origin}/#organization`:undefined;
  // 未配置正式源地址时保留基本事实，不构造空@id或猜测请求Host。
  if(!origin)return r.product?{'@context':'https://schema.org','@type':'Product',name:r.product.name,description:r.product.description,sku:r.product.sku}:{'@context':'https://schema.org','@type':'Organization',name:snapshot.settings.name,email:snapshot.settings.email||undefined};
  const path=r.product?getProductPath(snapshot,r.product):r.entry?getContentEntryPath(snapshot,r.entry):r.page.slug;
  const url=origin&&path?`${origin}${path}`:undefined,organization={'@type':'Organization','@id':orgId,name:snapshot.settings.name,url:origin,email:snapshot.settings.email||undefined,...o};
  const record=r.product||r.entry;const mapping=snapshot.settings.discovery?.mappings?.find(m=>m.modelId===record?.modelId);
  const field=(id:string|undefined)=>id&&record?.customFields&&typeof record.customFields[id]==='string'?record.customFields[id]:undefined;
  const productModel=snapshot.contentModels?.find(m=>m.id===r.product?.modelId);
  const properties=r.product?[{ '@type':'PropertyValue',name:'Material',value:r.product.material},...(r.product.specifications||[]).map(p=>({'@type':'PropertyValue',name:p.label,value:p.value})),...(productModel?.fields||[]).filter(f=>!['image','gallery','relation','url'].includes(f.type)&&!isEmptyFieldValue(r.product?.customFields?.[f.id])).map(f=>({'@type':'PropertyValue',name:f.label,value:formatFieldValue(f,r.product?.customFields?.[f.id])}))].filter(p=>p.value):undefined;
  // 建站方可能是贸易商/代理，不能自动声明其为每个产品的制造商或品牌方。
  const photos=r.product?productImages(r.product):[];
  const entity=r.product?{'@type':'Product','@id':url?`${url}#product`:undefined,name:r.product.name,description:r.product.description,sku:r.product.sku,url,image:origin&&photos.length?(photos.length===1?new URL(photos[0],origin).href:photos.map(image=>new URL(image,origin).href)):undefined,additionalProperty:properties}:mapping&&mapping.type!=='WebPage'?{'@type':mapping.type,'@id':url?`${url}#article`:undefined,headline:r.entry?.title,description:field(mapping.descriptionFieldId)||r.entry?.seoDescription,author:field(mapping.authorFieldId)?{'@type':'Person',name:field(mapping.authorFieldId)}:undefined,publisher:{'@id':orgId},dateModified:path?snapshot.urlState?.[path]?.modified:undefined,inLanguage:localeOf(snapshot.settings,r.entry||r.page),url}:undefined;
  // role/sameAs以外的企业说明仍由可见资料组件展示，不冒充Schema未定义的企业类别。
  delete (organization as Record<string,unknown>).role;
  const graph:unknown[]=[organization,{'@type':'WebSite','@id':origin?`${origin}/#website`:undefined,url:origin,name:snapshot.settings.name,publisher:{'@id':orgId}},{'@type':'WebPage','@id':url,url,name:r.entry?.title||r.product?.name||r.page.title,inLanguage:localeOf(snapshot.settings,record||r.page),isPartOf:{'@id':origin?`${origin}/#website`:undefined},...(entity?{mainEntity:{'@id':(entity as Record<string,unknown>)['@id']}}:{})}];
  if(entity)graph.push(entity);if(url&&path!=='/')graph.push({'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:snapshot.settings.name,item:origin},{'@type':'ListItem',position:2,name:r.entry?.title||r.product?.name||r.page.title,item:url}]});
  return {'@context':'https://schema.org','@graph':graph};
}
export interface DiscoveryIssue {level:'warning'|'info';path:string;message:string;}
/** 提示可定位的问题，不计算无法解释的“AI排名分”；多H1只是结构提示。 */
export function discoveryDiagnostics(snapshot:SiteSnapshot):DiscoveryIssue[]{
  const items:DiscoveryIssue[]=[],origin=publicSiteOrigin(snapshot.settings.publicUrl);if(!origin)items.push({level:'warning',path:'/',message:'尚未配置公开规范地址，无法生成正式canonical与站点地图'});else if(/localhost|127\.0\.0\.1|\[::1\]/i.test(origin))items.push({level:'warning',path:'/',message:'当前为本机地址，不能作为公网抓取验收'});
  if(!snapshot.settings.discovery?.organization?.legalName)items.push({level:'info',path:'/',message:'企业法定名称尚未填写；未知信息可以留空，不应编造'});
  for(const f of reviewedFacts(snapshot.settings.discovery))if(f.validUntil&&f.validUntil<new Date().toISOString().slice(0,10))items.push({level:'warning',path:'/',message:`事实“${f.title}”已超过填写的有效期，请重新核对`});
  const titles=new Map<string,string>();for(const {path,resolved:r} of indexableRoutes(snapshot)){const title=r.entry?.seoTitle||r.product?.seoTitle||r.page.seoTitle||r.entry?.title||r.product?.name||r.page.title;if(titles.has(title))items.push({level:'info',path,message:`标题与${titles.get(title)}相同，可检查是否为重复页面`});else titles.set(title,path);let h1=0,visited=0;const walk=(v:unknown)=>{if(++visited>20000)return;if(Array.isArray(v))v.forEach(walk);else if(record(v)){if(v.type==='Heading'&&record(v.props)&&v.props.level==='h1')h1++;if(v.type==='ProductDetail')h1++;Object.values(v).forEach(walk);}};walk(r.data);if(h1!==1)items.push({level:'info',path,message:h1?'检测到多个显式主标题，请核对文档结构':'未检测到显式H1；可在标题组件选择语义级别（动态区块仍需人工核对）'});if(items.length>=250)break;}
  return items.slice(0,250);
}
