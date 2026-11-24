import { safeLinkHref } from './site-safety';
import { isLocalImagePath } from './bundled-media';
import type { MediaItem } from './types';
import type {ComponentData} from '@puckeditor/core';
import { comparisonTableErrors } from './comparison-table';
import { imageComparisonErrors } from './image-comparison';
import { projectTimelineErrors } from './project-timeline';

export interface RichNode { type: 'doc' | 'paragraph' | 'heading' | 'text' | 'bulletList' | 'orderedList' | 'listItem' | 'hardBreak' | 'blockquote' | 'image'; text?: string; attrs?: Record<string, unknown>; marks?: { type: 'bold' | 'italic' | 'underline' | 'link'; attrs?: Record<string, unknown> }[]; content?: RichNode[]; }
export interface PresentationImage { id: string; src: string; alt: string; caption?: string; }
export interface PresentationPanel { id: string; title: string; body: string; }
export interface FreePanel {id:string;title:string;content:ComponentData[]}

/** 默认渲染数据保持旧格式；只有明确的新增操作才创建自由面板，避免影响旧页面。 */
export function initialPanelProps(type:string):Record<string,any>{
 if(type==='Tabs')return {items:[{id:'overview',title:'Overview',body:'Introduce your company.'},{id:'details',title:'Details',body:'Add the details that matter.'}]};
 if(type==='Accordion')return {firstOpen:false,items:[{id:'question-1',title:'How can we discuss a project?',body:'Contact our team with your requirements.'}]};
 return {images:[{id:'slide-1',src:'/images/studio.jpg',alt:'Replace with your own image',caption:''}]};
}
export function createFreePanelNode(type:'Tabs'|'Accordion'|'Carousel'):ComponentData{
 const props={id:`panel-${crypto.randomUUID()}`,...initialPanelProps(type)};
 return {type,props:{...props,...convertToFreePanels(type,props)}};
}

/** 只有用户明确转换时才移动旧正文/图片；保留组件 ID、外观和所有其他属性，历史快照不重写。 */
export function convertToFreePanels(type:string,props:Record<string,any>,makeId=()=>`panel-node-${crypto.randomUUID()}`):Record<string,any>{
 if(props.panelMode==='free')return props;
 const imageMode=type==='Carousel';
 const values=(imageMode?props.images:props.items)||[];
 const panels=values.map((item:PresentationImage|PresentationPanel,index:number)=>({id:item.id,title:'title' in item?item.title:item.caption?.slice(0,300)||`Slide ${index+1}`,content:imageMode?
  [{type:'Image',props:{id:makeId(),src:(item as PresentationImage).src,alt:(item as PresentationImage).alt,height:360,fit:props.fit||'cover',radius:0,design:{desktop:{width:'100%',height:360},mobile:{height:220}}}},...((item as PresentationImage).caption?[{type:'Text',props:{id:makeId(),text:(item as PresentationImage).caption,size:16,color:'#526274',align:'left',maxWidth:900}}]:[])]:
  [{type:'Text',props:{id:makeId(),text:(item as PresentationPanel).body,size:16,color:'#526274',align:'left',maxWidth:900}}]}));
 const next={...props,panelMode:'free',[imageMode?'slides':'items']:panels};
 if(imageMode)delete next.images;
 return next;
}
export const PRESENTATION_TYPES = ['RichText', 'Icon', 'Divider', 'Gallery', 'Accordion', 'Tabs', 'Video', 'Carousel'];
export const ICON_NAMES = ['check', 'globe', 'mail', 'phone', 'star', 'safety', 'truck', 'tool', 'team', 'arrow'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const image = isLocalImagePath;
const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export function textToRichText(value: string): RichNode { return { type: 'doc', content: value.split(/\n\s*\n/).map(text => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) })) }; }

