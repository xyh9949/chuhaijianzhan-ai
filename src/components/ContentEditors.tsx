'use client';
import RichTextComposer, { type RichTextAiSelection } from './RichTextComposer';
import AiContentWriter from './AiContentWriter';
import WritingSaveCheck from './WritingSaveCheck';
import { WritingSaveUncertainError, type PendingWritingSave } from '@/lib/ai-writing-save-client';
import type { AiWritingField, AiWritingProposal, AiWritingReceipt, AiWritingReceiptInput, AiWritingTask, AiWritingValue } from '@/lib/ai-writing-types';
import { appendRichWriting, entryAiFields, entryAiPresent, entryAiValue, mergeEntryAiReceipt, richWritingNeedsAppend, setEntryAiValues } from '@/lib/ai-entry-writing';
import ImagePicker from './ImagePicker';
import PublishDialog from './PublishDialog';
import {richTextErrors,richTextHasContent,richTextPlainText,richTextRecoveryErrors,textToRichText,type RichNode} from '@/lib/presentation-content';
import {entryWritingFields,entryPublicationState,ENTRY_PUBLICATION_LABELS} from '@/lib/content-writing';
import {formatDate} from '@/lib/date-format';
import './content-writing.css';
import MoreSettings from './MoreSettings';
import {columnPreset} from '@/lib/content-columns';
import SeoFields from './SeoFields';
import {editableLocaleShape} from '@/lib/localization';
import LocaleFields from './LocaleFields';
import RecordTermsFields from './RecordTermsFields';

import { useEffect, useRef, useState } from 'react';
import { App, Alert, Button, Card, Divider, Drawer, Empty, Flex, Form, Input, InputNumber, List, Modal, Select, Space, Switch, Tag, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, ArrowLeftOutlined, DeleteOutlined, EyeOutlined, CloudUploadOutlined, PlusOutlined, SaveOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import type { ContentEntry, ContentField, ContentModel, FieldType, Screen, StudioState } from '@/lib/types';
import { FIELD_TYPE_LABELS, FIELD_TYPES, validateModelValues } from '@/lib/content-models';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { getContentEntryPath } from '@/lib/content-routes';
import {isRelationDefinition,parseRelatedField} from '@/lib/content-relations';
import ModelFields, { compactModelValues, type ModelImageOption } from './ModelFields';
import './system.css';
import './content-models.css';

export type ModelDraft = { kind: 'model'; value: ContentModel; existingId?: string };
export type EntryDraft = { kind: 'entry'; value: ContentEntry; existingId?: string };
export type EditorDraft = ModelDraft | EntryDraft;
// 按入口分别保留恢复副本；旧单键缓存仍按用途恢复，另一入口保存不能清除它。
const cacheKey = (actorId: string, target?: ContentModel['target']) => `form-studio:model-recovery:${actorId}${target?`:${target}`:''}`;
// 在解析及写入前限制本地缓存字节；过大旧缓存也不能绕过恢复文档的安全上限。
const recoveryByteLimit=3*1024*1024;
const recoveryFits=(value:string)=>value.length<=recoveryByteLimit&&new TextEncoder().encode(value).byteLength<=recoveryByteLimit;
export function readRecovery(actorId: string, target?: ContentModel['target']): EditorDraft | null {
  try {
    const serialized=sessionStorage.getItem(cacheKey(actorId,target)) || (target?sessionStorage.getItem(cacheKey(actorId)):null) || 'null';
    if(!recoveryFits(serialized))return null;
    const item = JSON.parse(serialized);
    if (item?.actorId !== actorId || !item.draft?.value || typeof item.draft.value !== 'object') return null;
    const draft = item.draft, value = draft.value;
    const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);
    if (!validId(value.id) || typeof value.updated !== 'string' || draft.existingId !== undefined && !validId(draft.existingId)) return null;
    if (draft.kind === 'model') {
      if (typeof value.name !== 'string' || typeof value.description !== 'string' || !['product', 'content'].includes(value.target) || !Array.isArray(value.fields) || value.fields.length > 100) return null;
      if (!value.fields.every((field: ContentField) => field && validId(field.id) && typeof field.key === 'string' && typeof field.label === 'string' && FIELD_TYPES.includes(field.type) && typeof field.required === 'boolean' && (field.type!=='relation'||isRelationDefinition(field.relation,{draft:true})) && (field.options === undefined || Array.isArray(field.options) && field.options.every(option => option && typeof option.label === 'string' && typeof option.value === 'string')))) return null;
    } else if (draft.kind === 'entry') {
      if(!editableLocaleShape(value))return null;
      if (!validId(value.modelId) || typeof value.title !== 'string' || !['draft', 'published'].includes(value.status) || !value.customFields || typeof value.customFields !== 'object' || Array.isArray(value.customFields)) return null;
      if (['slug', 'seoTitle', 'seoDescription'].some(key => value[key] !== undefined && typeof value[key] !== 'string')) return null;
      if (!Object.entries(value.customFields).every(([key, field]) => validId(key) && (field === null || ['string', 'number', 'boolean'].includes(typeof field) || Array.isArray(field) && field.every(item => typeof item === 'string')))) return null;
      if(value.richTextFields!==undefined&&(!value.richTextFields||typeof value.richTextFields!=='object'||Array.isArray(value.richTextFields)||Object.entries(value.richTextFields).some(([key,doc])=>!validId(key)||richTextRecoveryErrors(doc,value.customFields[key]).length)))return null;
    } else return null;
    // 会话缓存同样属于不可信输入；完整结构检查后才交给表单遍历。
    // 参数设置与内容填写各自恢复到所属入口，兼容原缓存键。
    return target && (draft.kind === 'model' ? draft.value.target !== target : target !== 'content') ? null : draft as EditorDraft;
  } catch { return null; }
}
export function clearRecovery(actorId: string, target: ContentModel['target']) { try { sessionStorage.removeItem(cacheKey(actorId,target)); const legacy=readRecovery(actorId); if(legacy&&(legacy.kind==='model'?legacy.value.target:'content')===target)sessionStorage.removeItem(cacheKey(actorId)); } catch { /* 正常保存不依赖浏览器存储。 */ } }
function hasModelReference(value: unknown, modelId: string, fieldId?: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => hasModelReference(item, modelId, fieldId));
  const item = value as Record<string, unknown>;
  // 列表卡片有四个映射槽；删除保护与单字段绑定使用同一稳定字段 ID。
  if (item.modelId === modelId && (!fieldId || item.fieldId===fieldId || ['field', 'titleField', 'descriptionField', 'imageField', 'linkField'].some(key => item[key] === `field:${fieldId}`||typeof item[key]==='string'&&parseRelatedField(item[key])?.fieldId===fieldId))) return true;
  return Object.values(item).some(child => hasModelReference(child, modelId, fieldId));
}
export function usageOf(state: StudioState, modelId: string, fieldId?: string) {
  const hasValue = (item: { modelId?: string; customFields?: Record<string, unknown>;richTextFields?:Record<string,RichNode> }) => item.modelId === modelId && (!fieldId || Object.hasOwn(item.customFields || {}, fieldId) || Object.hasOwn(item.richTextFields||{},fieldId));
  return {
    products: state.products.filter(hasValue).length,
    entries: (state.contentEntries || []).filter(hasValue).length,
    pages: state.pages.filter(page => !fieldId && page.contentModelId === modelId || hasModelReference(state.editorData[page.id], modelId, fieldId)).length,
    blocks: (state.sharedBlocks || []).filter(block => hasModelReference(block.data, modelId, fieldId)).length,
    models:fieldId?0:(state.contentModels||[]).filter(model=>model.id!==modelId&&model.fields.some(f=>f.type==='relation'&&f.relation?.modelId===modelId)).length,
  };
}
export const usedCount = (usage: ReturnType<typeof usageOf>) => Object.values(usage).reduce((total, count) => total + count, 0);

