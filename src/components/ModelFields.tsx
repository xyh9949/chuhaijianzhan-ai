'use client';

import ImagePicker from './ImagePicker';
import { Button,Form, Input, InputNumber, Select, Space, Tag, Typography } from 'antd';
import {ArrowUpOutlined,ArrowDownOutlined} from '@ant-design/icons';
import {useStudioRuntime} from '@/lib/studio-client';
import {isRelationDefinition,relationOptions,relatedTitle,MAX_RELATION_ITEMS,type RelationSource} from '@/lib/content-relations';
import type { ContentField, ContentModel, FieldValue } from '@/lib/types';
import { isEmptyFieldValue, validateFieldValue } from '@/lib/content-models';

export type ModelImageOption = { value: string; label: string };

/** 空值从字段字典移除，便于之后删除字段；数字 0 与 false 必须原样保留。 */
export function compactModelValues(values: Record<string, FieldValue | undefined> = {}): Record<string, FieldValue> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => !isEmptyFieldValue(value))) as Record<string, FieldValue>;
}

function FieldInput({ field, imageOptions, value, onChange, id,source,productImages=false,imagesDisabled=false,onUploadingChange,uploadFolder }:  { id?: string; field: ContentField; imageOptions: ModelImageOption[]; value?: FieldValue; onChange?: (next: FieldValue | undefined) => void;source:RelationSource;uploadFolder?:string;productImages?:boolean;imagesDisabled?:boolean;onUploadingChange?:(busy:boolean)=>void }) {
  if(field.type==='relation'&&isRelationDefinition(field.relation)){
    const selected=Array.isArray(value)?value:typeof value==='string'&&value?[value]:[],records=relationOptions(source,field.relation),labels=new Map(records.map(r=>[r.id,`${relatedTitle(r)}${r.status==='draft'?' · 草稿':''}`]));
    const options=[...records.map(r=>({value:r.id,label:labels.get(r.id)})),...selected.filter(id=>!labels.has(id)).map(id=>({value:id,label:`目标已不存在 · ${id}`}))];
    const move=(index:number,delta:number)=>{const next=[...selected];[next[index],next[index+delta]]=[next[index+delta],next[index]];onChange?.(next);};
    return <Space orientation="vertical" style={{width:'100%'}}><Select id={id} aria-label={field.label} allowClear showSearch optionFilterProp="label" mode={field.relation.multiple?'multiple':undefined} maxCount={field.relation.multiple?MAX_RELATION_ITEMS:undefined} value={value as string|string[]|undefined} options={options} onChange={next=>onChange?.(next)} placeholder="选择已有内容；未发布目标需另行勾选发布" style={{width:'100%'}} />{field.relation.multiple&&selected.map((id,index)=><Space key={id} wrap><Typography.Text>{index+1}. {labels.get(id)||id}</Typography.Text><Button size="small" icon={<ArrowUpOutlined/>} aria-label={`上移${field.label}第${index+1}项`} disabled={index===0} onClick={()=>move(index,-1)}/><Button size="small" icon={<ArrowDownOutlined/>} aria-label={`下移${field.label}第${index+1}项`} disabled={index===selected.length-1} onClick={()=>move(index,1)}/></Space>)}</Space>;
  }
  if (field.type === 'boolean') return <Select id={id} allowClear aria-label={field.label} placeholder="尚未填写" value={value === true ? 'yes' : value === false ? 'no' : undefined} onChange={next => onChange?.(next === undefined ? undefined : next === 'yes')} options={[{ value: 'yes', label: '是' }, { value: 'no', label: '否' }]} />;
  if (field.type === 'number') return <InputNumber id={id} aria-label={field.label} style={{ width: '100%' }} value={typeof value === 'number' ? value : null} min={field.min} max={field.max} suffix={field.unit} onChange={next => onChange?.(next === null ? undefined : next)} />;
  if (field.type === 'select' || field.type === 'multiselect') return <Select id={id} allowClear showSearch optionFilterProp="label" aria-label={field.label} placeholder="请选择" mode={field.type === 'multiselect' ? 'multiple' : undefined} value={value as string | string[] | undefined} onChange={next => onChange?.(next)} options={field.options || []} />;
  if(productImages&&(field.type==='image'||field.type==='gallery'))return <ImagePicker uploadFolder={uploadFolder} id={id} label={field.label} value={value as string|string[]|undefined} onChange={onChange} multiple={field.type==='gallery'} max={20} disabled={imagesDisabled} legacyOptions={imageOptions} onUploadingChange={onUploadingChange}/>;
  if (field.type === 'image' || field.type === 'gallery') {
    const selected = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    const options = [...imageOptions, ...selected.filter(url => !imageOptions.some(item => item.value === url)).map(url => ({ value: url, label: '已保存的图片' }))];
    return <Select id={id} allowClear showSearch optionFilterProp="label" aria-label={field.label} placeholder={field.type === 'gallery' ? '选择图片，最多 20 张' : '从素材中选择'} mode={field.type === 'gallery' ? 'multiple' : undefined} maxCount={field.type === 'gallery' ? 20 : undefined} value={value as string | string[] | undefined} onChange={next => onChange?.(next)} options={options} />;
  }
  if (field.type === 'textarea') return <Input.TextArea id={id} aria-label={field.label} value={typeof value === 'string' ? value : ''} onChange={event => onChange?.(event.target.value)} autoSize={{ minRows: 3, maxRows: 9 }} maxLength={30000} showCount />;
  return <Input id={id} aria-label={field.label} type={field.type === 'date' ? 'date' : 'text'} value={typeof value === 'string' ? value : ''} onChange={event => onChange?.(event.target.value)} maxLength={2000} placeholder={field.type === 'url' ? 'https://… 或站内路径 /…' : undefined} />;
}

