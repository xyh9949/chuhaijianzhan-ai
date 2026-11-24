import { isLocalImagePath } from './bundled-media';
/** 三档覆盖只保存用户明确设置的字段；删除某项即恢复上一级继承。 */
export type Device = 'desktop' | 'tablet' | 'mobile';
export type DesignFieldRule = { kind: 'number' | 'length' | 'color' | 'image' | 'enum'; min?: number; max?: number; options?: readonly string[]; unit?: string };
const numeric = (min: number, max: number, unit = 'px'): DesignFieldRule => ({ kind: 'number', min, max, unit });
const option = (...options: string[]): DesignFieldRule => ({ kind: 'enum', options });
const length: DesignFieldRule = { kind: 'length', min: 0, max: 4000, options: ['auto'] };
const margin: DesignFieldRule = { ...numeric(-240, 480), options: ['auto'] };
const positions = ['center', 'top', 'bottom', 'left', 'right', 'left top', 'right top', 'left bottom', 'right bottom'];

// 保存校验、属性面板和 CSS 编译共用白名单，不能把客户输入直接拼接成任意 CSS。
export const DESIGN_FIELDS = {
  position:option('flow','relative','absolute','sticky'),top:{...numeric(-240,2400),options:['auto']},right:{...numeric(-240,2400),options:['auto']},bottom:{...numeric(-240,2400),options:['auto']},left:{...numeric(-240,2400),options:['auto']},
  zIndex:numeric(0,20,''),translateX:numeric(-480,480),translateY:numeric(-480,480),overflow:option('visible','hidden','clip','auto'),
  width: length, maxWidth: { ...length, options: ['none'] }, height: length,
  minHeight: length, maxHeight: { ...length, options: ['none'] },
  paddingTop: numeric(0, 480), paddingRight: numeric(0, 480), paddingBottom: numeric(0, 480), paddingLeft: numeric(0, 480),
  marginTop: margin, marginRight: margin, marginBottom: margin, marginLeft: margin,
  gap: numeric(0, 240), display: option('block', 'flex', 'grid', 'none'),
  flexDirection: option('row', 'column', 'row-reverse', 'column-reverse'), flexWrap: option('nowrap', 'wrap', 'wrap-reverse'),
  justifyContent: option('start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'),
  alignItems: option('start', 'center', 'end', 'stretch', 'baseline'),
  contentPosition: option('start', 'center', 'end'),
  columns: numeric(1, 12, ''), columnSpan: numeric(1, 12, ''), rowSpan: numeric(1, 12, ''), order: numeric(-100, 100, ''),
  fontSize: numeric(8, 200), fontWeight: numeric(100, 900, ''), lineHeight: numeric(0.8, 3.5, ''), letterSpacing: numeric(-10, 30),
  textAlign: option('left', 'center', 'right', 'justify'), fontFamily: option('inherit', 'sans', 'serif', 'mono'),
  color: { kind: 'color' }, backgroundColor: { kind: 'color' }, backgroundImage: { kind: 'image' },
  backgroundSize: option('cover', 'contain', 'auto'), backgroundPosition: option(...positions),
  borderWidth: numeric(0, 24), borderStyle: option('none', 'solid', 'dashed', 'dotted'), borderColor: { kind: 'color' }, borderRadius: numeric(0, 240),
  opacity: numeric(0, 1, ''), shadow: option('none', 'soft', 'medium', 'strong'),
  objectFit: option('cover', 'contain', 'fill', 'scale-down', 'none'), objectPosition: option(...positions), imageHeight: numeric(0, 2400),
} satisfies Record<string, DesignFieldRule>;
export type DesignKey = keyof typeof DESIGN_FIELDS;
export type DesignValues = Partial<Record<DesignKey, string | number>>;
export type ResponsiveDesign = Partial<Record<Device, DesignValues>>;
export const DESIGN_DEVICES: readonly Device[] = ['desktop', 'tablet', 'mobile'];

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function validValue(key: DesignKey, value: unknown): boolean {
  const rule: DesignFieldRule = DESIGN_FIELDS[key];
  if (rule.kind === 'number') return typeof value === 'string' ? Boolean(rule.options?.includes(value)) : typeof value === 'number' && Number.isFinite(value) && value >= rule.min! && value <= rule.max! && (!['columns', 'columnSpan', 'rowSpan', 'order','zIndex'].includes(key) || Number.isInteger(value));
  if (rule.kind === 'length') {
    if (typeof value === 'number') return Number.isFinite(value) && value >= rule.min! && value <= rule.max!;
    if (typeof value !== 'string') return false;
    if (rule.options?.includes(value)) return true;
    const match = /^(\d+(?:\.\d{1,3})?)(px|%|rem)$/.exec(value);
    return Boolean(match && Number(match[1]) <= (match[2] === '%' ? 100 : match[2] === 'rem' ? 250 : rule.max!));
  }
  if (typeof value !== 'string') return false;
  if (rule.kind === 'enum') return Boolean(rule.options?.includes(value));
  if (rule.kind === 'color') return /^(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent|currentColor|inherit)$/.test(value);
  return value === '' || isLocalImagePath(value);
}

