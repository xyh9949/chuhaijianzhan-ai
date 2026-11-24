import {productImages} from './product-images';
import { getProductPath } from './content-routes';
import type { BindingContext, ContentEntry, ContentField, ContentModel, FieldBinding, FieldType, MediaItem, PageItem, Product, SharedBlock } from './types';
import { formatFieldValue, isContentImage, isEmptyFieldValue, MAX_GALLERY_IMAGES } from './content-models';
import { safeLinkHref } from './site-safety';
import {richTextErrors,richTextPlainText,type RichNode} from './presentation-content';
import { getContentEntryPath, getContentTemplate } from './content-routes';
import {isRelationDefinition,isRelationLoop,relationLoopField,parseRelatedField,relatedRecords,relatedTitle,relatedUrl,relationReferences} from './content-relations';

export type BindingTarget = 'text' | 'alt' | 'src' | 'href' | 'images';
export interface BindingSource { pageTemplates?: import('./types').PageTemplate[];  contentModels?: ContentModel[]; contentEntries?: ContentEntry[]; products: Product[]; pages?: PageItem[]; media?: Pick<MediaItem, 'url' | 'alt'>[]; editorData?: Record<string, unknown>; sharedBlocks?: SharedBlock[]; siteLayout?: { header: { mode: string; blockId: string }; footer: { mode: string; blockId: string } }; }
export type BindingRecord = Product | ContentEntry;
export type FieldChoice = { value: string; label: string; type: FieldType; field?: ContentField };
export const BOUND_COMPONENT_TARGETS: Record<string, BindingTarget[]> = { Heading: ['text'], Text: ['text'], Image: ['src', 'alt'], ActionButton: ['text', 'href'], Gallery: ['images'] };
const productFields: FieldChoice[] = [['name','产品名称','text'],['sku','产品型号','text'],['category','产品分类','text'],['description','产品介绍','textarea'],['detailContent','产品图文详情','textarea'],['material','材质','text'],['image','产品封面','image'],['images','产品图片（首图）','gallery'],['url','产品详情链接','url']].map(([value,label,type])=>({ value: `builtin:${value}`, label, type: type as FieldType }));
const entryFields: FieldChoice[] = [{ value: 'builtin:title', label: '内容标题', type: 'text' }, { value: 'builtin:url', label: '内容详情链接', type: 'url' }];
export function compatibleField(type: FieldType, target: BindingTarget) {
  if (target === 'images') return type === 'gallery';
  if (target === 'src') return ['image','gallery'].includes(type);
  if (target === 'href') return type === 'url';
  return !['image','gallery','relation'].includes(type);
}
export function fieldChoices(source: 'product' | 'entry', model: ContentModel | undefined, target: BindingTarget): FieldChoice[] {
  const builtins = source === 'product' ? productFields : entryFields;
  const fields:FieldChoice[]=(model?.fields||[]).flatMap(field=>field.type!=='relation'?[{value:`field:${field.id}`,label:field.label,type:field.type,field}]:isRelationDefinition(field.relation)?[{value:`related:${field.id}:title`,label:`${field.label} · 关联标题`,type:'text' as const,field},...!field.relation.multiple?[{value:`related:${field.id}:url`,label:`${field.label} · 关联详情链接`,type:'url' as const,field}]:[]]:[]);
  return [...builtins,...fields].filter(field => compatibleField(field.type, target)).map(field =>
    target === 'images' && field.value === 'builtin:images' ? { ...field, label: '产品完整图片集' } : field);
}
export function recordsForSource(source: BindingSource, kind: 'product' | 'entry', modelId?: string) {
  return (kind === 'product' ? source.products : source.contentEntries || []).filter(record => !modelId || record.modelId === modelId);
}
export function bindingRecordLabel(record: BindingRecord) { return 'name' in record ? record.name : record.title; }

