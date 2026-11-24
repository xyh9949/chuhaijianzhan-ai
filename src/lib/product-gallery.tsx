import React from 'react';
import {imageAttributes} from './media-images';
import type {MediaItem} from './types';
import {componentTranslatableLabels} from './component-translatable-labels';

/** 隔离预览只有SSR HTML，无法依赖Ant Carousel水合；原生锚点与滚动吸附同时支持预览、键盘和公开站。 */
export default function ProductGallery({id,images,name,height,media,derived=true,labels}:{id:string;images:string[];name:string;height:number;media?:MediaItem[];derived?:boolean;labels?:unknown}){
 const text=componentTranslatableLabels('ProductDetail',labels);
 return <div className="editor-product-gallery"><div className="editor-product-gallery-track" tabIndex={0} role="region" aria-label={`${name} ${text.gallery}`}>
  {images.map((url,index)=><figure id={`${id}-photo-${index}`} key={url}><img {...imageAttributes(url,media,'auto',derived)} alt={media?.find(item=>item.url===url)?.alt||`${name} · ${index+1}`} style={{height}}/></figure>)}
 </div><nav className="editor-product-gallery-thumbs" aria-label={text.chooseImage}>{images.map((url,index)=><a key={url} href={`#${id}-photo-${index}`} aria-label={`${text.viewImage} ${index+1}`}><img {...imageAttributes(url,media,'320',derived)} alt={`${name} · ${text.thumbnail} ${index+1}`}/></a>)}</nav></div>;
}