/** 表单离开与会话过期共用保护；缓存仅恢复文本输入，不自动写入数据库。 */
function useDraftProtection({ dirty, busy, snapshot, save, close, actorId }: { dirty: boolean; busy: boolean; snapshot: EditorDraft; save: () => Promise<boolean>; close: () => void; actorId: string }) {
  const { message } = App.useApp();
  const target=snapshot.kind==='model'?snapshot.value.target:'content';
  const latest = useRef({ dirty, busy, snapshot, save, close }); latest.current = { dirty, busy, snapshot, save, close };
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const ask = (next: () => void) => { if (latest.current.busy) { message.info('正在处理，请等待完成'); return; } if (!latest.current.dirty) { next(); return; } pending.current = next; setOpen(true); };
  useEffect(() => {
    const guard = (event: Event) => {
      const detail = (event as CustomEvent<{ proceed?: () => void; target?: string }>).detail;
      if (!detail?.proceed) return;
      if (latest.current.busy) { event.preventDefault(); message.info('正在处理，请等待完成'); return; }
      if (!latest.current.dirty) return;
      event.preventDefault(); pending.current = () => { latest.current.close(); detail.proceed!(); }; setOpen(true);
    };
    const unload = (event: BeforeUnloadEvent) => { if (latest.current.dirty || latest.current.busy) { event.preventDefault(); event.returnValue = ''; } };
    const retain = () => { if (latest.current.dirty) { try { const serialized=JSON.stringify({ actorId, draft: latest.current.snapshot });if(recoveryFits(serialized))sessionStorage.setItem(cacheKey(actorId,target),serialized);else clearRecovery(actorId,target); } catch { /* 容量不足或存储禁用时无法跨登录恢复。 */ } } };
    window.addEventListener('form-studio:before-navigate', guard);
    window.addEventListener('form-studio:session-expired', retain, true);
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('form-studio:before-navigate', guard); window.removeEventListener('form-studio:session-expired', retain, true); window.removeEventListener('beforeunload', unload); };
  }, [actorId, message,target]);
  const proceed = () => { const next = pending.current; pending.current = null; setOpen(false); next?.(); };
  return { ask, dialog: <Modal title="当前修改尚未保存" open={open} onCancel={() => !saving && setOpen(false)} footer={<Space wrap><Button disabled={saving} onClick={() => setOpen(false)}>继续编辑</Button><Button danger disabled={saving} onClick={() => { clearRecovery(actorId,target); proceed(); }}>放弃修改</Button><Button type="primary" loading={saving} onClick={async () => { setSaving(true); try { if (await latest.current.save()) proceed(); } finally { setSaving(false); } }}>保存并继续</Button></Space>}><p>保存失败时会保留当前输入。离开前请选择保存或明确放弃。</p></Modal> };
}

function validateModelDraft(model: ContentModel): string[] {
  const errors: string[] = [];
  if (!model.name.trim()) errors.push('请填写名称');
  if (model.fields.length > 100) errors.push('一组最多 100 个填写项目');
  const keys = new Set<string>();
  for (const field of model.fields) {
    if (!field.label.trim()) errors.push('请填写所有项目名称');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(field.key) || ['constructor', 'prototype', '__proto__'].includes(field.key)) errors.push(`${field.label || '字段'}的标识需为小写字母开头，最多 64 位小写字母、数字或下划线`);
    if (keys.has(field.key)) errors.push(`字段标识 ${field.key} 重复`); keys.add(field.key);
    if (field.type === 'number' && field.min !== undefined && field.max !== undefined && field.min > field.max) errors.push(`${field.label} 的最小值不能大于最大值`);
    if(field.type==='relation'&&!isRelationDefinition(field.relation))errors.push(`${field.label}需选择关系目标和单/多选`);
    if (field.type === 'select' || field.type === 'multiselect') {
      if (!field.options?.length) errors.push(`${field.label} 至少需要一个选项`);
      const values = new Set<string>();
      for (const option of field.options || []) { if (!option.label.trim() || !option.value.trim()) errors.push(`${field.label} 的选项名称和值不能为空`); if (values.has(option.value)) errors.push(`${field.label} 的选项值重复`); values.add(option.value); }
    }
  }
  return [...new Set(errors)];
}

