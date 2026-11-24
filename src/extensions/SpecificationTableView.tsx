"use client";
import React from 'react';
import {Button,Table,Typography} from 'antd';
type Props={extensionType:string;version:number;title:string;caption:string;rows:{label:string;value:string}[];productHref?:string;pdfHref?:string;editing:boolean;preview:boolean;id?:string;className?:string;style?:React.CSSProperties;ref?:React.Ref<HTMLElement>};
/** Ant列回调留在客户端模块内部；RSC边界只传已校验的纯JSON与链接。外壳同时接Puck的class/id/ref。 */
export default function SpecificationTableView({extensionType,version,title,caption,rows,productHref,pdfHref,editing,preview,id,className,style,ref}:Props){
 return <section id={id} ref={ref} className={['site-extension-spec',className].filter(Boolean).join(' ')} data-extension={extensionType} data-extension-version={version} style={{padding:24,minWidth:0,...style}}>
 {title&&<Typography.Title level={2} style={{fontFamily:'inherit',color:'inherit',fontSize:'1.4em',marginTop:0}}>{title}</Typography.Title>}{caption&&<Typography.Paragraph style={{color:'inherit'}}>{caption}</Typography.Paragraph>}
 <Table style={{font:'inherit',color:'inherit'}} tableLayout="fixed" size="middle" pagination={false} dataSource={rows.map((row,key)=>({...row,key}))} showHeader={false} locale={{emptyText:'Add specifications'}} columns={[{dataIndex:'label',width:'36%',onCell:()=>({style:{overflowWrap:'anywhere',verticalAlign:'top',fontWeight:600}})},{dataIndex:'value',onCell:()=>({style:{overflowWrap:'anywhere',whiteSpace:'pre-wrap'}})}]}/>
 {(productHref||pdfHref)&&<div style={{display:'flex',gap:12,flexWrap:'wrap',marginTop:16}}>{productHref&&<Button href={productHref} disabled={editing}>View product</Button>}{pdfHref&&<Button href={pdfHref} disabled={editing||preview}>PDF</Button>}</div>}
 </section>;
}
