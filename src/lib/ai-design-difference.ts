import type { ComponentData, Data } from '@puckeditor/core';
import { componentSlots } from './editor-slots';
import { DESIGN_DEVICES, getLegacyDesign, resolveDesign, type DesignKey } from './responsive-style';

export interface AiDesignDifference {
  structureChanged: boolean; layoutChanged: boolean; typographyChanged: boolean; colorsChanged: boolean; copyChanged: boolean;
  similarPages: { pageId: string; title: string; reason: string }[]; warnings: string[];
}
const LAYOUT: DesignKey[] = ['position','top','right','bottom','left','zIndex','translateX','translateY','overflow','width','maxWidth','height','minHeight','maxHeight','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','gap','display','flexDirection','flexWrap','justifyContent','alignItems','contentPosition','columns','columnSpan','rowSpan','order','borderWidth','borderStyle','borderRadius','shadow','opacity','objectFit','objectPosition','imageHeight'];
const TYPOGRAPHY: DesignKey[] = ['fontSize','fontWeight','lineHeight','letterSpacing','textAlign','fontFamily'];
const COLORS: DesignKey[] = ['color','backgroundColor','borderColor'];
const COPY_KEYS = ['text','title','description','alt','cta','emptyText','label'];
const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const comparable = (text: string) => normalize(text).toLocaleLowerCase('en');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Inspected = { nodes: ComponentData[]; shape: unknown; orders: string[][]; copy: string[]; headings: string[]; body: string; productDetail: boolean; bounded: boolean };

