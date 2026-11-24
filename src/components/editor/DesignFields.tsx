'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Alert, Button, Collapse, ColorPicker, Empty, Form, Input, InputNumber, Segmented, Select, Space, Tabs, Tag, Tooltip } from 'antd';
import { DesktopOutlined, MobileOutlined, ReloadOutlined, TabletOutlined } from '@ant-design/icons';
import { createUsePuck, type Field } from '@puckeditor/core';
import { resolveThemeDesign } from '@/lib/theme-design';
import type { SiteTheme, MediaItem } from '@/lib/types';
import { DESIGN_FIELDS, getLegacyDesign, resolveDesign, validateDesign, type DesignFieldRule, type DesignValues, type Device, type ResponsiveDesign } from '@/lib/responsive-style';
import { safeImageSrc } from '@/lib/site-safety';
import { BUNDLED_IMAGES } from '@/lib/bundled-media';
import './design-fields.css';
import MoreSettings from '../MoreSettings';

export const EditorDeviceContext = createContext<{ device: Device; setDevice?: (device: Device) => void }>({ device: 'desktop' });
const useDesignPuck = createUsePuck();
const deviceLabels: Record<Device, string> = { desktop: '桌面', tablet: '平板', mobile: '手机' };
type DesignKey = keyof DesignValues;
const optionLabels: Record<string, string> = {
  flow:'正常文档流',relative:'相对定位',absolute:'容器内绝对定位',sticky:'滚动吸附',visible:'显示溢出',hidden:'裁掉溢出',clip:'裁切',
  block: '普通文档流', flex: '弹性布局', grid: '网格布局', none: '无 / 隐藏', row: '横向', column: '纵向',
  'row-reverse': '横向反序', 'column-reverse': '纵向反序', wrap: '允许换行', nowrap: '不换行', 'wrap-reverse': '反向换行', top: '顶部', bottom: '底部',
  start: '起点', end: '终点', 'flex-start': '起点', 'flex-end': '终点', center: '居中', stretch: '拉伸',
  'space-between': '两端对齐', 'space-around': '均匀留白', 'space-evenly': '等距排列', baseline: '基线',
  left: '左对齐', right: '右对齐', justify: '两端对齐', inherit: '跟随上级', sans: '无衬线', serif: '衬线', mono: '等宽',
  solid: '实线', dashed: '虚线', dotted: '点线', double: '双线', transparent: '透明', cover: '铺满裁切', contain: '完整显示',
  fill: '拉伸填满', 'scale-down': '等比缩小', auto: '自动', soft: '轻柔', medium: '中等', strong: '明显',
  'center center': '中央', 'left center': '左侧', 'right center': '右侧', 'center top': '顶部', 'center bottom': '底部',
  'left top': '左上', 'right top': '右上', 'left bottom': '左下', 'right bottom': '右下',
};

// 图片只使用已上传的素材或随应用交付的栅格图，不把任意输入直接写入草稿。
export function ImageAssetInput({ value, onChange, media, id, readOnly = false }: { value?: string; onChange: (value: string) => void; media: MediaItem[]; id?: string; readOnly?: boolean }) {
  const [input, setInput] = useState(value || '');
  const [error, setError] = useState('');
  useEffect(() => { setInput(value || ''); setError(''); }, [value]);
  const choices = [...media.filter((item) => item.kind === 'image').map((item) => ({ label: item.name, value: item.url })),
    ...BUNDLED_IMAGES.map(({ url, label }) => ({ label, value: url }))];
  function commit() {
    const next = input.trim();
    if (!validateDesign({ desktop: { backgroundImage: next } }).length) { setError(''); if (next !== (value || '')) onChange(next); }
    else setError('请选择素材库图片，或填写有效的站内素材地址。');
  }
  return <div className="design-media-input">
    {value && safeImageSrc(value) && <img src={value} alt="当前素材预览" />}
    <Select id={id} aria-label="从素材库选择图片" value={choices.some((item) => item.value === value) ? value : undefined} placeholder="从素材库选择" showSearch optionFilterProp="label" options={choices} disabled={readOnly} allowClear onChange={(next) => onChange(next || '')} popupMatchSelectWidth={false} />
    <MoreSettings title="手动填写图片地址（高级）" hasErrors={!!error}><Input aria-label="站内图片地址" value={input} placeholder="/api/media/…" disabled={readOnly} onChange={(event) => setInput(event.target.value)} onBlur={commit} onPressEnter={commit} status={error ? 'error' : undefined} />
    {error && <small role="alert" className="design-field-error">{error}</small>}</MoreSettings>
  </div>;
}

