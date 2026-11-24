'use client';

import { Collapse, Form, Input, Select, Space, Tag } from 'antd';
import { createUsePuck, type Field } from '@puckeditor/core';
import type { BindingContext, FieldBinding, StudioState } from '@/lib/types';
import { BOUND_COMPONENT_TARGETS, bindingRecordLabel, fieldChoices, recordsForSource, type BindingTarget } from '@/lib/content-binding';
import { FIELD_TYPE_LABELS } from '@/lib/content-models';
import { getSharedBlockUsage, sharedBlockContainsLoop } from '@/lib/shared-blocks';
import {isRelationDefinition,isRelationLoop} from '@/lib/content-relations';

const targetNames: Record<BindingTarget, string> = { text: '文字内容', alt: '图片说明', src: '图片来源', href: '链接地址', images: '整组图片' };
const kindOptions = [{ label: '产品', value: 'product' }, { label: '案例、团队等内容', value: 'entry' }];
function row(label: string, child: React.ReactNode) { return <Form.Item className="editor-property" label={label} layout="vertical">{child}</Form.Item>; }
type BindingDefaults = Pick<FieldBinding, 'source' | 'modelId'>;

/** 绑定只保存模型/字段/记录 ID；解除绑定后重新使用组件原有静态内容。 */
function BindingFields({ type, state, value, onChange, readOnly, defaults }: { type: string; state: StudioState; value?: Record<string, FieldBinding>; onChange: (value: Record<string, FieldBinding>) => void; readOnly?: boolean; defaults?: BindingDefaults }) {
  const bindings = value || {};
  return <div className="editor-binding-fields"><Collapse bordered={false} size="small" items={BOUND_COMPONENT_TARGETS[type].map(target => {
    const current = bindings[target], source = current?.source || defaults?.source || 'product';
    const models = (state.contentModels || []).filter(model => model.target === (source === 'product' ? 'product' : 'content'));
    const model = models.find(item => item.id === current?.modelId);
    const choices = fieldChoices(source, model, target);
    const commit = (next?: FieldBinding) => { const result = { ...bindings }; if (next) result[target] = next; else delete result[target]; onChange(result); };
    const initialize = (nextSource: 'product'|'entry', mode = current?.mode || 'current') => {
      // 详情模板新元素先选本模板的栏目/产品模型；仅用户启用绑定时写入，预览记录不会变成固定记录。
      const preferred = defaults?.source === nextSource ? state.contentModels?.find(model => model.id === defaults.modelId && model.target === (nextSource === 'product' ? 'product' : 'content')) : undefined;
      const nextModel = preferred || (nextSource === 'entry' ? state.contentModels?.find(model => model.target === 'content') : undefined);
      commit({ source: nextSource, mode, ...(nextModel ? { modelId: nextModel.id } : {}), field: fieldChoices(nextSource, nextModel, target)[0]?.value || '', fallback: '' });
    };
    return { key: target, label: <Space size={6}>{targetNames[target]}<Tag color={current ? 'blue' : undefined}>{current ? '动态' : '静态'}</Tag></Space>, children: <>
      {row(`${targetNames[target]}方式`, <Select<'manual'|'current'|'fixed'> aria-label={`${targetNames[target]}方式`} disabled={readOnly} value={current?.mode || 'manual'} options={[{ value: 'manual', label: '使用手动填写的内容' }, { value: 'current', label: '随当前产品或内容自动填写' }, { value: 'fixed', label: '始终显示指定的一条资料' }]} onChange={mode => mode === 'manual' ? commit() : current ? commit({ ...current, mode, ...(mode === 'current' ? { recordId: undefined } : {}) }) : initialize(source, mode)} />)}
      {current && <>
        {row('数据来源', <Select aria-label={`${targetNames[target]}数据来源`} disabled={readOnly} value={source} options={kindOptions} onChange={kind => initialize(kind)} />)}
        {row('资料栏目', <Select aria-label={`${targetNames[target]}内容模型`} disabled={readOnly} value={current.modelId || ''} options={[{ value: '', label: source === 'product' ? '产品基础字段 / 全部产品' : '仅内容标题 / 全部内容' }, ...models.map(model => ({ value: model.id, label: model.name }))]} onChange={modelId => { const model = models.find(item => item.id === modelId); commit({ ...current, modelId: modelId || undefined, recordId: undefined, field: fieldChoices(source, model, target)[0]?.value || '' }); }} />)}
        {current.mode === 'fixed' && row('指定记录', <Select aria-label={`${targetNames[target]}指定记录`} disabled={readOnly} showSearch optionFilterProp="label" placeholder="请选择记录" value={current.recordId || undefined} options={recordsForSource(state, source, current.modelId).map(record => ({ value: record.id, label: bindingRecordLabel(record) }))} onChange={recordId => commit({ ...current, recordId })} />)}
        {row('使用哪个填写项', <Select aria-label={`${targetNames[target]}绑定字段`} disabled={readOnly} showSearch optionFilterProp="label" placeholder="请选择兼容字段" value={current.field || undefined} options={choices.map(field => ({ value: field.value, label: `${field.label} · ${FIELD_TYPE_LABELS[field.type]}` }))} onChange={field => commit({ ...current, field })} />)}
        {target !== 'images' && row('缺值时显示', <Input aria-label={`${targetNames[target]}缺值后备内容`} disabled={readOnly} value={current.fallback || ''} placeholder={target === 'src' ? '素材地址，留空不显示图片' : target === 'href' ? '安全链接地址，留空不可跳转' : '留空则不显示内容'} onChange={event => commit({ ...current, fallback: event.target.value })} />)}
        <p className="design-help">{target === 'images' ? '从对应记录取用整组图片和顺序。请在产品或栏目记录里增删图片，未填写时不会显示画廊。' : current.mode === 'current' ? '详情模板跟随访问的记录；循环卡片跟随每条记录。普通页面需在页面设置中指定默认内容。' : '所选记录和模型需一同进入发布版本。'} 解除绑定可恢复原有静态内容。</p>
      </>}
    </> };
  })} /></div>;
}
export function dynamicBindingField(type: string, state: StudioState, defaults?: BindingDefaults): Field {
  return { type: 'custom', label: '自动填写内容', render: ({ value, onChange, readOnly }) => <BindingFields type={type} state={state} value={value} onChange={onChange} readOnly={readOnly} defaults={defaults} /> };
}

