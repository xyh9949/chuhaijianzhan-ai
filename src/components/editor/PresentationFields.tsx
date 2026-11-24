'use client';
import { Button, Card, Form, Input, Select, Space } from 'antd';
import type { Field } from '@puckeditor/core';
import type { MediaItem } from '@/lib/types';
import type { PresentationImage, PresentationPanel } from '@/lib/presentation-content';
import { ImageAssetInput } from './DesignFields';
import { useEffect, useState } from 'react';
import { videoSource } from '@/lib/presentation-content';

/** 列表项使用稳定ID，排序仅移动项；所有控件是Ant，不让普通用户编辑JSON。 */
export function CollectionEditor({ value = [], onChange, media, images, max, readOnly }: { value?: (PresentationImage | PresentationPanel)[]; onChange: (v: (PresentationImage | PresentationPanel)[]) => void; media: MediaItem[]; images: boolean; max: number; readOnly?: boolean }) {
  const change = (index: number, patch: object) => onChange(value.map((item, i) => i === index ? { ...item, ...patch } : item));
  const move = (index: number, delta: number) => { const next = [...value]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; onChange(next); };
  return <Space orientation="vertical" style={{ width: '100%' }}>{value.map((item, index) => <Card key={item.id} size="small" title={`第 ${index + 1} 项`} extra={<Space size={0}><Button size="small" type="text" aria-label={`上移第${index + 1}项`} disabled={readOnly || index === 0} onClick={() => move(index, -1)}>↑</Button><Button size="small" type="text" aria-label={`下移第${index + 1}项`} disabled={readOnly || index === value.length - 1} onClick={() => move(index, 1)}>↓</Button><Button size="small" type="text" danger disabled={readOnly} onClick={() => onChange(value.filter((_, i) => i !== index))}>移除</Button></Space>}>
    {'src' in item ? <><Form.Item layout="vertical" colon={false} label="图片素材"><ImageAssetInput id={`gallery-${item.id}`} media={media} value={item.src} readOnly={readOnly} onChange={src => change(index, { src })} /></Form.Item><Form.Item layout="vertical" colon={false} label="替代文字" htmlFor={`alt-${item.id}`}><Input id={`alt-${item.id}`} value={item.alt} disabled={readOnly} maxLength={1000} onChange={e => change(index, { alt: e.target.value })} /></Form.Item><Form.Item layout="vertical" colon={false} label="图片说明" htmlFor={`caption-${item.id}`}><Input id={`caption-${item.id}`} value={item.caption || ''} disabled={readOnly} maxLength={2000} onChange={e => change(index, { caption: e.target.value })} /></Form.Item></> : <><Form.Item layout="vertical" colon={false} label="标题" htmlFor={`title-${item.id}`}><Input id={`title-${item.id}`} value={item.title} disabled={readOnly} maxLength={300} onChange={e => change(index, { title: e.target.value })} /></Form.Item><Form.Item layout="vertical" colon={false} label="正文" htmlFor={`body-${item.id}`}><Input.TextArea id={`body-${item.id}`} value={item.body} disabled={readOnly} maxLength={10000} autoSize={{ minRows: 3 }} onChange={e => change(index, { body: e.target.value })} /></Form.Item></>}
  </Card>)}<Button block disabled={readOnly || value.length >= max} onClick={() => onChange([...value, images ? { id: `item-${crypto.randomUUID()}`, src: '/images/studio.jpg', alt: '', caption: '' } : { id: `item-${crypto.randomUUID()}`, title: '新的内容项', body: '' }])}>添加{images ? '图片' : '内容项'}（{value.length}/{max}）</Button></Space>;
}
export function collectionField(media: MediaItem[], images: boolean, max: number): Field { return { type: 'custom', label: images ? '图片列表' : '内容面板', render: ({ value, onChange, readOnly }) => <CollectionEditor value={value} onChange={onChange} readOnly={readOnly} media={media} images={images} max={max} /> }; }
function VideoInput({ value = '', onChange, media, readOnly }: { value?: string; onChange: (v: string) => void; media: MediaItem[]; readOnly?: boolean }) {
  const [input, setInput] = useState(value), [invalid, setInvalid] = useState(false);
  useEffect(() => { setInput(value); setInvalid(false); }, [value]);
  // 地址输入完成才提交，避免把用户尚未输入完的URL写进自动保存队列。
  function commit() { const next = input.trim(); if (next && !videoSource(next)) setInvalid(true); else { onChange(next); setInvalid(false); } }
  return <Form.Item layout="vertical" colon={false} label="安全视频来源" validateStatus={invalid ? 'error' : undefined} help={invalid ? '仅允许本地素材、HTTPS YouTube / Vimeo 视频地址' : undefined}><Input aria-label="视频来源地址" value={input} disabled={readOnly} placeholder="YouTube / Vimeo / 本地视频素材地址" onChange={e => setInput(e.target.value)} onBlur={commit} onPressEnter={commit} /><Select aria-label="选择本地视频" placeholder="从素材库选择本地视频" allowClear value={media.some(m => m.url === value) ? value : undefined} disabled={readOnly} style={{ width: '100%' }} options={media.filter(m => m.kind === 'video').map(m => ({ label: m.name, value: m.url }))} onChange={v => onChange(v || '')} /><p>仅使用已授权视频。本地 MP4 / WebM 可在素材中心上传；外部链接只接受 HTTPS YouTube / Vimeo。</p></Form.Item>;
}
export function videoField(media: MediaItem[]): Field { return { type: 'custom', label: '视频来源', render: ({ value, onChange, readOnly }) => <VideoInput value={value} onChange={onChange} media={media} readOnly={readOnly} /> }; }