/** 返回所有非法位置，服务器可转换为 422；渲染器也使用同一白名单跳过历史脏值。 */
export function validateDesign(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ['响应式样式必须是对象'];
  const errors: string[] = [];
  for (const [device, fields] of Object.entries(value)) {
    if (!DESIGN_DEVICES.includes(device as Device)) { errors.push(`不支持的样式断点：${device}`); continue; }
    if (!isRecord(fields)) { errors.push(`${device} 样式必须是对象`); continue; }
    for (const [key, entry] of Object.entries(fields)) {
      if (!Object.hasOwn(DESIGN_FIELDS, key)) errors.push(`不支持的样式属性：${device}.${key}`);
      else if (!validValue(key as DesignKey, entry)) errors.push(`样式值无效：${device}.${key}`);
    }
  }
  return errors;
}

function cleanValues(value: unknown): DesignValues {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => Object.hasOwn(DESIGN_FIELDS, key) && validValue(key as DesignKey, entry))) as DesignValues;
}

export function resolveDesign(value: unknown, device: Device, base: DesignValues = {}): DesignValues {
  const data = isRecord(value) ? value : {};
  const result = { ...base, ...cleanValues(data.desktop) };
  if (device !== 'desktop') Object.assign(result, cleanValues(data.tablet));
  if (device === 'mobile') Object.assign(result, cleanValues(data.mobile));
  return result;
}

/** 老页面不迁移、不重写；面板显示旧组件在当前断点的真实缺省值，再叠加显式覆盖。 */
export function getLegacyDesign(type: string, props: Record<string, unknown>, device: Device): DesignValues {
  const mobile = device === 'mobile';
  const n = (key: string, fallback: number) => typeof props[key] === 'number' ? props[key] as number : fallback;
  const s = (key: string, fallback: string) => typeof props[key] === 'string' ? props[key] as string : fallback;
  const legacy: DesignValues = { opacity: 1, borderWidth: 0, borderRadius: 0, shadow: 'none', columnSpan: 1, rowSpan: 1, order: 0 };
  if (type === 'Container') Object.assign(legacy, { width: '100%', display: 'grid', columns: props.layout === 'grid' ? n(mobile ? 'mobileColumns' : 'columns', mobile ? 1 : 2) : 1, gap: n('gap', 20), paddingTop: n('padding', 48), paddingBottom: n('padding', 48), paddingLeft: mobile ? 24 : n('inset', 40), paddingRight: mobile ? 24 : n('inset', 40), backgroundColor: s('background', '#f7f5f0'), backgroundImage: s('image', ''), backgroundSize: 'cover', backgroundPosition: mobile && props.image ? 'right' : 'center', minHeight: mobile && props.image ? 470 : n('minHeight', 120), alignItems: 'center', justifyContent: 'start', contentPosition: s('align', 'start') });
  if (type === 'Heading') Object.assign(legacy, { fontSize: n(mobile ? 'mobileSize' : 'size', mobile ? 34 : 44), color: s('color', '#222a25'), textAlign: s('align', 'left'), fontFamily: props.style === 'serif' ? 'serif' : 'inherit', fontWeight: 400, lineHeight: 1.06, letterSpacing: mobile ? -1 : -1.8, marginBottom: n('spacing', 0), maxWidth: 900 });
  if (type === 'Text') Object.assign(legacy, { fontSize: mobile ? 14 : n('size', 15), color: s('color', '#657067'), textAlign: s('align', 'left'), maxWidth: n('maxWidth', 500), fontWeight: 400, lineHeight: 1.8, letterSpacing: 0.04 });
  if (type === 'Image') Object.assign(legacy, { width: '100%', height: mobile ? Math.min(n('height', 360), 400) : n('height', 360), objectFit: s('fit', 'cover'), objectPosition: 'center', borderRadius: n('radius', 0) });
  if (['ActionButton', 'Download'].includes(type)) Object.assign(legacy, { textAlign: s('align', 'left'), fontSize: 12, fontWeight: 500, height: 44, paddingLeft: 22, paddingRight: 22 });
  if (['ProductList', 'ContentList'].includes(type)) Object.assign(legacy, { display: 'grid', columns: n(mobile ? 'mobileColumns' : 'columns', mobile ? 1 : 3), gap: 23, paddingTop: n('padding', 64), paddingBottom: n('padding', 64), paddingLeft: mobile ? 24 : 48, paddingRight: mobile ? 24 : 48 });
  if (type === 'ContentLoop') Object.assign(legacy, { display: 'grid', columns: n(mobile ? 'mobileColumns' : 'columns', mobile ? 1 : 3), gap: n('gap', 24), paddingTop: n('padding', 48), paddingBottom: n('padding', 48), paddingLeft: mobile ? 24 : 48, paddingRight: mobile ? 24 : 48 });
  if (type === 'ProductDetail') Object.assign(legacy, { display: 'grid', columns: mobile || props.layout === 'stacked' ? 1 : 2, gap: mobile ? 30 : 64, paddingTop: n('padding', 64), paddingBottom: n('padding', 64), paddingLeft: mobile ? 24 : 48, paddingRight: mobile ? 24 : 48, imageHeight: mobile ? 360 : n('imageHeight', 550), objectFit: 'cover', objectPosition: 'center' });
  if (type === 'Spacer') Object.assign(legacy, { height: n('height', 40), paddingLeft: 40, paddingRight: 40 });
  if (type === 'Form') Object.assign(legacy, { display: 'grid', columns: 1, gap: 24, maxWidth: 680 });
  if (type === 'Root') Object.assign(legacy, { backgroundColor: 'transparent', fontFamily: 'inherit', fontSize: 16, lineHeight: 1.5, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 });
  return legacy;
}

