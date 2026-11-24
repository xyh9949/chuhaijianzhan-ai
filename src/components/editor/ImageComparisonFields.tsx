'use client';

import { Card, Form, Input, Select } from 'antd';
import type { Config, Field } from '@puckeditor/core';
import { imageComparisonDefaults, type ImageComparisonSide } from '@/lib/image-comparison';
import type { MediaItem } from '@/lib/types';
import { ImageAssetInput } from './DesignFields';

/** 一侧的素材、说明与替代文字一起写回；素材变化时清空旧替代文字供用户重新核对。 */
function comparisonSideField(side: 'before' | 'after', media: MediaItem[]): Field {
  const label = side === 'before' ? '对比前' : '对比后';
  return {
    type: 'custom', label,
    render: ({ value, onChange, id, readOnly }) => {
      const current = (value || imageComparisonDefaults[side]) as ImageComparisonSide;
      return <Card size="small" title={label} style={{ marginBottom: 12 }}>
        <Form.Item label="图片素材" htmlFor={`${id}-src`} layout="vertical">
          <ImageAssetInput id={`${id}-src`} value={current.src} media={media} readOnly={readOnly} onChange={src => { if (src !== current.src) onChange({ ...current, src, alt: '' }); }} />
        </Form.Item>
        <Form.Item label="显示名称" htmlFor={`${id}-label`} layout="vertical">
          <Input id={`${id}-label`} value={current.label} disabled={readOnly} maxLength={100} onChange={event => onChange({ ...current, label: event.target.value })} />
        </Form.Item>
        <Form.Item label="替代文字" htmlFor={`${id}-alt`} layout="vertical" extra="描述画面中的主要内容，发布前需填写。">
          <Input.TextArea id={`${id}-alt`} value={current.alt} disabled={readOnly} maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }} onChange={event => onChange({ ...current, alt: event.target.value })} />
        </Form.Item>
      </Card>;
    },
  };
}

export function imageComparisonFields(media: MediaItem[]): Config['components'][string]['fields'] {
  return {
    title: { type: 'custom', label: '对比标题', render: ({ value, onChange, id, readOnly }) => <Form.Item label="对比标题（选填）" htmlFor={id} layout="vertical">
      <Input id={id} value={value || ''} disabled={readOnly} maxLength={200} onChange={event => onChange(event.target.value)} />
    </Form.Item> },
    mode: { type: 'custom', label: '查看方式', render: ({ value, onChange, id, readOnly }) => <Form.Item label="查看方式" htmlFor={id} layout="vertical">
      <Select id={id} value={value || 'toggle'} disabled={readOnly} options={[{ value: 'toggle', label: '单张切换' }, { value: 'split', label: '并排查看（手机上下显示）' }]} onChange={next => onChange(next)} />
    </Form.Item> },
    before: comparisonSideField('before', media),
    after: comparisonSideField('after', media),
  };
}
