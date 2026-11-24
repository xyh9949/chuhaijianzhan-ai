import type { Data } from '@puckeditor/core';
import type { AiTranslationField, AiTranslationValue } from './ai-translation-types';
import type { RichNode } from './presentation-content';
import { KNOWN_COMPONENT_TYPES, TRADE_COMPONENT_LABELS } from './component-contract';
import { comparisonTableLimits } from './comparison-table';
import type { SiteTranslationAssetKind } from './ai-site-translation-types';
import { COMPONENT_TRANSLATABLE_LABELS, componentTranslatableLabels } from './component-translatable-labels';
import { queryLabels, QUERY_LABEL_NAMES } from './query-labels';
import type { ContentQuery } from './types';

export type SiteTranslationPath = (string | number)[];
export interface NativeSiteTranslationField extends AiTranslationField { path: SiteTranslationPath; assetKey: string; }
export interface NativeSiteTranslationAsset { kind: SiteTranslationAssetKind; id: string; label: string; value: Record<string, unknown>; }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = new Set(['text', 'title', 'subtitle', 'description', 'label', 'caption', 'alt', 'eyebrow', 'overline', 'body', 'heading', 'homeLabel', 'emptyText', 'buttonText', 'ariaLabel']);
const skipped = new Set(['id', 'design', 'tokenBindings', 'stateStyles', 'bindings', 'bindingContext', 'query', 'linkTarget', 'source', 'href', 'src', 'image', 'fileUrl', 'videoUrl', 'poster', 'anchor', 'menuId', 'localeMenuIds', 'blockId', 'itemBlockId', 'formId', 'style', 'icon', 'className', 'css', 'js']);
/** 路径只来自本机白名单遍历，模型无法提交JSON路径、选择器或任意补丁。 */
export function readSiteTranslationPath(value: unknown, path: SiteTranslationPath): unknown { let current = value; for (const key of path) { if (!current || typeof current !== 'object') return undefined; current = (current as Record<string | number, unknown>)[key]; } return current; }
function writePath(value: Record<string, unknown>, path: SiteTranslationPath, next: unknown) { let current: Record<string | number, unknown> = value; for (const key of path.slice(0, -1)) { if (!current[key] || typeof current[key] !== 'object') throw new Error('译文结构已有变化，请重新核对'); current = current[key] as Record<string | number, unknown>; } current[path.at(-1)!] = next; }
const meaningful = (value: unknown) => typeof value === 'string' && !!value.trim();
const rich = (value: unknown): value is RichNode => object(value) && value.type === 'doc';
const componentNames: Record<string, string> = { ...TRADE_COMPONENT_LABELS, CompanyFacts: '公司资料', Download: '下载按钮', Breadcrumb: '当前位置导航', Navigation: '导航菜单', LanguageSwitcher: '语言切换', ProductList: '产品列表', ProductDetail: '产品详情', ContentList: '内容列表', ContentLoop: '循环列表', Gallery: '相册', Tabs: '标签页', Carousel: '轮播', Video: '视频', Form: '询盘表单', Heading: '标题', Text: '文字', ActionButton: '按钮', Image: '图片', RichText: '图文正文', Accordion: '折叠面板', Container: '布局容器', Icon: '图标', Divider: '分隔线' };
const textNames: Record<string, string> = { text: '文字', title: '标题', subtitle: '副标题', description: '介绍', label: '说明', caption: '图注', alt: '图片说明', eyebrow: '短标题', overline: '引导语', body: '正文', heading: '标题', homeLabel: '首页文字', emptyText: '无内容提示', buttonText: '按钮文字', ariaLabel: '辅助说明', company: '公司', alternateName: '别名', role: '企业角色', address: '地址', telephone: '电话', email: '邮箱', source: '来源', reviewed: '复核日期说明', validUntil: '有效期说明', profile: '官方主页', download: '下载文字', home: '首页', navigation: '导航说明', languages: '语言说明', countSuffix: '数量单位', empty: '无内容提示', unavailable: '不可用提示', collection: '系列说明', reference: '型号说明', material: '材料说明', contactNote: '联系提示', open: '打开', image: '图片', close: '关闭', closeImage: '关闭图片说明', sections: '内容组说明', images: '图片组说明', content: '内容说明', slide: '当前项', controls: '操作说明', previous: '上一项', previousSlide: '上一项说明', next: '下一项', nextSlide: '下一项说明', select: '选择提示', confirm: '确认提示', required: '必填提示', retry: '重试按钮', refresh: '刷新按钮', unconfirmed: '未确认提示', receiptError: '接收异常提示', tryAgain: '重试提示', noScript: '浏览器脚本提示' };
const labelFor = (type: string, name: string) => `${componentNames[type] || type} / ${textNames[name] || name}`;