/** ID 只转为固定字母数字类名，避免把组件名称或用户文本写进 CSS 选择器。 */
export function designClassName(id: string): string {
  return `fs-design-${Array.from(String(id)).map((char) => char.codePointAt(0)!.toString(16)).join('-') || 'root'}`;
}
const fontFamilies: Record<string, string> = { inherit: 'inherit', sans: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', serif: 'Georgia,"Times New Roman",serif', mono: '"SFMono-Regular",Consolas,monospace' };
const shadows: Record<string, string> = { none: 'none', soft: '0 4px 16px #18283c0d', medium: '0 10px 30px #18283c1a', strong: '0 18px 50px #18283c2b' };
const layoutKeys = new Set(['display', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'gap', 'columns']);
const buttonSurfaceKeys = new Set(['width', 'maxWidth', 'height', 'minHeight', 'maxHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'borderWidth', 'borderStyle', 'borderColor', 'borderRadius', 'shadow', 'opacity']);
const camelToCss = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function declarations(key: DesignKey, value: string | number): string {
  const rule: DesignFieldRule = DESIGN_FIELDS[key];
  let property = camelToCss(key); let formatted = String(value);
  if (typeof value === 'number' && (rule.kind === 'number' && rule.unit === 'px' || rule.kind === 'length')) formatted += 'px';
  if (key === 'position'&&value==='flow')formatted='static';
  if(key==='translateX'||key==='translateY')return `--fs-shift-${key==='translateX'?'x':'y'}:${formatted}!important;translate:var(--fs-shift-x,0px) var(--fs-shift-y,0px)!important;`;
  if (key === 'columns') { property = 'grid-template-columns'; formatted = `repeat(${value},minmax(0,1fr))`; }
  if (key === 'columnSpan') { property = 'grid-column'; formatted = `span ${value}`; }
  if (key === 'rowSpan') { property = 'grid-row'; formatted = `span ${value}`; }
  if (key === 'fontFamily') formatted = fontFamilies[String(value)];
  if (key === 'contentPosition') property = 'justify-content';
  if (key === 'shadow') { property = 'box-shadow'; formatted = shadows[String(value)]; }
  if (key === 'backgroundImage') formatted = value ? `url("${value}")` : 'none';
  // 显式覆盖必须高于旧组件内联样式和手机缺省值，未覆盖属性仍完全沿用旧页面。
  return `${property}:${formatted}!important;`;
}

function cssForValues(selector: string, values: DesignValues, type: string, inherited: DesignValues): string {
  const rules = new Map<string, string>();
  const append = (target: string, entry: string) => rules.set(target, (rules.get(target) || '') + entry);
  for (const [name, value] of Object.entries(values)) {
    const key = name as DesignKey;
    let target = selector;
    if (type === 'Form' && layoutKeys.has(key) && !(key === 'display' && value === 'none')) target += ' .site-contact-fields';
    if (type === 'Form' && ['fontSize', 'fontFamily', 'fontWeight', 'letterSpacing', 'lineHeight', 'color'].includes(key)) target += ' :where(label,input,textarea,select,.ant-select,.ant-btn)';
    if (type === 'Container' && layoutKeys.has(key) && !(key === 'display' && value === 'none')) target += '>.editor-site-slot';
    if (['ProductList', 'ContentList'].includes(type) && layoutKeys.has(key) && !(key === 'display' && value === 'none')) target += '>.editor-site-product-grid';
    // 列表布局只作用于卡片网格，不覆盖卡片内部自由设计的容器排版。
    if (type === 'ContentLoop' && layoutKeys.has(key) && !(key === 'display' && value === 'none')) target += '>.editor-site-loop-grid';
    if (['ActionButton', 'Download'].includes(type) && buttonSurfaceKeys.has(key)) target += '>.editor-site-action.ant-btn';
    if (type === 'ProductDetail' && ['imageHeight', 'objectFit', 'objectPosition'].includes(key)) target = `${selector}>img,${selector}>.editor-product-gallery .editor-product-gallery-track img`;
    if (['ProductList', 'ContentList', 'ProductDetail'].includes(type) && ['fontSize', 'fontFamily', 'fontWeight', 'letterSpacing', 'lineHeight', 'color'].includes(key)) {
      const descendant = ['ProductList', 'ContentList'].includes(type) ? ['>.editor-site-collection-heading>h2', ' .editor-site-product h3', ' .editor-product-link.ant-btn', ' .editor-site-product p', '>.editor-site-eyebrow'] : ['>.editor-site-detail-copy>h1', '>.editor-site-detail-copy>p', '>.editor-site-detail-copy>dl', '>.editor-site-detail-copy>dl>div', '>.editor-site-detail-copy>small', ' .editor-site-eyebrow'];
      target = descendant.map((suffix) => selector + suffix).join(',');
    }
    append(target,key==='position'&&value==='flow'&&type==='Container'?'position:relative!important;':declarations(key === 'imageHeight' ? 'height' : key, value!));
    // 恢复显式 display 时也恢复曾在更宽断点隐藏的外壳。
    if (key === 'display' && value !== 'none' && ['Container', 'ProductList', 'ContentList', 'ContentLoop', 'Form'].includes(type)) append(selector, `display:${type === 'Container' ? 'flex' : 'block'}!important;`);
    if (key === 'height' && type === 'Image' && inherited.maxHeight === undefined) append(selector, 'max-height:none!important;');
    if (key === 'imageHeight' && type === 'ProductDetail') append(target, 'max-height:none!important;');
    if (key === 'borderWidth' && inherited.borderStyle === undefined) append(target, 'border-style:solid!important;');
    if (key === 'maxWidth' && type === 'Container') append(`${selector}>.editor-site-slot`, declarations(key, value!));
  }
  return [...rules].map(([target, body]) => `${target}{${body}}`).join('');
}

/** 使用站点容器查询，因此画布 iframe、私有预览和发布页面共用相同断点规则。 */
export function compileDesignCss(id: string, design: unknown, type = 'Text', state?: 'hover' | 'focus' | 'active'): string {
  if (!isRecord(design)) return '';
  // 页面根样式使用独立结构选择器，合法的组件 ID="root" 不得覆盖整页。
  const selector = (type === 'Root' ? '.editor-site>.editor-site-page' : `${type === 'FormField' ? '.editor-site .site-contact-form .site-contact-fields' : type === 'FormSubmit' ? '.editor-site .site-contact-form .site-form-actions' : '.editor-site'} .${designClassName(id)}`) + (state ? state === 'focus' ? ':focus-within' : `:${state}` : '');
  const desktop = cssForValues(selector, cleanValues(design.desktop), type, resolveDesign(design, 'desktop'));
  const tablet = cssForValues(selector, cleanValues(design.tablet), type, resolveDesign(design, 'tablet'));
  const mobile = cssForValues(selector, cleanValues(design.mobile), type, resolveDesign(design, 'mobile'));
  return desktop + (tablet ? `@container form-site (max-width:1024px){${tablet}}` : '') + (mobile ? `@container form-site (max-width:700px){${mobile}}` : '');
}

// 根页面不能脱离文档或裁掉整页；其他组件绝对定位必须由显式容器承载。
export const ADVANCED_LAYOUT_KEYS=['position','top','right','bottom','left','zIndex','translateX','translateY','overflow'] as const;