function richText(value: unknown, depth = 0): string {
  if (!value || typeof value !== 'object' || depth > 24) return '';
  const node = value as { text?: unknown; content?: unknown[] };
  return typeof node.text === 'string' ? node.text : Array.isArray(node.content) ? node.content.map(child => richText(child, depth + 1)).join(' ') : '';
}
function copyOf(node: ComponentData): string[] {
  const props = node.props as Record<string, unknown>;
  const values = COPY_KEYS.flatMap(key => typeof props[key] === 'string' && props[key] ? [String(props[key])] : []);
  if (node.type === 'RichText') { const text = richText(props.doc); if (text) values.push(text); }
  // 旧面板正文与自由插槽的Text是同一段可见文案，按各自实际渲染位置计一次。
  if (['Tabs','Accordion','Carousel'].includes(node.type)) for (const item of (Array.isArray(props.items) ? props.items : Array.isArray(props.slides) ? props.slides : []) as { title?: unknown; body?: unknown }[]) {
    if (typeof item?.title === 'string') values.push(item.title);
    if (props.panelMode !== 'free' && typeof item?.body === 'string') values.push(item.body);
  }
  return values.map(normalize).filter(Boolean);
}
function commonChrome(node: ComponentData): boolean {
  if (['Navigation','Breadcrumb','LanguageSwitcher','Header','Footer','SiteHeader','SiteFooter'].includes(node.type)) return true;
  const label = String(node.props.nodeLabel || '');
  return /页眉|页脚|^(?:AI生成品牌与页面导航)$|(?:^|\s)(?:header|footer|navigation|nav)(?:\s|$)/i.test(label);
}
function inspect(data: Data, mainOnly = false): Inspected {
  const nodes: ComponentData[] = [], orders: string[][] = [], copy: string[] = [], headings: string[] = [], bodies: string[] = [];
  let productDetail = false, bounded = true;
  function walk(list: ComponentData[], depth: number): unknown[] {
    if (depth > 24) { bounded = false; return []; }
    const shape: unknown[] = [], siblingAnchors: string[] = [];
    for (const node of list) {
      if (nodes.length >= 1500) { bounded = false; break; }
      if (!node || typeof node.type !== 'string' || !node.props || mainOnly && commonChrome(node)) continue;
      nodes.push(node); if (node.type === 'ProductDetail') productDetail = true;
      const values = copyOf(node), copyStart = copy.length; copy.push(...values);
      // 动态正文/产品模板的默认占位文字不作为静态文案相似性证据。
      const bound = Boolean(node.props.bindings && Object.keys(node.props.bindings).length);
      if (!bound && node.type === 'Heading' && typeof node.props.text === 'string') headings.push(comparable(node.props.text));
      if (!bound && ['Text','RichText'].includes(node.type)) bodies.push(...values);
      const slots = componentSlots(node).map(slot => ({ path: slot.path, children: walk(slot.content, depth + 1) }));
      shape.push({ type: node.type, slots });
      // 节点ID不进入指纹；内容锚点只用于识别同父级重排，纯改文案不当作结构改变。
      siblingAnchors.push(JSON.stringify([node.type, copy.slice(copyStart), node.props.src || '', node.props.blockId || '', slots]));
    }
    orders.push(siblingAnchors); return shape;
  }
  const shape = walk(Array.isArray(data.content) ? data.content : [], 0);
  return { nodes, shape, orders, copy: copy.sort(), headings, body: bodies.join(' '), productDetail, bounded };
}
function reordered(before: string[][], after: string[][]): boolean {
  return before.some((old, index) => {
    const next = after[index]; if (!next) return false;
    const common = new Set(old.filter(anchor => next.includes(anchor)));
    return common.size >= 2 && !equal(old.filter(anchor => common.has(anchor)), next.filter(anchor => common.has(anchor)));
  });
}
function styles(data: Data, nodes: ComponentData[], fields: DesignKey[]): unknown[] {
  const all: { type: string; props: Record<string, unknown> }[] = [{ type: 'Root', props: data.root?.props || {} }, ...nodes];
  return all.flatMap(node => {
    const values = DESIGN_DEVICES.map(device => {
      const design = resolveDesign(node.props.design, device, getLegacyDesign(node.type, node.props, device));
      return Object.fromEntries(fields.filter(key => design[key] !== undefined && (fields !== COLORS || key !== 'borderColor' || Number(design.borderWidth || 0) > 0) && (fields !== COLORS || key !== 'backgroundColor' || !['transparent','inherit'].includes(String(design[key])))).map(key => [key, design[key]]));
    });
    // 原生产品详情顺序改变实际 DOM 位次，须与常规的断点CSS一起进入布局差异。
    if (fields === LAYOUT && node.type === 'ProductDetail') return [{ type: node.type, values, order: node.props.mobileOrder || 'image-first' }];
    return values.some(value => Object.keys(value).length) ? [{ type: node.type, values }] : [];
  });
}
function grams(text: string): Set<string> {
  const normalized = comparable(text).replace(/[^\p{L}\p{N}]+/gu, '');
  return new Set(Array.from({ length: Math.max(0, normalized.length - 2) }, (_, index) => normalized.slice(index, index + 3)));
}
function eligible(value: Inspected): boolean {
  return value.bounded && !value.productDetail && value.body.length >= 240 && value.body.length <= 60_000 && value.headings.length >= 2 && new Set(value.headings).size >= 2;
}
/** 本地比较所选范围的保存结构/三端样式/静态文字；既不调用模型，也不是全网唯一性或像素级判断。 */
export function analyzeAiDesignDifference(before: Data, after: Data, peers: { pageId: string; title: string; data: Data }[] = []): AiDesignDifference {
  const old = inspect(before), next = inspect(after);
  const result: AiDesignDifference = {
    structureChanged: !equal(old.shape, next.shape) || reordered(old.orders, next.orders),
    layoutChanged: !equal(styles(before, old.nodes, LAYOUT), styles(after, next.nodes, LAYOUT)),
    typographyChanged: !equal(styles(before, old.nodes, TYPOGRAPHY), styles(after, next.nodes, TYPOGRAPHY)),
    colorsChanged: !equal(styles(before, old.nodes, COLORS), styles(after, next.nodes, COLORS)),
    copyChanged: !equal(old.copy, next.copy), similarPages: [], warnings: [],
  };
  if (result.colorsChanged && !result.structureChanged && !result.layoutChanged && !result.typographyChanged && !result.copyChanged) result.warnings.push('本次主要调整了配色，组件结构、排版和文案保持；若希望设计差异更明显，可进一步调整图文关系或信息顺序。');
  if (!result.structureChanged && !result.layoutChanged && !result.typographyChanged && !result.colorsChanged && !result.copyChanged) result.warnings.push('未检测到所选范围的结构、布局、字体、配色或文案变化，请核对调整目标。');
  const main = inspect(after, true), seen = new Set<string>();
  if (eligible(main)) {
    const source = grams(main.body);
    for (const peer of peers.slice(0, 200)) {
      if (seen.has(peer.pageId)) continue; seen.add(peer.pageId);
      const compared = inspect(peer.data, true);
      if (!eligible(compared) || !equal(main.shape, compared.shape) || !equal(main.headings, compared.headings)) continue;
      const target = grams(compared.body), intersection = [...source].filter(gram => target.has(gram)).length, union = source.size + target.size - intersection;
      if (union > 0 && intersection / union >= 0.9 && Math.min(main.body.length, compared.body.length) / Math.max(main.body.length, compared.body.length) >= 0.85) result.similarPages.push({ pageId: peer.pageId, title: peer.title, reason: '正文、标题顺序和组件结构与当前实例的这个页面高度接近，请核对各页用途；共同品牌和常用组件可以保留。' });
      if (result.similarPages.length >= 5) break;
    }
  }
  if (!old.bounded || !next.bounded) result.warnings.push('所选范围超出本地差异分析的深度或节点限制，变化标签未覆盖全部内容，请查看实际预览。');
  return result;
}