export function ModelEditor({ initial, original, state, imageOptions: _images, onSave, onClose, readonly, recovered }: { initial: ContentModel; original?: ContentModel; state: StudioState; imageOptions: ModelImageOption[]; onSave: (model: ContentModel) => Promise<void>; onClose: () => void; readonly: boolean; recovered: boolean }) {
  const runtime = useStudioRuntime(), { message, modal } = App.useApp();
  const [model, setModel] = useState(() => structuredClone(initial));
  const [selected, setSelected] = useState<string | undefined>(initial.fields[0]?.id);
  const [busy, setBusy] = useState(false), [errors, setErrors] = useState<string[]>([]);
  const baseline = useRef(JSON.stringify(original || initial));
  const dirty = recovered || JSON.stringify(model) !== baseline.current;
  const productParameters=model.target==='product', noun=productParameters?'参数组':'栏目';
  const field = model.fields.find(item => item.id === selected);
  const locked = !!original?.fields.some(item => item.id === selected);
  function patchField(patch: Partial<ContentField>) { setModel(current => ({ ...current, fields: current.fields.map(item => item.id === selected ? { ...item, ...patch } : item) })); setErrors([]); }
  async function save() {
    if (readonly || busy) return false;
    const normalized = { ...model, name: model.name.trim(), description: model.description.trim(), fields: model.fields.map(item => ({ ...item, label: item.label.trim(), key: item.key.trim() })) };
    const problems = validateModelDraft(normalized);
    // 删除字段或改规则必须先清除已有值；让可修复的问题在提交服务器前呈现。
    for (const item of [...state.products, ...(state.contentEntries || [])].filter(item => item.modelId === model.id)) problems.push(...validateModelValues(normalized, item.customFields || {}));
    for (const item of original?.fields || []) if (!normalized.fields.some(field => field.id === item.id) && usedCount(usageOf(state, model.id, item.id))) problems.push(`字段“${item.label}”仍有内容值或页面绑定，请先解除使用`);
    if (problems.length) { setErrors([...new Set(problems)]); return false; }
    setBusy(true);
    try { await onSave(normalized); clearRecovery(runtime.actor.id,model.target); message.success(`${noun}已保存到草稿`); return true; }
    catch (error) { setErrors([(error as Error).message]); return false; }
    finally { setBusy(false); }
  }
  const protection = useDraftProtection({ dirty, busy, snapshot: { kind: 'model', value: model, existingId: original?.id }, save, close: onClose, actorId: runtime.actor.id });
  function removeField(item: ContentField) {
    const used = usageOf(state, model.id, item.id);
    if (usedCount(used)) { setErrors([`“${item.label}”仍用于 ${used.products} 件产品、${used.entries} 条内容、${used.pages} 个页面、${used.blocks} 个区块。请先清空字段值并解除绑定。`]); return; }
    modal.confirm({ title: `删除字段“${item.label}”？`, content: '尚未保存的当前模型草稿会移除此字段；已发布历史版本保持完整。', okText: '删除字段', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => { setModel(current => ({ ...current, fields: current.fields.filter(field => field.id !== item.id) })); setSelected(model.fields.find(field => field.id !== item.id)?.id); } });
  }
  function moveField(direction: -1 | 1) { const next = [...model.fields], index = next.findIndex(item => item.id === selected), destination = index + direction; if (index < 0 || destination < 0 || destination >= next.length) return; [next[index], next[destination]] = [next[destination], next[index]]; setModel({ ...model, fields: next }); }
  return <><Drawer title={original ? `${readonly ? '查看' : '编辑'}${noun} · ${original.name}` : `新建${noun}`} open size={1000} onClose={() => !busy && protection.ask(onClose)} extra={!readonly && <Button type="primary" loading={busy} icon={<SaveOutlined />} onClick={save}>{`保存${noun}`}</Button>} styles={{ body: { padding: 24 } }}>
    {recovered && <Alert type="warning" showIcon title="已恢复之前未保存的设置，请核对后保存" style={{ marginBottom: 18 }} />}
    {!!errors.length && <Alert type="error" showIcon title="请先处理以下内容" description={errors.map((error, index) => <div key={index}>{error}</div>)} style={{ marginBottom: 18 }} />}
    <Form layout="vertical" disabled={readonly || busy}>
      <Form.Item label={`${noun}名称`} required><Input aria-label={`${noun}名称`} maxLength={120} value={model.name} onChange={event=>setModel({...model,name:event.target.value})} placeholder={productParameters?'例如：橱柜参数、门窗参数':'例如：客户案例、公司新闻'}/></Form.Item>
      <Form.Item label={`${noun}说明`}><Input.TextArea aria-label={`${noun}说明`} rows={2} maxLength={2000} value={model.description} onChange={event => setModel({ ...model, description: event.target.value })} placeholder="说明这组字段适用的内容与填写口径" /></Form.Item>
      <Divider />
      <div className="cm-schema-layout"><div className="cm-field-list"><Flex justify="space-between" align="center"><Typography.Text strong>需要填写的项目 <Typography.Text type="secondary">{model.fields.length}</Typography.Text></Typography.Text>{!readonly && <Button size="small" disabled={busy || model.fields.length >= 100} icon={<PlusOutlined />} onClick={() => { let index = model.fields.length + 1; while (model.fields.some(item => item.key === `field_${index}`)) index++; const item: ContentField = { id: `field-${crypto.randomUUID()}`, key: `field_${index}`, label: '新项目', type: 'text', required: false }; setModel(current => ({ ...current, fields: [...current.fields, item] })); setSelected(item.id); }}>添加填写项目</Button>}</Flex>
        <List className="cm-fields" dataSource={model.fields} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="添加需要客户填写的字段" /> }} renderItem={item => <List.Item className={item.id === selected ? 'is-selected' : ''}><Button type="text" block onClick={() => setSelected(item.id)}><span><strong>{item.label || '未命名字段'}</strong></span><Tag>{FIELD_TYPE_LABELS[item.type]}</Tag></Button></List.Item>} />
      </div><Card className="cm-field-settings" title={field ? '填写项设置' : '选择一个填写项'}>{field ? <>
        <Flex gap={10} justify="space-between" wrap><Typography.Text type="secondary">调整此填写项</Typography.Text><Space size={4}><Button aria-label="字段上移" size="small" icon={<ArrowUpOutlined />} disabled={readonly || busy || model.fields[0]?.id === field.id} onClick={() => moveField(-1)} /><Button aria-label="字段下移" size="small" icon={<ArrowDownOutlined />} disabled={readonly || busy || model.fields.at(-1)?.id === field.id} onClick={() => moveField(1)} /><Button aria-label="删除当前字段" size="small" disabled={readonly || busy} danger icon={<DeleteOutlined />} onClick={() => removeField(field)} /></Space></Flex>
        <Form.Item label="显示名称" required style={{ marginTop: 20 }}><Input aria-label="显示名称" value={field.label} maxLength={120} onChange={event => patchField({ label: event.target.value })} placeholder="例如：板材厚度" /></Form.Item>
        <Form.Item label="填写方式"><Select aria-label="填写方式" value={field.type} disabled={locked || readonly || busy} options={FIELD_TYPES.map(type => ({ value: type, label: FIELD_TYPE_LABELS[type] }))} onChange={(type: FieldType) => patchField({ type, relation:type==='relation'?{source:'product',multiple:false,onDelete:'restrict'}:undefined,options: ['select', 'multiselect'].includes(type) ? [{ label: '选项一', value: 'option_1' }] : undefined, min: undefined, max: undefined, unit: undefined })} /></Form.Item><MoreSettings title="识别代码（高级）" hasErrors={!!errors.length} description="由系统自动填写，一般无需修改。已保存的代码用于关联已有资料，保持不变。"><Form.Item label="字段标识" required extra={locked ? '已保存的标识不可更改' : '小写字母、数字与下划线'}><Input aria-label="字段标识" value={field.key} disabled={locked || readonly || busy} maxLength={64} onChange={event => patchField({ key: event.target.value })} /></Form.Item></MoreSettings>
        {field.type==='relation'&&<><Form.Item label="关联目标" extra="基础产品或明确内容模型；保存后目标和选择方式不能原地改动。"><Select aria-label="关系目标模型" disabled={locked||readonly||busy} value={field.relation?.modelId||'@products'} options={[{value:'@products',label:'全部产品 · 内置基础来源'},...[...new Map([...(state.contentModels||[]),model].map(m=>[m.id,m])).values()].map(m=>({value:m.id,label:`${m.name} · ${m.target==='product'?'产品模型':'独立内容'}`}))]} onChange={modelId=>{const target=[...(state.contentModels||[]),model].find(m=>m.id===modelId);patchField({relation:{source:target?.target==='content'?'entry':'product',modelId:target?.id,multiple:field.relation?.multiple||false,onDelete:'restrict'}});}} /></Form.Item><Form.Item label="允许关联多个记录"><Switch aria-label="关系允许多选" checked={field.relation?.multiple} disabled={locked||readonly||busy} onChange={multiple=>patchField({relation:{...field.relation!,multiple}})}/></Form.Item><Alert type="info" title="删除已关联资料前，需要先取消关联" description="关联后可以在页面显示这些已有资料。仍在使用的关联内容不能直接删除。" style={{marginBottom:16}} /></>}
        <Form.Item label="填写说明"><Input.TextArea aria-label="字段填写说明" rows={2} maxLength={2000} value={field.description || ''} onChange={event => patchField({ description: event.target.value })} /></Form.Item>
        <Form.Item label="发布时必填"><Switch aria-label="字段发布必填" checked={field.required} onChange={required => patchField({ required })} /><Typography.Text type="secondary" style={{ marginLeft: 12 }}>草稿可以留空</Typography.Text></Form.Item>
        {field.type === 'number' && <><Form.Item label="显示单位"><Input aria-label="字段单位" value={field.unit || ''} maxLength={40} placeholder="例如：mm、kg" onChange={event => patchField({ unit: event.target.value })} /></Form.Item><div className="cm-field-dual"><Form.Item label="最小值"><InputNumber aria-label="字段最小值" style={{ width: '100%' }} value={field.min} onChange={min => patchField({ min: min ?? undefined })} /></Form.Item><Form.Item label="最大值"><InputNumber aria-label="字段最大值" style={{ width: '100%' }} value={field.max} onChange={max => patchField({ max: max ?? undefined })} /></Form.Item></div></>}
        {['select', 'multiselect'].includes(field.type) && <div><Typography.Text strong>可选内容</Typography.Text><Typography.Paragraph type="secondary">选项值用于存储。已有记录使用的值不能直接删除或改名。</Typography.Paragraph>{(field.options || []).map((option, index) => <div className="cm-option-row" key={index} style={{gridTemplateColumns:'minmax(0,1fr) 32px'}}><Input aria-label={`选项 ${index + 1} 名称`} value={option.label} maxLength={120} placeholder="显示名称" onChange={event => patchField({ options: field.options!.map((item, i) => i === index ? { ...item, label: event.target.value } : item) })} /><Button aria-label={`删除选项 ${index + 1}`} danger icon={<DeleteOutlined />} onClick={() => patchField({ options: field.options!.filter((_, i) => i !== index) })} /></div>)}{/* 仅新选项生成独立代码，修改显示名称不会重写已有保存值。 */}<MoreSettings title="选项识别代码（高级）" hasErrors={!!errors.length}>{(field.options||[]).map((option,index)=><Form.Item key={index} label={`选项 ${index+1} 的代码`}><Input aria-label={`选项 ${index+1} 值`} value={option.value} maxLength={100} onChange={event=>patchField({options:field.options!.map((item,i)=>i===index?{...item,value:event.target.value}:item)})}/></Form.Item>)}</MoreSettings><Button type="dashed" block disabled={(field.options || []).length >= 100} icon={<PlusOutlined />} onClick={() => patchField({ options: [...(field.options || []), { label: '', value: `option-${crypto.randomUUID()}` }] })}>添加选项</Button></div>}
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧选择或添加字段" />}</Card></div>
    </Form><Alert type="info" showIcon style={{ marginTop: 20 }} title="已有填写项目会保持关联，请谨慎删除" description="可以修改名称、填写说明、单位和顺序。仍被内容或页面使用的项目不能直接删除；栏目设置保存后也需要发布。" />
  </Drawer>{protection.dialog}</>;
}