/** 将当前实际渲染的缺省文字显式化到原生覆盖字段，不改变原文对象或查询配置。 */
export function materializeSiteTranslationText(value: Record<string, unknown>, sourceLocale: string, outputLocale: string, description?: string): Record<string, unknown> {
  const result = structuredClone(value);
  if (object(result.record) && !meaningful(result.record.seoDescription) && description?.trim()) result.record.seoDescription = description;
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!object(item)) return;
    if (typeof item.type === 'string' && object(item.props)) {
      const props = item.props;
      if (COMPONENT_TRANSLATABLE_LABELS[item.type]) props.labels = componentTranslatableLabels(item.type, props.labels);
      if (item.type === 'ContentLoop') {
        const query = object(props.query) ? props.query : {};
        props.query = { ...query, labels: { ...(object(query.labels) ? query.labels : {}), [outputLocale]: queryLabels(query as ContentQuery, sourceLocale) } };
      }
    }
    Object.values(item).forEach(visit);
  };
  visit(result.data); return result;
}

/** 原生节点仅翻可见文字与图文text节点，样式、媒体地址、绑定、查询和代码完全留在本机。 */
export function collectNativeSiteTranslationFields(asset: NativeSiteTranslationAsset, target?: Record<string, unknown>, outputLocale?: string): NativeSiteTranslationField[] {
  const fields: NativeSiteTranslationField[] = [], key = `${asset.kind}:${asset.id}`;
  const add = (path: SiteTranslationPath, label: string, maxLength = 60000) => {
    const source = readSiteTranslationPath(asset.value, path); if (!meaningful(source) && !rich(source)) return;
    const before = target ? readSiteTranslationPath(target, path) : source;
    fields.push({ key: `${key}:${JSON.stringify(path)}`, assetKey: key, label: `${asset.label} · ${label}`, path, kind: rich(source) ? 'richtext' : 'text', maxLength, source: structuredClone(source) as AiTranslationValue, before: typeof before === 'string' || rich(before) ? structuredClone(before) : null });
    if (rich(source)) {
      const images = (node: RichNode, location: SiteTranslationPath) => { if (node.type === 'image') for (const attribute of ['alt', 'caption']) if (typeof node.attrs?.[attribute] === 'string') add([...location, 'attrs', attribute], `${label} / 图片${attribute === 'alt' ? '说明' : '图注'}`, 1000); node.content?.forEach((child, index) => images(child, [...location, 'content', index])); };
      images(source, path);
    }
  };
  const textProps = (value: unknown, path: SiteTranslationPath, label: string) => {
    if (Array.isArray(value)) { value.forEach((item, index) => textProps(item, [...path, index], label)); return; }
    if (!object(value)) return;
    if (typeof value.type === 'string' && object(value.props)) { design(value, path); return; }
    for (const [name, item] of Object.entries(value)) {
      if (skipped.has(name)) continue;
      if (strings.has(name) && typeof item === 'string') add([...path, name], labelFor(label, name));
      else if ((name === 'doc' || name === 'richText') && rich(item)) add([...path, name], `${label} / 图文`);
      else if (Array.isArray(item) || object(item) && !rich(item)) textProps(item, [...path, name], label);
    }
  };
  const design = (value: unknown, path: SiteTranslationPath) => {
    if (Array.isArray(value)) { value.forEach((item, index) => design(item, [...path, index])); return; }
    if (!object(value)) return;
    if (typeof value.type === 'string' && object(value.props)) {
      if (!KNOWN_COMPONENT_TYPES.includes(value.type)) throw new Error(`组件 ${value.type} 尚未声明文字翻译能力，请先处理兼容组件`);
      const props = value.props, bindings = object(props.bindings) ? props.bindings : {};
      // 对比表有按列位置保存的纯文字数组；翻译只写对应单元格，保留矩阵、素材和样式。
      if (value.type === 'ComparisonTable') {
        const location = [...path, 'props'];
        const limits = comparisonTableLimits;
        add([...location, 'title'], '产品型号对比表 / 标题', limits.title);
        if (Array.isArray(props.modelColumns)) props.modelColumns.forEach((_, column) => add([...location, 'modelColumns', column], `产品型号对比表 / 产品列 ${column + 1}`, limits.column));
        if (Array.isArray(props.rows)) props.rows.forEach((row, index) => {
          add([...location, 'rows', index, 'label'], `产品型号对比表 / 参数 ${index + 1}`, limits.row);
          if (object(row) && Array.isArray(row.values)) row.values.forEach((_, column) => add([...location, 'rows', index, 'values', column], `产品型号对比表 / 参数 ${index + 1} · 产品列 ${column + 1}`, limits.cell));
        });
        return;
      }
      for (const [name, item] of Object.entries(props)) {
        if (name === 'labels') { if (object(item)) for (const labelKey of Object.keys(COMPONENT_TRANSLATABLE_LABELS[value.type] || {})) if (typeof item[labelKey] === 'string') add([...path, 'props', name, labelKey], labelFor(value.type, labelKey), 1000); continue; }
        if (name === 'query' && value.type === 'ContentLoop' && object(item) && object(item.labels)) { if (outputLocale && object(item.labels[outputLocale])) for (const labelKey of Object.keys(QUERY_LABEL_NAMES)) if (typeof item.labels[outputLocale][labelKey] === 'string') add([...path, 'props', name, 'labels', outputLocale, labelKey], `列表控件 / ${QUERY_LABEL_NAMES[labelKey as keyof typeof QUERY_LABEL_NAMES]}`, 1000); continue; }
        if (skipped.has(name) || Object.hasOwn(bindings, name)) continue;
        if (strings.has(name) && typeof item === 'string') add([...path, 'props', name], labelFor(value.type, name));
        else if (name === 'doc' && rich(item)) add([...path, 'props', name], `${componentNames[value.type] || value.type} / 正文`);
        else if (Array.isArray(item) || object(item) && !rich(item)) textProps(item, [...path, 'props', name], value.type);
      }
      return;
    }
    for (const [name, item] of Object.entries(value)) {
      if (name === 'root' && object(item) && object(item.props)) { if (typeof item.props.title === 'string') add([...path, name, 'props', 'title'], '页面编辑标题', 200); }
      else if (name === 'content' || name === 'zones') design(item, [...path, name]);
      else if (Array.isArray(item) || object(item)) design(item, [...path, name]);
    }
  };
  if (asset.kind === 'page') { add(['record', 'title'], '页面名称', 200); add(['record', 'seoTitle'], '搜索标题', 200); add(['record', 'seoDescription'], '搜索介绍', 1000); design(asset.value.data, ['data']); }
  else if (asset.kind === 'block') { add(['name'], '区块名称', 100); design(asset.value.data, ['data']); }
  else if (asset.kind === 'menu') {
    add(['name'], '菜单名称', 120);
    const menu = (items: unknown, path: SiteTranslationPath) => { if (!Array.isArray(items)) return; items.forEach((item, index) => { if (!object(item)) return; add([...path, index, 'label'], '菜单文字', 120); menu(item.children, [...path, index, 'children']); }); }; menu(asset.value.items, ['items']);
  } else {
    add(['name'], '表单名称', 120); add(['submitLabel'], '提交按钮', 200); add(['successMessage'], '成功提示', 1000);
    if (Array.isArray(asset.value.fields)) asset.value.fields.forEach((item, index) => { if (!object(item)) return; add(['fields', index, 'label'], '字段名称', 200); add(['fields', index, 'placeholder'], '字段提示', 500); if (Array.isArray(item.options)) item.options.forEach((_, option) => add(['fields', index, 'options', option, 'label'], '选项', 200)); });
  }
  return fields;
}

