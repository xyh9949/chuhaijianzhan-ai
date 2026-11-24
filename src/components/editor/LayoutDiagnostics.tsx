"use client";
import {useState} from 'react';
import {Alert,Button,Drawer,Space,Table,Typography} from 'antd';
import {layoutFindings} from '@/lib/layout-diagnostics';
/** 读取当前画布实际几何，不把缩放比例或预览宽度当成自定义断点。 */
export default function LayoutDiagnostics({device}:{device:string}){
 const[open,setOpen]=useState(false),[findings,setFindings]=useState<{id:string;message:string}[]>([]);
 function inspect(){const frame=document.querySelector<HTMLIFrameElement>('.editor-canvas iframe'),doc=frame?.contentDocument;setFindings(doc?layoutFindings(doc):[{id:'canvas',message:'画布尚未就绪'}]);setOpen(true);}
 return <><Button type="text" size="small" onClick={inspect}>检查布局</Button><Drawer title={`当前${device==='mobile'?'手机':device==='tablet'?'平板':'桌面'}布局检查`} open={open} onClose={()=>setOpen(false)} size={520}><Space orientation="vertical" style={{width:'100%'}}><Alert type={findings.length?'warning':'success'} title={findings.length?`发现${findings.length}处需核对的位置`:'未检测到边界溢出或绝对定位覆盖控件'}/><Typography.Paragraph type="secondary">这是当前画布/当前滚动位置的几何提示，最多30项；有意叠放也会提示。切设备、修改或滚动后重新检查，仍需查看公开页面和键盘操作。</Typography.Paragraph><Button onClick={inspect}>重新检查当前设备</Button><Table size="small" rowKey={(_,i)=>String(i)} pagination={false} dataSource={findings} columns={[{title:'元素',dataIndex:'id',render:v=><span style={{overflowWrap:'anywhere'}}>{v}</span>},{title:'提示',dataIndex:'message'}]}/></Space></Drawer></>;
}
