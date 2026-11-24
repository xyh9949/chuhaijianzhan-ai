'use client';

import React,{useMemo,useState} from 'react';
import {StyleProvider,createCache} from '@ant-design/cssinjs';
import { Button, ConfigProvider } from 'antd';
import { ArrowRightOutlined, CheckCircleOutlined, GlobalOutlined, MailOutlined, PhoneOutlined, StarOutlined, SafetyCertificateOutlined, TruckOutlined, ToolOutlined, TeamOutlined } from '@ant-design/icons';
import type { SiteTheme } from './types';

// 图标包依赖 React Context，服务端注册表只引用这个客户端边界。
export function SiteArrow() { return <ArrowRightOutlined />; }

const siteIcons = { check: CheckCircleOutlined, globe: GlobalOutlined, mail: MailOutlined, phone: PhoneOutlined, star: StarOutlined, safety: SafetyCertificateOutlined, truck: TruckOutlined, tool: ToolOutlined, team: TeamOutlined, arrow: ArrowRightOutlined };
/** 图标依赖React Context，沿用站点现有客户端边界，避免RSC模块求值时调用createContext。 */
export function SiteIcon({ name }: { name: string }) { const Icon = siteIcons[name as keyof typeof siteIcons] || CheckCircleOutlined; return <Icon aria-hidden />; }

export function SiteProvider({ theme, font, children }: { theme: SiteTheme; font: string; children: React.ReactNode }) {
  const [frameHead,setFrameHead]=useState<HTMLHeadElement>(),frameCache=useMemo(()=>createCache(),[frameHead]);
  // Puck在iframe中通过portal渲染：动态Ant变量必须注入实际文档。公开站继续继承SSR收集缓存，不增加DOM包裹或改变客户CSS层级。
  const content=React.isValidElement(children)?React.cloneElement(children as React.ReactElement<{ref?:React.Ref<HTMLElement>}>,{ref:(node:HTMLElement|null)=>{if(node&&node.ownerDocument!==document)setFrameHead(previous=>previous===node.ownerDocument.head?previous:node.ownerDocument.head);}}):children;
  // cssinjs缓存按路径记忆；切文档时仅重挂一次样式子树，不能在同一组hook中替换缓存实体。
  return <StyleProvider key={frameHead?'iframe':'host'} {...(frameHead?{container:frameHead,cache:frameCache}:{})}><ConfigProvider theme={{ inherit: false, token: { colorPrimary: theme.primary, borderRadius: theme.radius, fontFamily: font } }}>{content}</ConfigProvider></StyleProvider>;
}

export function SiteButton({ text, href, kind = 'theme', buttonStyle, size = 'large', editing = false, productLink = false, onActivate }: {
  text: string; href?: string; kind?: string; buttonStyle?: string; size?: 'small' | 'middle' | 'large'; editing?: boolean; productLink?: boolean; onActivate?: () => void;
}) {
  return <Button className={productLink ? 'editor-product-link' : `editor-site-action editor-site-action-${kind}`} type={productLink ? 'link' : kind === 'theme' && buttonStyle !== 'outline' ? 'primary' : 'default'} size={size} href={editing ? undefined : href} icon={productLink ? undefined : <ArrowRightOutlined />} iconPlacement="end" onClick={editing || onActivate || href?.startsWith('#') ? (event) => {
    // 本地编辑预览仍使用 hash 路由，页内锚点需在当前文档滚动，不切换后台屏幕。
    event.preventDefault();
    if (editing) return;
    if (onActivate) onActivate();
    else if (href?.startsWith('#')) event.currentTarget.ownerDocument.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } : undefined}>{text}</Button>;
}