/** 仅从传入快照取值；真实产品路由优先于页面里设置的编辑样本。 */
export function resolveBindingRecord(binding: Pick<FieldBinding,'source'|'mode'|'recordId'|'modelId'>, source: BindingSource, context: { bindingContext?: BindingContext; productId?: string } = {}): BindingRecord | undefined {
  const selected = binding.mode === 'fixed' ? binding.recordId : binding.source === 'product' && context.productId ? context.productId : context.bindingContext?.source === binding.source ? context.bindingContext.recordId : undefined;
  return recordsForSource(source, binding.source, binding.modelId).find(record => record.id === selected && record.status === 'published');
}
export function recordFieldValue(source: BindingSource, kind: 'product' | 'entry', record: BindingRecord | undefined, fieldKey: string, modelId?: string): { value: unknown; field?: ContentField; type?: FieldType } {
  // 草稿允许绑定仍未选字段；缺失属性和空字段同样走后备内容，不使预览崩溃。
  if (!record || typeof fieldKey !== 'string' || modelId && record.modelId !== modelId) return { value: undefined };
  if (fieldKey.startsWith('builtin:')) {
    const choice = (kind === 'product' ? productFields : entryFields).find(item => item.value === fieldKey);
    if (!choice) return { value: undefined };
    const key = fieldKey.slice(8);
    const value = key==='images'&&kind==='product'?productImages(record as Product):key === 'url' ? kind === 'entry' ? getContentEntryPath({ ...source, pages: source.pages || [] }, record as ContentEntry) : getProductPath({ ...source, pages: source.pages || [] }, record as Product) : (record as unknown as Record<string, unknown>)[key];
    return { value:key==='detailContent'&&value&&typeof value==='object'?richTextPlainText(value as RichNode):value, type: choice.type };
  }
  const model = source.contentModels?.find(item => item.id === (modelId || record.modelId));
  // 只允许关系目标的标题或单条详情地址，不支持继续访问目标的关系字段。
  const related=parseRelatedField(fieldKey);
  if(related){const field=model?.fields.find(f=>f.id===related.fieldId);if(field?.type!=='relation'||!isRelationDefinition(field.relation)||related.property==='url'&&field.relation.multiple)return {value:undefined};const targets=relatedRecords(source,field,record.customFields?.[field.id]).filter(r=>r.status==='published');return {value:related.property==='title'?targets.map(relatedTitle).join(', '):targets[0]?relatedUrl(source,field.relation,targets[0]):undefined,type:related.property==='url'?'url':'text'};}
  const field = model?.fields.find(item => `field:${item.id}` === fieldKey);
  return { field, type: field?.type, value: field ? record.customFields?.[field.id] : undefined };
}
/** 数字零和布尔否保留；图片集绑定图片时取首图，缺值只使用显式后备内容。 */
export function resolveBindingValue(binding: FieldBinding, target: Exclude<BindingTarget, 'images'>, source: BindingSource, context: { bindingContext?: BindingContext; productId?: string } = {}): string {
  const record = resolveBindingRecord(binding, source, context);
  const result = recordFieldValue(source, binding.source, record, binding.field, binding.modelId);
  let value = result.type && compatibleField(result.type, target) && !isEmptyFieldValue(result.value)
    ? target === 'src' ? Array.isArray(result.value) ? result.value[0] : result.value : formatFieldValue(result.field, result.value as Parameters<typeof formatFieldValue>[1])
    : binding.fallback || '';
  if (typeof value !== 'string') value = '';
  if (target === 'src') return isContentImage(value) ? value : '';
  if (target === 'href') return safeLinkHref(value) || '';
  return value as string;
}

/** 画廊读取实际记录的完整图片次序。缺值时省略，不回退成上一条案例或手填静态素材。 */
export function resolveGalleryBinding(binding: FieldBinding, source: BindingSource, context: { bindingContext?: BindingContext; productId?: string } = {}) {
  const record = resolveBindingRecord(binding, source, context);
  if (!record) return [];
  const { value, type } = recordFieldValue(source, binding.source, record, binding.field, binding.modelId);
  if (type !== 'gallery' || !Array.isArray(value)) return [];
  const urls = [...new Set(value.filter(isContentImage))].slice(0, MAX_GALLERY_IMAGES);
  return urls.map((src, index) => ({
    id: `bound-${index + 1}`,
    src,
    alt: source.media?.find(item => item.url === src)?.alt?.trim() || `${bindingRecordLabel(record)} (${index + 1})`,
    caption: '',
  }));
}

