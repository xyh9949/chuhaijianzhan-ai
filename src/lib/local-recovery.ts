import type { Screen } from './types';
export type RecoveryEntry<T=unknown>={version:1;actorId:string;scope:string;screen:Screen;title:string;updatedAt:number;snapshot:T;persisted:boolean;requiresFile:boolean};
const prefix='form-studio:local-recovery:v1:',memory=new Map<string,RecoveryEntry>();
const key=(actorId:string,scope:string)=>`${prefix}${actorId}:${scope}`;
const screens:Screen[]=['overview','site-journey','pages','products','media','inquiries','templates','theme','global-design','content-models','releases','settings','seo','editor','preview','login','setup'];
function storage(){try{return globalThis.sessionStorage;}catch{return undefined;}}
function changed(){if(typeof window!=='undefined')window.dispatchEvent(new Event('form-studio:local-recovery-changed'));}
/** 大文件只在当前窗口内存保留；持久投影仅存选项/文件名，刷新后明确要求重新选择原文件。 */
export function storeLocalRecovery<T>(actorId:string,scope:string,screen:Screen,title:string,snapshot:T,persistedSnapshot:unknown=snapshot,requiresFile=false,now=Date.now()){
 const entry:RecoveryEntry<T>={version:1,actorId,scope,screen,title:title.slice(0,160),updatedAt:now,snapshot,persisted:false,requiresFile:false};memory.set(key(actorId,scope),entry);
 try{const serialized=JSON.stringify({...entry,snapshot:persistedSnapshot,persisted:true,requiresFile});if(serialized.length>3*1024*1024)throw new Error('recovery too large');const target=storage();if(!target)throw new Error('storage unavailable');target.setItem(key(actorId,scope),serialized);entry.persisted=true;}catch{/* 当前输入仍在内存，不把存储失败误报成可跨刷新恢复。 */}
 changed();return entry;
}
export function readLocalRecovery<T>(actorId:string,scope:string,validate:(snapshot:unknown)=>boolean,now=Date.now()):RecoveryEntry<T>|undefined{
 let entry=memory.get(key(actorId,scope));if(!entry)try{entry=JSON.parse(storage()?.getItem(key(actorId,scope))||'null');}catch{return;}
 if(!entry||typeof entry.title!=='string'||entry.title.length>160||typeof entry.scope!=='string'||entry.scope.length>200||typeof entry.persisted!=='boolean'||typeof entry.requiresFile!=='boolean'||entry.version!==1||entry.actorId!==actorId||entry.scope!==scope||!screens.includes(entry.screen)||!Number.isSafeInteger(entry.updatedAt)||entry.updatedAt>now+60000||now-entry.updatedAt>24*60*60*1000)return;
 try{if(!validate(entry.snapshot))return;}catch{return;}
 return entry as RecoveryEntry<T>;
}
export function clearLocalRecovery(actorId:string,scope:string){memory.delete(key(actorId,scope));try{storage()?.removeItem(key(actorId,scope));}catch{}changed();}
/** 只枚举当前账号；换账号会清本模块其他账号缓存，不把上一人的私人备注暴露在恢复入口。 */
export function localRecoveries(actorId:string){
 const keys=new Set([...memory.keys()]);try{const s=storage();if(s)for(let i=0;i<s.length;i++){const k=s.key(i);if(k?.startsWith(prefix))keys.add(k);}}catch{}
 const entries:RecoveryEntry[]=[];for(const k of keys){if(!k.startsWith(`${prefix}${actorId}:`))continue;const scope=k.slice(`${prefix}${actorId}:`.length),entry=readLocalRecovery(actorId,scope,()=>true);if(entry)entries.push(entry);}return entries.sort((a,b)=>b.updatedAt-a.updatedAt);
}
export function clearOtherLocalRecoveries(actorId:string){for(const k of memory.keys())if(!k.startsWith(`${prefix}${actorId}:`))memory.delete(k);try{const s=storage();if(s)for(let i=s.length-1;i>=0;i--){const k=s.key(i);if(k?.startsWith(prefix)&&!k.startsWith(`${prefix}${actorId}:`))s.removeItem(k);}}catch{}}

/** 弹层关闭也走同一导航保护，让备注等本地输入先明确处理。 */
export function requestLocalLeave(proceed:()=>void,target='local-close'){const event=new CustomEvent('form-studio:before-navigate',{cancelable:true,detail:{target,proceed}});if(window.dispatchEvent(event))proceed();}
