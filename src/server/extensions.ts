import {LOCAL_EXTENSIONS} from '../extensions/registry';
import {KNOWN_COMPONENT_TYPES} from '../lib/component-contract';
import {getDatabase} from './database';
import {getDraftRecord} from './studio';
/** 管理员只读检查当前草稿和保留历史。预算耗尽时明确标记覆盖不全，不能据此认为可安全移除。 */
export function extensionInventory(){
 const rows=new Map(LOCAL_EXTENSIONS.map(e=>[e.type,{type:e.type,label:e.label,version:e.version,readableVersions:e.readableVersions,license:e.license,description:e.description,registered:true,draftUses:0,historyUses:0,locations:[] as string[],versions:new Set<number>()}]));
 let budget=100000,bytes=0,complete=true,scannedReleases=0;
 const scan=(v:unknown,location:string,history=false,depth=0):void=>{if(--budget<0||depth>40){complete=false;return;}if(Array.isArray(v)){v.forEach(x=>scan(x,location,history,depth+1));return;}if(!v||typeof v!=='object')return;const node=v as Record<string,unknown>;
  if(typeof node.type==='string'&&node.props&&typeof node.props==='object'&&(rows.has(node.type)||!KNOWN_COMPONENT_TYPES.includes(node.type))){if(!rows.has(node.type)){if(rows.size>=100){complete=false;return;}rows.set(node.type,{type:node.type,label:node.type,version:0,readableVersions:[],license:'Unknown local extension',description:'当前构建未注册此组件',registered:false,draftUses:0,historyUses:0,locations:[],versions:new Set()});}const row=rows.get(node.type)!;if(history)row.historyUses++;else row.draftUses++;if(row.locations.length<20&&!row.locations.includes(location))row.locations.push(location);const version=(node.props as Record<string,unknown>).extensionVersion;if(typeof version==='number')row.versions.add(version);}
  Object.values(node).forEach(x=>scan(x,location,history,depth+1));
 };
 function snapshot(s:Record<string,unknown>,label:string,history=false){const data=s.editorData as Record<string,unknown>|undefined;for(const p of s.pages as {id:string;title:string}[]||[])scan(data?.[p.id],`${label} / 页面 ${p.title}`,history);for(const b of s.sharedBlocks as {name:string;data:unknown}[]||[])scan(b.data,`${label} / 区块 ${b.name}`,history);for(const t of s.pageTemplates as {name:string;data:unknown}[]||[])scan(t.data,`${label} / 模板 ${t.name}`,history);}
 const draft=getDraftRecord();snapshot(draft.content as unknown as Record<string,unknown>,'当前草稿');
 const total=(getDatabase().prepare('SELECT count(*) AS count FROM cms_release').get() as {count:number}).count;
 const releases=getDatabase().prepare('SELECT id,manifest_json FROM cms_release ORDER BY created_at DESC LIMIT 50').all() as {id:string;manifest_json:string}[];
 for(const r of releases){bytes+=Buffer.byteLength(r.manifest_json);if(bytes>16*1024*1024||budget<0){complete=false;break;}try{snapshot(JSON.parse(r.manifest_json),`历史 ${r.id}`,true);scannedReleases++;}catch{complete=false;}}
 if(scannedReleases<total)complete=false;
 return {revision:draft.revision,coverage:{complete,scannedReleases,totalReleases:total,nodeBudget:100000,historyByteBudget:16*1024*1024},items:[...rows.values()].map(r=>({...r,versions:[...r.versions].sort(),removalBlocked:!complete||r.draftUses>0||r.historyUses>0}))};
}
