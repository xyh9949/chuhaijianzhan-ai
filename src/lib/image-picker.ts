import type {MediaItem} from './types';

export type PickerImage=Pick<MediaItem,'url'|'name'|'folder'|'width'|'height'>;
/** 保留旧图片地址以兼容既有产品；同一图片只展示一次，素材库中的名称和目录优先。 */
export function pickerImages(media:MediaItem[],legacy:{value:string;label:string}[]=[]):PickerImage[]{
 const images=new Map<string,PickerImage>();
 legacy.filter(item=>item.value).forEach(item=>images.set(item.value,{url:item.value,name:item.label,folder:'已有产品图片'}));
 media.filter(item=>item.kind==='image').forEach(item=>images.set(item.url,item));
 return [...images.values()];
}
export function filterPickerImages(images:PickerImage[],query:string,folder:string){const q=query.trim().toLocaleLowerCase();return images.filter(image=>(!folder||image.folder===folder)&&(!q||`${image.name} ${image.folder}`.toLocaleLowerCase().includes(q)));}
/** 客户端只做即时提示；实际文件签名、解码、权限与8 MB上限仍由上传接口验证。 */
export function imageUploadError(file:Pick<File,'type'|'size'>):string{
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))return '请选择 JPG、PNG 或 WebP 图片';
 if(!file.size)return '图片文件为空，请重新选择';
 if(file.size>8*1024*1024)return '图片不能超过 8 MB';
 return '';
}
/** 多图按选择顺序保留，取消选择后不改变其他图片顺序。 */
export function togglePickerImage(values:string[],url:string,max:number){return values.includes(url)?values.filter(value=>value!==url):values.length<max?[...values,url]:values;}
