import {MAX_PRODUCT_IMAGES} from '../lib/product-images';
import { PRODUCT_CONTENT_LIMITS } from '../lib/product-content-limits';
import { bundledImageReferences, isLocalImagePath } from '../lib/bundled-media';
import {componentSlots} from '../lib/editor-slots';
import {advancedLayoutErrors} from '../lib/advanced-layout';
import {resolveDesign,DESIGN_DEVICES,ADVANCED_LAYOUT_KEYS} from '../lib/responsive-style';
import {KNOWN_COMPONENT_TYPES,isComponentNodeId} from '../lib/component-contract';
import { componentTranslatableLabelErrors } from '../lib/component-translatable-labels';
import { productDetailPresentationErrors } from '../lib/product-detail-presentation';
import {extensionFor,normalizeExtensionProps,extensionReferences,extensionSourceErrors} from '../extensions/registry';
import { formContentErrors } from '../lib/form-content';
import { templateValidationView } from '../lib/page-templates';
import {detailTemplateErrors} from '../lib/detail-templates';
import {localizationErrors,siteLocales,localeOf} from '../lib/localization';
import { effectiveLayoutBlockId, layoutBlockIds } from '../lib/site-layout-locales';
import { presentationErrors, presentationMediaErrors, richTextErrors } from '../lib/presentation-content';
import { themeDesignErrors } from '../lib/theme-design';
import { redirectErrors } from '../lib/site-redirects';
import { seoErrors } from '../lib/site-seo';
import { taxonomyErrors } from '../lib/taxonomy';
import { contentQueryErrors } from '../lib/content-query';
import { navigationErrors } from '../lib/site-navigation';
import { siteLinkErrors } from '../lib/site-links';
import { ApiError } from './http';
import type { DraftContent, PublicationSelection, SiteSnapshot } from './types';
import { validateDesign } from '../lib/responsive-style';
import { validateContentState } from './model-validation';
import { collectBindingReferences, contentBindingErrors } from '../lib/content-binding';
import { validateCustomCode, validateSnippet } from './site-code';
import { createSharedBlockNodeCounter, getSharedBlockReferences, sharedBlockContainsLoop, SHARED_BLOCK_MAX_DEPTH, SHARED_BLOCK_MAX_NODES } from '../lib/shared-blocks';
import { contentRouteErrors } from '../lib/content-routes';

type ObjectValue = Record<string, unknown>;
export function object(value: unknown, label = '数据'): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, `${label}必须是对象`);
  return value as ObjectValue;
}
export function text(value: unknown, label: string, max = 500, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ApiError(422, `${label}${required ? '不能为空且' : ''}需为不超过 ${max} 字符的文本`);
  return value;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ApiError(422, '缺少有效的数据版本，请刷新后重试');
  return Number(value);
}
export function identifier(value: unknown, label = '标识'): string {
  const id = text(value, label, 100, true);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new ApiError(422, `${label}格式不正确`);
  return id;
}
function strings(value: unknown, label: string, max = 1000): string[] {
  if (!Array.isArray(value) || value.length > max) throw new ApiError(422, `${label}必须是有效列表`);
  const values = value.map((item) => identifier(item, label));
  if (new Set(values).size !== values.length) throw new ApiError(422, `${label}不能重复`);
  return values;
}
function number(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ApiError(422, `${label}必须在 ${min}–${max} 之间`);
}
function choice(value: unknown, choices: readonly string[], label: string) {
  if (typeof value !== 'string' || !choices.includes(value)) throw new ApiError(422, `${label}不是支持的选项`);
}
function list(value: unknown, label: string, max = 1000): ObjectValue[] {
  if (!Array.isArray(value) || value.length > max) throw new ApiError(422, `${label}最多 ${max} 项`);
  return value.map((item) => object(item, label));
}
function unique(items: ObjectValue[], key: string, label: string, lower = false) {
  const keys = items.map((item) => lower ? String(item[key]).trim().toLowerCase() : String(item[key]));
  if (new Set(keys).size !== keys.length) throw new ApiError(422, `${label}不能重复`);
}

