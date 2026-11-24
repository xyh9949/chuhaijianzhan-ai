import { ApiError } from './http';
import { FIELD_TYPES, validateModelValues } from '../lib/content-models';
import type { ContentField, ContentModel } from '../lib/types';
import type { DraftContent, SiteSnapshot } from './types';
import {isRelationDefinition,relationErrors} from '../lib/content-relations';
import {richTextErrors,richTextPlainText} from '../lib/presentation-content';

function fail(message: string): never { throw new ApiError(422, message); }
const record = (value: unknown, label: string): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail(`${label}必须是对象`);
const text = (value: unknown, label: string, max: number, required = false): string => typeof value === 'string' && value.length <= max && (!required || !!value.trim()) ? value : fail(`${label}${required ? '不能为空且' : ''}需为不超过 ${max} 字符的文本`);
const id = (value: unknown, label: string): string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value) ? value : fail(`${label}格式不正确`);
const list = (value: unknown, label: string, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : fail(`${label}最多 ${max} 项`);
function known(value: Record<string, unknown>, keys: string[], label: string) { if (Object.keys(value).some((key) => !keys.includes(key))) fail(`${label}包含不支持的字段`); }
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) fail(`${label}不能重复`); }

type ContentState = Pick<SiteSnapshot, 'products' | 'contentModels' | 'contentEntries'>;

/** 模型本身严格校验；可选字段缺失不触发旧客户数据迁移。 */
export function validateContentState(source: ContentState, publishing = false): void {
  const models = source.contentModels === undefined ? [] : list(source.contentModels, '内容模型', 100).map((value) => {
    const model = record(value, '内容模型'); known(model, ['id', 'name', 'description', 'target', 'fields', 'updated'], '内容模型');
    id(model.id, '模型 ID'); text(model.name, '模型名称', 120, true); text(model.description, '模型说明', 2000); text(model.updated, '模型更新时间', 100);
    if (!['product', 'content'].includes(String(model.target))) fail('模型用途需为产品或独立内容');
    const fields = list(model.fields, '模型字段', 100).map((value) => {
      const field = record(value, '自定义字段'); known(field, ['id', 'key', 'label', 'type', 'required', 'description', 'unit', 'min', 'max', 'options','relation'], '自定义字段');
      id(field.id, '字段 ID'); text(field.key, '字段键', 64, true); text(field.label, '字段名称', 120, true);
      if (!/^[a-z][a-z0-9_]*$/.test(String(field.key)) || ['__proto__', 'prototype', 'constructor'].includes(String(field.key))) fail('字段键需以小写字母开头，只使用小写字母、数字和下划线');
      if (!FIELD_TYPES.includes(field.type as ContentField['type'])) fail('自定义字段类型不受支持');
      if (typeof field.required !== 'boolean') fail('请明确设置字段是否必填');
      if(field.type==='relation'?!isRelationDefinition(field.relation):field.relation!==undefined)fail('请为关系字段设置有效目标与选择方式，普通字段不能包含关系定义');
      if (field.description !== undefined) text(field.description, '字段说明', 2000);
      if (field.unit !== undefined) text(field.unit, '字段单位', 40);
      if (field.unit && field.type !== 'number') fail('只有数字字段可以设置单位');
      for (const key of ['min', 'max']) if (field[key] !== undefined && (field.type !== 'number' || typeof field[key] !== 'number' || !Number.isFinite(field[key]))) fail('数字字段的最小值和最大值必须为有限数字');
      if (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max) fail('字段最小值不能大于最大值');
      if (field.type === 'select' || field.type === 'multiselect') {
        const options = list(field.options, '字段选项', 100).map((value) => {
          const option = record(value, '字段选项'); known(option, ['label', 'value'], '字段选项');
          text(option.label, '选项名称', 120, true); return text(option.value, '选项值', 100, true);
        });
        if (!options.length) fail('选择字段至少需要一个选项');
        unique(options, '选项值');
      } else if (field.options !== undefined && (!Array.isArray(field.options) || field.options.length)) fail('只有选择字段可以设置选项');
      return field as unknown as ContentField;
    });
    unique(fields.map((field) => field.id), '字段 ID'); unique(fields.map((field) => field.key), '字段键');
    return model as unknown as ContentModel;
  });
  unique(models.map((model) => model.id), '模型 ID');
  const byId = new Map(models.map((model) => [model.id, model]));
  const validateRecord = (modelId: unknown, values: unknown, target: ContentModel['target'], label: string) => {
    // 未选择模型允许缺失或空字符串；false/0/null 不能冒充缺省模型，也不能把空值对象伪装成 null。
    if ((modelId === undefined || modelId === '') && target === 'product') { if (values !== undefined && Object.keys(record(values, `${label}扩展字段`)).length) fail(`${label}需先选择产品模型或清空扩展字段`); return; }
    const model = byId.get(id(modelId, `${label}模型`));
    if (!model || model.target !== target) fail(`${label}引用的${target === 'product' ? '产品' : '内容'}模型不存在或用途不匹配`);
    const errors = validateModelValues(model, values === undefined ? {} : record(values, `${label}扩展字段`), publishing);
    if (errors.length) fail(`${label}：${errors.join('；')}`);
  };
  for (const product of source.products) {
    if('richTextFields'in product&&product.richTextFields!==undefined)fail('排版正文只能用于内容记录，不能写入产品参数');
    validateRecord(product.modelId, product.customFields, 'product', `产品“${product.name}”`);
  }
  const entries = source.contentEntries === undefined ? [] : list(source.contentEntries, '内容记录', 2000).map((value) => {
    const entry = record(value, '内容记录'); known(entry, ['id', 'modelId', 'title', 'status', 'updated', 'customFields','richTextFields', 'slug', 'seoTitle', 'seoDescription', 'seoImage', 'noindex', 'termIds', 'sortOrder','locale','translationGroupId','translationState'], '内容记录');
    const entryId = id(entry.id, '内容记录 ID'); text(entry.title, '内容标题', 200, true); text(entry.updated, '内容更新时间', 100);
    if (!['draft', 'published'].includes(String(entry.status))) fail('内容记录状态无效');
    // 地址只接受单个安全路径段；留空使用稳定 ID，不能注入斜线、编码路径或系统查询参数。
    if (entry.slug !== undefined && (typeof entry.slug !== 'string' || entry.slug !== '' && !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(entry.slug))) fail('内容地址需为最多100位的小写字母、数字、下划线或连字符，留空使用记录 ID');
    if (entry.seoTitle !== undefined) text(entry.seoTitle, '内容 SEO 标题', 200);
    if (entry.seoDescription !== undefined) text(entry.seoDescription, '内容 SEO 描述', 1000);
    validateRecord(entry.modelId, record(entry.customFields, '内容扩展字段'), 'content', `内容“${entry.title}”`);
    // 排版副本只属于该栏目的多行文本；投影不一致整笔拒绝，不猜测哪份正文才是新值。
    if(entry.richTextFields!==undefined){
      const docs=record(entry.richTextFields,'排版正文'),model=byId.get(String(entry.modelId))!,values=entry.customFields as Record<string,unknown>;
      if(Object.keys(docs).length>100)fail('排版正文最多100个填写项目');
      for(const [fieldId,doc]of Object.entries(docs)){
        const field=model.fields.find(f=>f.id===fieldId);
        if(!field||field.type!=='textarea')fail('排版正文只能对应当前栏目的已有多行文本项目');
        const errors=richTextErrors(doc);if(errors.length)fail(`${field.label}：${errors.join('；')}`);
        const plain=richTextPlainText(doc as import('../lib/presentation-content').RichNode);
        if(plain.length>30000)fail(`${field.label}：正文纯文字最多30000字符`);
        if(typeof values[fieldId]!=='string'||values[fieldId]!==plain)fail(`${field.label}：排版正文与纯文字不同，请同步保存或明确清除排版副本`);
      }
    }
    return entryId;
  });
  unique(entries, '内容记录 ID');
  const relations=relationErrors(source);if(relations.length)fail(relations.join('；'));
}