/** 完整写作页复用原草稿、权限与发布检查；格式仅在编辑后保存，不改写旧纯文字。 */
type EntryWritingSession={fields:AiWritingField[];sourceText:string;task:AiWritingTask;language:string;referenceProductIds:string[];notice?:string;selection?:{key:string;value:AiWritingValue;handle:RichTextAiSelection};modelId:string};
type EntryWritingUndo={receipt:AiWritingReceiptInput;kinds:Record<string,AiWritingField['kind']>;previous:AiWritingReceiptInput[];previousUndo?:EntryWritingUndo};
export function EntryEditor({initial,original,state,models,imageOptions,onSave,onClose,recovered,readonly,onRepair}:{initial:ContentEntry;original?:ContentEntry;state:StudioState;models:ContentModel[];imageOptions:ModelImageOption[];onSave:(entry:ContentEntry,receipts?:AiWritingReceiptInput[])=>Promise<ContentEntry>;onClose:()=>void;recovered:boolean;readonly:boolean;onRepair?:(screen:Screen,pageId?:string)=>void}){
 const runtime=useStudioRuntime(),{message,modal}=App.useApp(),[form]=Form.useForm<ContentEntry>();
 const [draft,setDraft]=useState<ContentEntry>(()=>structuredClone(initial));
 const [busy,setBusy]=useState(false),[uploading,setUploading]=useState(false),[error,setError]=useState(''),[publishOpen,setPublishOpen]=useState(false);
 const [writingOpen,setWritingOpen]=useState(false),[writingSession,setWritingSession]=useState<EntryWritingSession>(),[aiBusy,setAiBusy]=useState(false),[referenceProducts,setReferenceProducts]=useState<string[]>([]);
 const [writingReceipts,setWritingReceipts]=useState<AiWritingReceiptInput[]>([]),[writingUndo,setWritingUndo]=useState<EntryWritingUndo>();
 const [pendingWritingSave,setPendingWritingSave]=useState<PendingWritingSave>();
 const [previewLink,setPreviewLink]=useState('');
 const uploads=useRef(0),baseline=useRef(JSON.stringify(original||initial));
 const onImageUploading=(active:boolean)=>{uploads.current=Math.max(0,uploads.current+(active?1:-1));setUploading(uploads.current>0);};
 const dirty=recovered||JSON.stringify(draft)!==baseline.current;
 useEffect(()=>{window.scrollTo({top:0});if(!readonly&&!original)form.getFieldInstance('title')?.focus({preventScroll:true});},[initial.id]);
 const modelId=Form.useWatch('modelId',form)||draft.modelId,model=models.find(m=>m.id===modelId&&m.target==='content');
 const fields=entryWritingFields(model),preset=model?columnPreset(model):undefined,noun=preset?.key==='team'?'成员':preset?.name||'内容',titleLabel=preset?.key==='team'?'成员姓名':preset?.key==='case'?'案例名称':preset?.key==='news'?'新闻标题':'内容标题';
 const live=runtime.envelope.state.contentEntries?.find(e=>e.id===draft.id),publication=entryPublicationState(live||draft,state.releases,runtime.envelope.activeReleaseId);
 const richProblems=Object.values(draft.richTextFields||{}).flatMap(doc=>richTextErrors(doc));
 const path=getContentEntryPath(state,draft),bodyValue=fields.body?(draft.richTextFields?.[fields.body.id]?richTextPlainText(draft.richTextFields[fields.body.id]):String(draft.customFields[fields.body.id]||'')):'',charCount=bodyValue.replace(/\s/g,'').length;
 function readValues(){return {...draft,...form.getFieldsValue(true)} as ContentEntry;}
 function changed(){setDraft(current=>({...current,...form.getFieldsValue(true)}));setError('');}
 function setRich(fieldId:string,doc:RichNode){
  // plain保持旧模板/搜索/摘要可用，sidecar保存排版，服务端要求两者严格一致。
  form.setFieldValue(['customFields',fieldId],richTextPlainText(doc));form.setFieldValue(['richTextFields',fieldId],doc);changed();
 }
 // 保存与预览使用相同的字段核对，预览不改变草稿与写作撤销状态。
 async function checkedEntry(){
   if(!model)throw new Error('请先选择有效的栏目');
   await form.validateFields();const values=readValues(),allRich=values.richTextFields||{};
   // 先拒绝非法或超限文档，再清理合法空文档；不能把无效正文当成空值保存。
   const richErrors=Object.values(allRich).flatMap(doc=>richTextErrors(doc));if(richErrors.length)throw new Error(richErrors.join('；'));
   const rich=Object.fromEntries(Object.entries(allRich).filter(([,doc])=>richTextHasContent(doc)));
   const customFields=compactModelValues(values.customFields);for(const [id,doc]of Object.entries(rich))customFields[id]=richTextPlainText(doc);
   const problems=validateModelValues(model,customFields,false);if(problems.length)throw new Error(problems.join('；'));
   return {...values,title:values.title.trim(),slug:values.slug?.trim()||undefined,seoTitle:values.seoTitle?.trim()||undefined,seoDescription:values.seoDescription?.trim()||undefined,customFields,...(values.richTextFields!==undefined||original?.richTextFields!==undefined?{richTextFields:rich}:{})};
 }
 async function save(){
  if(readonly||busy||aiBusy||uploads.current||!model)return false;setBusy(true);setError('');
  try{const next=await checkedEntry();
   const saved=await onSave(next,writingReceipts);baseline.current=JSON.stringify(saved);syncWritingDraft(saved);setWritingReceipts([]);setWritingUndo(undefined);setPendingWritingSave(undefined);clearRecovery(runtime.actor.id,'content');message.success('草稿已保存，可以继续编辑');return true;
  }catch(reason){if(reason instanceof WritingSaveUncertainError)setPendingWritingSave(reason.pending);setError((reason as {errorFields?:unknown[]}).errorFields?'请检查标出的填写项目，当前输入已保留。':(reason as Error).message);return false;}finally{setBusy(false);}
 }
 const protection=useDraftProtection({dirty,busy:busy||uploading||aiBusy,snapshot:{kind:'entry',value:draft,existingId:original?.id},save,close:onClose,actorId:runtime.actor.id});
 function syncWritingDraft(next:ContentEntry){
  form.setFieldsValue(next);
  // setFieldsValue会合并嵌套对象；直接替换两份字段映射，撤回删除时不能遗留旧排版或SEO值。
  form.setFieldValue('customFields',structuredClone(next.customFields));form.setFieldValue('richTextFields',next.richTextFields?structuredClone(next.richTextFields):undefined);
  form.setFieldValue('seoTitle',next.seoTitle);form.setFieldValue('seoDescription',next.seoDescription);setDraft(structuredClone(next));
 }
 function writingSource(current:ContentEntry,currentModel:ContentModel){
  const bodyField=entryWritingFields(currentModel).body,body=bodyField?entryAiValue(current,`customFields:${bodyField.id}`,'richtext'):null;
  const references=state.products.filter(product=>referenceProducts.includes(product.id)).slice(0,3).map(product=>`产品：${product.name}\n型号：${product.sku}\n分类：${product.category}\n材质：${product.material}\n介绍：${product.description}`).join('\n\n');
  return [`栏目：${currentModel.name}`,`语言：${current.locale||state.settings.language||'en'}`,`标题：${current.title}`,typeof body==='string'?body:body?richTextPlainText(body):'',references].filter(Boolean).join('\n\n').slice(0,12000);
 }
 function openWriting(selection?:RichTextAiSelection){
  if(runtime.actor.role!=='admin'||readonly||busy||uploading||!model)return;
  if(selection&&selection.text.length>12000){message.info('一次最多调整12000字符，请缩小选段；原文没有修改。');return;}
  const current=readValues(),available=entryAiFields(current,model),bodyKey=fields.body?`customFields:${fields.body.id}`:'';
  const bodyField=available.find(field=>field.key===bodyKey),body=bodyField?.before;
  // 本次只读取明确选择的产品公开文字，不把扩展私密字段或整素材库带进模型。
  const source=selection?selection.text:writingSource(current,model);
  if(selection&&!bodyField)return;
  setWritingSession({modelId:model.id,referenceProductIds:referenceProducts.filter(id=>state.products.some(product=>product.id===id)).slice(0,3),fields:selection?[{...bodyField!,before:textToRichText(selection.text)}]:available,sourceText:source,task:selection?'rewrite':'article',language:current.locale||state.settings.language||'en',...(selection?{selection:{key:bodyKey,value:entryAiValue(current,bodyKey,'richtext'),handle:selection},notice:'只替换明确选中的文字。生成后正文有变化时会保留建议并要求重新选择。'}:body&&typeof body!=='string'&&richWritingNeedsAppend(body)?{notice:'原正文包含图片或文字链接，采用正文时会追加AI内容至末尾，完整保留原文；标题、摘要等仍按勾选项替换。'}:{})});
  setWritingOpen(true);
 }
 async function applyWriting(proposal:AiWritingProposal,selectedKeys:string[]){
  if(!writingSession||!model||model.id!==writingSession.modelId||proposal.target.kind!=='entry'||proposal.target.id!==draft.id||proposal.target.modelId!==model.id)throw new Error('所属栏目或目标已变化，请重新准备建议；当前输入已保留。');
  const current=readValues(),chosen=proposal.fields.filter(field=>selectedKeys.includes(field.key));
  if((current.locale||state.settings.language||'en')!==writingSession.language)throw new Error('当前文章语言已变化，建议仍保留，请重新选择语言并生成。');
  if(JSON.stringify(referenceProducts.filter(id=>state.products.some(product=>product.id===id)).slice(0,3))!==JSON.stringify(writingSession.referenceProductIds))throw new Error('本次选用的产品已有变化，请按当前范围重新准备建议。');
  if(!writingSession.selection&&writingSource(current,model)!==writingSession.sourceText)throw new Error('写作依据或关联产品已有变化，建议仍保留，请重新核对后生成。');
  if(!chosen.length)throw new Error('请先选择要填入的内容');
  const before:Record<string,AiWritingValue>={},after:Record<string,AiWritingValue>={},beforePresent:Record<string,boolean>={},kinds:Record<string,AiWritingField['kind']>={};
  for(const field of chosen){
   // 本人历史提案仍属于原选段，不能借当前新句柄把旧结果写入别处。
   if(writingSession.selection?.key===field.key&&JSON.stringify(field.before)!==JSON.stringify(writingSession.fields.find(item=>item.key===field.key)?.before))throw new Error('此建议针对之前的另一段文字，请为当前选段重新准备建议；原文没有修改。');
   const value=entryAiValue(current,field.key,field.kind),expected=writingSession.selection?.key===field.key?writingSession.selection.value:field.before;
   if(JSON.stringify(value)!==JSON.stringify(expected))throw new Error(`“${field.label}”已有后续修改，建议仍保留，请重新核对后生成。`);
   before[field.key]=structuredClone(value);beforePresent[field.key]=entryAiPresent(current,field.key);kinds[field.key]=field.kind;
   const next=field.kind==='richtext'&&typeof field.after==='string'?textToRichText(field.after):field.after;
   if(writingSession.selection?.key===field.key){
    if(typeof next==='string')throw new Error('选段建议格式无效');
    after[field.key]=writingSession.selection.handle.apply(next,field.maxLength);
   }else if(field.kind==='richtext'&&value&&typeof value!=='string'&&richWritingNeedsAppend(value)){
    if(typeof next==='string')throw new Error('正文建议格式无效');
    after[field.key]=appendRichWriting(value,next);
   }else after[field.key]=next;
   const output=after[field.key],plain=typeof output==='string'?output:output?richTextPlainText(output):'';
   if(plain.length>field.maxLength)throw new Error(`“${field.label}”追加后超过${field.maxLength}字符，请缩短建议；原输入已保留。`);
  }
  const next=setEntryAiValues(current,chosen.map(field=>({key:field.key,kind:field.kind,value:after[field.key]})));
  const receipt:AiWritingReceiptInput={proposalId:proposal.id,selectedKeys:chosen.map(field=>field.key),before,after,beforePresent};
  syncWritingDraft(next);setWritingReceipts(mergeEntryAiReceipt(writingReceipts,receipt));setWritingUndo({receipt,kinds,previous:structuredClone(writingReceipts),previousUndo:writingUndo});setError('');
  message.success('已填入编辑区，请继续核对；保存草稿后才写入数据库。');
 }
 function undoWriting(){
  if(!writingUndo)return;
  try{
   const current=readValues(),{receipt,kinds}=writingUndo;
   if(receipt.selectedKeys.some(key=>JSON.stringify(entryAiValue(current,key,kinds[key]))!==JSON.stringify(receipt.after[key])))throw new Error('AI填写的内容已有后续人工修改，不能用旧结果覆盖；当前输入已保留。');
   const next=setEntryAiValues(current,receipt.selectedKeys.map(key=>({key,kind:kinds[key],value:receipt.before[key],present:receipt.beforePresent?.[key]})));
   syncWritingDraft(next);setWritingReceipts(writingUndo.previous);setWritingUndo(writingUndo.previousUndo);message.success('本次AI填入已撤回，其他输入保持。');
  }catch(reason){setError((reason as Error).message);}
 }
 function detachWriting(){
  // 明确清除关联时仅只读恢复已拒绝的操作，保留编辑区和并发保护，不自动重送保存。
  modal.confirm({title:'保留文字，继续手工保存？',content:'当前文字、排版和其他输入保持。必要时先读取最新工作区；尚有其它待提交内容或未确认请求时会阻止操作。本次修改不再登记为AI撤销记录，之后仍需点击“保存草稿”，不会自动保存或发布。',okText:'保留文字并继续',cancelText:'返回编辑',onOk:async()=>{try{if(runtime.getSaveState()==='error')await runtime.recoverRejectedMutation();else if(runtime.getSaveState()!=='saved'||runtime.isMutating)throw new Error('工作区仍在同步，请等待完成；当前文章保持。');}catch(reason){message.error(reason instanceof Error?reason.message:'读取最新工作区失败，当前输入保持');throw reason;}setWritingReceipts([]);setWritingUndo(undefined);message.info('文字已保留，请按原流程保存草稿。');}});
 }
 async function undoSavedWriting(receipt:AiWritingReceipt){
  if(busy||uploading||aiBusy)throw new Error('正在处理，请等待完成');
  if(JSON.stringify(readValues())!==baseline.current)throw new Error('当前文章还有未保存修改，请先保存或明确放弃，再撤销已保存的AI结果。');
  let restored:ContentEntry|undefined;
  await runtime.mutate(async env=>{const next=await request<StudioEnvelope>(`/api/ai/writing/receipts/${receipt.id}/undo`,{method:'POST',body:JSON.stringify({expectedRevision:env.revision})});restored=next.state.contentEntries?.find(item=>item.id===draft.id);return next;});
  if(!restored)throw new Error('这条内容已不存在，请核对最新工作区');
  baseline.current=JSON.stringify(restored);syncWritingDraft(restored);setWritingReceipts([]);setWritingUndo(undefined);clearRecovery(runtime.actor.id,'content');
 }
 async function preview(){
  if(uploads.current||busy||aiBusy||!path)return;
  const target=window.open('about:blank','_blank');if(target)target.opener=null;
  setBusy(true);setError('');setPreviewLink('');
  try {
    const href=readonly||(!dirty&&original)?`/preview${path}`:(await request<{href:string}>('/api/content-entry-preview',{method:'POST',body:JSON.stringify({entry:await checkedEntry()})})).href;
    if(target&&!target.closed)target.location.href=href;else setPreviewLink(href);
  }catch(reason){target?.close();setError((reason as {errorFields?:unknown[]}).errorFields?'请检查标出的填写项目，当前输入已保留。':(reason as Error).message);}
  finally{setBusy(false);}
 }
 async function publish(){if(uploads.current||busy)return;if((dirty||!original)&&!await save())return;setPublishOpen(true);}
 function switchColumn(next:string){const apply=()=>{form.setFieldValue('modelId',next);form.setFieldValue('customFields',{});form.setFieldValue('richTextFields',{});changed();};if(Object.keys(draft.customFields||{}).length||Object.keys(draft.richTextFields||{}).length)modal.confirm({title:'切换所属栏目？',content:'当前栏目的专用资料会清空，标题保留。保存后才更新数据库。',okText:'切换并清空资料',cancelText:'继续当前栏目',onOk:apply});else apply();}
 const normalFields=fields.other.filter(f=>!draft.richTextFields?.[f.id]),extraRich=fields.other.filter(f=>!!draft.richTextFields?.[f.id]);
 function richValue(id:string){return draft.richTextFields?.[id]||textToRichText(typeof draft.customFields[id]==='string'?draft.customFields[id] as string:'');}
 return <section className="sys-screen content-entry-page"><header className="content-entry-toolbar"><Space wrap><Button icon={<ArrowLeftOutlined/>} onClick={()=>protection.ask(onClose)} disabled={busy||uploading||aiBusy}>返回{model?.name||'内容'}列表</Button><Tag color={dirty?'gold':publication==='published'?'green':publication==='modified'?'orange':undefined}>{dirty?'有未保存修改':ENTRY_PUBLICATION_LABELS[publication]}</Tag></Space><Space wrap>{runtime.actor.role==='admin'&&!readonly&&<Button icon={<ThunderboltOutlined/>} disabled={busy||uploading||aiBusy||!model} onClick={()=>openWriting()}>AI写文章</Button>}{writingUndo&&<Button icon={<UndoOutlined/>} disabled={busy||uploading||aiBusy} onClick={undoWriting}>撤回AI填入</Button>}<Button icon={<EyeOutlined/>} onClick={preview} disabled={busy||uploading||aiBusy||!!richProblems.length||!path}>预览</Button>{!readonly&&<Button type="primary" icon={<SaveOutlined/>} loading={busy} disabled={uploading||aiBusy||!!richProblems.length||!model} onClick={save}>保存草稿</Button>}</Space></header>
  {recovered&&<Alert type="warning" showIcon title="已恢复之前的写作内容，请核对后保存" className="content-entry-alert"/>}
  {error&&<Alert type="error" showIcon title={error} className="content-entry-alert"/>}
  {previewLink&&<Alert type="info" showIcon title="浏览器拦截了预览标签页" className="content-entry-alert" action={<Button href={previewLink} target="_blank" rel="noopener noreferrer">打开文章预览</Button>}/>}
  {pendingWritingSave&&<WritingSaveCheck pending={pendingWritingSave} current={readValues} onConfirmed={saved=>{const entry=saved as ContentEntry;baseline.current=JSON.stringify(entry);syncWritingDraft(entry);setWritingReceipts([]);setWritingUndo(undefined);setPendingWritingSave(undefined);setError('');clearRecovery(runtime.actor.id,'content');message.success('已确认保存，可以继续编辑。');}}/>}
  {!!writingReceipts.length&&<Alert type="info" showIcon title="已填入编辑区，尚未保存" description="点击“保存草稿”后才保存本次修改；建议过期或资料变化时，也可保留文字继续手工保存。" className="content-entry-alert ai-writing-adoption-notice" action={<Button disabled={busy||uploading||aiBusy} onClick={detachWriting}>保留文字，继续保存</Button>}/>}
  {uploading&&<Alert type="info" showIcon title="正在上传图片，请稍候再保存或离开" className="content-entry-alert"/>}
  <Form form={form} initialValues={initial} layout="vertical" disabled={readonly||busy||aiBusy} onValuesChange={changed} requiredMark="optional"><Form.Item name="modelId" hidden><Input/></Form.Item>
   <div className="content-entry-layout"><main className="content-entry-main">
    <Card className="content-entry-card"><Typography.Text className="content-entry-eyebrow">{model?.name||'内容'} · {readonly?'查看内容':'编辑内容'}</Typography.Text><Form.Item name="title" className="content-entry-title" rules={[{required:true,whitespace:true,message:`请填写${titleLabel}`},{max:200,message:'标题最多200字符'}]}><Input aria-label={titleLabel} placeholder={`输入${titleLabel}`} maxLength={200} variant="borderless"/></Form.Item>
     {fields.cover&&<Form.Item name={['customFields',fields.cover.id]} className="content-entry-cover" extra="封面可以直接上传，也可以从素材库选择。"><ImagePicker label="封面图片" variant="cover" disabled={busy} legacyOptions={imageOptions} uploadFolder="内容图片" onUploadingChange={onImageUploading}/></Form.Item>}
     {fields.excerpt&&!draft.richTextFields?.[fields.excerpt.id]&&<Form.Item name={['customFields',fields.excerpt.id]} label={fields.excerpt.label}><Input.TextArea aria-label={fields.excerpt.label} autoSize={{minRows:2,maxRows:5}} maxLength={30000} placeholder="简要概括这篇内容，方便客户快速了解"/></Form.Item>}
    </Card>
    {fields.body?<Card className="content-entry-card content-entry-body-card" title={fields.body.label} extra={<Typography.Text type="secondary">{richProblems.length?'请调整正文':`${charCount} 字符`}</Typography.Text>}><RichTextComposer key={fields.body.id} label={fields.body.label} value={richValue(fields.body.id)} onChange={doc=>setRich(fields.body!.id,doc)} readOnly={readonly||busy||aiBusy} onUploadingChange={onImageUploading} onAiSelection={runtime.actor.role==='admin'&&!readonly?selection=>openWriting(selection):undefined}/></Card>:<Alert type="info" showIcon title="此栏目没有正文填写项" description="已有专用资料可在右侧填写；管理员可以在栏目设置中添加正文。"/>}
    {fields.excerpt&&draft.richTextFields?.[fields.excerpt.id]&&<Card className="content-entry-card" title={fields.excerpt.label}><RichTextComposer label={fields.excerpt.label} value={richValue(fields.excerpt.id)} onChange={doc=>setRich(fields.excerpt!.id,doc)} readOnly={readonly||busy} onUploadingChange={onImageUploading}/></Card>}
    {extraRich.map(field=><Card className="content-entry-card" title={field.label} key={field.id}><RichTextComposer label={field.label} value={richValue(field.id)} onChange={doc=>setRich(field.id,doc)} readOnly={readonly||busy} onUploadingChange={onImageUploading}/></Card>)}
   </main><aside className="content-entry-sidebar">
    <Card title="网站状态" className="content-entry-card"><Tag color={publication==='published'?'green':publication==='modified'?'orange':'default'}>{ENTRY_PUBLICATION_LABELS[publication]}</Tag><Typography.Paragraph type="secondary" style={{marginTop:12}}>{dirty?'当前修改还没有保存。':publication==='published'?'保存的内容与网站当前版本一致。':'草稿已保存在后台，发布后客户才能看到。'}</Typography.Paragraph>{live?.updated&&<Typography.Paragraph type="secondary">最近保存<br/>{formatDate(live.updated,state.settings.timezone)}</Typography.Paragraph>}{runtime.actor.role==='admin'?<Button block icon={<CloudUploadOutlined/>} disabled={busy||uploading||!!richProblems.length||readonly||!model} onClick={publish}>{publication==='published'||publication==='modified'?'检查并更新网站':'检查并发布内容'}</Button>:<Typography.Text type="secondary">网站发布由管理员检查确认。</Typography.Text>}</Card>
    <Card title="内容资料" className="content-entry-card"><Form.Item label="所属栏目"><Select aria-label="所属栏目" value={modelId} disabled={readonly||!!original||busy||uploading||aiBusy} options={models.map(m=>({value:m.id,label:m.name}))} onChange={switchColumn}/></Form.Item>{model?.description&&<Typography.Paragraph type="secondary">{model.description}</Typography.Paragraph>}{model&&normalFields.length>0&&<ModelFields model={{...model,fields:normalFields}} imageOptions={imageOptions} productImages imagesDisabled={busy} onUploadingChange={onImageUploading}/>}</Card>
    {runtime.actor.role==='admin'&&!readonly&&<Card className="content-entry-card"><MoreSettings title="AI写作参考（选填）"><Form.Item label="参考产品" extra="最多选择3个，只使用名称、型号、分类、材质和已有介绍。不会自动改产品。"><Select mode="multiple" aria-label="文章AI参考产品" value={referenceProducts} maxCount={3} options={state.products.map(product=>({value:product.id,label:product.name}))} disabled={busy||aiBusy} onChange={setReferenceProducts}/></Form.Item><Typography.Text type="secondary">企业事实与写作偏好在“站点设置 → AI服务 → 写作资料”统一维护。</Typography.Text></MoreSettings></Card>}
    <Card className="content-entry-card"><MoreSettings title="分类标签与显示顺序（选填）"><RecordTermsFields taxonomies={state.taxonomies} source="entry" modelId={modelId}/></MoreSettings><SeoFields media={state.media} fallbackTitle={draft.title} productImages uploadFolder="内容图片" imagesDisabled={busy} onUploadingChange={onImageUploading}><Form.Item name="slug" label="内容网址名称" extra={path||'此栏目尚未设置详情页'} rules={[{validator:(_,value:string|undefined)=>!value||/^[a-z0-9][a-z0-9_-]{0,99}$/.test(value)?Promise.resolve():Promise.reject(new Error('请使用小写字母、数字、短横线或下划线，最多100字符'))}]}><Input aria-label="内容网址标识" placeholder="留空可使用系统地址" maxLength={100}/></Form.Item></SeoFields><LocaleFields settings={state.settings}/></Card>
   </aside></div>
  </Form>{protection.dialog}{writingSession&&<AiContentWriter open={writingOpen} onClose={()=>setWritingOpen(false)} target={{kind:'entry',id:draft.id,modelId:writingSession.modelId}} fields={writingSession.fields} sourceText={writingSession.sourceText} referenceProductIds={writingSession.referenceProductIds} initialTask={writingSession.task} initialLanguage={writingSession.language} tasks={writingSession.selection?['rewrite','summary']:undefined} initialInstruction={writingSession.selection?'润色选中的文字，保留已提供的事实。':undefined} applyNotice={writingSession.notice} onApply={applyWriting} onBusyChange={setAiBusy} onUndoSaved={undoSavedWriting}/>} {publishOpen&&<PublishDialog entryId={draft.id} onClose={()=>setPublishOpen(false)} onPublished={()=>setPublishOpen(false)} onRepair={(target,pageId)=>{setPublishOpen(false);onRepair?.(target,pageId);}}/>}
 </section>;
}
