'use client';
import ImagePicker from './ImagePicker';
import { Form, Input, Select, Switch, Typography } from 'antd';
import type { MediaItem } from '@/lib/types';
import type {ReactNode} from 'react';
import MoreSettings from './MoreSettings';

/** 普通页、产品和独立内容共用相同SEO字段，不在表单内执行HTML或搜索服务请求。 */
export default function SeoFields({ media, fallbackTitle,children,openSignal=0,productImages=false,imagesDisabled=false,onUploadingChange,uploadFolder }: { media: MediaItem[]; fallbackTitle?: string;children?:ReactNode;openSignal?:number;productImages?:boolean;uploadFolder?:string;imagesDisabled?:boolean;onUploadingChange?:(busy:boolean)=>void }) {
  const form = Form.useFormInstance(), title = Form.useWatch('seoTitle', form), description = Form.useWatch('seoDescription', form), currentTitle = Form.useWatch('title', form), currentName = Form.useWatch('name', form);
  return <Form.Item noStyle shouldUpdate>{()=> <MoreSettings title="搜索与分享（选填）" openSignal={openSignal} hasErrors={form.getFieldsError().some(f=>['seoTitle','seoDescription','seoImage','slug','noindex'].includes(String(f.name[0]))&&!!f.errors.length)} description="可以先留空。需要单独设置搜索结果中的标题、介绍或分享图片时，再展开填写。">
    {children}<Form.Item name="seoTitle" label="搜索结果标题" rules={[{ max: 200 }]}><Input aria-label="搜索结果标题" maxLength={200} placeholder="留空使用内容标题" /></Form.Item><Form.Item name="seoDescription" label="搜索结果介绍" rules={[{ max: 1000 }]}><Input.TextArea aria-label="搜索结果介绍" rows={3} maxLength={1000} /></Form.Item><Form.Item name="seoImage" label="分享时显示的图片">{productImages?<ImagePicker uploadFolder={uploadFolder} label="分享图片" disabled={imagesDisabled} onUploadingChange={onUploadingChange}/>:<Select aria-label="分享图片" allowClear options={media.filter(item => item.kind === 'image').map(item => ({ value: item.url, label: item.name }))} />}</Form.Item><Form.Item name="noindex" label="不让搜索引擎收录此内容" extra="一般保持关闭。开启后会告知搜索引擎不要收录此内容，不影响直接访问。" valuePropName="checked"><Switch aria-label="不让搜索引擎收录此内容" /></Form.Item><div style={{ border: '1px solid #e5e9ef', padding: 14, borderRadius: 6, marginBottom: 18 }}><Typography.Text type="secondary">搜索结果示意，实际显示由搜索引擎决定</Typography.Text><Typography.Paragraph style={{ color: '#174895', fontSize: 18, margin: '8px 0' }}>{title || currentTitle || currentName || fallbackTitle || '内容标题'}</Typography.Paragraph><Typography.Paragraph type="secondary" style={{ margin: 0 }}>{description || '未填写，将沿用已有内容或网站说明。'}</Typography.Paragraph></div>
  </MoreSettings>}</Form.Item>;
}