const richShape = (node: RichNode): unknown => ({ type: node.type, content: node.content?.map(richShape) });
function copyRichText(source: RichNode, target: RichNode): RichNode {
  if (JSON.stringify(richShape(source)) !== JSON.stringify(richShape(target))) throw new Error('已有译文的图文排版结构与原文不同，请先在编辑器核对结构；不会覆盖目标图片、链接和手工排版');
  const result = structuredClone(target), walk = (from: RichNode, to: RichNode) => { if (from.type === 'text') to.text = from.text; from.content?.forEach((child, index) => walk(child, to.content![index])); }; walk(source, result); return result;
}
/** 已有译文只换明确文字，保留其图、链接、样式与其他属性；富文本结构不同必须人工处理。 */
export function writeNativeSiteTranslationFields(value: Record<string, unknown>, fields: NativeSiteTranslationField[], after: AiTranslationValue[]): Record<string, unknown> {
  if (fields.length !== after.length) throw new Error('整站翻译字段数量不一致');
  const result = structuredClone(value);
  fields.forEach((field, index) => { const next = after[index], current = readSiteTranslationPath(result, field.path); if (rich(next) && rich(current)) writePath(result, field.path, copyRichText(next, current)); else if (typeof next === 'string') writePath(result, field.path, next); else throw new Error('翻译字段格式无效'); });
  return result;
}
/** 已有译文必须保留相同原生节点/插槽骨架；结构变化不由翻译功能偷偷重建页面。 */
export function siteTranslationStructure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(siteTranslationStructure);
  if (!object(value)) return typeof value;
  if (rich(value)) return richShape(value);
  if (typeof value.type === 'string' && object(value.props)) return { type: value.type, children: Object.fromEntries(Object.entries(value.props).filter(([key, item]) => key !== 'labels' && (Array.isArray(item) && !['images'].includes(key) || object(item) && !skipped.has(key))).map(([key, item]) => [key, siteTranslationStructure(item)])) };
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => ['root', 'content', 'zones'].includes(key) || Array.isArray(item) || object(item)).map(([key, item]) => [key, siteTranslationStructure(item)]));
}
export function requireCompatibleSiteTranslationData(source: unknown, target: unknown) { if (JSON.stringify(siteTranslationStructure(source)) !== JSON.stringify(siteTranslationStructure(target))) throw new Error('已有目标语言页面或区块布局与原文不同，请先在编辑器对齐结构后再翻译；现有排版已保留'); }
export function asSiteData(value: unknown): Data { return value as Data; }