/** 只有Text的正文视图使用排版副本；标题、SEO和查询继续读取原有纯文字值。 */
export function resolveRichTextBinding(binding:FieldBinding,source:BindingSource,context:{bindingContext?:BindingContext;productId?:string}={}):RichNode|undefined{
  // 产品图文详情沿Text正文的原生文档通道；标题等纯文字消费者只取文字投影。
  if(binding.source==='product'&&binding.field==='builtin:detailContent'){const product=resolveBindingRecord(binding,source,context) as Product|undefined;return product?.detailContent&&!richTextErrors(product.detailContent).length?product.detailContent:undefined;}
  if(binding.source!=='entry')return;
  const record=resolveBindingRecord(binding,source,context) as ContentEntry|undefined;
  const result=recordFieldValue(source,'entry',record,binding.field,binding.modelId);
  if(result.field?.type!=='textarea'||!record)return;
  const doc=record.richTextFields?.[result.field.id];
  if(doc&&!richTextErrors(doc).length&&typeof result.value==='string'&&result.value===richTextPlainText(doc))return doc;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
function nodeWalk(value: unknown, visit: (node: Record<string, unknown>) => void) {
  if (Array.isArray(value)) { value.forEach(item => nodeWalk(item, visit)); return; }
  if (!isObject(value)) return;
  if (typeof value.type === 'string' && isObject(value.props)) visit(value);
  Object.values(value).forEach(child => nodeWalk(child, visit));
}

/** 发布依赖与字段删除保护共用同一套声明式绑定检查，不解析模板字符串或执行表达式。 */
export function contentBindingErrors(source: BindingSource, publishing = false, pageFilter?:Set<string>, routePages=source.pages): string[] {
  const errors = new Set<string>();
  const models = new Map((source.contentModels || []).map(model => [model.id, model]));
  const blocks = new Map((source.sharedBlocks || []).map(block => [block.id, block]));
  const add = (label: string, message: string) => errors.add(`${label}：${message}`);
  const modelFor = (kind: unknown, id: unknown, label: string) => {
    if (id === undefined || id === '') return undefined;
    if (!identifier(id)) add(label, '绑定模型标识无效');
    const model = models.get(String(id));
    if (!model) add(label, `绑定模型 ${id} 不存在`);
    else if (model.target !== (kind === 'product' ? 'product' : 'content')) add(label, '绑定来源与模型用途不匹配');
    return model;
  };
  const fieldCheck = (kind: 'product'|'entry', model: ContentModel | undefined, key: unknown, target: BindingTarget, label: string, required = publishing) => {
    if (key === undefined || key === '') { if (required) add(label, '请选择绑定字段'); return; }
    if (typeof key !== 'string' || !fieldChoices(kind, model, target).some(field => field.value === key)) add(label, `字段 ${String(key)} 不存在或不兼容 ${target}`);
    if (key === 'builtin:url' && publishing && kind === 'product' && !routePages?.some(page => page.slug === '/products/:slug')) add(label, '产品链接需要同时发布产品详情模板');
    const related=typeof key==='string'?parseRelatedField(key):undefined,relation=related?model?.fields.find(f=>f.id===related.fieldId)?.relation:undefined;
    if(publishing&&related?.property==='url'&&isRelationDefinition(relation)){if(relation.source==='product'&&!routePages?.some(p=>p.slug==='/products/:slug'))add(label,'关联产品链接需要同时发布产品详情模板');if(relation.source==='entry'&&!routePages?.some(p=>p.contentModelId===relation.modelId))add(label,'关联内容链接需要同时发布目标模型的详情模板');}
  };
  const contextCheck = (raw: unknown, label: string): BindingContext | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (!isObject(raw)) { add(label, '页面内容上下文必须是对象'); return undefined; }
    if (!Object.keys(raw).length) return undefined;
    if (Object.keys(raw).some(key => !['source','recordId','modelId'].includes(key))) add(label, '页面内容上下文包含未知属性');
    if (!['product','entry'].includes(String(raw.source))) { add(label, '页面内容来源无效'); return undefined; }
    modelFor(raw.source, raw.modelId, label);
    if (!raw.recordId) { if (publishing) add(label, '请选择页面默认内容记录'); return undefined; }
    if (!identifier(raw.recordId)) add(label, '页面内容记录标识无效');
    const record = recordsForSource(source, raw.source as 'product'|'entry').find(item => item.id === raw.recordId);
    if (!record) add(label, `页面内容记录 ${raw.recordId} 不存在`);
    else if (raw.modelId && record.modelId !== raw.modelId) add(label, '页面内容记录与所选模型不匹配');
    // 上下文允许不重复保存模型 ID，但发布时仍需按真实记录检查绑定模型。
    return { source: raw.source as 'product'|'entry', recordId: String(raw.recordId), modelId: record?.modelId || (typeof raw.modelId === 'string' ? raw.modelId : undefined) };
  };
  type DynamicScope = { source: 'product'|'entry'; modelId?: string };
  const entryUrlCheck = (kind: 'product'|'entry', key: unknown, modelId: string | undefined, label: string, required = true) => {
    // 模板资产的虚拟页面只提供绑定上下文；真实网址依赖始终核对当前候选的实际页面。
    if (publishing && required && kind === 'entry' && key === 'builtin:url' && (!modelId || !getContentTemplate({ ...source, pages: routePages || [] }, modelId))) add(label, '内容链接需要同时发布该模型的详情模板');
  };
  const bindingCheck = (raw: unknown, target: BindingTarget, label: string, context: BindingContext | undefined, dynamicScope: DynamicScope | undefined, checkCurrent: boolean) => {
    if (!isObject(raw)) { add(label, '动态绑定必须是对象'); return; }
    if (Object.keys(raw).some(key => !['source','mode','modelId','recordId','field','fallback'].includes(key))) add(label, '动态绑定包含未知属性');
    if (!['product','entry'].includes(String(raw.source)) || !['current','fixed'].includes(String(raw.mode))) { add(label, '动态绑定来源或方式无效'); return; }
    const kind = raw.source as 'product'|'entry';
    const model = modelFor(kind, raw.modelId, label);
    fieldCheck(kind, model, raw.field, target, label);
    if (raw.fallback !== undefined && (typeof raw.fallback !== 'string' || raw.fallback.length > 30000)) add(label, '绑定后备内容需为不超过30000字符的文本');
    if (raw.fallback && target === 'src' && !isContentImage(raw.fallback)) add(label, '绑定图片后备内容需来自素材库');
    if (raw.fallback && target === 'href' && !safeLinkHref(raw.fallback)) add(label, '绑定链接后备内容不安全');
    if (raw.fallback && target === 'images') add(label, '动态图片集需直接读取记录，缺值时省略');
    if (raw.mode === 'fixed') {
      if (!raw.recordId) { if (publishing) add(label, '请选择固定绑定记录'); return; }
      if (!identifier(raw.recordId)) add(label, '固定绑定记录标识无效');
      const record = recordsForSource(source, kind).find(item => item.id === raw.recordId);
      if (!record) add(label, `固定绑定记录 ${raw.recordId} 不存在`);
      else if (raw.modelId && record.modelId !== raw.modelId) add(label, '固定绑定记录与模型不匹配');
      entryUrlCheck(kind, raw.field, record?.modelId || model?.id, label);
    } else {
      const effective = dynamicScope || context;
      if (publishing && checkCurrent) {
        if (!effective || effective.source !== kind) add(label, '当前记录绑定需要页面内容上下文、匹配的详情模板或循环列表');
        else if (raw.modelId && effective.modelId && raw.modelId !== effective.modelId) add(label, '当前记录绑定与页面模型不匹配，或循环来源模型不同');
        else if (raw.modelId && !effective.modelId && !dynamicScope) add(label, '当前记录绑定与页面模型不匹配');
      }
      entryUrlCheck(kind, raw.field, effective?.source === kind ? effective.modelId || model?.id : model?.id, label, checkCurrent);
    }
  };
  const walkData = (data: unknown, label: string, inherited?: BindingContext, dynamicScope?: DynamicScope, blockPath: string[] = [], checkCurrent = true, budget = { visits: 0 }) => {
    if (!isObject(data)) return;
    const root = isObject(data.root) && isObject(data.root.props) ? data.root.props : {};
    // 复用区块继承调用页面上下文，资产自身的编辑样本不会固定公开页面的动态产品。
    const context = blockPath.length || dynamicScope?.source === 'entry' || publishing && !checkCurrent ? inherited : contextCheck(root.bindingContext, label);
    nodeWalk(data.content, node => {
      if (++budget.visits > 10000) { add(label, '动态绑定检查的展开组件超过10000个'); return; }
      const props = node.props as Record<string, unknown>, type = String(node.type), nodeLabel = `${label} / ${String(props.id || type)}`;
      if (props.bindings !== undefined) {
        if (!isObject(props.bindings)) add(nodeLabel, '动态绑定列表必须是对象');
        else for (const [target, binding] of Object.entries(props.bindings)) {
          if (!BOUND_COMPONENT_TARGETS[type]?.includes(target as BindingTarget)) add(nodeLabel, `组件不支持 ${target} 绑定`);
          else bindingCheck(binding, target as BindingTarget, nodeLabel, context, dynamicScope, checkCurrent);
        }
      }
      if (type === 'ContentList') {
        if (!['product','entry'].includes(String(props.source))) { add(nodeLabel, '内容列表来源无效'); return; }
        const kind = props.source as 'product'|'entry';
        const model = modelFor(kind, props.modelId, nodeLabel);
        if (kind === 'entry' && !model && publishing) add(nodeLabel, '独立内容列表必须选择内容模型');
        for (const [key,target] of [['titleField','text'],['descriptionField','text'],['imageField','src'],['linkField','href']] as const) { fieldCheck(kind, model, props[key], target, nodeLabel, key === 'titleField' && publishing); entryUrlCheck(kind, props[key], model?.id, nodeLabel); }
        if (props.emptyText !== undefined && (typeof props.emptyText !== 'string' || props.emptyText.length > 2000)) add(nodeLabel, '空列表提示需为2000字符内文本');
      }
      if (type === 'ContentLoop') {
        if (!['product','entry'].includes(String(props.source))) { add(nodeLabel, '循环列表来源无效'); return; }
        const kind = props.source as 'product'|'entry', model = modelFor(kind, props.modelId, nodeLabel);
        if(props.relation!==undefined){
          const descriptor=props.relation,field=relationLoopField(source,descriptor),owner=isRelationLoop(descriptor)?descriptor:undefined;
          if(!owner||!field)add(nodeLabel,'当前记录关系来源无效或字段不存在');
          else {
            if(field.relation!.source!==kind||(field.relation!.modelId||'')!==(props.modelId||''))add(nodeLabel,'关系循环的输出模型必须与关系字段目标一致');
            const effective=dynamicScope||context;
            if(publishing&&checkCurrent&&(!effective||effective.source!==owner.source||effective.modelId&&effective.modelId!==owner.modelId||!effective.modelId&&!dynamicScope))add(nodeLabel,'关系循环需要匹配所属模型的当前记录上下文');
          }
        }
        if (kind === 'entry' && !model && publishing) add(nodeLabel, '独立内容循环列表必须选择内容模型');
        if (!props.itemBlockId && publishing) add(nodeLabel, '循环列表必须选择卡片模板');
        const block = typeof props.itemBlockId === 'string' ? blocks.get(props.itemBlockId) : undefined;
        // 卡片的样本仅供编辑；每次调用都用列表来源覆盖父页面和区块样本。
        if (block && !blockPath.includes(block.id) && blockPath.length < 8) walkData(block.data, `${nodeLabel} / ${block.name}`, undefined, { source: kind, modelId: model?.id }, [...blockPath, block.id], checkCurrent, budget);
      }
      if (type === 'SharedBlock' && typeof props.blockId === 'string' && !blockPath.includes(props.blockId) && blockPath.length < 8) {
        const block = blocks.get(props.blockId); if (block) walkData(block.data, `${label} / ${block.name}`, context, dynamicScope, [...blockPath, block.id], checkCurrent, budget);
      }
    });
    if (isObject(data.zones)) for (const content of Object.values(data.zones)) walkData({ content }, label, context, dynamicScope, [...blockPath, '__legacy'], checkCurrent, budget);
  };
  for (const page of source.pages || []) {
    if(pageFilter&&!pageFilter.has(page.id))continue;
    const data = source.editorData?.[page.id];
    const scope: DynamicScope | undefined = page.contentModelId ? { source: 'entry', modelId: page.contentModelId } : page.slug === '/products/:slug' ? { source: 'product' } : undefined;
    walkData(data, `页面“${page.title}”`, undefined, scope);
    const root = isObject(data) && isObject(data.root) && isObject(data.root.props) ? data.root.props : {};
    const context = page.contentModelId ? undefined : contextCheck(root.bindingContext, `页面“${page.title}”`);
    if (root.showChrome !== 'no') for (const slot of ['header','footer'] as const) {
      const setting = source.siteLayout?.[slot], block = setting?.mode === 'block' ? blocks.get(setting.blockId) : undefined;
      if (block && root[`${slot}Mode`] !== 'hidden') walkData(block.data, `页面“${page.title}” / ${slot}`, context, scope, [block.id]);
    }
  }
  for (const block of source.sharedBlocks || []) walkData(block.data, `同步区块“${block.name}”`, undefined, undefined, [], false);
  return [...errors];
}

