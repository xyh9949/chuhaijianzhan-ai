'use client';

import { Select, Typography } from 'antd';
import type { Field } from '@puckeditor/core';
import type { LinkTarget, StudioState } from '@/lib/types';
import { getContentEntryPath, getProductPath } from '@/lib/content-routes';

/** 只保存对象ID；解除引用后继续使用原静态href或动态绑定，不改写旧链接。 */
export function linkTargetField(state: StudioState): Field {
  const choices = [
    ...state.pages.filter(page => !page.slug.includes(':')).map(page => ({ value: `page:${page.id}`, label: `页面 · ${page.title}` })),
    ...state.products.filter(product => getProductPath(state, product)).map(product => ({ value: `product:${product.id}`, label: `产品 · ${product.name}` })),
    ...(state.contentEntries || []).filter(entry => getContentEntryPath(state, entry)).map(entry => ({ value: `entry:${entry.id}`, label: `内容 · ${entry.title}` })),
  ];
  return { type: 'custom', label: '内部链接目标', render: ({ value, onChange, readOnly }) => {
    const target = value as LinkTarget | null | undefined;
    return <div><Select aria-label="内部链接目标" style={{ width: '100%' }} disabled={readOnly} showSearch optionFilterProp="label" value={target ? `${target.kind}:${target.id}` : ''} options={[{ value: '', label: '使用原链接地址或动态绑定' }, ...choices]} onChange={value => { if (!value) onChange(null); else { const [kind, id] = value.split(':'); onChange({ kind, id }); } }} /><Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>内部目标随当前版本的网址更新。选择后请解除动态链接绑定；外链和页内锚点继续填写链接地址。</Typography.Paragraph></div>;
  } };
}
