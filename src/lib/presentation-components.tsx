import {FreePanelRender,panelSlotsField} from './free-panel-render';
import React from 'react';
import { imageAttributes } from './media-images';
import type { MediaItem } from './types';
import { Button, Divider } from 'antd';
import { SiteIcon } from './site-controls';
import type { Config } from '@puckeditor/core';
import { richTextErrors, videoSource, type PresentationImage, type PresentationPanel, type RichNode } from './presentation-content';
import { safeImageSrc, safeLinkHref } from './site-safety';
import {componentTranslatableLabels} from './component-translatable-labels';

/** 服务端直接创建受控React元素，不使用Tiptap HTML生成器或dangerouslySetInnerHTML。 */
export function RichDocument({ doc, resolveHref = safeLinkHref,media=[],derived=true }: { doc: RichNode; resolveHref?: (href: string) => string | undefined;media?:MediaItem[];derived?:boolean }) {
  if (richTextErrors(doc).length) return null;
  const render = (node: RichNode, key: React.Key): React.ReactNode => {
    if (node.type === 'text') {
      let result: React.ReactNode = node.text;
      for (const mark of node.marks || []) result = mark.type === 'bold' ? <strong>{result}</strong> : mark.type === 'italic' ? <em>{result}</em> : mark.type==='underline'?<u>{result}</u>:<a href={resolveHref(String(mark.attrs?.href || ''))} target={mark.attrs?.target === '_blank' ? '_blank' : undefined} rel={mark.attrs?.target === '_blank' ? 'noopener noreferrer' : undefined}>{result}</a>;
      return <React.Fragment key={key}>{result}</React.Fragment>;
    }
    const content = node.content?.map((child, index) => render(child, index));
    if (node.type === 'doc') return <React.Fragment key={key}>{content}</React.Fragment>;
    if (node.type === 'hardBreak') return <br key={key} />;
    const textAlign=node.attrs?.textAlign ? node.attrs.textAlign as React.CSSProperties['textAlign'] : undefined;
    if (node.type === 'heading') return node.attrs?.level === 3 ? <h3 key={key} style={{textAlign}}>{content}</h3> : <h2 key={key} style={{textAlign}}>{content}</h2>;
    if (node.type === 'bulletList') return <ul key={key}>{content}</ul>;
    if (node.type === 'orderedList') return <ol key={key} start={Number(node.attrs?.start) || 1}>{content}</ol>;
    if (node.type === 'listItem') return <li key={key}>{content}</li>;
    if(node.type==='blockquote')return <blockquote key={key}>{content}</blockquote>;
    // 文章图片仅以受控地址和尺寸生成元素；caption为普通React文本，不能注入HTML。
    if(node.type==='image'){const align=node.attrs?.align||'left';return <figure key={key} className="site-rich-image" style={{width:`${node.attrs?.width||100}%`,maxWidth:'100%',marginTop:'1.25em',marginBottom:'1.25em',marginLeft:align==='left'?0:'auto',marginRight:align==='right'?0:'auto'}}><img {...imageAttributes(String(node.attrs?.src||''),media,'auto',derived)} alt={String(node.attrs?.alt||'')} style={{display:'block',width:'100%',height:'auto'}}/>{node.attrs?.caption?<figcaption>{String(node.attrs.caption)}</figcaption>:null}</figure>;}
    return <p key={key} style={{textAlign}}>{content}</p>;
  };
  return render(doc, 'doc');
}

/** Ant交互组件依赖水合，而隔离预览仅保留SSR HTML；这些交互使用原生语义保留同等键盘操作。
 * 后台字段仍使用Ant，公开端无需加载编辑引擎或自制脚本，JS关闭时内容也可读、可操作。 */