/** 稳定标识的含义不能原地改变；另建字段/模型后显式迁移，历史快照仍保留原定义。 */
export function validateModelEvolution(previous: DraftContent, next: DraftContent) {
  for (const model of next.contentModels || []) {
    const old = previous.contentModels?.find((item) => item.id === model.id);
    if (!old) continue;
    if (old.target !== model.target) fail(`模型“${old.name}”用途创建后不能更改，请新建模型`);
    for (const field of model.fields) {
      const before = old.fields.find((item) => item.id === field.id);
      if (before && (before.key !== field.key || before.type !== field.type)) fail(`字段“${before.label}”的键和类型创建后不能更改，请新建字段`);
      if(before?.type==='relation'&&(['source','modelId','multiple','onDelete'] as const).some(key=>before.relation?.[key]!==field.relation?.[key]))fail(`关系字段“${before.label}”的目标与单多选创建后不能更改，请新建字段并迁移值`);
    }
  }
  // 旧客户端替换整条记录时不能无声丢弃排版；主动恢复旧版本走独立恢复流程，不受此保存保护影响。
  for(const entry of next.contentEntries||[]){
    const old=previous.contentEntries?.find(v=>v.id===entry.id);
    if(old?.richTextFields&&Object.keys(old.richTextFields).length&&entry.richTextFields===undefined)fail(`内容“${entry.title}”包含排版正文，请保留排版副本；纯文字替换需明确提交richTextFields:{}`);
  }
}