/** 页面根上下文用于普通页面及模板画布；真实产品 URL 始终优先，不改写产品数据。 */
export function bindingContextField(state: StudioState, sampleOnly: boolean | 'template' = false, contentModelId?: string): Field {
  return { type: 'custom', label: contentModelId || sampleOnly === 'template' ? '详情模板预览样本' : sampleOnly ? '区块预览样本' : '页面内容记录', render: ({ value, onChange, readOnly }) => {
    const current = value as BindingContext | undefined;
    const source = contentModelId ? 'entry' : current?.source;
    return <div className="editor-binding-context">{!contentModelId && row('页面内容来源', <Select aria-label="页面内容来源" disabled={readOnly} value={source || 'none'} options={[{ value: 'none', label: '不设置默认记录' }, ...kindOptions]} onChange={source => onChange(source === 'none' ? {} : { source, recordId: '' })} />)}
      {source && row(contentModelId ? '预览内容记录' : '页面默认记录', <Select aria-label="页面默认记录" disabled={readOnly} showSearch optionFilterProp="label" placeholder="选择记录" value={current?.recordId || undefined} options={recordsForSource(state, source, contentModelId).map(record => ({ value: record.id, label: `${bindingRecordLabel(record)}${record.modelId ? ` · ${state.contentModels?.find(model => model.id === record.modelId)?.name || '内容模型'}` : ''}` }))} onChange={recordId => { const record = recordsForSource(state, source).find(record => record.id === recordId); onChange({ source, recordId, ...(record?.modelId ? { modelId: record.modelId } : {}) }); }} />)}
      <p className="design-help">{contentModelId || sampleOnly === 'template' ? '样本只用于编辑预览；正式详情页自动使用 URL 对应的内容，样本无需同时发布。' : sampleOnly ? '此记录仅用于区块画布预览；区块插入页面后，继承所在页面或循环列表的当前记录。' : '当前记录绑定使用这里的内容。产品详情模板的正式 URL 优先采用访问的产品；固定的默认记录需进入发布版本。'}</p>
    </div>;
  } };
}

