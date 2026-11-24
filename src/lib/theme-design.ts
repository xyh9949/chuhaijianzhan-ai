import type { SiteTheme, StateStyles, StylePreset, TokenBindings } from './types';
import { DESIGN_DEVICES, DESIGN_FIELDS, compileDesignCss, validateDesign, resolveDesign, type DesignKey, type ResponsiveDesign } from './responsive-style';

type Props = { design?: ResponsiveDesign; stylePresetId?: string; tokenBindings?: TokenBindings; stateStyles?: StateStyles; nodeLabel?: string; locked?: boolean };
type Source = { pageTemplates?: import('./types').PageTemplate[]; theme: SiteTheme; pages?: { id: string; title: string }[]; editorData?: Record<string, unknown>; sharedBlocks?: { id: string; name: string; data: unknown }[] };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const idValid = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const visualKeys = new Set(['translateX','translateY','color', 'backgroundColor', 'borderColor', 'borderWidth', 'borderRadius', 'opacity', 'shadow']);

/** 各来源在每个断点合并，断点继承随后交给原编译器；显式元素值始终优先。 */
export function mergeDesign(...values: (ResponsiveDesign | undefined)[]): ResponsiveDesign {
  const result: ResponsiveDesign = {};
  for (const device of DESIGN_DEVICES) for (const value of values) if (value?.[device]) result[device] = { ...result[device], ...value[device] };
  return result;
}
/** 来源优先于设备覆盖；供页面默认、复用样式及交互状态共用。 */
export function composeDesign(...layers: (ResponsiveDesign | undefined)[]): ResponsiveDesign {
  return Object.fromEntries(DESIGN_DEVICES.map(device => [device, Object.assign({}, ...layers.map(d => resolveDesign(d, device)))]));
}
export function tokenDesign(theme: SiteTheme, bindings?: TokenBindings): ResponsiveDesign {
  const result: ResponsiveDesign = {};
  for (const device of DESIGN_DEVICES) for (const [key, id] of Object.entries(bindings?.[device] || {})) {
    const token = theme.tokens?.find(t => t.id === id);
    if (token && !validateDesign({ [device]: { [key]: token.value } }).length) result[device] = { ...result[device], [key]: token.value };
  }
  return result;
}
export function resolveThemeDesign(theme: SiteTheme, props: Props): ResponsiveDesign {
  const preset = theme.presets?.find(p => p.id === props.stylePresetId);
  const layers = [preset?.design, tokenDesign(theme, preset?.tokenBindings), tokenDesign(theme, props.tokenBindings), props.design];
  // 先继承每一来源的断点，再叠加来源；元素桌面的明确值也高于样式库的手机值。
  return composeDesign(...layers);
}
export function themeNodeCss(theme: SiteTheme, id: string, props: Props, type: string): string {
  const preset = theme.presets?.find(p => p.id === props.stylePresetId);
  let css = compileDesignCss(id, resolveThemeDesign(theme, props), type);
  for (const state of ['hover', 'focus', 'active'] as const) css += compileDesignCss(id, composeDesign(preset?.stateStyles?.[state], props.stateStyles?.[state]), type, state);
  return css;
}
function bindingErrors(theme: SiteTheme, value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!record(value)) return [`${label}令牌绑定必须是对象`];
  const errors: string[] = [];
  for (const [device, fields] of Object.entries(value)) {
    if (!DESIGN_DEVICES.includes(device as never) || !record(fields)) { errors.push(`${label}令牌断点无效`); continue; }
    for (const [key, id] of Object.entries(fields)) {
      const token = theme.tokens?.find(t => t.id === id);
      if (!Object.hasOwn(DESIGN_FIELDS, key) || key === 'backgroundImage' || !token || validateDesign({ [device]: { [key]: token.value } }).length) errors.push(`${label}令牌不可用于 ${device}.${key}（令牌缺失或值不兼容）`);
    }
  }
  return errors;
}
function stateErrors(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!record(value)) return [`${label}交互状态必须是对象`];
  const errors: string[] = [];
  for (const [state, design] of Object.entries(value)) {
    if (!['hover', 'focus', 'active'].includes(state)) errors.push(`${label}交互状态无效`);
    errors.push(...validateDesign(design).map(e => label + e));
    if (record(design)) for (const values of Object.values(design)) if (record(values) && Object.keys(values).some(key => !visualKeys.has(key))) errors.push(`${label}交互状态仅允许颜色、边框、圆角、透明度、阴影和有限位移`);
  }
  return errors;
}
/** 草稿、最终候选与历史激活都检查引用，不能删除仍被页面或其他样式引用的定义。 */
export function themeDesignErrors(source: Source): string[] {
  const theme = source.theme; const errors: string[] = [];
  const checkList = (value: unknown, label: string, max: number) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > max) { errors.push(`${label}最多${max}项`); return; }
    const ids = new Set();
    for (const item of value) if (!record(item) || !idValid(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100) errors.push(`${label}名称或ID无效/重复`); else ids.add(item.id);
  };
  checkList(theme.tokens, '主题令牌', 200); checkList(theme.presets, '复用样式', 200);
  if (errors.length) return errors;
  if (Array.isArray(theme.tokens)) for (const t of theme.tokens) if (!t || !((typeof t.value === 'number' && Number.isFinite(t.value)) || (typeof t.value === 'string' && t.value.length <= 100 && !/[;{}<>]/.test(t.value)))) errors.push('令牌值必须是有限数字或简短样式值');
  if (theme.headingFont !== undefined && !['Georgia', 'Inter', 'system', 'Arial', 'Times New Roman'].includes(theme.headingFont)) errors.push('标题字体无效');
  errors.push(...validateDesign(theme.defaults));
  if (Array.isArray(theme.presets)) for (const p of theme.presets) if (p && record(p)) errors.push(...validateDesign(p.design), ...bindingErrors(theme, p.tokenBindings, String(p.name)), ...stateErrors(p.stateStyles, String(p.name)));
  const walk = (v: unknown, label: string) => {
    if (Array.isArray(v)) { v.forEach(x => walk(x, label)); return; }
    if (!record(v)) return;
    if (record(v.props)) {
      const p = v.props;
      if (p.stylePresetId !== undefined && (typeof p.stylePresetId !== 'string' || p.stylePresetId && !theme.presets?.some(s => s.id === p.stylePresetId))) errors.push(`${label}引用的复用样式不存在`);
      if (p.nodeLabel !== undefined && (typeof p.nodeLabel !== 'string' || p.nodeLabel.length > 100)) errors.push(`${label}图层名称无效`);
      if (p.locked !== undefined && typeof p.locked !== 'boolean') errors.push(`${label}锁定值无效`);
      errors.push(...bindingErrors(theme, p.tokenBindings, label), ...stateErrors(p.stateStyles, label));
    }
    Object.values(v).forEach(x => walk(x, label));
  };
  for (const [id, data] of Object.entries(source.editorData || {})) walk(data, source.pages?.find(p => p.id === id)?.title || id);
  for (const block of source.sharedBlocks || []) walk(block.data, block.name);
  return errors;
}
/** 引用清单用于修改前提示；同步区块影响保守包含全部页面，避免漏报间接引用。 */
export function styleUsage(source: Source, id: string): string[] {
  const uses = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(uses);
    if (!record(value)) return false;
    return value.stylePresetId === id || (record(value.tokenBindings) && Object.values(value.tokenBindings).some(v => record(v) && Object.values(v).includes(id))) || Object.values(value).some(uses);
  };
  const result = (source.pages || []).filter(p => uses(source.editorData?.[p.id])).map(p => p.title);
  for (const t of source.pageTemplates || []) if (uses(t.data)) result.push(`页面模板：${t.name}`);
  for (const b of source.sharedBlocks || []) if (uses(b.data)) result.push(`同步区块：${b.name}（可能影响引用页）`);
  for (const p of source.theme.presets || []) if (uses(p)) result.push(`复用样式：${p.name}`);
  return result;
}
export const STATE_STYLE_KEYS = [...visualKeys] as DesignKey[];
export type { Props as ThemeNodeProps, StylePreset };