export function imageAssetField(label: string, media: MediaItem[]): Field {
  return { type: 'custom', label, render: ({ value, onChange, id, readOnly }) => <Form.Item className="editor-property" label={label} htmlFor={id} layout="vertical"><ImageAssetInput value={value} onChange={onChange} id={id} media={media} readOnly={readOnly} /></Form.Item> };
}

/** 常用内容先显示；数据绑定及复用设置仍挂载，已有配置会主动展开提示。 */
export function groupedEditorFields({ fields }: { fields: Record<string, React.ReactNode> }) {
 return <GroupedEditorFields fields={fields}/>;
}
function GroupedEditorFields({fields}:{fields:Record<string,React.ReactNode>}){
 const props=useDesignPuck(store=>store.selectedItem?.props||store.appState.data.root.props)||{};
 const hidden=['design','content','stylePresetId','tokenBindings','stateStyles','fieldDesign','submitDesign','bindings','bindingContext','query','localeMenuIds','imageSize'];
 const content=Object.entries(fields).filter(([key])=>!hidden.includes(key)).map(([key,field])=><React.Fragment key={key}>{field}</React.Fragment>);
 const automatic=!!Object.keys(props.bindings||{}).length||!!props.bindingContext?.recordId||!!props.bindingContext?.modelId;
 return <Tabs className="design-content-tabs" size="small" key={String(props.id||'root')} items={[
  {key:'content',label:'内容',children:<>
   {content.length?content:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="直接拖入内容，在外观标签中调整排列和大小。"/>}
   {(fields.bindings||fields.bindingContext)&&<MoreSettings title={automatic?'自动内容设置 · 已有配置':'自动显示产品或资料（高级）'} defaultOpen={automatic} description="手动填写文字和图片时可以忽略；制作产品详情、案例模板或循环卡片时使用。">{fields.bindings}{fields.bindingContext}</MoreSettings>}
   {fields.query&&<MoreSettings title="列表筛选与排序（选填）" defaultOpen={!!props.query}>{fields.query}</MoreSettings>}
   {(fields.localeMenuIds||fields.imageSize)&&<MoreSettings title="更多显示设置（选填）">{fields.localeMenuIds}{fields.imageSize}</MoreSettings>}
  </>},
  {key:'design',label:'外观',children:<>{fields.design}{(fields.fieldDesign||fields.submitDesign)&&<Collapse items={[{key:'fields',label:'输入框的外观',children:fields.fieldDesign},{key:'submit',label:'提交按钮的外观',children:fields.submitDesign}]}/>}{(fields.stylePresetId||fields.tokenBindings||fields.stateStyles)&&<MoreSettings title="复用样式与互动效果（高级）" defaultOpen={!!props.stylePresetId||!!Object.keys(props.tokenBindings||{}).length||!!Object.keys(props.stateStyles||{}).length}>{fields.stylePresetId}{fields.tokenBindings}{fields.stateStyles}</MoreSettings>}</>},
 ]}/>;
}

function LengthInput({ value, onChange, id, disabled, keywords = ['auto'] }: { value: unknown; onChange: (value?: string | number) => void; id: string; disabled?: boolean; keywords?: readonly string[] }) {
  const raw = value === undefined ? '' : String(value);
  const unit = raw === 'auto' || raw === 'none' ? raw : raw.endsWith('%') ? '%' : raw.endsWith('rem') ? 'rem' : 'px';
  const numeric = Number.parseFloat(raw);
  return <Space.Compact className="design-length-input"><InputNumber id={id} value={Number.isFinite(numeric) ? numeric : null} placeholder="默认" min={0} max={unit === '%' ? 100 : unit === 'rem' ? 250 : 4000} disabled={disabled || unit === 'auto' || unit === 'none'} onChange={(next) => onChange(next === null ? undefined : unit === '%' || unit === 'rem' ? `${next}${unit}` : next)} /><Select aria-label="尺寸单位" value={unit} disabled={disabled} options={[{ value: 'px', label: '像素' }, { value: '%', label: '%' }, { value: 'rem', label: '相对字号' }, ...keywords.map((keyword) => ({ value: keyword, label: keyword === 'none' ? '不限' : '自动' }))]} onChange={(next) => onChange(next === 'auto' || next === 'none' ? next : next === '%' || next === 'rem' ? `${Math.min(Number.isFinite(numeric) ? numeric : 1, next === '%' ? 100 : 250)}${next}` : Number.isFinite(numeric) ? numeric : 0)} /></Space.Compact>;
}

