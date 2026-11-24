'use client';
import { useEffect,useRef,useState } from 'react';
import { App,Alert,Button,Modal,Space } from 'antd';
import type { Screen } from '@/lib/types';
import { clearLocalRecovery,storeLocalRecovery } from '@/lib/local-recovery';
/** 先处理本地弹层，再重放同一个导航意图，让已有画布/代码保护依次处理，避免多个确认框同时打开。 */
export function useLocalDraftGuard({actorId,scope,screen,title,dirty,busy,snapshot,persistedSnapshot,requiresFile=false,save,discard,prepareRetention,retentionNote}:{actorId:string;scope:string;screen:Screen;title:string;dirty:boolean;busy:boolean;snapshot:unknown;persistedSnapshot?:unknown;requiresFile?:boolean;save?:()=>Promise<boolean>;discard:()=>void;prepareRetention?:()=>Promise<unknown>;retentionNote?:string}){
 const {message}=App.useApp(),latest=useRef({dirty,busy,snapshot,persistedSnapshot,requiresFile,save,discard,prepareRetention});latest.current={dirty,busy,snapshot,persistedSnapshot,requiresFile,save,discard,prepareRetention};
 const [open,setOpen]=useState(false),[saving,setSaving]=useState(false),[warning,setWarning]=useState('');const pending=useRef<(()=>void)|undefined>(undefined),dismissed=useRef(false);
 const retain=(prepared?:unknown)=>{const v=latest.current;if(!v.dirty)return;const entry=storeLocalRecovery(actorId,scope,screen,title,prepared??v.snapshot,prepared??v.persistedSnapshot??v.snapshot,v.requiresFile);if(!entry.persisted)setWarning('浏览器恢复存储不可用，输入只保留在当前窗口内存；刷新或关闭窗口可能丢失。');return entry;};
 const retainRef=useRef(retain);retainRef.current=retain;
 function ask(next:()=>void){if(latest.current.busy){message.info('正在等待服务器结果，请稍后再离开');return;}if(!latest.current.dirty){next();return;}pending.current=next;setOpen(true);}
 useEffect(()=>{
  const guard=(event:Event)=>{const detail=(event as CustomEvent<{target?:string;proceed?:()=>void}>).detail;if(dismissed.current||!detail?.proceed||event.defaultPrevented)return;if(!latest.current.dirty&&!latest.current.busy)return;event.preventDefault();event.stopImmediatePropagation();if(latest.current.busy){message.info('正在等待服务器结果，请稍后再离开');return;}pending.current=()=>{const retry=new CustomEvent('form-studio:before-navigate',{cancelable:true,detail});if(window.dispatchEvent(retry))detail.proceed!();};setOpen(true);};
  const unload=(e:BeforeUnloadEvent)=>{if(latest.current.dirty){retainRef.current();e.preventDefault();e.returnValue='';}};
  const expired=()=>retainRef.current();window.addEventListener('form-studio:before-navigate',guard,true);window.addEventListener('form-studio:session-expired',expired,true);window.addEventListener('beforeunload',unload);
  return()=>{window.removeEventListener('form-studio:before-navigate',guard,true);window.removeEventListener('form-studio:session-expired',expired,true);window.removeEventListener('beforeunload',unload);};
 },[actorId,scope,screen,title,message]);
 function proceed(){const next=pending.current;pending.current=undefined;latest.current.dirty=false;latest.current.busy=false;setOpen(false);next?.();}
 // 私有资料可先写服务端短期暂存，成功后才离开。自动卸载只写本地恢复，避免发送未经确认的资料。
 async function keep(){const prepare=latest.current.prepareRetention;if(!prepare){retainRef.current();proceed();return;}setSaving(true);setWarning('');try{const entry=retainRef.current(await prepare());if(entry?.persisted)proceed();}catch(error){setWarning(error instanceof Error?error.message:'暂存未完成，请继续编辑或重试。');}finally{setSaving(false);}}
 return {ask,resolve:()=>{dismissed.current=true;latest.current.dirty=false;latest.current.busy=false;clearLocalRecovery(actorId,scope);},clear:()=>clearLocalRecovery(actorId,scope),dialog:<Modal title={`未保存 · ${title}`} open={open} onCancel={()=>!saving&&setOpen(false)} footer={<Space wrap><Button disabled={saving} onClick={()=>setOpen(false)}>继续编辑</Button><Button disabled={saving} danger onClick={()=>{clearLocalRecovery(actorId,scope);latest.current.discard();proceed();}}>放弃修改</Button><Button disabled={saving} onClick={()=>void keep()}>保留输入并离开</Button>{save&&<Button type="primary" loading={saving} onClick={async()=>{setSaving(true);try{if(await latest.current.save?.()){clearLocalRecovery(actorId,scope);proceed();}else setWarning('保存未完成，请选择继续编辑并查看表单中的错误；输入仍保留。');}catch(e){setWarning((e as Error).message);}finally{setSaving(false);}}}>保存并继续</Button>}</Space>}><p>{retentionNote||'输入尚未提交。保留后只恢复到编辑状态，系统不会自动保存、导入或发布。'}</p>{requiresFile&&<Alert type="info" title="文件在当前窗口内存保留；整页刷新或关闭窗口后需重新选择原文件，选项仍可恢复。" />}{warning&&<Alert type="warning" title={warning} />}</Modal>};
}