/** 产品和独立内容共用 Ant 表单字段；草稿允许缺少必填值，已填写值始终按模型规则校验。
 * 保留 Ant 默认的 preserve；切换模型由父表单显式清空，避免卸载字段时恢复旧 initialValues。
 * 网格项和标签允许收缩/长词折行，避免手机上的长参数名把整列及控件撑出屏幕。 */
export default function ModelFields({ model, imageOptions, name = 'customFields',productImages=false,imagesDisabled=false,onUploadingChange }: { model: ContentModel; imageOptions: ModelImageOption[]; name?: string;productImages?:boolean;imagesDisabled?:boolean;onUploadingChange?:(busy:boolean)=>void }) {
  const runtime=useStudioRuntime();
  return <div className="model-value-fields">{model.fields.map(field => <Form.Item key={field.id} style={{minWidth:0}} name={[name, field.id]} label={<Space size={6} wrap style={{maxWidth:'100%',minWidth:0}} styles={{item:{minWidth:0,maxWidth:'100%',whiteSpace:'normal',overflowWrap:'anywhere'}}}>{field.label}{field.required && <Tag color="gold">发布必填</Tag>}</Space>} extra={field.description || (field.type === 'gallery' ? '图片按所选顺序展示，最多 20 张。' :field.type==='relation'?'选择要关联的已有内容，多选时可以调整顺序；使用中的内容需先解除关联才能删除。':undefined)} rules={[{ validator: (_, value: unknown) => { const errors = validateFieldValue(field, value); return errors.length ? Promise.reject(new Error(errors[0])) : Promise.resolve(); } }]}><FieldInput uploadFolder={model.target==='content'?'内容图片':undefined} field={field} imageOptions={imageOptions} source={runtime.envelope.state} productImages={productImages} imagesDisabled={imagesDisabled} onUploadingChange={onUploadingChange} /></Form.Item>)}{!model.fields.length && <Typography.Text type="secondary">当前模型还没有扩展字段，请由管理员添加字段。</Typography.Text>}</div>;
}
