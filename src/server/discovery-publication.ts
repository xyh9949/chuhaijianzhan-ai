import {effectiveLayoutBlockId} from '../lib/site-layout-locales';
import {localeOf} from '../lib/localization';
import {createHash} from 'node:crypto';
import {indexableRoutes} from '../lib/discovery';
import type {SiteSnapshot} from './types';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** 仅用于内容比较；更新时间、状态和纯视觉样式不构成新的事实更新。 */
function substantive(v:unknown):unknown {if(Array.isArray(v))return v.map(substantive);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!['updated','status','design','tokenBindings','stateStyles','stylePresetId','urlState','releaseId'].includes(k)).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,substantive(x)]));return v;}
/** 资产先做摘要，避免每个网址重复序列化整站；列表依赖按整组保守更新。 */
export function withPublicUrlState(next:SiteSnapshot,previous:SiteSnapshot|null,now=new Date().toISOString()):SiteSnapshot {
  const blocks=new Map((next.sharedBlocks||[]).map(b=>[b.id,b])),blockHashes=new Map<string,string>();
  function blockHash(id:string,path:string[]=[]):string {if(path.includes(id)||path.length>=8)return '';if(blockHashes.has(id))return blockHashes.get(id)!;const b=blocks.get(id),refs=refsIn(b?.data),value=hash([substantive(b),usesCatalogue(b?.data)?catalogue:'',...refs.map(x=>blockHash(x,[...path,id]))]);blockHashes.set(id,value);return value;}
  const catalogue=hash(substantive([next.products,next.contentEntries,next.contentModels,next.taxonomies]));
  const chrome=hash(substantive([next.settings,next.siteLayout,next.forms,next.customCode,next.pageTemplates]));
  const urlState:NonNullable<SiteSnapshot['urlState']>={};
  for(const {path,resolved:r} of indexableRoutes(next)){
    const refs=refsIn(r.data);for(const slot of [next.siteLayout?.header,next.siteLayout?.footer]){const blockId=effectiveLayoutBlockId(slot,next.settings,localeOf(next.settings,r.entry||r.product||r.page));if(blockId)refs.push(blockId);}
    const loop=usesCatalogue(r.data);
    const fingerprint=hash([substantive([r.page,r.product,r.entry,r.data]),chrome,...[...new Set(refs)].sort().map(x=>blockHash(x)),loop?catalogue:'']);
    // 旧版本没有逐URL事实时间时不猜测它的历史日期；首次迁移真实记录本次发布。
    const before=previous?.urlState?.[path];urlState[path]={hash:fingerprint,modified:before?.hash===fingerprint?before.modified:now};
  }
  return {...next,urlState};
}
function refsIn(v:unknown):string[]{const refs:string[]=[];let count=0;function walk(x:unknown){if(++count>100000)return;if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object'){const o=x as {type?:string;props?:{blockId?:string;itemBlockId?:string}};if(o.type==='SharedBlock'&&o.props?.blockId)refs.push(o.props.blockId);if(o.type==='ContentLoop'&&o.props?.itemBlockId)refs.push(o.props.itemBlockId);Object.values(x).forEach(walk);}}walk(v);return refs;}

/** 固定绑定和同步区块里的列表同样依赖记录，不能漏掉它们的真实变化。 */
function usesCatalogue(v:unknown){const json=JSON.stringify(v)||'';return /"type":"(?:ContentLoop|ProductList|ContentList)"|"bindings":|"bindingContext":/.test(json);}