type RichTextLimits={nodes:number;characters:number};
const richTextSaveLimits:RichTextLimits={nodes:2000,characters:60000};
const richTextRecoveryLimits:RichTextLimits={nodes:20000,characters:240000};
/** JSON只接受编辑器声明的节点/标记；仅本地恢复显式使用较大限额，保存与发布沿用默认限额。 */
export function richTextErrors(value: unknown,limits:RichTextLimits=richTextSaveLimits): string[] {
  const errors: string[] = []; let count = 0, chars = 0;
  const blocks=['paragraph','heading','bulletList','orderedList','blockquote','image'];
  const children: Record<string, string[]> = { doc: blocks, paragraph: ['text', 'hardBreak'], heading: ['text', 'hardBreak'], bulletList: ['listItem'], orderedList: ['listItem'], listItem: blocks, blockquote: blocks, image: [], text: [], hardBreak: [] };
  function walk(node: unknown, parent: string | null, depth: number) {
    if (++count > limits.nodes || depth > 12) { errors.push(`富文本最多${limits.nodes}节点、12层`); return; }
    if (!record(node) || typeof node.type !== 'string' || !children[node.type] || (parent === null ? node.type !== 'doc' : !children[parent].includes(node.type))) { errors.push('富文本节点或层级无效'); return; }
    if (Object.keys(node).some(key => !['type', 'text', 'attrs', 'marks', 'content'].includes(key))) errors.push('富文本存在未允许属性');
    const attrs = node.attrs === undefined ? {} : node.attrs;
    if (!record(attrs)) errors.push('富文本节点属性无效');
    else {
      const allowed = node.type === 'heading' ? ['level','textAlign'] : node.type==='paragraph'?['textAlign']:node.type === 'orderedList' ? ['start', 'type'] : node.type==='image'?['src','alt','caption','width','align']:[];
      if (Object.keys(attrs).some(key => !allowed.includes(key))) errors.push('富文本节点属性未允许');
      if (node.type === 'heading' && ![2, 3].includes(attrs.level as number)) errors.push('富文本仅允许二级/三级标题');
      if (attrs.start !== undefined && (!Number.isInteger(attrs.start) || Number(attrs.start) < 1 || Number(attrs.start) > 1000)) errors.push('列表起始序号无效');
      if (attrs.type !== undefined && attrs.type !== null && attrs.type !== '1') errors.push('列表类型无效');
      if(attrs.textAlign!==undefined&&attrs.textAlign!==null&&!['left','center','right','justify'].includes(String(attrs.textAlign)))errors.push('正文对齐方式无效');
      if(node.type==='image'){
        if(!image(attrs.src))errors.push('正文图片必须来自本实例素材库');
        if(attrs.alt!==undefined&&(typeof attrs.alt!=='string'||attrs.alt.length>500))errors.push('图片替代文字最多500字符');
        if(attrs.caption!==undefined&&(typeof attrs.caption!=='string'||attrs.caption.length>1000))errors.push('图片说明最多1000字符');
        if(attrs.width!==undefined&&(typeof attrs.width!=='number'||![25,50,75,100].includes(attrs.width)))errors.push('正文图片宽度只允许25、50、75或100');
        if(attrs.align!==undefined&&!['left','center','right'].includes(String(attrs.align)))errors.push('正文图片对齐方式无效');
        if(typeof attrs.caption==='string')chars+=attrs.caption.length;
      }
    }
    if (node.type === 'text') { if (typeof node.text !== 'string' || !node.text.length) errors.push('富文本字符节点无效'); else chars += node.text.length; }
    else if (node.text !== undefined) errors.push('文字只能位于文字节点');
    if (node.marks !== undefined) {
      // 同一文字可同时应用加粗、斜体、下划线和链接，数量上限须覆盖四种允许标记。
      if (node.type !== 'text' || !Array.isArray(node.marks) || node.marks.length > 4) errors.push('富文本标记无效');
      else for (const mark of node.marks) {
        if (!record(mark) || !['bold', 'italic', 'underline', 'link'].includes(String(mark.type)) || Object.keys(mark).some(k => !['type', 'attrs'].includes(k))) { errors.push('富文本标记未允许'); continue; }
        if (mark.type === 'link') {
          const a = mark.attrs;
          if (!record(a) || !safeLinkHref(a.href) || typeof a.href !== 'string' || a.href.length > 2048 || Object.keys(a).some(k => !['href', 'target', 'rel', 'class'].includes(k)) || a.target !== undefined && a.target !== null && !['_self', '_blank'].includes(String(a.target)) || a.class !== undefined && a.class !== null || a.rel !== undefined && a.rel !== null && (typeof a.rel !== 'string' || a.rel.length > 100)) errors.push('富文本链接不安全');
        } else if (mark.attrs !== undefined && (!record(mark.attrs) || Object.keys(mark.attrs).length)) errors.push('文字标记不允许属性');
      }
    }
    if (node.content !== undefined) { if (!Array.isArray(node.content) || node.content.length > limits.nodes) errors.push('富文本内容必须是有限列表'); else node.content.forEach(c => walk(c, String(node.type), depth + 1)); }
  }
  walk(value, null, 0); if (chars > limits.characters) errors.push(`富文本最多${limits.characters}字符`);
  return [...new Set(errors)];
}