const useBindingPuck = createUsePuck();
function ContentListFields({ state, readOnly }: { state: StudioState; readOnly?: boolean }) {
  const { selectedItem, dispatch, getSelectorForId } = useBindingPuck(store => store);
  const props = selectedItem?.props || {};
  const source: 'product'|'entry' = props.source === 'entry' ? 'entry' : 'product';
  const models = (state.contentModels || []).filter(model => model.target === (source === 'product' ? 'product' : 'content'));
  const model = models.find(model => model.id === props.modelId);
  const patch = (values: Record<string, unknown>) => {
    const selector = selectedItem && getSelectorForId(selectedItem.props.id);
    if (selector && selectedItem) dispatch({ type: 'replace', destinationIndex: selector.index, destinationZone: selector.zone, data: { ...selectedItem, props: { ...selectedItem.props, ...values } } });
  };
  const selectSource = (kind: 'product'|'entry', modelId = '') => {
    const model = state.contentModels?.find(item => item.id === modelId);
    patch({ source: kind, modelId, titleField: kind === 'product' ? 'builtin:name' : 'builtin:title', descriptionField: kind === 'product' ? 'builtin:description' : '', imageField: fieldChoices(kind, model, 'src')[0]?.value || '', linkField: kind === 'product' ? 'builtin:url' : fieldChoices(kind, model, 'href')[0]?.value || '' });
  };
  return <div className="editor-list-bindings">
    {row('列表数据来源', <Select aria-label="列表数据来源" disabled={readOnly} value={source} options={kindOptions} onChange={kind => selectSource(kind)} />)}
    {row('列表内容模型', <Select aria-label="列表内容模型" disabled={readOnly} value={props.modelId || ''} options={[{ value: '', label: source === 'product' ? '全部产品 / 基础字段' : '请选择内容模型' }, ...models.map(item => ({ value: item.id, label: item.name }))]} onChange={id => selectSource(source, id)} />)}
    {([['titleField','列表标题字段','text'],['descriptionField','列表说明字段','text'],['imageField','列表图片字段','src'],['linkField','列表链接字段','href']] as const).map(([key,label,target]) => <div key={key}>{row(label, <Select aria-label={label} disabled={readOnly} value={props[key] || ''} options={[{ value: '', label: key === 'titleField' ? '请选择标题字段' : '不显示' }, ...fieldChoices(source, model, target).map(field => ({ value: field.value, label: `${field.label} · ${FIELD_TYPE_LABELS[field.type]}` }))]} onChange={value => patch({ [key]: value })} />)}</div>)}
    <p className="design-help">列表按当前快照顺序显示。模型关联详情模板后，可绑定“内容详情链接”自动跳转。</p>
  </div>;
}
/** source 属性面板批量更新关联映射，避免切换模型的中间状态保存成错误字段引用。 */
export function contentListSourceField(state: StudioState): Field {
  return { type: 'custom', label: '内容模型与字段映射', render: ({ readOnly }) => <ContentListFields state={state} readOnly={readOnly} /> };
}

