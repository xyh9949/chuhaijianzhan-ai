'use client';
import { Alert, Button, Collapse, Form, Input, Space } from 'antd';
import type { Field } from '@puckeditor/core';
import { COMPONENT_LABEL_NAMES, COMPONENT_TRANSLATABLE_LABELS } from '@/lib/component-translatable-labels';

/** 缺省提示只在占位符展示，不在打开编辑器时补写存量页面；清空单项恢复原默认文字。 */
export function componentLabelsField(type:string):Field {
  return {type:'custom',label:'控件提示文字',render:({value,onChange,id,readOnly})=>{
    const labels=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,string>:{};
    return <Collapse size="small" items={[{key:'labels',label:'控件提示文字（多语言）',children:<Space orientation="vertical" size={12} style={{display:'flex'}}>{type==='CompanyFacts'&&<Alert type="info" title="这里只改栏目说明，企业名称、地址和事实值仍取自站点设置。"/>}{Object.entries(COMPONENT_TRANSLATABLE_LABELS[type]||{}).map(([key,fallback])=><Form.Item key={key} layout="vertical" label={COMPONENT_LABEL_NAMES[key]||'提示文字'} htmlFor={`${id}-${key}`} style={{marginBottom:0}}><Input.TextArea id={`${id}-${key}`} aria-label={COMPONENT_LABEL_NAMES[key]||'提示文字'} value={labels[key]||''} placeholder={fallback} maxLength={1000} autoSize={{minRows:1,maxRows:4}} disabled={readOnly} onChange={event=>{const next={...labels};if(event.target.value)next[key]=event.target.value;else delete next[key];onChange(next);}}/></Form.Item>)}<Button disabled={readOnly||!Object.keys(labels).length} onClick={()=>onChange({})}>恢复默认提示</Button></Space>}]} />;
  }};
}
