import React from 'react';
import SpecificationTableView from './SpecificationTableView';
import type {Config} from '@puckeditor/core';
import {LOCAL_EXTENSIONS,normalizeExtensionProps,SPEC_TYPE} from './registry';
import {getProductPath} from '../lib/content-routes';
import {siteLinkHref} from '../lib/site-routing';
import type {SiteRenderContext} from '../lib/site-render-config';
/** 渲染映射是已编译的本地源码；数据不会选择模块路径、解析表达式或加载npm。 */
export function extensionRenderComponents(context:SiteRenderContext):Config['components']{
 return Object.fromEntries(LOCAL_EXTENSIONS.map(e=>[e.type,{label:e.label,defaultProps:e.defaultProps,render:(props:Record<string,unknown>)=>{
  const business=Object.fromEntries(['extensionVersion',...Object.keys(e.schema),...(props.extensionVersion===1?['items']:[])].filter(k=>props[k]!==undefined).map(k=>[k,props[k]]));
  let p:Record<string,unknown>;try{p=normalizeExtensionProps(e.type,business);}catch{return <section role="alert">This component needs a compatible local extension.</section>;}
  if(e.type!==SPEC_TYPE)return <section role="alert">Component renderer unavailable.</section>;
  const product=context.products.find(product=>product.id===p.productId&&product.status==='published'),href=product?getProductPath(context,product):undefined,pdf=context.media?.find(m=>m.url===p.fileUrl&&m.kind==='document');
  return <SpecificationTableView extensionType={e.type} version={e.version} title={String(p.title||'')} caption={String(p.caption||'')} rows={p.rows as {label:string;value:string}[]} productHref={href?siteLinkHref(href,context.previewPrefix):undefined} pdfHref={pdf?.url} editing={Boolean(context.editorCanvas)} preview={Boolean(context.previewPrefix)}/>;
 }}]));
}