/** 查询/SEO的唯一文字投影：块间双换行，图片只计说明，替代文字与URL不进入正文。 */
export function richTextPlainText(doc:RichNode,limits?:RichTextLimits):string{
  if(richTextErrors(doc,limits).length)return '';
  const plain=(node:RichNode):string=>node.type==='text'?node.text||'':node.type==='hardBreak'?'\n':node.type==='image'?String(node.attrs?.caption||''):['paragraph','heading'].includes(node.type)?(node.content||[]).map(plain).join(''):(node.content||[]).map(plain).filter(value=>value.length>0).join('\n\n');
  return plain(doc);
}
/** 恢复仍完整检查所有节点；仅允许超限正文继续修改，绝不以恢复限额保存或发布。
 * 超限时编辑器的普通投影是空串；也兼容缓存已保留完整投影，其他不一致仍拒绝。 */
export function richTextRecoveryErrors(doc:unknown,plain:unknown):string[]{
  const errors=richTextErrors(doc,richTextRecoveryLimits);if(errors.length)return errors;
  const expected=richTextPlainText(doc as RichNode,richTextRecoveryLimits);
  return typeof plain==='string'&&(plain===expected||plain===''&&richTextErrors(doc).length>0)?[]:['恢复正文与文字副本不一致'];
}
/** 图片本身是有效内容，不能因为其文字投影为空而被表单compact丢弃。 */
export function richTextHasContent(doc:RichNode):boolean{
  if(richTextErrors(doc).length)return false;
  const imageIn=(node:RichNode):boolean=>node.type==='image'||!!node.content?.some(imageIn);
  return !!richTextPlainText(doc).trim()||imageIn(doc);
}
/** 嵌入只接受固定服务商的视频标识；本地视频仅走受控媒体路由，不接任意iframe源码。 */
export function videoSource(value: unknown): { kind: 'file' | 'embed'; src: string } | undefined {
  if (typeof value !== 'string') return;
  if (/^\/api\/media\/[a-zA-Z0-9_-]+$/.test(value)) return { kind: 'file', src: value };
  try {
    const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    const youtube = ['www.youtube.com', 'youtube.com'].includes(url.hostname) && url.pathname === '/watch' ? url.searchParams.get('v') : ['youtu.be'].includes(url.hostname) ? url.pathname.slice(1) : ['www.youtube-nocookie.com'].includes(url.hostname) && url.pathname.startsWith('/embed/') ? url.pathname.slice(7) : undefined;
    if (youtube && /^[a-zA-Z0-9_-]{11}$/.test(youtube)) return { kind: 'embed', src: `https://www.youtube-nocookie.com/embed/${youtube}` };
    const vimeo = url.hostname === 'vimeo.com' ? url.pathname.slice(1) : url.hostname === 'player.vimeo.com' && url.pathname.startsWith('/video/') ? url.pathname.slice(7) : undefined;
    if (vimeo && /^\d{1,12}$/.test(vimeo)) return { kind: 'embed', src: `https://player.vimeo.com/video/${vimeo}` };
  } catch { /* 非允许的地址不产生嵌入。 */ }
}
export function presentationErrors(type: string, props: Record<string, unknown>, publishing: boolean): string[] {
  if (type === 'ComparisonTable') return comparisonTableErrors(props, publishing);
  if (type === 'ProjectTimeline') return projectTimelineErrors(props, publishing);
  if (type === 'ImageComparison') return imageComparisonErrors(props, publishing);
  if (!PRESENTATION_TYPES.includes(type)) return [];
  const errors: string[] = [];
  if (type === 'RichText') errors.push(...richTextErrors(props.doc));
  if (type === 'Icon' && (!ICON_NAMES.includes(String(props.icon)) || props.label !== undefined && (typeof props.label !== 'string' || props.label.length > 200))) errors.push('图标或无障碍名称无效');
  if (['Tabs','Accordion','Carousel'].includes(type)&&props.panelMode!==undefined&&props.panelMode!=='free')errors.push('内容排版模式无效');
  if (type==='Gallery'||type==='Carousel'&&props.panelMode!=='free') {
    const items = props.images; const max = type === 'Gallery' ? 20 : 10;
    // 绑定画廊发布时由记录供图；兼容校验仍负责确认字段类型及记录来源。
    const dynamicGallery = type === 'Gallery' && record(props.bindings) && record(props.bindings.images);
    if (!Array.isArray(items) || items.length > max || publishing && !items.length && !dynamicGallery) errors.push(`图片列表需要1–${max}项`);
    else { const ids = new Set(); for (const item of items) { if (!record(item) || !id(item.id) || ids.has(item.id) || !image(item.src) || typeof item.alt !== 'string' || item.alt.length > 1000 || item.caption !== undefined && (typeof item.caption !== 'string' || item.caption.length > 2000)) errors.push('图库图片、ID或文字无效'); else ids.add(item.id); } }
    if (props.ratio !== undefined && !['original', '1/1', '4/3', '16/9'].includes(String(props.ratio))) errors.push('图库裁切比例无效');
    if (props.fit !== undefined && !['cover', 'contain'].includes(String(props.fit))) errors.push('图库裁切方式无效');
    if (props.lightbox !== undefined && typeof props.lightbox !== 'boolean') errors.push('灯箱开关无效');
  }
  if (props.panelMode==='free'&&['Accordion','Tabs','Carousel'].includes(type)){
    const items=type==='Carousel'?props.slides:props.items,max=type==='Tabs'?8:type==='Carousel'?10:50;
    if(!Array.isArray(items)||items.length>max||publishing&&!items.length)errors.push(`自由内容面板需要1–${max}项`);
    else{const ids=new Set();for(const item of items){if(!record(item)||!id(item.id)||ids.has(item.id)||typeof item.title!=='string'||item.title.length>300||publishing&&!item.title.trim()||!Array.isArray(item.content)||item.body!==undefined)errors.push('自由内容面板需要独立标识、标题和可拖放内容');else ids.add(item.id);}}
    if(type==='Accordion'&&props.firstOpen!==undefined&&typeof props.firstOpen!=='boolean')errors.push('首项展开开关无效');
  }else if (['Accordion', 'Tabs'].includes(type)) {
    const items = props.items, max = type === 'Tabs' ? 8 : 50;
    if (!Array.isArray(items) || items.length > max || publishing && !items.length) errors.push(`内容面板需要1–${max}项`);
    else { const ids = new Set(); for (const item of items) if (!record(item) || !id(item.id) || ids.has(item.id) || typeof item.title !== 'string' || publishing && !item.title.trim() || item.title.length > 300 || typeof item.body !== 'string' || item.body.length > 10000) errors.push('内容面板ID、标题或正文无效'); else ids.add(item.id); }
    if (props.firstOpen !== undefined && typeof props.firstOpen !== 'boolean') errors.push('首项展开开关无效');
  }
  // 旧面板在编辑器载入时可能补空 slot；非空内容必须明确转换，防止保存了却没有公开展示。
  if(props.panelMode!=='free'&&['Tabs','Accordion','Carousel'].includes(type)){
    const items=type==='Carousel'?props.slides:props.items;
    if(Array.isArray(items)&&items.some(item=>record(item)&&Array.isArray(item.content)&&item.content.length))errors.push('请先将旧内容转换为自由排版');
  }
  if (type === 'Video') {
    if (props.videoUrl !== '' && !videoSource(props.videoUrl) || publishing && !videoSource(props.videoUrl)) errors.push('视频仅允许本地视频素材、HTTPS YouTube或Vimeo');
    if (props.poster && !image(props.poster)) errors.push('视频封面必须使用图片素材');
    if (typeof props.title !== 'string' || publishing && !props.title.trim() || props.title.length > 300) errors.push('视频需要有效标题');
  }
  return errors;
}

