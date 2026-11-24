import type {ContentEntry,PageTemplate,Product,DetailTemplateRule} from './types';
import type {RelationSource} from './content-relations';
import {validLocale,localeOf,siteLocales,type LocaleSettings} from './localization';
type Source=RelationSource&{pageTemplates?:PageTemplate[];taxonomies?:import('./types').Taxonomy[]};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const ids=(v:unknown)=>v===undefined||Array.isArray(v)&&v.length>0&&v.length<=200&&new Set(v).size===v.length&&v.every(id=>typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id));
export function isDetailRule(v:unknown):v is DetailTemplateRule{return object(v)&&Object.keys(v).every(k=>['enabled','priority','modelId','recordIds','termIds','locale'].includes(k))&&typeof v.enabled==='boolean'&&Number.isInteger(v.priority)&&Number(v.priority)>=0&&Number(v.priority)<=1000&&(v.locale===undefined||validLocale(v.locale))&&(v.modelId===undefined||typeof v.modelId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v.modelId))&&ids(v.recordIds)&&ids(v.termIds);}
const scope=(t:PageTemplate)=>t.kind==='entry'?t.modelId:t.detailRule?.modelId;
/** 条件只有集合相交；不解析用户表达式，布局选择也不会参与路由生成。 */
export function detailRuleMatches(t:PageTemplate,kind:'product'|'entry',record:Product|ContentEntry,settings?:LocaleSettings){const r=t.detailRule;return !!r?.enabled&&t.kind===kind&&(!r.locale||r.locale===localeOf(settings,record))&&(!scope(t)||scope(t)===record.modelId)&&(!r.recordIds||r.recordIds.includes(record.id))&&(!r.termIds||r.termIds.some(id=>record.termIds?.includes(id)));}
export function chooseDetailTemplate(source:Source,kind:'product'|'entry',record:Product|ContentEntry){const matches=(source.pageTemplates||[]).filter(t=>detailRuleMatches(t,kind,record,source.settings)).sort((a,b)=>b.detailRule!.priority-a.detailRule!.priority);return {template:matches[0],reason:matches[0]?`命中“${matches[0].name}”，优先级 ${matches[0].detailRule!.priority}`:'没有匹配规则，使用默认详情页',ambiguous:matches.length>1&&matches[0].detailRule!.priority===matches[1].detailRule!.priority};}
/** 同优先级只接受能证明互斥的模型或记录集合，防止未来新增记录后发生不确定匹配。 */
export function detailTemplateErrors(source:Source,publishing=false):string[]{const errors:string[]=[],rules=(source.pageTemplates||[]).filter(t=>t.detailRule!==undefined);
 for(const t of rules){const r=t.detailRule;if(!isDetailRule(r)||t.kind==='page'){errors.push(`模板“${t.name}”的详情规则格式无效`);continue;}
  if(t.kind==='entry'&&r.modelId&&r.modelId!==t.modelId)errors.push(`模板“${t.name}”的规则模型与详情用途不一致`);
  if(r.modelId&&!source.contentModels?.some(m=>m.id===r.modelId&&m.target===(t.kind==='product'?'product':'content')))errors.push(`模板“${t.name}”的条件模型不存在`);
  if(r.locale&&!siteLocales(source.settings).some(l=>l.code===r.locale))errors.push(`模板“${t.name}”的限定语言尚未配置或未选择发布设置`);
  const records=(t.kind==='product'?source.products:source.contentEntries||[]).filter(v=>(!scope(t)||v.modelId===scope(t))&&(!r.locale||r.locale===localeOf(source.settings,v)));
  if(r.recordIds?.some(id=>!records.some(v=>v.id===id)))errors.push(`模板“${t.name}”引用了不存在或未选择发布的记录`);
  const terms=(source.taxonomies||[]).filter(tax=>tax.source===t.kind&&(!tax.modelId||tax.modelId===scope(t))).flatMap(tax=>tax.terms.map(v=>v.id));
  if(r.termIds?.some(id=>!terms.includes(id)))errors.push(`模板“${t.name}”引用的分类不存在或不适用`);
  if(publishing&&r.enabled&&!source.pages?.some(p=>t.kind==='product'?p.slug==='/products/:slug':p.contentModelId===t.modelId))errors.push(`条件模板“${t.name}”缺少默认详情页兜底，请明确发布默认详情页`);
 }
 // 格式错误已在上方报告，不让非法集合进入碰撞计算并掩盖为服务器异常。
 const validRules=rules.filter(t=>t.kind!=='page'&&isDetailRule(t.detailRule));
 for(let i=0;i<validRules.length;i++)for(const b of validRules.slice(i+1)){const a=validRules[i],ar=a.detailRule,br=b.detailRule;if(!ar?.enabled||!br?.enabled||a.kind!==b.kind||ar.priority!==br.priority)continue;if(ar.locale&&br.locale&&ar.locale!==br.locale)continue;if(scope(a)&&scope(b)&&scope(a)!==scope(b))continue;if(ar.recordIds&&br.recordIds&&!ar.recordIds.some(id=>br.recordIds!.includes(id)))continue;errors.push(`条件模板“${a.name}”与“${b.name}”同优先级 ${ar.priority} 可能同时命中，请调整优先级或限定互斥记录`);}
 return errors;
}
