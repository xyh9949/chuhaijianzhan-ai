'use client';
import { readFreshStudio } from '@/lib/refresh-studio';
import { useEffect,useState } from 'react';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import { readLocalRecovery,localRecoveries,clearLocalRecovery } from '@/lib/local-recovery';

import { Alert, App, Button, Card, Flex, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag } from 'antd';
import { createUsePuck, type Field } from '@puckeditor/core';
import type { FormDefinition, FormFieldDefinition } from '@/lib/types';
import { createFormDefinition, formContentErrors, FORM_FIELD_TYPES } from '@/lib/form-content';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { getSharedBlockUsage } from '@/lib/shared-blocks';

const fieldLabels: Record<string, string> = { text: '单行文字', textarea: '多行留言', email: '电子邮箱', phone: '电话号码', select: '下拉选择', checkbox: '复选确认', country: '国家 / 地区', product: '关联产品' };
const mappings = [{ value: 'name', label: '联系人', types: ['text'] }, { value: 'company', label: '公司', types: ['text'] }, { value: 'email', label: '联系邮箱', types: ['email'] }, { value: 'phone', label: '电话', types: ['phone'] }, { value: 'country', label: '国家 / 地区', types: ['country', 'text', 'select'] }, { value: 'product', label: '咨询产品', types: ['product'] }, { value: 'message', label: '客户留言', types: ['text', 'textarea'] }];
const useFormPuck = createUsePuck();
function lengthLimit(type: string) { return type === 'textarea' ? 10000 : type === 'email' ? 254 : type === 'phone' ? 40 : type === 'country' ? 100 : 2000; }

