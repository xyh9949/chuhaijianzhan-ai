'use client';

import {useEffect,useId,useRef,useState,type MouseEvent} from 'react';
import {Alert,Button,Divider,Form,Input,Modal,Select,Space,Tooltip,Typography} from 'antd';
import {AlignCenterOutlined,AlignLeftOutlined,AlignRightOutlined,BoldOutlined,DeleteOutlined,EditOutlined,ItalicOutlined,LinkOutlined,OrderedListOutlined,PictureOutlined,RedoOutlined,ThunderboltOutlined,UnderlineOutlined,UndoOutlined,UnorderedListOutlined} from '@ant-design/icons';
import {EditorContent,Extension,Node,useEditor,useEditorState,type Editor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type {SelectionBookmark} from '@tiptap/pm/state';
import {safeLinkHref} from '@/lib/site-safety';
import {isLocalImagePath} from '@/lib/bundled-media';
import {richTextErrors,richTextPlainText,textToRichText,type RichNode} from '@/lib/presentation-content';
import {normalizeComposerDocument} from '@/lib/composer-document';
import ImagePicker from './ImagePicker';
import './rich-text-composer.css';

type Align='left'|'center'|'right';
type ImageWidth=25|50|75|100;
type ImageDraft={src:string;alt:string;caption:string;width:ImageWidth;align:Align};
/** 句柄只在当前编辑器内存有效；全文已变化时拒绝旧选区，避免把结果插到错误段落。 */
export type RichTextAiSelection={text:string;before:RichNode;apply:(replacement:RichNode,maxCharacters?:number)=>RichNode};
type Props={id?:string;value?:RichNode;onChange:(doc:RichNode)=>void;readOnly?:boolean;onUploadingChange?:(busy:boolean)=>void;onAiSelection?:(selection:RichTextAiSelection)=>void;label?:string};
const widths:ImageWidth[]=[25,50,75,100];
const alignments:Align[]=['left','center','right'];
const emptyImage=():ImageDraft=>({src:'',alt:'',caption:'',width:100,align:'center'});
const localImage=isLocalImagePath;
function imageValues(attrs:Record<string,unknown>):ImageDraft{return {src:typeof attrs.src==='string'?attrs.src:'',alt:typeof attrs.alt==='string'?attrs.alt:'',caption:typeof attrs.caption==='string'?attrs.caption:'',width:widths.includes(attrs.width as ImageWidth)?attrs.width as ImageWidth:100,align:alignments.includes(attrs.align as Align)?attrs.align as Align:'center'};}

/** 图片仅保存原素材URL与有限排版属性；DOM不把用户文字拼接成HTML。 */
const ComposerImage=Node.create({
 name:'image',group:'block',atom:true,draggable:true,selectable:true,
 addAttributes(){return {src:{default:''},alt:{default:''},caption:{default:''},width:{default:100},align:{default:'center'}};},
 parseHTML(){return [{tag:'figure[data-rich-image]',getAttrs:element=>{const figure=element as HTMLElement,img=figure.querySelector('img'),src=img?.getAttribute('src');if(!localImage(src))return false;return imageValues({src,alt:img?.getAttribute('alt')||'',caption:figure.querySelector('figcaption')?.textContent||'',width:Number(figure.dataset.width),align:figure.dataset.align});}}];},
 renderHTML({node}){const attrs=imageValues(node.attrs);return ['figure',{'data-rich-image':'true','data-width':attrs.width,'data-align':attrs.align,class:'rtc-image'},['img',{...(localImage(attrs.src)?{src:attrs.src}:{}),alt:attrs.alt,draggable:'false'}],...(attrs.caption?[['figcaption',{},attrs.caption]]:[])];},
 addNodeView(){return ({node})=>{const figure=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');figure.className='rtc-image';figure.dataset.richImage='true';figure.contentEditable='false';img.draggable=false;figure.append(img,caption);
  const show=(attrs:Record<string,unknown>)=>{const v=imageValues(attrs);figure.dataset.width=String(v.width);figure.dataset.align=v.align;if(localImage(v.src))img.setAttribute('src',v.src);else img.removeAttribute('src');img.alt=v.alt;caption.textContent=v.caption;caption.hidden=!v.caption;};show(node.attrs);
  return {dom:figure,update:next=>{if(next.type.name!=='image')return false;show(next.attrs);return true;}};
 };}
});
/** 仅段落和标题允许三种对齐，图片使用独立align；打开旧值不会自动回写。 */
const ComposerAlignment=Extension.create({name:'composerAlignment',addGlobalAttributes(){return [{types:['paragraph','heading'],attributes:{textAlign:{default:'left',parseHTML:element=>alignments.includes(element.style.textAlign as Align)?element.style.textAlign:'left',renderHTML:attributes=>alignments.includes(attributes.textAlign)?{style:`text-align:${attributes.textAlign}`}:{}}}}];}});
const extensions=[StarterKit.configure({code:false,codeBlock:false,horizontalRule:false,strike:false,heading:{levels:[2,3]},link:{openOnClick:false,autolink:false,linkOnPaste:false,HTMLAttributes:{target:null,rel:null},isAllowedUri:url=>Boolean(safeLinkHref(url))}}),ComposerAlignment,ComposerImage];

/** Ant提供工具栏/表单，Tiptap负责选区与受限JSON；保存和发布由父表单明确执行。 */
export default function RichTextComposer({id,value,onChange,readOnly=false,onUploadingChange,onAiSelection,label='正文'}:Props){
 const generatedId=useId(),inputId=id||`rich-composer-${generatedId}`;
 const valueFingerprint=JSON.stringify(value||textToRichText(''));
 const callback=useRef(onChange),busyCallback=useRef(onUploadingChange);callback.current=onChange;busyCallback.current=onUploadingChange;
 const incoming=useRef(valueFingerprint),emitted=useRef(''),editorRef=useRef<Editor|null>(null);
 const bookmark=useRef<SelectionBookmark|null>(null),imagePosition=useRef<number|null>(null),invalidPosition=useRef(false),uploadCount=useRef(0);
 const [linkOpen,setLinkOpen]=useState(false),[href,setHref]=useState(''),[imageOpen,setImageOpen]=useState(false),[editingImage,setEditingImage]=useState(false),[image,setImage]=useState<ImageDraft>(emptyImage),[uploading,setUploading]=useState(false),[error,setError]=useState(''),[dialogError,setDialogError]=useState(''),[pasteNotice,setPasteNotice]=useState('');
 const imageAction=useRef<(position?:number)=>void>(()=>{});
 const editor=useEditor({extensions,immediatelyRender:false,editable:!readOnly,content:value||textToRichText(''),
  editorProps:{attributes:{id:inputId,role:'textbox','aria-label':label,'aria-multiline':'true','aria-readonly':String(readOnly)},handleDoubleClickOn:(_view,position,node)=>{if(node.type.name!=='image'||readOnly)return false;imageAction.current(position);return true;},handlePaste:(_view,event)=>{
   // 媒体粘贴不自动抓取外站图片；先保留纯文字，图片必须显式上传或从素材库选择。
   const html=event.clipboardData?.getData('text/html')||'';if(event.clipboardData?.files.length||/<(?:img|svg|iframe|script|style|link|video|audio|object|embed|source)\b/i.test(html)){event.preventDefault();const text=event.clipboardData?.getData('text/plain')||'';if(text)editorRef.current?.commands.insertContent(textToRichText(text).content||[]);setPasteNotice('已保留粘贴的文字。图片请使用“插入图片”上传或从素材库选择。');return true;}return false;
  }},
  onTransaction:({transaction})=>{if(bookmark.current&&transaction.docChanged){try{bookmark.current=bookmark.current.map(transaction.mapping);if(imagePosition.current!==null)imagePosition.current=transaction.mapping.map(imagePosition.current);}catch{invalidPosition.current=true;}}},
  onUpdate:({editor:current})=>{const doc=normalizeComposerDocument(current.getJSON() as RichNode);emitted.current=JSON.stringify(doc);setError(richTextErrors(doc).join('；'));callback.current(doc);}
 });
 editorRef.current=editor;
 // immediatelyRender=false时库订阅器可能仍缓存首次null快照；订阅沿用hook，读取当前实例，不派发假编辑事务。
 const selection=useEditorState({editor,selector:()=>{const current=editor;return {bold:current?.isActive('bold')||false,italic:current?.isActive('italic')||false,underline:current?.isActive('underline')||false,bullet:current?.isActive('bulletList')||false,ordered:current?.isActive('orderedList')||false,quote:current?.isActive('blockquote')||false,link:current?.isActive('link')||false,level:current?.isActive('heading',{level:2})?2:current?.isActive('heading',{level:3})?3:0,image:current?.isActive('image')||false,align:current?.isActive('image')?current.getAttributes('image').align:current?.isActive('heading')?current.getAttributes('heading').textAlign:current?.getAttributes('paragraph').textAlign,width:current?.getAttributes('image').width||100,undo:current?.can().undo()||false,redo:current?.can().redo()||false,empty:current?.isEmpty!==false,selectedText:current&&!current.state.selection.empty?current.state.doc.textBetween(current.state.selection.from,current.state.selection.to,'\n'):'' ,characters:current?richTextPlainText(normalizeComposerDocument(current.getJSON() as RichNode)).replace(/\s/g,'').length:0};}});
 const disabled=!editor||readOnly||linkOpen||imageOpen||uploading;
 useEffect(()=>{if(!editor)return;const json=valueFingerprint;if(json===incoming.current)return;incoming.current=json;if(json===emitted.current||json===JSON.stringify(normalizeComposerDocument(editor.getJSON() as RichNode)))return;const next=JSON.parse(json) as RichNode;
  // 外部切换正文时不把旧弹窗光标映射到新记录；保留输入，要求重新定位后再应用。
  if(bookmark.current){invalidPosition.current=true;setDialogError('正文已被更新，图片和链接输入已保留。请取消后重新定位插入位置。');}editor.commands.setContent(next,{emitUpdate:false});setError(richTextErrors(next).join('；'));
 },[editor,valueFingerprint]);
 // Tiptap默认会在setEditable时发update；模式切换不能把旧正文误报成编辑修改。
 useEffect(()=>{editor?.setEditable(!readOnly&&!imageOpen&&!linkOpen,false);},[editor,readOnly,imageOpen,linkOpen]);
 function remember(){if(!editor)return;bookmark.current=editor.state.selection.getBookmark();invalidPosition.current=false;}
 function restore(current:Editor){if(invalidPosition.current||!bookmark.current){setDialogError('正文位置已变化，请取消后重新选择，原内容没有修改。');return false;}try{current.view.dispatch(current.state.tr.setSelection(bookmark.current.resolve(current.state.doc)));return true;}catch{setDialogError('无法恢复原来的光标位置，请取消后重新选择，原内容没有修改。');return false;}}
 function openLink(){if(!editor||readOnly)return;remember();setHref(String(editor.getAttributes('link').href||''));setDialogError('');setLinkOpen(true);}
 function openImage(position?:number){if(!editor||readOnly)return;const selected=position??(editor.isActive('image')?editor.state.selection.from:null);remember();imagePosition.current=selected;setEditingImage(selected!==null);setImage(selected!==null?imageValues(editor.state.doc.nodeAt(selected)?.attrs||{}):emptyImage());setDialogError('');setImageOpen(true);}
 imageAction.current=openImage;
 function closeImage(){if(uploadCount.current){setDialogError('正在上传图片，请等待完成后再关闭。');return;}setImageOpen(false);bookmark.current=null;imagePosition.current=null;setDialogError('');}
 function imageActivity(active:boolean){uploadCount.current=Math.max(0,uploadCount.current+(active?1:-1));setUploading(uploadCount.current>0);busyCallback.current?.(active);}
 function applyImage(){if(!editor||readOnly||uploadCount.current)return;if(!localImage(image.src)){setDialogError('请先上传或从素材库选择图片，原正文没有修改。');return;}if(image.alt.length>500||image.caption.length>1000){setDialogError('图片描述最多500字，图片说明最多1000字。');return;}if(!restore(editor))return;
  const attrs={...image,alt:image.alt.trim(),caption:image.caption.trim()};let applied=false;
  if(imagePosition.current!==null){const position=imagePosition.current;if(editor.state.doc.nodeAt(position)?.type.name!=='image'){setDialogError('原图片位置已变化，请取消后重新选择，原正文没有修改。');return;}applied=editor.chain().focus().setNodeSelection(position).updateAttributes('image',attrs).run();}
  else applied=editor.chain().focus().insertContent({type:'image',attrs}).run();
  if(!applied){setDialogError('此处暂时不能插入图片，请选择段落位置，图片资料已保留。');return;}setImageOpen(false);bookmark.current=null;imagePosition.current=null;setDialogError('');
 }
 function applyLink(){if(!editor||readOnly)return;const allowed=safeLinkHref(href);if(!allowed||href.length>2048){setDialogError('请输入站内路径、HTTP(S)、邮箱或电话链接，原文字保持不变。');return;}if(!restore(editor))return;
  if(editor.state.selection.empty&&!editor.isActive('link'))editor.chain().focus().insertContent({type:'text',text:allowed,marks:[{type:'link',attrs:{href:allowed}}]}).unsetLink().run();else editor.chain().focus().extendMarkRange('link').setLink({href:allowed}).run();setLinkOpen(false);bookmark.current=null;setDialogError('');
 }
 function align(next:Align){if(!editor)return;if(editor.isActive('image'))editor.chain().focus().updateAttributes('image',{align:next}).run();else editor.chain().focus().updateAttributes('paragraph',{textAlign:next}).updateAttributes('heading',{textAlign:next}).run();}
 function openAiSelection(){
  if(!editor||disabled||!onAiSelection)return;
  const {from,to}=editor.state.selection,text=editor.state.doc.textBetween(from,to,'\n');
  if(!text.trim())return;
  let protectedContent=false;editor.state.doc.nodesBetween(from,to,node=>{if(node.type.name==='image'||node.marks.some(mark=>mark.type.name==='link'))protectedContent=true;});
  if(protectedContent){setError('选段包含图片或链接，请仅选择普通文字后再润色；原内容没有修改。');return;}
  const before=normalizeComposerDocument(editor.getJSON() as RichNode),fingerprint=JSON.stringify(before),current=editor;
  onAiSelection({text,before,apply:(replacement:RichNode,maxCharacters=60000)=>{
   if(current.isDestroyed||JSON.stringify(normalizeComposerDocument(current.getJSON() as RichNode))!==fingerprint)throw new Error('生成后正文已变化，选段结果仍保留，请重新选择原段落。');
   const problems=richTextErrors(replacement);if(problems.length)throw new Error(problems.join('；'));
   if(!richTextPlainText(replacement).trim())throw new Error('选段建议没有有效文字，原文没有修改。');
   const hasProtected=(node:RichNode):boolean=>node.type==='image'||!!node.marks?.some(mark=>mark.type==='link')||!!node.content?.some(hasProtected);
   if(hasProtected(replacement))throw new Error('选段建议包含图片或链接，未修改原文；请改为普通文字建议。');
   // 仅替换明确选择的区间，一次事务进入原撤销历史，区间外的图片和链接保持原样。
   const onlyParagraph=replacement.content?.length===1&&replacement.content[0].type==='paragraph';
   const inserted=onlyParagraph?replacement.content![0].content||[]:replacement.content||[];
   if(!current.chain().focus().insertContentAt({from,to},inserted).command(({tr})=>{
    // 先检查暂存事务，不通过时不dispatch；不能先改正文再因长度超限报告失败。
    const candidate=normalizeComposerDocument(tr.doc.toJSON() as RichNode),problems=richTextErrors(candidate);if(problems.length)throw new Error(problems.join('；'));
    if(richTextPlainText(candidate).length>maxCharacters)throw new Error(`改写后正文超过${maxCharacters}字符，原文没有修改。`);
    return true;
   }).run())throw new Error('此选区暂时不能替换，请重新定位；原内容已保留。');
   return normalizeComposerDocument(current.getJSON() as RichNode);
  }});
 }
 const preventFocus=(event:MouseEvent)=>event.preventDefault();
 return <div className={`rich-text-composer ${readOnly?'is-readonly':''}`} data-testid="rich-text-composer">
  <div className="rtc-toolbar" role="toolbar" aria-label={`${label}排版工具`}>
   <Select aria-label="正文段落类型" value={selection?.level||0} disabled={disabled} style={{width:124}} options={[{value:0,label:'正文'},{value:2,label:'二级标题'},{value:3,label:'三级标题'}]} onChange={level=>level?editor?.chain().focus().setHeading({level:level as 2|3}).run():editor?.chain().focus().setParagraph().run()}/>
   <Space size={3} wrap><Tooltip title="粗体"><Button aria-label="粗体" aria-pressed={selection?.bold} icon={<BoldOutlined/>} type={selection?.bold?'primary':'default'} disabled={disabled} onMouseDown={preventFocus} onClick={()=>editor?.chain().focus().toggleBold().run()}/></Tooltip><Tooltip title="斜体"><Button aria-label="斜体" aria-pressed={selection?.italic} icon={<ItalicOutlined/>} type={selection?.italic?'primary':'default'} disabled={disabled} onMouseDown={preventFocus} onClick={()=>editor?.chain().focus().toggleItalic().run()}/></Tooltip><Tooltip title="下划线"><Button aria-label="下划线" aria-pressed={selection?.underline} icon={<UnderlineOutlined/>} type={selection?.underline?'primary':'default'} disabled={disabled} onMouseDown={preventFocus} onClick={()=>editor?.chain().focus().toggleUnderline().run()}/></Tooltip></Space>
   <Divider orientation="vertical"/><Space size={3} wrap><Tooltip title="项目列表"><Button aria-label="项目列表" aria-pressed={selection?.bullet} icon={<UnorderedListOutlined/>} type={selection?.bullet?'primary':'default'} disabled={disabled} onMouseDown={preventFocus} onClick={()=>editor?.chain().focus().toggleBulletList().run()}/></Tooltip><Tooltip title="编号列表"><Button aria-label="编号列表" aria-pressed={selection?.ordered} icon={<OrderedListOutlined/>} type={selection?.ordered?'primary':'default'} disabled={disabled} onMouseDown={preventFocus} onClick={()=>editor?.chain().focus().toggleOrderedList().run()}/></Tooltip><Button aria-label="引用" aria-pressed={selection?.quote} type={selection?.quote?'primary':'default'} disabled={disabled||selection?.image} onMouseDown={preventFocus} onClick={()=>editor?.chain().focus().toggleBlockquote().run()}>引用</Button></Space>
   <Divider orientation="vertical"/><Space size={3} wrap>{([{value:'left',name:'左对齐',icon:<AlignLeftOutlined/>},{value:'center',name:'居中对齐',icon:<AlignCenterOutlined/>},{value:'right',name:'右对齐',icon:<AlignRightOutlined/>}] as const).map(option=><Tooltip title={option.name} key={option.value}><Button aria-label={option.name} aria-pressed={selection?.align===option.value} icon={option.icon} type={selection?.align===option.value?'primary':'default'} disabled={disabled} onMouseDown={preventFocus} onClick={()=>align(option.value)}/></Tooltip>)}</Space>
   <Divider orientation="vertical"/><Button icon={<LinkOutlined/>} disabled={disabled||selection?.image} onMouseDown={preventFocus} onClick={openLink}>链接</Button><Button icon={<PictureOutlined/>} disabled={disabled} onMouseDown={preventFocus} onClick={()=>openImage()}>插入图片</Button>
   {onAiSelection&&<Button icon={<ThunderboltOutlined/>} disabled={disabled||!selection?.selectedText.trim()} onMouseDown={preventFocus} onClick={openAiSelection}>AI润色选段</Button>}
   <Space size={3}><Tooltip title="撤销"><Button aria-label="撤销" icon={<UndoOutlined/>} disabled={disabled||!selection?.undo} onMouseDown={preventFocus} onClick={()=>editor?.chain().focus().undo().run()}/></Tooltip><Tooltip title="重做"><Button aria-label="重做" icon={<RedoOutlined/>} disabled={disabled||!selection?.redo} onMouseDown={preventFocus} onClick={()=>editor?.chain().focus().redo().run()}/></Tooltip></Space>
  </div>
  {selection?.image&&!readOnly&&<div className="rtc-image-tools"><Typography.Text type="secondary">已选择正文图片</Typography.Text><Space wrap><Button size="small" icon={<EditOutlined/>} onMouseDown={preventFocus} onClick={()=>openImage()} disabled={disabled}>编辑图片</Button><Select aria-label="正文图片宽度" value={selection.width} options={widths.map(width=>({value:width,label:`${width}% 宽度`}))} disabled={disabled} onChange={width=>editor?.chain().focus().updateAttributes('image',{width}).run()}/><Button size="small" danger icon={<DeleteOutlined/>} disabled={disabled} onMouseDown={preventFocus} onClick={()=>editor?.chain().focus().deleteSelection().run()}>移除图片</Button></Space></div>}
  <div className="rtc-writing-area"><EditorContent editor={editor}/>{selection?.empty&&!readOnly&&<span className="rtc-placeholder" aria-hidden="true">从这里开始写正文，可使用上方工具排版和插入图片…</span>}</div>
  <div className="rtc-footer"><Typography.Text type="secondary">{selection?.characters||0} 字</Typography.Text><Typography.Text type="secondary">选中文字后排版，点击图片可调整宽度与说明</Typography.Text></div>
  {error&&<Alert type="error" showIcon title={error}/>} {pasteNotice&&<Alert type="info" showIcon closable title={pasteNotice} onClose={()=>setPasteNotice('')}/>}
  <Modal title="设置文字链接" open={linkOpen} onCancel={()=>{setLinkOpen(false);bookmark.current=null;setDialogError('');}} onOk={applyLink} okText="应用链接" cancelText="取消" okButtonProps={{disabled:readOnly||invalidPosition.current}}><Form layout="vertical"><Form.Item label="链接地址"><Input aria-label="正文链接地址" value={href} maxLength={2048} placeholder="https://… 或站内路径 /…" onChange={event=>{setHref(event.target.value);setDialogError('');}}/></Form.Item></Form>{dialogError&&<Alert type="error" showIcon title={dialogError}/>}<Button disabled={readOnly||!selection?.link} onClick={()=>{if(editor&&restore(editor)){editor.chain().focus().extendMarkRange('link').unsetLink().run();setLinkOpen(false);bookmark.current=null;}}}>移除链接</Button></Modal>
  <Modal className="rtc-image-modal" title={editingImage?'编辑正文图片':'插入正文图片'} open={imageOpen} width={780} onCancel={closeImage} keyboard={!uploading} footer={<Space><Button onClick={closeImage} disabled={uploading}>取消</Button><Button type="primary" onClick={applyImage} disabled={readOnly||uploading||!image.src||invalidPosition.current}>{editingImage?'保存图片设置':'插入正文'}</Button></Space>}>
   <ImagePicker label="正文图片" uploadFolder="内容图片" value={image.src} onChange={next=>{setImage(current=>({...current,src:typeof next==='string'?next:next[0]||''}));setDialogError('');}} onUploadingChange={imageActivity} disabled={readOnly}/>
   <Form layout="vertical"><Form.Item label="图片描述" extra="简单描述图片内容，方便无障碍阅读和搜索理解。"><Input aria-label="正文图片描述" value={image.alt} maxLength={500} onChange={event=>setImage(current=>({...current,alt:event.target.value}))} disabled={readOnly||uploading}/></Form.Item><Form.Item label="图片下方说明（选填）"><Input.TextArea aria-label="正文图片说明" rows={2} value={image.caption} maxLength={1000} onChange={event=>setImage(current=>({...current,caption:event.target.value}))} disabled={readOnly||uploading}/></Form.Item><div className="rtc-image-layout"><Form.Item label="显示宽度"><Select aria-label="插入图片显示宽度" value={image.width} options={widths.map(width=>({value:width,label:`${width}%`}))} onChange={width=>setImage(current=>({...current,width}))} disabled={readOnly||uploading}/></Form.Item><Form.Item label="图片对齐"><Select aria-label="插入图片对齐" value={image.align} options={[{value:'left',label:'靠左'},{value:'center',label:'居中'},{value:'right',label:'靠右'}]} onChange={next=>setImage(current=>({...current,align:next}))} disabled={readOnly||uploading}/></Form.Item></div></Form>
   {dialogError&&<Alert type="error" showIcon title={dialogError}/>} {uploading&&<Alert type="info" showIcon title="正在上传图片，完成后可插入正文。"/>}
  </Modal>
 </div>;
}
