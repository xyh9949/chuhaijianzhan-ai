'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Alert,Button,Empty,Image,Input,Modal,Pagination,Select,Space,Typography,Upload,Tag} from 'antd';
import {ArrowLeftOutlined,ArrowRightOutlined,CheckCircleFilled,DeleteOutlined,PictureOutlined,UploadOutlined} from '@ant-design/icons';
import {request,useStudioRuntime,type StudioEnvelope} from '@/lib/studio-client';
import type {MediaItem} from '@/lib/types';
import {imageAttributes} from '@/lib/media-images';
import {filterPickerImages,imageUploadError,pickerImages,togglePickerImage} from '@/lib/image-picker';
import './image-picker.css';

type Props={id?:string;label?:string;value?:string|string[];onChange?:(value:string|string[])=>void;multiple?:boolean;coverFirst?:boolean;variant?:'field'|'cover';max?:number;disabled?:boolean;legacyOptions?:{value:string;label:string}[];uploadFolder?:string;onUploadingChange?:(busy:boolean)=>void};

/** 产品或内容内直接上传并自动入库；选择器只在确认时改字段，取消选择不改产品，也不发布网站；默认产品相册用首张封面，移动或移除时自动递补。 */
export default function ImagePicker({id,label='图片',value,onChange,multiple=false,coverFirst=false,variant='field',max=20,disabled=false,legacyOptions=[],uploadFolder='产品图片',onUploadingChange}:Props){
 const runtime=useStudioRuntime(),[open,setOpen]=useState(false),[pending,setPending]=useState<string[]>([]),[query,setQuery]=useState(''),[folder,setFolder]=useState(''),[page,setPage]=useState(1),[uploadCount,setUploadCount]=useState(0),[error,setError]=useState('');
 const current=Array.isArray(value)?value:value?[value]:[],valueRef=useRef(current),pendingUploads=useRef(0),mounted=useRef(true),emitRef=useRef(onChange),busyRef=useRef(onUploadingChange);
 valueRef.current=current;emitRef.current=onChange;busyRef.current=onUploadingChange;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const images=useMemo(()=>pickerImages(runtime.envelope.state.media,legacyOptions),[runtime.envelope.state.media,legacyOptions]);
 const filtered=filterPickerImages(images,query,folder),pageSize=12,uploading=uploadCount>0,readOnly=disabled||runtime.actor.role==='viewer';
 const folders=[...new Set(images.map(image=>image.folder))];
 function change(values:string[]){setError('');valueRef.current=values;emitRef.current?.(multiple?values:values[0]||'');}
 async function upload(file:File){
  if(readOnly)return Upload.LIST_IGNORE;
  const issue=imageUploadError(file);if(issue){setError(issue);return Upload.LIST_IGNORE;}
  if(multiple&&valueRef.current.length+pendingUploads.current>=max){setError(`最多选择 ${max} 张图片`);return Upload.LIST_IGNORE;}
  pendingUploads.current++;setUploadCount(count=>count+1);busyRef.current?.(true);setError('');
  try{
   let uploaded:MediaItem|undefined;
   // 由工作区队列串行取得最新版本，上传新增素材不能覆盖同页尚未保存的产品字段。
   await runtime.mutate(async env=>{const body=new FormData();body.append('file',file);body.append('expectedRevision',String(env.revision));body.append('folder',uploadFolder);const result=await request<StudioEnvelope&{media:MediaItem}>('/api/media',{method:'POST',body});uploaded=result.media;return result;});
   if(mounted.current&&uploaded){change(multiple?[...valueRef.current,uploaded.url]:[uploaded.url]);setOpen(false);}
  }catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'上传未完成，请重试，原图片和资料已保留');}
  finally{pendingUploads.current--;busyRef.current?.(false);if(mounted.current)setUploadCount(count=>Math.max(0,count-1));}
  return Upload.LIST_IGNORE;
 }
 function begin(){setError('');setPending([...current]);setQuery('');setFolder('');setPage(1);setOpen(true);}
 function select(url:string){if(multiple){if(!pending.includes(url)&&pending.length>=max){setError(`最多选择 ${max} 张图片`);return;}setPending(values=>togglePickerImage(values,url,max));}else setPending([url]);}
 function move(index:number,delta:number){const next=[...current];[next[index],next[index+delta]]=[next[index+delta],next[index]];change(next);}
 return <div className={`image-picker ${multiple?'image-picker-multiple':''} ${variant==='cover'?'image-picker-cover-field':''}`}  role="group" aria-label={label} aria-busy={uploading}>
  <div className="image-picker-selected">{current.length?current.map((url,index)=><div className="image-picker-current" key={url}><Image src={url} alt={`${label}${multiple?`第${index+1}张`:''}预览`} styles={{image:{width:'100%',height:variant==='cover'?260:multiple?112:192,objectFit:'contain'}}}/>{coverFirst&&index===0&&<Tag color="blue" className="image-picker-cover">封面</Tag>}<Space wrap size={4}>{coverFirst&&index>0&&<Button size="small" aria-label={`将${label}第${index+1}张设为封面`} disabled={readOnly||uploading} onClick={()=>change([url,...current.filter((_,i)=>i!==index)])}>设为封面</Button>}{multiple&&<><Button size="small" aria-label={`${label}上移第${index+1}张`} icon={<ArrowLeftOutlined/>} disabled={readOnly||uploading||index===0} onClick={()=>move(index,-1)}/><Button size="small" aria-label={`${label}下移第${index+1}张`} icon={<ArrowRightOutlined/>} disabled={readOnly||uploading||index===current.length-1} onClick={()=>move(index,1)}/></>}<Button size="small" icon={<DeleteOutlined/>} aria-label={`${label}移除第${index+1}张`} disabled={readOnly||uploading} onClick={()=>change(current.filter((_,i)=>i!==index))}>移除</Button></Space></div>):<div className="image-picker-empty"><PictureOutlined/><span>还没有选择{label}</span></div>}</div>
  <div className="image-picker-actions"><Space wrap><Upload accept="image/jpeg,image/png,image/webp" multiple={multiple} showUploadList={false} beforeUpload={upload} disabled={readOnly||uploading||multiple&&current.length>=max}><Button icon={<UploadOutlined/>} loading={uploading} disabled={readOnly||uploading||multiple&&current.length>=max}>{uploading?'正在上传…':'上传图片'}</Button></Upload><Button id={id} aria-label={`${label}：从素材库选择`} icon={<PictureOutlined/>} onClick={begin} disabled={readOnly||uploading}>从素材库选择</Button></Space><Typography.Text type="secondary">JPG、PNG、WebP，每张最多8 MB。上传后自动存入素材库。</Typography.Text>{multiple&&<Typography.Text type="secondary">已选 {current.length}/{max} 张，可调整顺序。</Typography.Text>}</div>
  {error&&<Alert type="error" showIcon title={error} closable onClose={()=>setError('')}/>}
  <Modal className="image-picker-modal" title={`选择${label}`} open={open} width={900} onCancel={()=>setOpen(false)} footer={<Space wrap><Typography.Text type="secondary">已选 {pending.length}{multiple?`/${max}`:''} 张</Typography.Text><Button onClick={()=>setOpen(false)}>取消</Button><Button type="primary" disabled={readOnly||!pending.length} onClick={()=>{change(pending);setOpen(false);}}>使用所选图片</Button></Space>} styles={{body:{maxHeight:'68vh',overflowY:'auto'}}}>
   <div className="image-picker-filters"><Input.Search aria-label="搜索素材图片" placeholder="搜索图片名称或文件夹" allowClear value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}}/><Select aria-label="图片文件夹" value={folder} options={[{value:'',label:'全部图片'},...folders.map(value=>({value,label:value}))]} onChange={value=>{setFolder(value);setPage(1);}}/></div>
   <div className="image-picker-grid">{filtered.slice((page-1)*pageSize,page*pageSize).map(image=><Button key={image.url} block className={`image-picker-option ${pending.includes(image.url)?'is-selected':''}`} aria-label={`选择图片 ${image.name}`} aria-pressed={pending.includes(image.url)} disabled={multiple&&pending.length>=max&&!pending.includes(image.url)} data-image-url={image.url} onClick={()=>select(image.url)}><Image src={imageAttributes(image.url,runtime.envelope.state.media,'320').src} alt={image.name} preview={false} styles={{image:{width:'100%',height:128,objectFit:'contain'}}}/><Typography.Text ellipsis={{tooltip:image.name}}>{image.name}</Typography.Text><Typography.Text type="secondary">{image.width&&image.height?`${image.width} × ${image.height}`:image.folder}</Typography.Text>{pending.includes(image.url)&&<CheckCircleFilled className="image-picker-check"/>}</Button>)}</div>
   {!filtered.length&&<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query||folder?'没有找到匹配的图片':'素材库还没有图片，可取消后直接上传'}/>}
   <Pagination current={page} pageSize={pageSize} total={filtered.length} onChange={setPage} hideOnSinglePage showSizeChanger={false} style={{marginTop:20}}/>
  </Modal>
 </div>;
}