/** 循环只保存数据来源和卡片引用；卡片内部的拖拽设计仍复用同步区块画布。 */
function ContentLoopFields({ state, editingBlockId, readOnly }: { state: StudioState; editingBlockId?: string; readOnly?: boolean }) {
  const { selectedItem, dispatch, getSelectorForId } = useBindingPuck(store => store);
  const props = selectedItem?.props || {}, source = props.source === 'product' ? 'product' : 'entry';
  const models = (state.contentModels || []).filter(model => model.target === (source === 'product' ? 'product' : 'content'));
  const ancestors = editingBlockId ? getSharedBlockUsage(editingBlockId, state).blockIds : [];
  const cards = (state.sharedBlocks || []).filter(block => block.id !== editingBlockId && !ancestors.includes(block.id) && !sharedBlockContainsLoop(block.id, state.sharedBlocks));
  const relationOptions=(state.contentModels||[]).flatMap(model=>model.fields.filter(f=>f.type==='relation'&&isRelationDefinition(f.relation)).map(field=>({value:`${model.id}:${field.id}`,label:`${model.name} / ${field.label}`,model,field})));
  const relation=isRelationLoop(props.relation)?props.relation:undefined;
  const patch = (values: Record<string, unknown>) => {
    const selector = selectedItem && getSelectorForId(selectedItem.props.id);
    if (selector && selectedItem) dispatch({ type: 'replace', destinationIndex: selector.index, destinationZone: selector.zone, data: { ...selectedItem, props: { ...selectedItem.props, ...values } } });
  };
  return <div className="editor-loop-bindings">
    {row('记录范围',<Select aria-label="循环记录范围" disabled={readOnly} value={relation?`${relation.modelId}:${relation.fieldId}`:''} options={[{value:'',label:'普通内容集合'},...relationOptions]} onChange={value=>{const selected=relationOptions.find(o=>o.value===value);patch(selected?{relation:{source:selected.model.target==='product'?'product':'entry',modelId:selected.model.id,fieldId:selected.field.id},source:selected.field.relation!.source,modelId:selected.field.relation!.modelId||'',itemBlockId:selected.field.relation!.source===source&&(selected.field.relation!.modelId||'')===(props.modelId||'')?props.itemBlockId:'',query:undefined}:{relation:undefined,query:undefined});}}/>)}
    {row('循环数据来源', <Select aria-label="循环数据来源" disabled={readOnly||!!relation} value={source} options={kindOptions} onChange={source => patch({ source, modelId: '', itemBlockId: '', query: undefined })} />)}
    {row('循环内容模型', <Select aria-label="循环内容模型" disabled={readOnly||!!relation} value={props.modelId || ''} options={[{ value: '', label: source === 'product' ? '全部产品 / 基础字段' : '请选择内容模型' }, ...models.map(model => ({ value: model.id, label: model.name }))]} onChange={modelId => patch({ modelId, itemBlockId: '', query: undefined })} />)}
    {relation&&<p className="design-help">只展示当前记录所选关联，按选择顺序排列；空关系使用下方空状态。页面需提供匹配模型的当前记录。</p>}
    {row('卡片设计模板', <Select aria-label="卡片设计模板" disabled={readOnly} value={props.itemBlockId || ''} showSearch optionFilterProp="label" options={[{ value: '', label: '请选择或创建卡片模板' }, ...cards.map(block => ({ value: block.id, label: block.name }))]} onChange={itemBlockId => patch({ itemBlockId })} />)}
    <p className="design-help">在属性面板顶部新建或编辑卡片。卡片内可拖拽任意基础元素、容器与同步区块，动态字段绑定到“当前记录”；不支持卡片内再次循环。</p>
  </div>;
}
export function contentLoopSourceField(state: StudioState, editingBlockId?: string): Field {
  return { type: 'custom', label: '循环来源与卡片模板', render: ({ readOnly }) => <ContentLoopFields state={state} editingBlockId={editingBlockId} readOnly={readOnly} /> };
}