export function presentationComponents(resolveHref: (href: string) => string | undefined, media?: MediaItem[], derived = true, editorCanvas = false): Config['components'] {
  return {
    RichText: { render: ({ doc }) => <div className="site-rich-text"><RichDocument doc={doc} resolveHref={resolveHref} media={media} derived={derived}/></div> },
    Icon: { render: ({ icon, label }) => <span className="site-icon" role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={!label || undefined}><SiteIcon name={icon} /></span> },
    Divider: { render: ({ text }) => <div className="site-divider"><Divider plain>{text || undefined}</Divider></div> },
    Gallery: { render: ({ id, images = [], ratio = '4/3', fit = 'cover', lightbox = true,labels }) => {const text=componentTranslatableLabels('Gallery',labels);return <div className="site-gallery" style={{ '--gallery-ratio': ratio === 'original' ? 'auto' : ratio, '--gallery-fit': fit } as React.CSSProperties}>{images.map((image: PresentationImage) => <figure key={image.id}>{lightbox ? <><Button type="text" className="site-gallery-open" popoverTarget={`${id}-lightbox-${image.id}`} aria-label={`${text.open}: ${image.alt || image.caption || text.image}`}><img {...imageAttributes(image.src, media, 'auto', derived)} alt={image.alt} loading="lazy" /></Button><div popover="auto" id={`${id}-lightbox-${image.id}`} className="site-lightbox" role="dialog" aria-label={image.alt || text.image}><Button popoverTarget={`${id}-lightbox-${image.id}`} popoverTargetAction="hide" aria-label={text.closeImage}>{text.close} ×</Button><img {...imageAttributes(image.src, media, 'auto', derived)} alt={image.alt} loading="lazy" />{image.caption && <p>{image.caption}</p>}</div></> : <img {...imageAttributes(image.src, media, 'auto', derived)} alt={image.alt} loading="lazy" />}{image.caption && <figcaption>{image.caption}</figcaption>}</figure>)}</div>;} },
    Accordion: { fields: {items:panelSlotsField(50)}, render: ({ panelMode, puck, id, items = [], firstOpen = false }) => panelMode==='free'?FreePanelRender({type:'Accordion',id,items:items||[],editing:!!editorCanvas&&!!puck?.isEditing,firstOpen}):<div className="site-accordion">{items.map((item: PresentationPanel, index: number) => <details key={item.id} open={firstOpen && index === 0}><summary>{item.title}</summary><div className="site-panel-body">{item.body}</div></details>)}</div> },
    Tabs: { fields: {items:panelSlotsField(8)}, render: ({ panelMode, puck, id, items = [],labels }) => panelMode==='free'?FreePanelRender({type:'Tabs',id,items:items||[],editing:!!editorCanvas&&!!puck?.isEditing,labels}):<div className="site-tabs" role="group" aria-label={componentTranslatableLabels('Tabs',labels).sections} style={{ '--tab-count': Math.max(1, items.length) } as React.CSSProperties}>{items.map((item: PresentationPanel, index: number) => <div className="site-tab" key={item.id}><input type="radio" id={`${id}-tab-${item.id}`} name={`${id}-tabs`} defaultChecked={index === 0} aria-label={item.title} /><label htmlFor={`${id}-tab-${item.id}`} style={{ gridColumn: index + 1 }}>{item.title}</label><section className="site-panel-body" aria-label={item.title}>{item.body}</section></div>)}</div> },
    Video: { render: ({ videoUrl, title, poster,labels }) => { const video = videoSource(videoUrl); return <figure className="site-video">{video?.kind === 'file' ? <video src={video.src} poster={safeImageSrc(poster)} controls preload="metadata" aria-label={title} playsInline /> : video ? <iframe src={video.src} title={title} loading="lazy" allow="fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" /> : <p>{componentTranslatableLabels('Video',labels).unavailable}</p>}<figcaption>{title}</figcaption></figure>; } },
    Carousel: { fields: {slides:panelSlotsField(10)}, render: ({ panelMode, slides, puck, id, images = [], ratio = '16/9', fit = 'cover',labels }) => {const text=componentTranslatableLabels('Carousel',labels);return panelMode==='free'?FreePanelRender({type:'Carousel',id,items:slides||[],editing:!!editorCanvas&&!!puck?.isEditing,labels}):<div className="site-carousel"><div className="site-carousel-track" tabIndex={0} role="region" aria-label={text.images}>{images.map((image: PresentationImage, index: number) => <figure key={image.id} id={`${id}-slide-${image.id}`} style={{ '--gallery-ratio': ratio === 'original' ? 'auto' : ratio, '--gallery-fit': fit } as React.CSSProperties}><img {...imageAttributes(image.src, media, 'auto', derived)} alt={image.alt} loading="lazy" />{image.caption && <figcaption>{image.caption}</figcaption>}<nav aria-label={`${text.slide} ${index + 1} ${text.controls}`}><a href={`#${id}-slide-${images[(index + images.length - 1) % images.length]?.id}`} aria-label={text.previousSlide}>← {text.previous}</a><span>{index + 1} / {images.length}</span><a href={`#${id}-slide-${images[(index + 1) % images.length]?.id}`} aria-label={text.nextSlide}>{text.next} →</a></nav></figure>)}</div></div>;} },
  };
}