function ColorInput({ value, onChange, id, disabled }: { value: unknown; onChange: (value?: string) => void; id: string; disabled?: boolean }) {
  const [input, setInput] = useState(String(value || ''));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setInput(String(value || '')); setInvalid(false); }, [value]);
  function commit() { const next = input.trim(); const errors = next ? validateDesign({ desktop: { color: next } }) : []; if (errors.length) setInvalid(true); else { setInvalid(false); onChange(next || undefined); } }
  return <><div className="design-color-input"><ColorPicker disabled={disabled} value={typeof value === 'string' && (value.startsWith('#') || value === 'transparent') ? value : '#ffffff'} onChangeComplete={(next) => onChange(next.toHexString())} /><Input id={id} aria-label="颜色值" value={input} placeholder="继承颜色" disabled={disabled} status={invalid ? 'error' : undefined} onChange={(event) => setInput(event.target.value)} onBlur={commit} onPressEnter={commit} /></div>{invalid && <small className="design-field-error" role="alert">请输入十六进制颜色，或 transparent / inherit。</small>}</>;
}

export function DesignFields({ value, onChange, type, media, id, readOnly, theme }: { theme?: SiteTheme; value?: ResponsiveDesign; onChange: (next: ResponsiveDesign) => void; type: string; media: MediaItem[]; id: string; readOnly?: boolean }) {
  const { device, setDevice } = useContext(EditorDeviceContext);
  const props = useDesignPuck((store) => type === 'Root' ? store.appState.data.root.props : store.selectedItem?.props) || {};
  const design = value || {};
  const own = design[device] || {};
  const resolved = resolveDesign(theme ? resolveThemeDesign(theme, { ...props, design }) : design, device, getLegacyDesign(type, props, device));
  const has = (key: DesignKey) => Object.prototype.hasOwnProperty.call(own, key);
  // 仅更改当前断点；删除键表示恢复继承，保留其他设备和其他字段，避免批量覆盖。
  function change(key: DesignKey, next: unknown) {
    const values = { ...own } as Record<string, unknown>;
    if (next === undefined || next === null) delete values[key]; else values[key] = next;
    const updated = { ...design, [device]: values };
    if (!Object.keys(values).length) delete updated[device];
    if (!validateDesign(updated).length) onChange(updated);
  }
  function inheritedFrom(key: DesignKey) {
    if (has(key)) return device === 'desktop' ? '基础样式' : '独立覆盖';
    if (device === 'mobile' && design.tablet?.[key] !== undefined) return '跟随平板';
    if (device !== 'desktop' && design.desktop?.[key] !== undefined) return '跟随电脑';
    return theme && (props.stylePresetId || props.tokenBindings) ? '跟随全站样式' : '组件默认';
  }
  function field(key: DesignKey, label: string, unit?: string) {
    const spec: DesignFieldRule = DESIGN_FIELDS[key];
    const fieldId = `${id}-${key}`;
    let control: React.ReactNode;
    if (spec.kind === 'number') {
      const numeric = <InputNumber id={fieldId} value={typeof resolved[key] === 'number' ? resolved[key] as number : null} min={spec.min} max={spec.max} step={key === 'opacity' ? 0.05 : key === 'lineHeight' || key === 'letterSpacing' ? 0.1 : 1} precision={['columns', 'columnSpan', 'rowSpan', 'order', 'fontWeight','zIndex'].includes(key) ? 0 : undefined} placeholder={resolved[key] === 'auto' ? '自动' : '默认'} disabled={readOnly || resolved[key] === 'auto'} suffix={unit} onChange={(next) => change(key, next)} />;
      // 外边距的 auto 是明确的 CSS 值，与删除字段恢复继承不同；左右均为 auto 可让限宽容器居中。
      control = spec.options?.includes('auto') ? <Space.Compact className="design-length-input">{numeric}<Select aria-label={`${label}单位`} value={resolved[key] === 'auto' ? 'auto' : 'px'} disabled={readOnly} options={[{ value: 'px', label: '像素' }, { value: 'auto', label: '自动' }]} onChange={(next) => change(key, next === 'auto' ? 'auto' : typeof resolved[key] === 'number' ? resolved[key] : 0)} /></Space.Compact> : numeric;
    }
    else if (spec.kind === 'length') control = <LengthInput id={fieldId} value={resolved[key]} onChange={(next) => change(key, next)} disabled={readOnly} keywords={spec.options} />;
    else if (spec.kind === 'color') control = <ColorInput id={fieldId} value={resolved[key]} onChange={(next) => change(key, next)} disabled={readOnly} />;
    else if (spec.kind === 'image') control = <ImageAssetInput id={fieldId} value={String(resolved[key] || '')} onChange={(next) => change(key, next)} media={media} readOnly={readOnly} />;
    else control = <Select id={fieldId} value={resolved[key]} placeholder="跟随默认" allowClear disabled={readOnly} options={(spec.options || []).map((option) => ({ value: option, label: key === 'display' && option === 'none' ? '隐藏此元素' : optionLabels[option] || option }))} onChange={(next) => change(key, next)} />;
    return <div className={`design-field ${has(key) ? 'design-field-overridden' : ''}`} key={key}><div className="design-field-caption"><label htmlFor={fieldId}>{label}</label><span>{inheritedFrom(key)}</span><Tooltip title="清除此项设置，恢复继承"><Button type="text" size="small" icon={<ReloadOutlined />} aria-label={`重置${label}`} disabled={!has(key) || readOnly} onClick={() => change(key, undefined)} /></Tooltip></div>{control}</div>;
  }
  const isLayout = ['Container', 'ProductList', 'ProductDetail', 'ContentList', 'ContentLoop', 'Form'].includes(type);
  const isText = !['Image', 'Spacer'].includes(type);
  const groups = [
    ...(!['Root','FormField','FormSubmit'].includes(type)?[{key:'position',label:'高级定位与裁切',children:<>{field('position','定位方式')}<div className="design-field-grid">{field('top','距上','px')}{field('right','距右','px')}{field('bottom','距下','px')}{field('left','距左','px')}</div>{field('zIndex','层叠顺序 0–20')}<div className="design-field-grid">{field('translateX','横向位移','px')}{field('translateY','纵向位移','px')}</div>{field('overflow','溢出处理')}{resolved.position==='absolute'&&<Alert type="warning" title="绝对定位不撑高父容器" description={device==='mobile'?'手机仍使用绝对定位。建议改为正常文档流，检查溢出和遮挡。':'放入显式容器并设置足够高度；平板/手机可独立恢复正常文档流。'}/>}<p className="design-help">吸附受最近滚动容器和父容器边界约束，设置距上后使用画布“检查布局”核对。隐藏/裁切不会删除内容。</p></> }]:[]),
    { key: 'layout', label: '布局与位置', children: <>{field('display', '显示与布局')}{isLayout && <><div className="design-field-grid">{field('columns', '网格列数')}{field('gap', '元素间距', 'px')}</div>{field('flexDirection', '排列方向')}{field('flexWrap', '自动换行')}{field('justifyContent', '沿排列方向对齐')}{field('alignItems', '另一方向对齐')}</>}{type === 'Container' && <>{field('contentPosition', '整组垂直位置')}<p className="design-help">设置高度或最小高度后，可将整组内容放在容器顶部、中央或底部。</p></>}{type !== 'Root' && <><div className="design-field-grid">{field('columnSpan', '跨列数量')}{field('rowSpan', '跨行数量')}</div>{field('order', '排列顺序')}<p className="design-help">跨列用于父容器的网格布局；顺序数值越小越靠前。隐藏后可从图层重新选中。</p></>}</> },
    { key: 'size', label: '尺寸', children: <><div className="design-field-grid design-compound-grid">{field('width', '宽度')}{field('maxWidth', '最大宽度')}{field('height', '高度')}{field('minHeight', '最小高度')}</div>{field('maxHeight', '最大高度')}</> },
    { key: 'spacing', label: '内容留白与间距', children: <><div className="design-spacing-label">组件内部留白（像素）</div><div className="design-field-grid">{field('paddingTop', '内上')}{field('paddingRight', '内右')}{field('paddingBottom', '内下')}{field('paddingLeft', '内左')}</div><div className="design-spacing-label">与周围内容的距离（像素 / 自动）</div><div className="design-field-grid design-compound-grid">{field('marginTop', '外上')}{field('marginRight', '外右')}{field('marginBottom', '外下')}{field('marginLeft', '外左')}</div><p className="design-help">设置最大宽度，并将左右外边距设为“自动”，可让区块水平居中。</p></> },
    ...(isText ? [{ key: 'typography', label: '字体与文字', children: <>{['ProductList', 'ContentList', 'ProductDetail'].includes(type) && <p className="design-help">统一调整此区块内的文字；精细组合排版可使用独立标题和正文元素。</p>}{type === 'Root' && <p className="design-help">页面字体作为默认值；组件已单独设置的样式仍然优先。</p>}{field('fontFamily', '字体风格')}<div className="design-field-grid">{field('fontSize', '字号', 'px')}{field('fontWeight', '文字粗细')}{field('lineHeight', '行高倍数')}{field('letterSpacing', '字间距', 'px')}</div>{field('textAlign', '文字对齐')}{field('color', '文字颜色')}</> }] : []),
    { key: 'appearance', label: '背景与外观', children: <>{field('backgroundColor', '背景颜色')}{field('backgroundImage', '背景图片')}{field('backgroundSize', '背景显示')}{field('backgroundPosition', '背景焦点')}<div className="design-field-grid">{field('borderWidth', '边框宽度', 'px')}{field('borderRadius', '圆角', 'px')}</div>{field('borderStyle', '边框线型')}{field('borderColor', '边框颜色')}{field('shadow', '阴影')}{field('opacity', '不透明度')}</> },
    ...(['Image', 'ProductDetail'].includes(type) ? [{ key: 'image', label: '图片显示', children: <>{type === 'ProductDetail' && field('imageHeight', '产品主图高度', 'px')}{field('objectFit', '图片裁切方式')}{field('objectPosition', '图片焦点')}</> }] : []),
  ];
  return <div className="design-fields" data-design-device={device} key={String(props.id || 'root')}>
    <div className="design-device-card"><div className="design-device-title"><strong>{deviceLabels[device]}样式</strong><Tag color={Object.keys(own).length ? 'blue' : undefined}>{Object.keys(own).length ? `${Object.keys(own).length} 项设置` : '使用默认设置'}</Tag></div>
      <Segmented block size="small" value={device} onChange={(next) => setDevice?.(next as Device)} disabled={!setDevice} options={[{ value: 'desktop', label: '桌面', icon: <DesktopOutlined /> }, { value: 'tablet', label: '平板', icon: <TabletOutlined /> }, { value: 'mobile', label: '手机', icon: <MobileOutlined /> }]} />
      <p>电脑是基础外观；平板和手机只需调整不同之处。文字和图片在各设备共用。</p>
      <Button size="small" type="text" icon={<ReloadOutlined />} disabled={!Object.keys(own).length || readOnly} onClick={() => { const next = { ...design }; delete next[device]; onChange(next); }}>重置{deviceLabels[device]}全部设置</Button>
    </div>
    <Collapse bordered={false} className="design-groups" defaultActiveKey={isLayout ? ['layout'] : type === 'Image' ? ['size', 'image'] : ['typography']} items={groups} />
  </div>;
}

export function responsiveDesignField(type: string, media: MediaItem[], theme?: SiteTheme): Field {
  return { type: 'custom', label: '电脑和手机的外观', render: ({ value, onChange, id, readOnly }) => <DesignFields theme={theme} type={type} value={value} onChange={onChange} media={media} id={id} readOnly={readOnly} /> };
}
