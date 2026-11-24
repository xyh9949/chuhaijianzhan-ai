'use client';
import { useEffect,useState } from 'react';
import { Alert,Button,Collapse,Popconfirm,Space,Typography } from 'antd';
import type { Screen } from '@/lib/types';
import { clearLocalRecovery,clearOtherLocalRecoveries,localRecoveries,type RecoveryEntry } from '@/lib/local-recovery';
/** 恢复只回到编辑界面，不重放保存/导入/发布。仅当前账号能看到它自己的输入副本。 */
export default function LocalRecoveryPanel({actorId,onResume}:{actorId:string;onResume:(scope:string,screen:Screen)=>void}){
 const [items,setItems]=useState<RecoveryEntry[]>([]);
 useEffect(()=>{clearOtherLocalRecoveries(actorId);const load=()=>setItems(localRecoveries(actorId));load();window.addEventListener('form-studio:local-recovery-changed',load);return()=>window.removeEventListener('form-studio:local-recovery-changed',load);},[actorId]);
 function download(item:RecoveryEntry){const url=URL.createObjectURL(new Blob([JSON.stringify({scope:item.scope,screen:item.screen,snapshot:item.snapshot},null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='unsaved-input-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 if(!items.length)return null;
 return <Alert type="warning" showIcon style={{marginBottom:16}} title={`本账号有${items.length}份未保存输入`} description={<Collapse size="small" items={items.map(item=>({key:item.scope,label:item.title,children:<Space orientation="vertical"><Typography.Text>输入仅作为恢复副本保留，尚未提交。{item.requiresFile?'原文件已不在窗口内存，请重新选择；文件名和选项仍保留。':!item.persisted?'当前只有窗口内存副本；刷新或关闭窗口可能丢失。':''}</Typography.Text><Space wrap><Button size="small" onClick={()=>onResume(item.scope,item.screen)}>返回恢复入口</Button><Button size="small" onClick={()=>download(item)}>下载输入副本</Button><Popconfirm title="移除这份恢复副本？" description="不改变服务器数据，也不关闭当前编辑表单。" onConfirm={()=>clearLocalRecovery(actorId,item.scope)}><Button size="small" danger>移除副本</Button></Popconfirm></Space></Space>}))} />} />;
}
