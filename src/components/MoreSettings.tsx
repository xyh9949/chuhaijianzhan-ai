'use client';

import {useEffect,useState,type ReactNode} from 'react';
import {Collapse,Typography} from 'antd';

/** 只折叠显示，字段始终挂载，避免保存时遗漏隐藏输入；校验出错或明确定位时自动展开。 */
export default function MoreSettings({title='更多设置（选填）',description,children,defaultOpen=false,hasErrors=false,openSignal=0}:{title?:ReactNode;description?:string;children:ReactNode;defaultOpen?:boolean;hasErrors?:boolean;openSignal?:number}){
 const [open,setOpen]=useState(defaultOpen);
 useEffect(()=>{if(hasErrors||openSignal)setOpen(true);},[hasErrors,openSignal]);
 return <Collapse size="small" style={{marginBottom:16}} activeKey={open||hasErrors?['more']:[]} onChange={keys=>setOpen(keys.includes('more'))} items={[{key:'more',label:title,forceRender:true,children:<>{description&&<Typography.Paragraph type="secondary">{description}</Typography.Paragraph>}{children}</>}]} />;
}