export function isSafeHref(value: string): boolean {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value) || value.startsWith('//')) return false;
  return value.startsWith('#') || /^\/(?!\/)/.test(value) || /^(https?:\/\/|mailto:|tel:)/i.test(value);
}
export function isSafeImage(value: string): boolean {
  // 上传地址和内置清单共用严格规则，演示素材扩充不能开放任意静态文件。
  return isLocalImagePath(value);
}
function safeJson(value: unknown, depth = 0) {
  if (depth > 32) throw new ApiError(422, '数据嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach((item) => safeJson(item, depth + 1)); return; }
  const obj = object(value);
  for (const [key, item] of Object.entries(obj)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ApiError(422, '数据包含不允许的字段');
    safeJson(item, depth + 1);
  }
}
const nodeTypes = KNOWN_COMPONENT_TYPES;
/** 旧草稿可以保留未知组件；复制/导入须先拒绝，不能让编辑器静默丢弃它们。 */
export function assertKnownPageComponents(data: unknown) {
  const walk = (v: unknown) => { if (Array.isArray(v)) { v.forEach(walk); return; } if (!v || typeof v !== 'object') return; const node = v as ObjectValue; if (typeof node.type === 'string' && node.props && typeof node.props === 'object' && !nodeTypes.includes(node.type)) throw new ApiError(422, `未知组件“${node.type}”无法复制或导入；原始数据保留，请使用兼容的渲染器`); Object.values(node).forEach(walk); }; walk(data);
}
const ranges: Record<string, [number, number]> = { columns: [1, 4], mobileColumns: [1, 2], gap: [0, 120], padding: [0, 240], inset: [0, 160], minHeight: [0, 1000], size: [10, 120], mobileSize: [12, 80], spacing: [0, 100], maxWidth: [120, 1600], height: [0, 1000], radius: [0, 80], count: [1, 12], imageHeight: [180, 800] };
function validateResponsiveDesign(value: unknown, label: string) {
  // 草稿和发布共用同一属性白名单；三端覆盖不能绕过普通图片与样式的安全边界。
  const errors = validateDesign(value);
  if (errors.length) throw new ApiError(422, `${label}响应式样式无效：${errors.join('；')}`);
}
export function validatePageData(value: unknown, label: string, publishing = false) {
  const anchors = new Set<string>();
  const checkAnchors = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(checkAnchors); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as { type?: string; props?: { anchor?: unknown } };
    if (node.type && node.props?.anchor !== undefined && node.props.anchor !== '') { const anchor = node.props.anchor; if (typeof anchor !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(anchor) || anchors.has(anchor)) throw new ApiError(422, `${label}锚点别名无效或重复`); anchors.add(anchor); }
    Object.values(value).forEach(checkAnchors);
  }; checkAnchors(value);
  // 页面设计永远是声明式数据；可执行源码只能通过管理员专用的顶层 customCode 保存。
  const rejectEmbeddedCode = (item: unknown, depth = 0): void => {
    if (depth > 32) throw new ApiError(422, `${label}数据嵌套过深`);
    if (Array.isArray(item)) { item.forEach((child) => rejectEmbeddedCode(child, depth + 1)); return; }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (/^(customCode|customCss|customJs|css|js|script|scripts|javascript|html|innerHTML|dangerouslySetInnerHTML)$/i.test(key) || /^on[a-z]/i.test(key)) throw new ApiError(422, `${label}不能内嵌 CSS / JS 或事件处理器，请使用管理员自定义代码功能`);
      rejectEmbeddedCode(child, depth + 1);
    }
  };
  rejectEmbeddedCode(value);
  const data = object(value, `${label}设计`);
  const root = object(data.root, `${label}根节点`);
  const rootProps = object(root.props, `${label}根属性`);
  if (rootProps.title !== undefined) text(rootProps.title, '页面内部名称', 200);
  if (rootProps.brand !== undefined) text(rootProps.brand, '品牌名称', 200);
  if (rootProps.showChrome !== undefined) choice(rootProps.showChrome, ['yes', 'no'], '页眉页脚');
  for (const key of ['headerMode', 'footerMode']) if (rootProps[key] !== undefined) choice(rootProps[key], ['inherit', 'hidden'], key === 'headerMode' ? '页面页眉' : '页面页脚');
  if (rootProps.design !== undefined){validateResponsiveDesign(rootProps.design, `${label}页面`);if(Object.values(rootProps.design as Record<string,Record<string,unknown>>).some(v=>ADVANCED_LAYOUT_KEYS.some(k=>Object.hasOwn(v,k))))throw new ApiError(422,'高级定位和裁切请设置在容器或元素，不应用于整页根节点');}
  const seen = new Set<string>();
  let count = 0;
  const walk = (nodes: unknown, depth: number,insideContainer=false) => {
    if (depth > 20) throw new ApiError(422, `${label}容器嵌套最多 20 层`);
    for (const node of list(nodes, `${label}内容`, 1000)) {
      if (++count > 1000) throw new ApiError(422, `${label}组件超过 1000 个`);
      text(node.type, `${label}组件类型`, 100, true);
      // 草稿保留未来/旧版组件的数据，发布只接受当前渲染器认识的组件，避免静默丢内容。
      if (publishing) choice(node.type, nodeTypes, `${label}组件类型`);
      const props = object(node.props, '组件属性');
      const labelErrors=componentTranslatableLabelErrors(String(node.type),props.labels);
      if(labelErrors.length)throw new ApiError(422,`${label}：${labelErrors.join('；')}`);
      // 可选详情呈现字段同样约束草稿/发布/导入；渲染fallback不能替代有效保存校验。
      if(node.type==='ProductDetail'){const errors=productDetailPresentationErrors(props);if(errors.length)throw new ApiError(422,`${label}：${errors.join('；')}`);}
      if(node.type==='Heading'&&props.level!==undefined)choice(props.level,['h1','h2','h3','h4','h5','h6'],'标题语义');
      if(extensionFor(String(node.type)))try{normalizeExtensionProps(String(node.type),props);}catch(e){throw new ApiError(422,`${label}：${(e as Error).message}`);}
      // 可选的原生导航显示方式沿用旧菜单默认折叠；非法值不能进入草稿或发布快照。
      if(node.type==='Navigation'&&props.mobileMode!==undefined)choice(props.mobileMode,['collapse','inline'],'导航手机显示方式');
      if(node.type==='LanguageSwitcher'){if(props.label!==undefined)text(props.label,'语言导航说明',200);if(props.missing!==undefined)choice(props.missing,['hide','disabled'],'缺译显示方式');}
      const componentErrors = presentationErrors(String(node.type), props, publishing);
      if (componentErrors.length) throw new ApiError(422, `${label}：${componentErrors.join('；')}`);
      for(const device of DESIGN_DEVICES)if(resolveDesign(props.design,device).position==='absolute'&&!insideContainer)throw new ApiError(422,`${label}绝对定位元素必须放在显式容器内`);
      if(!isComponentNodeId(props.id))throw new ApiError(422,'组件标识格式无效');const id=props.id;
      if (seen.has(id)) throw new ApiError(422, `${label}组件标识重复`);
      seen.add(id);
      // 动态按钮的静态 href 可以留空；来源、字段、模型与模板依赖仍由后续绑定校验严格检查。
      const hrefBinding = (props.bindings as { href?: unknown } | undefined)?.href;
      const hasHrefBinding = node.type === 'ActionButton' && !!hrefBinding && typeof hrefBinding === 'object' && !Array.isArray(hrefBinding);
      // 深层面板 slot 与容器使用相同预算、ID、绑定和素材校验，不能绕过发布检查。
      for(const slot of componentSlots({type:String(node.type),props}))walk(slot.content,depth+1,insideContainer||node.type==='Container');
      for (const [key, item] of Object.entries(props)) {
        if(key==='content'){if(node.type!=='Container')walk(item,depth+1,insideContainer);continue;}
        if (['design', 'fieldDesign', 'submitDesign'].includes(key)) { validateResponsiveDesign(item, `${label}组件 ${id}`); continue; }
        if (ranges[key]) number(item, key, ...(node.type === 'ContentLoop' && key === 'count' ? [1, 50] as [number, number] : ranges[key]));
        if (['text', 'title', 'eyebrow', 'alt', 'category', 'cta'].includes(key)) text(item, key, 30000);
        if (['src', 'image'].includes(key) && item !== '' && (typeof item !== 'string' || !isSafeImage(item))) throw new ApiError(422, `${label}图片必须从素材库选择`);
        if (key === 'href' && !(item === '' && (!publishing || hasHrefBinding || !!props.linkTarget)) && (typeof item !== 'string' || !isSafeHref(item))) throw new ApiError(422, `${label}包含不安全或无效的链接`);
        if (['color', 'background'].includes(key) && (typeof item !== 'string' || !/^(#[0-9a-fA-F]{3,8}|transparent)$/.test(item))) throw new ApiError(422, `${label}颜色格式不正确`);
      }
      const enums: Record<string, string[]> = { layout: node.type === 'ProductDetail' ? ['split', 'stacked'] : ['column', 'grid'], align: node.type === 'Container' ? ['start', 'center', 'end'] : ['left', 'center', 'right'], fit: ['cover', 'contain'], kind: ['theme', 'dark', 'light', 'outline'], style: ['serif', 'sans'], line: ['yes', 'no'] };
      for (const [key, values] of Object.entries(enums)) if (props[key] !== undefined) choice(props[key], values, `${label}.${key}`);
      if (props.productId !== undefined && props.productId !== '') identifier(props.productId, '绑定产品');
      if (node.type === 'ProductDetail' && props.showCustomFields !== undefined) choice(props.showCustomFields, ['yes', 'no'], '展示产品扩展字段');
      if (node.type === 'Image' && props.imageSize !== undefined) choice(props.imageSize, ['auto', 'original', '320', '768', '1440'], '图片尺寸');
      if (node.type === 'Download' && !(props.fileUrl === '' && !publishing) && (typeof props.fileUrl !== 'string' || !/^\/api\/media\/[a-zA-Z0-9_-]+$/.test(props.fileUrl))) throw new ApiError(422, `${label}请选择PDF目录素材`);
      if (node.type === 'SharedBlock' && (publishing || props.blockId !== '')) identifier(props.blockId, '同步区块引用');
      if (node.type === 'ContentLoop') {
        choice(props.source, ['product', 'entry'], '循环列表数据来源');
        if (props.modelId !== undefined && props.modelId !== '') identifier(props.modelId, '循环列表内容模型');
        if (publishing || props.itemBlockId !== '') identifier(props.itemBlockId, '循环卡片模板');
        for (const key of ['count', 'columns', 'mobileColumns']) if (props[key] !== undefined && !Number.isInteger(props[key])) throw new ApiError(422, `循环列表${key}必须为整数`);
        if (props.emptyText !== undefined) text(props.emptyText, '循环列表空内容提示', 2000);
      }
    }
  };
  walk(data.content, 0);
  if (data.zones !== undefined) for (const nodes of Object.values(object(data.zones, '旧版区域'))) walk(nodes, 0);
}

export function validateDraft(value: unknown): DraftContent {
  safeJson(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new ApiError(422, '内容数据超过 4 MB，请减少页面内容或拆分页面');
  const draft = object(value, '工作区');
  const pages = list(draft.pages, '页面', 200);
  const editor = object(draft.editorData, '页面设计');
  for (const page of pages) {
    identifier(page.id, '页面 ID'); text(page.title, '页面名称', 120, true); text(page.type, '页面类型', 100, true); text(page.updated, '更新时间', 100);
    choice(page.status, ['draft', 'published'], '页面状态');
    const slug = text(page.slug, '页面路径', 200, true);
    // 独立详情使用带模型的末段动态模板；其他动态表达式不进入路由系统。
    if (page.contentModelId !== undefined && page.contentModelId !== '') identifier(page.contentModelId, '详情模板内容模型');
    const contentTemplate = !!page.contentModelId && /^\/[a-z0-9][a-z0-9/_-]*\/:slug$/.test(slug);
    if (!(slug === '/' || slug === '/products/:slug' || contentTemplate || /^\/[a-z0-9][a-z0-9/_-]*$/.test(slug)) || slug.includes('//') || (slug !== '/' && slug.endsWith('/')) || /^\/(api|admin|preview|_next)(\/|$)/.test(slug)) throw new ApiError(422, `页面“${page.title}”路径无效或属于系统保留路径`);
    validatePageData(editor[String(page.id)], String(page.title));
  }
  unique(pages, 'id', '页面 ID'); unique(pages, 'slug', '页面路径');
  const pageIds = new Set(pages.map((page) => page.id));
  for (const key of Object.keys(editor)) if (key !== '__themeControls' && !pageIds.has(key)) throw new ApiError(422, `设计数据找不到对应页面：${key}`);
  if (draft.sharedBlocks !== undefined) {
    const blocks = list(draft.sharedBlocks, '同步区块', 200);
    unique(blocks, 'id', '同步区块 ID');
    for (const block of blocks) {
      identifier(block.id, '同步区块 ID'); text(block.name, '同步区块名称', 120, true); text(block.updated, '同步区块更新时间', 100);
      validatePageData(block.data, `同步区块“${block.name}”`);
    }
  }
  if (draft.siteLayout !== undefined) {
    const layout = object(draft.siteLayout, '全站页眉页脚');
    for (const key of ['header', 'footer']) {
      const slot = object(layout[key], key === 'header' ? '页眉' : '页脚');
      choice(slot.mode, ['default', 'block', 'hidden'], '页眉页脚模式');
      if (slot.mode === 'block') identifier(slot.blockId, '页眉页脚同步区块');
      else text(slot.blockId, '页眉页脚同步区块', 100);
      if (slot.localeBlockIds !== undefined) {
        const variants=object(slot.localeBlockIds,'语言页眉页脚'); const locales=siteLocales(draft.settings as unknown as import('../lib/types').SiteSettings);
        if(Object.keys(variants).length>10)throw new ApiError(422,'语言页眉页脚最多10种');
        for(const [locale,id] of Object.entries(variants)){if(!locales.some(item=>item.code===locale))throw new ApiError(422,'语言页眉页脚使用未启用语言');identifier(id,'语言同步区块');}
      }
    }
  }
  if (draft.customCode !== undefined) validateCustomCode(draft.customCode, new Set([...pageIds].map(String)));
  const dependencyErrors = sharedDependencyErrors(draft as unknown as DraftContent);
  if (dependencyErrors.length) throw new ApiError(422, dependencyErrors.join('；'));
  const controls = editor.__themeControls;
  if (controls !== undefined) {
    const c = object(controls, '主题附加设置');
    if (c.contentWidth !== undefined) number(c.contentWidth, '内容宽度', 720, 1600);
    if (c.buttonSize !== undefined) choice(c.buttonSize, ['small', 'middle', 'large'], '按钮大小');
    if (c.buttonStyle !== undefined) choice(c.buttonStyle, ['solid', 'outline', 'filled'], '按钮样式');
  }
  const products = list(draft.products, '产品', 2000);
  for (const product of products) {
    identifier(product.id, '产品 ID'); text(product.name, '产品名称', PRODUCT_CONTENT_LIMITS.name, true); text(product.sku, '产品型号', PRODUCT_CONTENT_LIMITS.sku, true); text(product.category, '产品分类', PRODUCT_CONTENT_LIMITS.category, true);
    choice(product.status, ['draft', 'published'], '产品状态');
    text(product.description, '产品介绍', PRODUCT_CONTENT_LIMITS.description);
    // 长详情是独立原生文档；旧产品缺省时不补写，也不能用HTML或null冒充文档。
    if (product.detailContent !== undefined) { const errors = richTextErrors(product.detailContent); if (errors.length) throw new ApiError(422, `产品图文详情：${errors.join('；')}`); }
    text(product.material, '产品材质', PRODUCT_CONTENT_LIMITS.material);
    if (typeof product.image !== 'string' || (product.image && !isSafeImage(product.image))) throw new ApiError(422, '产品封面必须从素材库选择');
    // 新产品图片有序保存，首张与兼容封面一致；旧单图记录不要求补字段。
    if(product.images!==undefined){if(!Array.isArray(product.images)||product.images.length>MAX_PRODUCT_IMAGES||product.images.some(url=>typeof url!=='string'||!isSafeImage(url))||new Set(product.images).size!==product.images.length)throw new ApiError(422,'产品图片需为不重复的素材图片列表，最多20张');if(product.image!==(product.images[0]||''))throw new ApiError(422,'产品封面必须是产品图片的第一张');}
    if(product.updated!==undefined&&(typeof product.updated!=='string'||!Number.isFinite(Date.parse(product.updated))))throw new ApiError(422,'产品更新时间无效');
    if (product.seoTitle !== undefined) text(product.seoTitle, 'SEO 标题', 200);
    if (product.seoDescription !== undefined) text(product.seoDescription, 'SEO 描述', 1000);
    if (product.specifications !== undefined) for (const row of list(product.specifications, '产品规格', 100)) { text(row.label, '规格名称', 200, true); text(row.value, '规格值', 2000, true); }
  }
  unique(products, 'id', '产品 ID'); unique(products, 'sku', '产品型号', true);
  const media = list(draft.media, '素材', 5000);
  for (const item of media) {
    identifier(item.id, '素材 ID'); text(item.name, '文件名称', 250, true); choice(item.kind, ['image', 'document', 'video'], '素材类型');
    text(item.folder, '素材目录', 100); text(item.alt, '图片说明', 1000); text(item.size, '素材大小', 100);
    for (const key of ['width', 'height']) if (item[key] !== undefined) { number(item[key], `图片${key}`, 1, 40_000_000); if (item.kind !== 'image' || !Number.isInteger(item[key])) throw new ApiError(422, '图片固有尺寸无效'); }
    if (item.bytes !== undefined) { number(item.bytes, '素材字节数', 1, 40 * 1024 * 1024); if (!Number.isInteger(item.bytes)) throw new ApiError(422, '素材字节数无效'); }
    if (item.pages !== undefined) { number(item.pages, 'PDF页数', 1, 1000); if (item.kind !== 'document' || !Number.isInteger(item.pages)) throw new ApiError(422, 'PDF页数无效'); }
    if (item.variants !== undefined) {
      if (item.kind !== 'image' || !item.width || !item.height) throw new ApiError(422, '图片衍生尺寸缺少原图信息');
      const variants = list(item.variants, '图片衍生尺寸', 3); unique(variants, 'width', '图片衍生宽度');
      for (const v of variants) if (![320, 768, 1440].includes(Number(v.width)) || typeof v.width !== 'number' || v.width >= Number(item.width) || v.height !== Math.max(1, Math.round(Number(item.height) * v.width / Number(item.width)))) throw new ApiError(422, '图片衍生尺寸无效');
    }
    if (typeof item.url !== 'string' || !isSafeImage(item.url)) throw new ApiError(422, '素材地址必须由上传服务生成');
  }
  unique(media, 'id', '素材 ID'); unique(media, 'url', '素材地址');
  const theme = object(draft.theme, '网站主题');
  for (const key of ['primary', 'background', 'text']) if (typeof theme[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(theme[key] as string)) throw new ApiError(422, '主题颜色必须是六位十六进制颜色');
  number(theme.radius, '主题圆角', 0, 40); choice(theme.font, ['Georgia', 'Inter', 'system', 'Arial', 'Times New Roman'], '网站字体');
  const settings = object(draft.settings, '网站设置');
  text(settings.name, '网站名称', 200, true); text(settings.description, '网站说明', 2000); text(settings.domain, '网站域名', 253); text(settings.email, '联系邮箱', 254);
  if (settings.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(settings.email))) throw new ApiError(422, '联系邮箱格式不正确');
  text(settings.language, '网站语言', 35, true); text(settings.timezone, '时区', 80, true);
  try { new Intl.DateTimeFormat('en', { timeZone: String(settings.timezone) }); } catch { throw new ApiError(422, '时区标识无效'); }
  validateContentState(draft as unknown as DraftContent);
  const routeErrors = [...contentRouteErrors(draft as unknown as DraftContent), ...siteLinkErrors(draft as unknown as DraftContent), ...navigationErrors(draft as unknown as DraftContent), ...taxonomyErrors(draft as unknown as DraftContent), ...redirectErrors(draft as unknown as DraftContent), ...seoErrors(draft as unknown as DraftContent), ...themeDesignErrors(draft as unknown as DraftContent), ...presentationMediaErrors(draft as unknown as DraftContent), ...formContentErrors(draft as unknown as DraftContent), ...pageTemplateErrors(draft as unknown as DraftContent),...extensionSourceErrors(draft as unknown as DraftContent),...advancedLayoutErrors(draft as unknown as DraftContent)];
  if (routeErrors.length) throw new ApiError(422, routeErrors.join('；'));
  const queryValidation = contentQueryErrors(draft as unknown as DraftContent);
  if (queryValidation.length) throw new ApiError(422, queryValidation.join('；'));
  const bindingErrors = contentBindingErrors(draft as unknown as DraftContent);
  if (bindingErrors.length) throw new ApiError(422, bindingErrors.join('；'));
  const languages=localizationErrors(draft as unknown as DraftContent);if(languages.length)throw new ApiError(422,languages.join('；'));
  return structuredClone(value) as DraftContent;
}

export function validateSelection(value: unknown): PublicationSelection {
  const input = object(value, '发布请求');
  revision(input.expectedRevision);
  if (input.baseReleaseId !== null) identifier(input.baseReleaseId, '当前线上版本');
  if (typeof input.includeTheme !== 'boolean' || typeof input.includeSettings !== 'boolean') throw new ApiError(422, '请明确选择是否发布主题及网站设置');
  if (input.title !== undefined) text(input.title, '版本说明', 200);
  const pageIds = strings(input.pageIds, '发布页面');
  const removePageIds = strings(input.removePageIds ?? [], '下线页面');
  const productIds = strings(input.productIds ?? [], '发布产品', 2000);
  const removeProductIds = strings(input.removeProductIds ?? [], '下线产品', 2000);
  const sharedBlockIds = strings(input.sharedBlockIds ?? [], '发布同步区块', 200);
  const removeSharedBlockIds = strings(input.removeSharedBlockIds ?? [], '下线同步区块', 200);
  const contentModelIds = strings(input.contentModelIds ?? [], '发布内容模型', 100);
  const removeContentModelIds = strings(input.removeContentModelIds ?? [], '下线内容模型', 100);
  const contentEntryIds = strings(input.contentEntryIds ?? [], '发布内容记录', 2000);
  const removeContentEntryIds = strings(input.removeContentEntryIds ?? [], '下线内容记录', 2000);
  for (const key of ['includeLayout', 'includeCode', 'includeCatalog', 'includeRedirects', 'includeForms', 'includeTemplates']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiError(422, '请明确选择是否发布页眉页脚及自定义代码');
  if (pageIds.some((id) => removePageIds.includes(id)) || productIds.some((id) => removeProductIds.includes(id)) || sharedBlockIds.some((id) => removeSharedBlockIds.includes(id)) || contentModelIds.some((id) => removeContentModelIds.includes(id)) || contentEntryIds.some((id) => removeContentEntryIds.includes(id))) throw new ApiError(422, '同一内容不能同时发布和下线');
  return { expectedRevision: Number(input.expectedRevision), baseReleaseId: input.baseReleaseId as string | null, title: input.title as string | undefined, pageIds, removePageIds, productIds, removeProductIds, sharedBlockIds, removeSharedBlockIds, contentModelIds, removeContentModelIds, contentEntryIds, removeContentEntryIds, includeTheme: input.includeTheme, includeSettings: input.includeSettings, includeTemplates: input.includeTemplates === true, includeForms: input.includeForms === true, includeRedirects: input.includeRedirects === true, includeCatalog: input.includeCatalog === true, includeLayout: input.includeLayout === true, includeCode: input.includeCode === true };
}

/** 模板是可复制资产，依赖真实站点内容；虚拟详情只检查模板自身，不能让公开页面借它通过路由校验。 */
export function pageTemplateErrors(source: Pick<SiteSnapshot, 'pages' | 'products' | 'media' | 'editorData' | 'theme' | 'pageTemplates' | 'sharedBlocks' | 'siteLayout' | 'customCode' | 'contentModels' | 'contentEntries' | 'forms' | 'taxonomies'>, publishing = false): string[] {
  if (source.pageTemplates === undefined) return [];
  try {
    const templates = list(source.pageTemplates, '页面模板', 200); unique(templates, 'id', '页面模板ID');
    let codeBytes = 0;
    for (const t of templates) {
      if (Object.keys(t).some(k => !['id', 'name', 'description', 'kind', 'modelId', 'sourcePath', 'data', 'code', 'updated','detailRule'].includes(k))) throw new ApiError(422, '页面模板包含未知字段');
      identifier(t.id, '页面模板ID'); text(t.name, '模板名称', 120, true); text(t.description, '模板说明', 2000); text(t.updated, '模板更新时间', 100);
      choice(t.kind, ['page', 'product', 'entry'], '页面模板用途');
      if (source.pages.some(p => p.id === t.id)) throw new ApiError(422, '页面模板ID不能与真实页面重复');
      if (t.kind === 'entry') { identifier(t.modelId, '模板模型'); if (!source.contentModels?.some(m => m.id === t.modelId && m.target === 'content')) throw new ApiError(422, `模板“${t.name}”关联的独立内容模型不存在`); }
      else if (t.modelId !== undefined && t.modelId !== '') throw new ApiError(422, '只有独立内容详情模板可关联内容模型');
      if (t.sourcePath !== undefined && (typeof t.sourcePath !== 'string' || t.sourcePath.length > 400 || !/^\/[a-zA-Z0-9/_:-]*$/.test(t.sourcePath))) throw new ApiError(422, '模板原始路径无效');
      validatePageData(t.data, `页面模板“${t.name}”`, publishing);
      if (t.code !== undefined) { validateSnippet(t.code, `模板“${t.name}”代码`, true); codeBytes += Buffer.byteLength(JSON.stringify(t.code)); }
    }
    if (codeBytes > 1024 * 1024) throw new ApiError(422, '页面模板代码总量不能超过1 MB');
    const view = templateValidationView(source);
    const conditional=new Set((source.pageTemplates||[]).filter(t=>t.detailRule?.enabled).map(t=>t.id));
    return [...detailTemplateErrors(source,publishing),...contentBindingErrors(view,publishing,conditional,source.pages),...sharedDependencyErrors(view), ...navigationErrors(view, publishing), ...siteLinkErrors(view), ...contentBindingErrors(view, false), ...contentQueryErrors(view), ...themeDesignErrors(view), ...presentationMediaErrors(view), ...formContentErrors(view, publishing)];
  } catch (e) { if (e instanceof ApiError) return [e.message]; throw e; }
}

type ReferenceSource = Pick<SiteSnapshot, 'pages' | 'editorData' | 'products'> & Partial<Pick<SiteSnapshot, 'sharedBlocks' | 'siteLayout' | 'customCode' | 'contentModels' | 'contentEntries' | 'theme' | 'pageTemplates' | 'settings'>>;

/** 引用分析不展开数据副本；共享图使用去重边，避免重复引用产生指数级遍历。 */
export function sharedBlockReferences(value: unknown): Set<string> {
  return new Set(getSharedBlockReferences(value));
}

export function sharedDependencyErrors(source: Pick<ReferenceSource, 'pages' | 'editorData' | 'sharedBlocks' | 'siteLayout' | 'settings'>): string[] {
  const errors = new Set<string>();
  const blocks = new Map((source.sharedBlocks || []).map((block) => [block.id, block]));
  // 卡片可以嵌套容器和普通同步区块，但不能经任何引用再次进入循环列表。
  const inspectLoops = (value: unknown, owner: string): void => {
    if (Array.isArray(value)) { value.forEach(item => inspectLoops(item, owner)); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as ObjectValue, props = node.props as ObjectValue | undefined;
    if (node.type === 'ContentLoop' && typeof props?.itemBlockId === 'string' && props.itemBlockId && sharedBlockContainsLoop(props.itemBlockId, source.sharedBlocks)) errors.add(`${owner}的循环卡片不能直接或间接包含另一个循环列表`);
    Object.values(node).forEach(item => inspectLoops(item, owner));
  };
  for (const block of blocks.values()) inspectLoops(block.data, `同步区块“${block.name}”`);
  for (const page of source.pages) inspectLoops(source.editorData[page.id], `页面“${page.title}”`);
  const edges = new Map([...blocks].map(([id, block]) => [id, sharedBlockReferences(block.data)]));
  const visiting = new Set<string>(); const heights = new Map<string, number>();
  const visit = (id: string, owner: string): number => {
    if (!blocks.has(id)) { errors.add(`${owner}引用的同步区块 ${id} 不存在，请明确包含所需区块或先移除引用`); return 0; }
    if (visiting.has(id)) { errors.add(`同步区块“${blocks.get(id)!.name}”存在循环引用`); return 0; }
    if (heights.has(id)) return heights.get(id)!;
    visiting.add(id); let height = 1;
    for (const dependency of edges.get(id)!) height = Math.max(height, 1 + visit(dependency, `同步区块“${blocks.get(id)!.name}”`));
    visiting.delete(id); heights.set(id, height);
    if (height > SHARED_BLOCK_MAX_DEPTH) errors.add(`同步区块引用最多 ${SHARED_BLOCK_MAX_DEPTH} 层，请减少嵌套`);
    return height;
  };
  for (const id of blocks.keys()) visit(id, '同步区块');
  for (const page of source.pages) for (const id of sharedBlockReferences(source.editorData[page.id])) visit(id, `页面“${page.title}”`);
  for (const key of ['header', 'footer'] as const) { const slot = source.siteLayout?.[key]; for(const id of layoutBlockIds(slot)) visit(id, key === 'header' ? '全站页眉' : '全站页脚'); }
  if (!errors.size) {
    // 深度限制不能阻止重复引用指数膨胀；用图缓存估算展开组件数，不创建巨型节点副本。
    const dataCost = createSharedBlockNodeCounter(source.sharedBlocks); const limit = SHARED_BLOCK_MAX_NODES;
    for (const block of blocks.values()) if (dataCost(block.data) > limit) errors.add(`同步区块“${block.name}”展开后超过 ${limit} 个组件，请减少重复引用`);
    for (const page of source.pages) {
      const data = source.editorData[page.id] as { root?: { props?: ObjectValue } } | undefined;
      const props = data?.root?.props; let count = dataCost(data);
      if (props?.showChrome !== 'no') for (const key of ['header', 'footer'] as const) {
        const slot = source.siteLayout?.[key];
        if (props?.[`${key}Mode`] !== 'hidden') { const variants=page.slug.includes(':')?siteLocales(source.settings).map(item=>item.code):[localeOf(source.settings,page)]; const ids=variants.map(locale=>effectiveLayoutBlockId(slot,source.settings,locale)).filter((id):id is string=>!!id); count+=Math.max(0,...ids.map(id=>dataCost(blocks.get(id)?.data))); }
      }
      if (count > limit) errors.add(`页面“${page.title}”展开后超过 ${limit} 个组件，请减少重复引用`);
    }
  }
  return [...errors];
}

/** 统计共享内容变化会影响哪些页面，包含间接引用及继承页眉页脚。 */
export function affectedSharedPages(source: ReferenceSource, changed: Set<string>) {
  const blocks = new Map((source.sharedBlocks || []).map((block) => [block.id, block]));
  const reaches = (ids: Set<string>, visited = new Set<string>()): boolean => {
    for (const id of ids) {
      if (changed.has(id)) return true;
      if (visited.has(id)) continue;
      visited.add(id); const block = blocks.get(id);
      if (block && reaches(sharedBlockReferences(block.data), visited)) return true;
    }
    return false;
  };
  return source.pages.filter((page) => {
    const data = source.editorData[page.id] as { root?: { props?: Record<string, unknown> } } | undefined;
    const props = data?.root?.props;
    const refs = sharedBlockReferences(data);
    if (props?.showChrome !== 'no') for (const key of ['header', 'footer'] as const) {
      const slot = source.siteLayout?.[key];
      if (props?.[`${key}Mode`] !== 'hidden') for(const locale of page.slug.includes(':')?siteLocales(source.settings).map(item=>item.code):[localeOf(source.settings,page)]){const id=effectiveLayoutBlockId(slot,source.settings,locale);if(id)refs.add(id);}
    }
    return reaches(refs);
  }).map(({ id, title }) => ({ id, title }));
}

export function collectReferences(snapshot: ReferenceSource) {
  const urls = new Set<string>(); const productIds = new Set<string>(); let usesProductList = false;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as ObjectValue;
    if(typeof node.type==='string'&&extensionFor(node.type)){const refs=extensionReferences(node.type,node.props);refs.products.forEach(id=>productIds.add(id));refs.media.forEach(url=>urls.add(url));}
    if (node.type === 'ProductList') usesProductList = true;
    if (node.type === 'ProductDetail' && node.props && typeof node.props === 'object') { const id = (node.props as ObjectValue).productId; if (typeof id === 'string' && id) productIds.add(id); }
    // 图片绑定缺值时仍会使用后备图片；该素材必须随版本保存并受删除保护。
    if (node.type === 'Image' && node.props && typeof node.props === 'object') {
      const bindings = (node.props as ObjectValue).bindings as { src?: { fallback?: unknown } } | undefined;
      const fallback = bindings?.src?.fallback;
      if (typeof fallback === 'string' && fallback) urls.add(fallback);
    }
    // 遍历全部断点而不是只取当前有效值：历史/手机背景同样属于发布和删除保护的依赖。
    for (const [key, item] of Object.entries(node)) { if (key === 'href' && typeof item === 'string' && /^\/api\/media\/[a-zA-Z0-9_-]+(?:\?|$)/.test(item)) urls.add(item.split('?')[0]); else if (['src', 'image', 'backgroundImage', 'poster', 'videoUrl', 'fileUrl'].includes(key) && typeof item === 'string' && item && (!['videoUrl', 'fileUrl'].includes(key) || item.startsWith('/api/media/'))) urls.add(item); else visit(item); }
  };
  snapshot.pages.forEach((page) => { visit(snapshot.editorData[page.id]); if (page.seoImage) urls.add(page.seoImage); });
  // 所有已存同步区块及关闭中的 CSS 也保留素材依赖，便于稍后启用和历史恢复。
  snapshot.sharedBlocks?.forEach((block) => visit(block.data));
  snapshot.pageTemplates?.forEach(template => visit(template.data));
  // 复用样式中的背景和全站默认同样保留素材引用；令牌值不允许媒体地址。
  visit(snapshot.theme?.defaults); visit(snapshot.theme?.presets);
  for (const code of [snapshot.customCode?.global, ...Object.values(snapshot.customCode?.pages || {}), ...snapshot.pageTemplates?.map(t => t.code) || []]) if (code) {
    for (const match of code.css.matchAll(/\/api\/media\/[a-zA-Z0-9_-]+/g)) urls.add(match[0]);
    for (const url of bundledImageReferences(code.css)) urls.add(url);
  }
  snapshot.products.forEach((product) => { if (product.image) urls.add(product.image); product.images?.forEach(url=>urls.add(url)); if (product.seoImage) urls.add(product.seoImage); if(product.detailContent)visit(product.detailContent); });
  snapshot.contentEntries?.forEach(entry => { if (entry.seoImage) urls.add(entry.seoImage);Object.values(entry.richTextFields||{}).forEach(visit); });
  // 扩展图片按模型类型收集；文本中恰好出现素材地址不被当作图片字段。
  const models = new Map((snapshot.contentModels || []).map((model) => [model.id, model]));
  for (const item of [...snapshot.products, ...(snapshot.contentEntries || [])]) {
    const model = item.modelId ? models.get(item.modelId) : undefined;
    for (const field of model?.fields || []) {
      const value = item.customFields?.[field.id];
      if (field.type === 'image' && typeof value === 'string' && value) urls.add(value);
      if (field.type === 'gallery' && Array.isArray(value)) value.forEach((url) => { if (typeof url === 'string' && url) urls.add(url); });
    }
  }
  const bindings = collectBindingReferences(snapshot);
  bindings.productIds.forEach((id) => productIds.add(id));
  return { urls, productIds, usesProductList, modelIds: bindings.modelIds, entryIds: bindings.entryIds };
}

export async function readJson(request: Request, limit = 5 * 1024 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) throw new ApiError(413, '请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, '缺少请求内容');
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new ApiError(413, '请求内容过大'); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, '请求不是有效的 JSON'); }
}