/** 素材地址合法还不够：视频只能引用视频，图库/封面只能引用图片；检查最终发布素材清单。 */
export function presentationMediaErrors(source: { media: MediaItem[]; editorData: Record<string, unknown>; sharedBlocks?: { data: unknown }[] } & Partial<Pick<import('./types').StudioState, 'products' | 'contentEntries' | 'contentModels' | 'theme'>>): string[] {
  const errors: string[] = [];
  const check = (url: unknown, kind: MediaItem['kind'], allowMissing = false) => { if (typeof url === 'string' && url.startsWith('/api/media/')) { const item = source.media.find(m => m.url === url); if (item ? item.kind !== kind : !allowMissing) errors.push(`组件引用的${kind === 'video' ? '视频' : kind === 'document' ? 'PDF目录' : '图片'}素材不存在或类型不符：${url}`); } };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; } if (!record(v)) return;
    if (record(v.props)) {
      if (v.type === 'Video') { check(v.props.videoUrl, 'video'); check(v.props.poster, 'image'); }
      if (v.type === 'Download') check(v.props.fileUrl, 'document');
      if (v.type === 'ImageComparison') {
        if (record(v.props.before)) check(v.props.before.src, 'image');
        if (record(v.props.after)) check(v.props.after.src, 'image');
      }
      for (const key of ['src', 'image', 'backgroundImage', 'poster']) check(v.props[key], 'image', true);
      if (['Gallery', 'Carousel'].includes(String(v.type)) && Array.isArray(v.props.images)) for (const image of v.props.images) if (record(image)) check(image.src, 'image');
    }
    // 旧图片/背景草稿允许先填合法地址；已知类型不能冒充图片，缺文件仍由最终发布依赖检查拒绝。
    for (const key of ['src', 'image', 'backgroundImage', 'poster', 'seoImage']) check(v[key], 'image', true);
    Object.values(v).forEach(walk);
  };
  Object.values(source).forEach(walk);
  // 产品非封面图片同样校验素材类型，不能用PDF或视频冒充相册。
  source.products?.forEach(product=>product.images?.forEach(url=>check(url,'image',true)));
  for (const item of [...source.products || [], ...source.contentEntries || []]) for (const field of source.contentModels?.find(m => m.id === item.modelId)?.fields || []) if (field.type === 'image' || field.type === 'gallery') { const v = item.customFields?.[field.id]; for (const url of Array.isArray(v) ? v : [v]) check(url, 'image', true); }
  return [...new Set(errors)];
}
