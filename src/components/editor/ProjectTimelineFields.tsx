'use client';

import type { Config } from '@puckeditor/core';
import { Button, Collapse, Form, Input, Space } from 'antd';
import { PROJECT_TIMELINE_MAX_ITEMS, type ProjectMilestone } from '@/lib/project-timeline';

/** 每次编辑保存同一份有序阶段数组，保留其他阶段内容。 */
export const projectTimelineFields: NonNullable<Config['components'][string]['fields']> = {
  title: {
    type: 'custom', label: '时间线标题',
    render: ({ id, value, onChange, readOnly }) => <Form.Item label="时间线标题" htmlFor={id} layout="vertical">
      <Input id={id} value={value ?? ''} maxLength={160} disabled={readOnly} onChange={event => onChange(event.target.value)} />
    </Form.Item>,
  },
  items: {
    type: 'custom', label: '项目阶段',
    render: ({ value, onChange, readOnly }) => {
      const items: ProjectMilestone[] = value ?? [];
      const edit = (index: number, field: keyof ProjectMilestone, next: string) => onChange(items.map((item, position) => position === index ? { ...item, [field]: next } : item));
      const move = (index: number, target: number) => {
        if (target < 0 || target >= items.length) return;
        const next = [...items];
        [next[index], next[target]] = [next[target], next[index]];
        onChange(next);
      };
      return <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Collapse size="small" defaultActiveKey={['0']} items={items.map((item, index) => ({
          key: String(index), label: item.title || `阶段 ${index + 1}`,
          children: <>
            <Form.Item label="阶段标记" layout="vertical">
              <Input aria-label={`阶段 ${index + 1} 标记`} value={item.label} maxLength={80} disabled={readOnly} onChange={event => edit(index, 'label', event.target.value)} />
            </Form.Item>
            <Form.Item label="阶段标题" layout="vertical">
              <Input aria-label={`阶段 ${index + 1} 标题`} value={item.title} maxLength={160} disabled={readOnly} onChange={event => edit(index, 'title', event.target.value)} />
            </Form.Item>
            <Form.Item label="阶段说明" layout="vertical">
              <Input.TextArea aria-label={`阶段 ${index + 1} 说明`} value={item.description} maxLength={1200} disabled={readOnly} autoSize={{ minRows: 2, maxRows: 5 }} onChange={event => edit(index, 'description', event.target.value)} />
            </Form.Item>
            <Space wrap>
              <Button size="small" aria-label={`上移阶段 ${index + 1}`} disabled={readOnly || index === 0} onClick={() => move(index, index - 1)}>上移</Button>
              <Button size="small" aria-label={`下移阶段 ${index + 1}`} disabled={readOnly || index === items.length - 1} onClick={() => move(index, index + 1)}>下移</Button>
              <Button size="small" danger aria-label={`移除阶段 ${index + 1}`} disabled={readOnly} onClick={() => onChange(items.filter((_, position) => position !== index))}>移除</Button>
            </Space>
          </>,
        }))} />
        <Button block disabled={readOnly || items.length >= PROJECT_TIMELINE_MAX_ITEMS} onClick={() => onChange([...items, { label: '', title: '', description: '' }])}>添加阶段</Button>
      </Space>;
    },
  },
};