type FormRecovery={definition:FormDefinition;existing:boolean;baseRevision:number};
const formScope=(id:string)=>`form-definition:${id}`;
function validFormRecovery(value:unknown){
 const v=value as FormRecovery|undefined,d=v?.definition;
 // 恢复检查结构而不强制业务必填，空名称/未完成字段也必须能恢复到编辑器。
 return !!v&&typeof v.existing==='boolean'&&Number.isSafeInteger(v.baseRevision)&&!!d&&typeof d.id==='string'&&d.id.length<=100&&typeof d.name==='string'&&d.name.length<=120&&typeof d.enabled==='boolean'&&typeof d.submitLabel==='string'&&d.submitLabel.length<=80&&typeof d.successMessage==='string'&&d.successMessage.length<=500&&Array.isArray(d.fields)&&d.fields.length<=32&&d.fields.every(f=>f&&typeof f.id==='string'&&f.id.length<=100&&typeof f.label==='string'&&f.label.length<=200&&FORM_FIELD_TYPES.includes(f.type)&&typeof f.required==='boolean'&&(f.maxLength===undefined||typeof f.maxLength==='number')&&(f.options===undefined||Array.isArray(f.options)&&f.options.length<=100&&f.options.every(o=>o&&typeof o.id==='string'&&o.id.length<=100&&typeof o.label==='string'&&o.label.length<=200)));
}
function pendingForm(actorId:string){return localRecoveries(actorId).filter(r=>r.scope.startsWith('form-definition:')).map(r=>readLocalRecovery<FormRecovery>(actorId,r.scope,validFormRecovery)).find(Boolean);}
/** 标签和排序可以改，字段ID保持稳定；既有询盘保存提交时的字段标签、类型和答案。 */
function FormEditorDialog({ initial, existing, onClose, onSaved }: { initial: FormDefinition; existing: boolean; onClose: () => void; onSaved?: (id: string) => void }) {
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const [recovered]=useState(()=>readLocalRecovery<FormRecovery>(runtime.actor.id,formScope(initial.id),validFormRecovery));
  const [draft,setDraft]=useState(()=>structuredClone(recovered?.snapshot.definition||initial)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [baseRevision,setBaseRevision]=useState(recovered?.snapshot.baseRevision??runtime.getEnvelope().revision),[recoveredDirty,setRecoveredDirty]=useState(!!recovered);
  const dirty=recoveredDirty||JSON.stringify(draft)!==JSON.stringify(initial);
  async function refresh(){try{const env=await readFreshStudio(runtime);setBaseRevision(env.revision);setError('');message.info('已读取最新工作区；输入保留，请核对表单定义后再保存。');}catch(e){setError((e as Error).message);}}

  const patchField = (id: string, patch: Partial<FormFieldDefinition>) => setDraft(prev => ({ ...prev, fields: prev.fields.map(f => f.id === id ? { ...f, ...patch } : f) }));
  function moveField(index: number, delta: number) { setDraft(prev => { const fields = [...prev.fields]; [fields[index], fields[index + delta]] = [fields[index + delta], fields[index]]; return { ...prev, fields }; }); }
  async function save() {
    setBusy(true);setError('');
    try {
      const found=runtime.getEnvelope().state.forms?.find(f=>f.id===draft.id);if(found&&JSON.stringify(found)===JSON.stringify(draft)){clearLocalRecovery(runtime.actor.id,formScope(draft.id));message.success('服务器已有相同表单，恢复输入无需重复保存');onSaved?.(draft.id);onClose();return true;}
      await runtime.mutate(env => {
        if(env.revision!==baseRevision)throw new RequestError(409,'工作区已变化，表单输入保留；请读取最新工作区并核对后重试');
        if(!existing&&env.state.forms?.some(f=>f.id===draft.id))throw new RequestError(409,'此表单标识已经存在，不能作为新表单覆盖；请到资源管理核对已有定义');
        if (existing && !env.state.forms?.some(f => f.id === draft.id)) throw new RequestError(409, '表单已被其他窗口删除，请保留输入并重新创建');
        const forms = [...(env.state.forms || []).filter(f => f.id !== draft.id), draft];
        const errors = formContentErrors({ ...env.state, forms }); if (errors.length) throw new RequestError(422, errors.join('；'));
        return request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { forms } }) });
      });
      clearLocalRecovery(runtime.actor.id,formScope(draft.id));setRecoveredDirty(false);message.success('表单定义已保存为草稿，公开生效需单独勾选发布'); onSaved?.(draft.id); onClose();return true;
    } catch (e) { setError((e as Error).message);return false; } finally { setBusy(false); }
  }
  const guard=useLocalDraftGuard({actorId:runtime.actor.id,scope:formScope(draft.id),screen:'global-design',title:'询盘表单设置',dirty,busy,snapshot:{definition:draft,existing,baseRevision},save:runtime.actor.role==='admin'?save:undefined,discard:onClose});
  return <>{guard.dialog}<Modal title={existing ? '编辑表单定义' : '新建网站表单'} open width={860} onCancel={()=>guard.ask(onClose)} confirmLoading={busy} okButtonProps={{disabled:runtime.actor.role!=='admin'}} onOk={save} okText="保存表单草稿" cancelText="取消">
    {(dirty||!existing)&&<Tag color="gold">当前表单输入尚未保存</Tag>}{recovered&&<Alert type="warning" title="已恢复本账号未保存的表单输入；尚未写入数据库" />}{error&&<Alert type="error" title={error} action={<Button size="small" disabled={busy} onClick={refresh}>读取最新工作区</Button>} />}
    <Alert type="info" showIcon title="定义字段，按页面自由设计外观" description="修改定义会影响所有引用处；旧询盘保持原始答案。收件邮箱和邮件凭据由服务器配置，访客不能指定。" />
    <Form layout="vertical"><Form.Item label="允许多产品询价" htmlFor="website-form-rfq" extra="表单发布后，同语言的产品目录和详情会显示加入询价入口。买家可为每款填写数量和要求。">
      <Switch id="website-form-rfq" aria-label="允许多产品询价" checked={draft.multiProduct === true} onChange={enabled => setDraft(previous => ({ ...previous, multiProduct: enabled || undefined }))} />
    </Form.Item></Form>
    <Form layout="vertical"><Form.Item label="表单名称" htmlFor="website-form-name"><Input id="website-form-name" aria-label="表单名称" maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Form.Item><Form.Item label="允许公开提交"><Switch aria-label="允许公开提交" checked={draft.enabled} onChange={enabled => setDraft({ ...draft, enabled })} /></Form.Item><Form.Item label="提交按钮文字"><Input aria-label="提交按钮文字" maxLength={80} value={draft.submitLabel} onChange={e => setDraft({ ...draft, submitLabel: e.target.value })} /></Form.Item><Form.Item label="接收成功提示"><Input.TextArea aria-label="接收成功提示" maxLength={500} value={draft.successMessage} onChange={e => setDraft({ ...draft, successMessage: e.target.value })} /><p>此提示代表系统已收到提交；不要把它写成邮件已经送达或未经确认的回复时限。</p></Form.Item></Form>
    <Space orientation="vertical" style={{ width: '100%' }}>{draft.fields.map((field, index) => <Card key={field.id} size="small" title={`${index + 1}. ${field.label || '未命名字段'}`} extra={<Space size={0}><Button size="small" aria-label={`上移字段${index + 1}`} disabled={!index} onClick={() => moveField(index, -1)}>↑</Button><Button size="small" aria-label={`下移字段${index + 1}`} disabled={index === draft.fields.length - 1} onClick={() => moveField(index, 1)}>↓</Button><Button danger size="small" onClick={() => setDraft(prev => ({ ...prev, fields: prev.fields.filter(f => f.id !== field.id) }))}>移除</Button></Space>}>
      <Form layout="vertical"><Flex gap={12} wrap><Form.Item label="填写项名称" style={{ flex: '1 1 220px' }}><Input aria-label={`字段${index + 1}名称`} maxLength={200} value={field.label} onChange={e => patchField(field.id, { label: e.target.value })} /></Form.Item><Form.Item label="类型" style={{ flex: '1 1 180px' }}><Select aria-label={`字段${index + 1}类型`} value={field.type} options={FORM_FIELD_TYPES.map(value => ({ value, label: fieldLabels[value] }))} onChange={type => { const allowed = mappings.find(m => m.value === field.mapTo)?.types.includes(type); patchField(field.id, { type, options: type === 'select' ? [{ id: `option-${crypto.randomUUID()}`, label: '新的选项' }] : undefined, mapTo: allowed ? field.mapTo : undefined, maxLength: ['select', 'product', 'checkbox'].includes(type) ? undefined : lengthLimit(type) }); }} /></Form.Item><Form.Item label="必填"><Switch aria-label={`字段${index + 1}必填`} checked={field.required} onChange={required => patchField(field.id, { required })} /></Form.Item></Flex>
      <Flex gap={12} wrap><Form.Item label="输入提示" style={{ flex: '1 1 220px' }}><Input aria-label={`字段${index + 1}提示`} maxLength={300} value={field.placeholder || ''} onChange={e => patchField(field.id, { placeholder: e.target.value })} /></Form.Item>{!['select', 'product', 'checkbox'].includes(field.type) && <Form.Item label="最多字符"><InputNumber aria-label={`字段${index + 1}长度`} min={1} max={lengthLimit(field.type)} value={field.maxLength || lengthLimit(field.type)} onChange={v => v !== null && patchField(field.id, { maxLength: v })} /></Form.Item>}<Form.Item label="这项资料用于哪里" style={{ flex: '1 1 180px' }}><Select aria-label={`字段${index + 1}对应资料`} value={field.mapTo} allowClear placeholder="仅保留为自定义答案" options={mappings.filter(m => m.types.includes(field.type)).map(({ value, label }) => ({ value, label }))} onChange={mapTo => patchField(field.id, { mapTo: mapTo as FormFieldDefinition['mapTo'] })} /></Form.Item></Flex>
      {field.type === 'select' && <Form.Item label="下拉选项"><Space orientation="vertical" style={{ width: '100%' }}>{(field.options || []).map(option => <Space key={option.id} style={{ width: '100%' }}><Input aria-label={`选项${option.label}`} value={option.label} maxLength={200} onChange={e => patchField(field.id, { options: field.options?.map(o => o.id === option.id ? { ...o, label: e.target.value } : o) })} /><Button danger size="small" onClick={() => patchField(field.id, { options: field.options?.filter(o => o.id !== option.id) })}>移除</Button></Space>)}<Button disabled={(field.options?.length || 0) >= 100} onClick={() => patchField(field.id, { options: [...(field.options || []), { id: `option-${crypto.randomUUID()}`, label: '新的选项' }] })}>添加选项</Button></Space></Form.Item>}
      </Form>
    </Card>)}<Button block disabled={draft.fields.length >= 32} onClick={() => setDraft(prev => ({ ...prev, fields: [...prev.fields, { id: `field-${crypto.randomUUID()}`, label: '新的字段', type: 'text', required: false, maxLength: 200 }] }))}>添加字段（{draft.fields.length}/32）</Button></Space>
  </Modal></>;
}
function usedPages(state: ReturnType<ReturnType<typeof useStudioRuntime>['getEnvelope']>['state'], id: string) {
  const contains = (v: unknown): boolean => { if (Array.isArray(v)) return v.some(contains); if (!v || typeof v !== 'object') return false; const obj = v as { type?: string; props?: { formId?: string } }; return obj.type === 'Form' && obj.props?.formId === id || Object.values(obj).some(contains); };
  const ids = new Set(state.pages.filter(p => contains(state.editorData[p.id])).map(p => p.id));
  for (const block of state.sharedBlocks || []) if (contains(block.data)) { const used = getSharedBlockUsage(block.id, state); used.pageIds.forEach(p => ids.add(p)); if (used.layoutSlots.length) state.pages.forEach(p => ids.add(p.id)); }
  return state.pages.filter(p => ids.has(p.id)).map(p => p.title);
}
export default function FormManager() {
  const runtime = useStudioRuntime(), state = runtime.envelope.state, { message } = App.useApp();
  const [editing,setEditing]=useState<{definition:FormDefinition;existing:boolean}|undefined>(()=>pendingForm(runtime.actor.id)?.snapshot);
  useEffect(()=>{const resume=(event:Event)=>{const scope=(event as CustomEvent<{scope?:string}>).detail?.scope;if(scope?.startsWith('form-definition:')){const entry=readLocalRecovery<FormRecovery>(runtime.actor.id,scope,validFormRecovery);if(entry)setEditing(entry.snapshot);}};window.addEventListener('form-studio:recover-local',resume);return()=>window.removeEventListener('form-studio:recover-local',resume);},[runtime.actor.id]);
  const admin = runtime.actor.role === 'admin';
  async function remove(id: string) { try { await runtime.mutate(env => request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { forms: env.state.forms?.filter(f => f.id !== id) || [] } }) })); message.success('未引用表单已从草稿删除，历史版本独立保留'); } catch (e) { message.error((e as Error).message); } }
  return <Space orientation="vertical" style={{ width: '100%' }}><Alert showIcon title="表单定义独立发布，询盘数据独立保存" description="将表单拖入页面后选择这里的定义。网站回退不会删除已收到的询盘或通知任务；停用表单也需要发布后公开生效。" /><Flex justify="end"><Button type="primary" disabled={!admin} onClick={() => setEditing({ definition: createFormDefinition(), existing: false })}>新建表单</Button></Flex><Table<FormDefinition> rowKey="id" scroll={{ x: 720 }} dataSource={state.forms || []} columns={[{ title: '表单', dataIndex: 'name' }, { title: '状态', render: (_, f) => <Tag color={f.enabled ? 'green' : undefined}>{f.enabled ? '允许提交' : '已停用'}</Tag> }, { title: '字段', render: (_, f) => f.fields.length }, { title: '影响页面', render: (_, f) => usedPages(state, f.id).join('、') || '未直接用于页面（仍需检查区块引用）' }, { title: '操作', render: (_, f) => <Space><Button disabled={!admin} onClick={() => setEditing({ definition: f, existing: true })}>编辑</Button><Button disabled={!admin} onClick={() => setEditing({ definition: { ...structuredClone(f), id: `form-${crypto.randomUUID()}`, name: `${f.name} · 副本` }, existing: false })}>复制</Button><Popconfirm title="删除未引用的表单定义？" onConfirm={() => remove(f.id)}><Button disabled={!admin} danger>删除</Button></Popconfirm></Space> }]} />{editing && <FormEditorDialog initial={editing.definition} existing={editing.existing} onClose={() => setEditing(undefined)} />}</Space>;
}
function FormReference({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const runtime = useStudioRuntime(), [editing, setEditing] = useState<{ definition: FormDefinition; existing: boolean }>();
  const form = runtime.envelope.state.forms?.find(f => f.id === value);
  return <Form.Item layout="vertical" colon={false} label="引用网站表单"><Select aria-label="引用网站表单" value={value || undefined} allowClear options={runtime.envelope.state.forms?.map(f => ({ value: f.id, label: `${f.name}${f.enabled ? '' : '（已停用）'}` }))} onChange={v => onChange(v || '')} /><Space wrap><Button size="small" disabled={runtime.actor.role !== 'admin'} onClick={() => setEditing({ definition: createFormDefinition(), existing: false })}>新建表单定义</Button><Button size="small" disabled={!form || runtime.actor.role !== 'admin'} onClick={() => form && setEditing({ definition: form, existing: true })}>编辑定义</Button></Space>{editing && <FormEditorDialog initial={editing.definition} existing={editing.existing} onClose={() => setEditing(undefined)} onSaved={onChange} />}</Form.Item>;
}
export function formReferenceField(): Field { return { type: 'custom', label: '表单定义', render: ({ value, onChange }) => <FormReference value={value} onChange={onChange} /> }; }
export function formWideFieldsField(): Field { return { type: 'custom', label: '整行字段', render: ({ value, onChange }) => <WideFields value={value} onChange={onChange} /> }; }
function WideFields({ value, onChange }: { value?: string[]; onChange: (v?: string[]) => void }) {
  const runtime = useStudioRuntime(), selected = useFormPuck(s => s.selectedItem);
  const fields = runtime.envelope.state.forms?.find(f => f.id === selected?.props.formId)?.fields || [];
  return <Form.Item layout="vertical" colon={false} label="跨整行字段"><Select aria-label="跨整行字段" mode="multiple" value={value ?? fields.filter(f => ['textarea', 'checkbox'].includes(f.type)).map(f => f.id)} options={fields.map(f => ({ value: f.id, label: f.label }))} onChange={onChange} /><Button size="small" onClick={() => onChange(undefined)}>恢复默认（留言/复选跨整行）</Button></Form.Item>;
}
