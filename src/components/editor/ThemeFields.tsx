'use client';
import { useContext, useState } from 'react';
import { Alert, App, Button, Form, Input, InputNumber, Modal, Select, Space } from 'antd';
import { createUsePuck, type Field } from '@puckeditor/core';
import type { SiteTheme, StateStyles, TokenBindings } from '@/lib/types';
import { DESIGN_DEVICES, DESIGN_FIELDS, validateDesign, type DesignKey, type Device, type ResponsiveDesign } from '@/lib/responsive-style';
import { composeDesign, resolveThemeDesign, STATE_STYLE_KEYS } from '@/lib/theme-design';
import { EditorDeviceContext } from './DesignFields';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
const useThemePuck = createUsePuck();
const labels: Partial<Record<DesignKey, string>> = {position:'定位方式',top:'距上',right:'距右',bottom:'距下',left:'距左',zIndex:'层叠顺序',translateX:'横向位移',translateY:'纵向位移',overflow:'溢出处理', color: '文字颜色', backgroundColor: '背景颜色', fontSize: '字号', fontFamily: '字体风格', fontWeight: '字重', lineHeight: '行高', maxWidth: '最大宽度', width: '宽度', height: '高度', gap: '间距', borderRadius: '圆角', borderColor: '边框颜色', borderWidth: '边框宽度', paddingTop: '内上', paddingRight: '内右', paddingBottom: '内下', paddingLeft: '内左', marginTop: '外上', marginRight: '外右', marginBottom: '外下', marginLeft: '外左', opacity: '透明度', shadow: '阴影' };
export const designKeyOptions = Object.keys(DESIGN_FIELDS).filter(key => key !== 'backgroundImage').map(key => ({ value: key as DesignKey, label: `${labels[key as DesignKey] || key} · ${key}` }));
const devices = [{ value: 'desktop', label: '桌面' }, { value: 'tablet', label: '平板' }, { value: 'mobile', label: '手机' }];
/** 结构化声明编辑器保留三端差异；只写可通过同一白名单校验的值。 */
export function DesignRows({ value = {}, onChange, keys }: { value?: ResponsiveDesign; onChange: (v: ResponsiveDesign) => void; keys?: DesignKey[] }) {
  const rows = DESIGN_DEVICES.flatMap(device => Object.entries(value[device] || {}).map(([key, entry]) => ({ device, key: key as DesignKey, entry })));
  function set(device: Device, key: DesignKey, next: string | number | undefined) { const result = structuredClone(value); if (next === undefined) { delete result[device]?.[key]; } else result[device] = { ...result[device], [key]: next }; onChange(result); }
  return <Space orientation="vertical" style={{ width: '100%' }}>{rows.map(row => {
    const spec = DESIGN_FIELDS[row.key]; const options = 'options' in spec ? spec.options : undefined;
    return <Space key={`${row.device}-${row.key}`} wrap><Select aria-label="样式断点" value={row.device} options={devices} onChange={device => { if (value[device]?.[row.key] !== undefined) return; const next = structuredClone(value); delete next[row.device]?.[row.key]; next[device] = { ...next[device], [row.key]: row.entry }; onChange(next); }} /><span>{labels[row.key] || row.key}</span>{spec.kind === 'number' ? <InputNumber aria-label={`${row.key}值`} value={typeof row.entry === 'number' ? row.entry : null} min={'min' in spec ? spec.min : 0} max={'max' in spec ? spec.max : 4000} onChange={v => v !== null && set(row.device, row.key, v)} /> : spec.kind === 'enum' ? <Select aria-label={`${row.key}值`} value={row.entry} options={options?.map(v => ({ value: v, label: v }))} onChange={v => set(row.device, row.key, v)} style={{ width: 150 }} /> : <Input aria-label={`${row.key}值`} value={String(row.entry)} onChange={e => set(row.device, row.key, e.target.value)} style={{ width: 150 }} />}<Button danger size="small" onClick={() => set(row.device, row.key, undefined)}>移除</Button></Space>;
  })}<Select<DesignKey> aria-label="添加样式属性" placeholder="添加桌面样式属性" value={undefined} showSearch optionFilterProp="label" style={{ width: '100%' }} options={designKeyOptions.filter(o => (!keys || keys.includes(o.value)) && value.desktop?.[o.value] === undefined)} onChange={key => { const spec = DESIGN_FIELDS[key]; const initial = spec.kind === 'color' ? '#222222' : spec.kind === 'image' ? '' : spec.kind === 'enum' ? spec.options?.[0] || 'inherit' : 'min' in spec ? spec.min : 0; set('desktop', key, initial); }} /></Space>;
}
export function TokenRows({ theme, value = {}, onChange }: { theme: SiteTheme; value?: TokenBindings; onChange: (v: TokenBindings) => void }) {
  const rows = DESIGN_DEVICES.flatMap(device => Object.entries(value[device] || {}).map(([key, id]) => ({ device, key: key as DesignKey, id })));
  const { device } = useContext(EditorDeviceContext);
  return <Space orientation="vertical" style={{ width: '100%' }}>{rows.map(row => <Space key={`${row.device}-${row.key}`} wrap><span>{row.device} · {labels[row.key] || row.key}</span><Select aria-label={`${row.key}令牌`} value={row.id} style={{ minWidth: 130 }} options={theme.tokens?.filter(t => !validateDesign({ desktop: { [row.key]: t.value } }).length).map(t => ({ value: t.id, label: t.name }))} onChange={id => onChange({ ...value, [row.device]: { ...value[row.device], [row.key]: id } })} /><Button size="small" danger onClick={() => { const next = structuredClone(value); delete next[row.device]?.[row.key]; onChange(next); }}>解除</Button></Space>)}<Select<DesignKey> aria-label="绑定令牌属性" placeholder={`为${device}属性绑定令牌`} value={undefined} showSearch optionFilterProp="label" style={{ width: '100%' }} options={designKeyOptions.filter(o => theme.tokens?.some(t => !validateDesign({ desktop: { [o.value]: t.value } }).length))} onChange={key => { const token = theme.tokens?.find(t => !validateDesign({ desktop: { [key]: t.value } }).length); if (token) onChange({ ...value, [device]: { ...value[device], [key]: token.id } }); }} /></Space>;
}
export function StateRows({ value = {}, onChange }: { value?: StateStyles; onChange: (v: StateStyles) => void }) {
  return <Space orientation="vertical" style={{ width: '100%' }}>{(['hover', 'focus', 'active'] as const).map(state => <Form.Item layout="vertical" colon={false} key={state} label={{ hover: '鼠标悬停', focus: '键盘焦点', active: '按下' }[state]} style={{ width: '100%' }}><DesignRows keys={STATE_STYLE_KEYS} value={value[state]} onChange={design => onChange({ ...value, [state]: design })} /></Form.Item>)}</Space>;
}
function PresetField({ value, onChange, theme }: { value?: string; onChange: (v: string) => void; theme: SiteTheme }) {
  const { selectedItem, appState, dispatch, getSelectorForId } = useThemePuck(s => s);
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const [creating, setCreating] = useState(false), [name, setName] = useState('新的复用样式'), [busy, setBusy] = useState(false);
  const props = selectedItem?.props || appState.data.root.props;
  async function create() {
    const preset = { id: `style-${crypto.randomUUID()}`, name: name.trim(), design: resolveThemeDesign(theme, props), stateStyles: mergeStates(theme.presets?.find(p => p.id === value)?.stateStyles, props.stateStyles) };
    if (!preset.name) return;
    setBusy(true);
    try {
      await runtime.mutate(env => request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { theme: { ...env.state.theme, presets: [...(env.state.theme.presets || []), preset] } } }) }));
      // 定义先保存成功，才在画布建立引用；不先写入缺失资源的临时草稿。
      replace({ ...props, design: {}, tokenBindings: {}, stateStyles: {}, stylePresetId: preset.id }); setCreating(false);
    } catch (e) { message.error((e as Error).message); } finally { setBusy(false); }
  }
  function replace(next: typeof props) {
    const selector = selectedItem && getSelectorForId(selectedItem.props.id);
    if (selector && selectedItem) dispatch({ type: 'replace', destinationIndex: selector.index, destinationZone: selector.zone, data: { ...selectedItem, props: next } });
    else dispatch({ type: 'replaceRoot', root: { ...appState.data.root, props: next } });
  }
  function detach() {
    const next = { ...props, design: resolveThemeDesign(theme, props), stylePresetId: '', tokenBindings: {}, stateStyles: mergeStates(theme.presets?.find(p => p.id === value)?.stateStyles, props.stateStyles) };
    replace(next);
  }
  return <Form.Item layout="vertical" colon={false} label="复用样式"><Select aria-label="复用样式" allowClear value={value || undefined} options={theme.presets?.map(p => ({ value: p.id, label: p.name }))} onChange={v => onChange(v || '')} /><Space wrap><Button size="small" disabled={!value} onClick={detach}>解除为独立样式</Button><Button size="small" onClick={() => setCreating(true)}>保存为复用样式</Button></Space><Alert type="info" title="组件默认 → 复用样式 → 元素令牌 → 元素明确覆盖" description="修改样式库会同步引用元素；清除样式选择会回到原默认，解除则保留当前外观。" /><Modal title="从当前元素创建样式" open={creating} onCancel={() => setCreating(false)} confirmLoading={busy} onOk={create}><Input aria-label="复用样式名称" maxLength={100} value={name} onChange={e => setName(e.target.value)} /><p>当前三端样式和交互状态将保存为资源，并由此元素引用。</p></Modal></Form.Item>;
}
function mergeStates(a?: StateStyles, b?: StateStyles): StateStyles { return Object.fromEntries((['hover', 'focus', 'active'] as const).map(state => [state, composeDesign(a?.[state], b?.[state])])); }
export function presetField(theme: SiteTheme): Field { return { type: 'custom', label: '复用样式', render: ({ value, onChange }) => <PresetField value={value} onChange={onChange} theme={theme} /> }; }
export function tokenField(theme: SiteTheme): Field { return { type: 'custom', label: '令牌绑定', render: ({ value, onChange }) => <Form.Item layout="vertical" colon={false} label="令牌绑定"><TokenRows theme={theme} value={value} onChange={onChange} /></Form.Item> }; }
export function stateField(): Field { return { type: 'custom', label: '交互状态', render: ({ value, onChange }) => <StateRows value={value} onChange={onChange} /> }; }
