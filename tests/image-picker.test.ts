import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterPickerImages,imageUploadError,pickerImages,togglePickerImage} from '../src/lib/image-picker';
import type {MediaItem} from '../src/lib/types';

const image=(id:string,name:string,folder='产品图片'):MediaItem=>({id,name,folder,url:`/api/media/${id}`,kind:'image',size:'1 KB',alt:'',width:800,height:600});
test('按图片展示只包含图片素材，去重时以素材元数据为准并保留旧产品图片',()=>{
 const result=pickerImages([image('a','新名称.jpg'),{...image('pdf','目录.pdf'),kind:'document'}],[{value:'/api/media/a',label:'旧名称'},{value:'/images/chair.jpg',label:'原产品封面'}]);
 assert.equal(result.length,2);assert.equal(result[0].name,'新名称.jpg');assert.equal(result[0].width,800);assert.equal(result[1].url,'/images/chair.jpg');
});
test('图片筛选支持名称和文件夹，重复文件名仍保留独立素材',()=>{
 const items=[image('a','Product.jpg','椅子'),image('b','Product.jpg','桌子')];assert.equal(filterPickerImages(items,' product ','').length,2);assert.equal(filterPickerImages(items,'椅子','').length,1);assert.equal(filterPickerImages(items,'','桌子')[0].url,'/api/media/b');assert.equal(filterPickerImages(items,'missing','').length,0);
});
test('图片选取保留点击顺序、取消只移除目标、数量上限不能覆盖既有选择',()=>{
 const values=['a','b'];assert.deepEqual(togglePickerImage(values,'c',3),['a','b','c']);assert.deepEqual(togglePickerImage(values,'a',3),['b']);assert.deepEqual(togglePickerImage(values,'c',2),['a','b']);assert.deepEqual(values,['a','b']);
});
test('即时上传提示对齐服务端格式和8MB边界，拒绝空文件及其他格式',()=>{
 assert.equal(imageUploadError({type:'image/jpeg',size:8*1024*1024}),'');assert.match(imageUploadError({type:'image/png',size:8*1024*1024+1}),/8 MB/);assert.match(imageUploadError({type:'image/svg+xml',size:100}),/JPG/);assert.match(imageUploadError({type:'image/webp',size:0}),/为空/);
});