/** 引用只来自正式绑定字段；字段值中的普通同名文本不当成模型或记录引用。 */
export function collectBindingReferences(source: BindingSource) {
  const modelIds = new Set<string>(), entryIds = new Set<string>(), productIds = new Set<string>();
  const add = (binding: unknown, context = false) => {
    if (!isObject(binding)) return;
    if (typeof binding.modelId === 'string' && binding.modelId) modelIds.add(binding.modelId);
    if ((context || binding.mode === 'fixed') && typeof binding.recordId === 'string' && binding.recordId) (binding.source === 'product' ? productIds : entryIds).add(binding.recordId);
  };
  const inspect = (data: unknown, includeContext = true) => {
    if (!isObject(data)) return;
    if (includeContext && isObject(data.root) && isObject(data.root.props)) add(data.root.props.bindingContext, true);
    nodeWalk(data, node => {
      const props = node.props as Record<string, unknown>;
      if (isObject(props.bindings)) Object.values(props.bindings).forEach(value=>add(value));
      if (['ContentList','ContentLoop'].includes(String(node.type)) && typeof props.modelId === 'string' && props.modelId) modelIds.add(props.modelId);
      if(node.type==='ContentLoop'&&isRelationLoop(props.relation))modelIds.add(props.relation.modelId);
    });
  };
  // 内容详情模板的默认记录是可替换编辑样本，不是正式版本和删除保护的固定依赖。
  for (const page of source.pages || []) { if (page.contentModelId) modelIds.add(page.contentModelId); inspect(source.editorData?.[page.id], !page.contentModelId); }
  for (const block of source.sharedBlocks || []) inspect(block.data, false);
  for (const t of source.pageTemplates || []) { if (t.modelId) modelIds.add(t.modelId);if(t.detailRule?.modelId)modelIds.add(t.detailRule.modelId);for(const id of t.detailRule?.recordIds||[])(t.kind==='product'?productIds:entryIds).add(id); inspect(t.data, t.kind === 'page'); }
  const relations=relationReferences(source);for(const id of relations.modelIds)modelIds.add(id);for(const id of relations.entryIds)entryIds.add(id);for(const id of relations.productIds)productIds.add(id);
  return { modelIds, entryIds, productIds };
}
