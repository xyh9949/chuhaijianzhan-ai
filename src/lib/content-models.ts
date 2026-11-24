import type { ContentField, ContentModel, FieldType, FieldValue } from './types';
import { isLocalImagePath } from './bundled-media';
import { safeLinkHref } from './site-safety';
import {isRelationDefinition,MAX_RELATION_ITEMS} from './content-relations';

export const FIELD_TYPE_LABELS: Record<FieldType, string> = { text: '单行文本', textarea: '多行文本', number: '数字', boolean: '是 / 否', date: '日期', select: '单选', multiselect: '多选', image: '图片', gallery: '图片集', url: '链接',relation:'关联内容' };
export const FIELD_TYPES = Object.keys(FIELD_TYPE_LABELS) as FieldType[];
export const MAX_GALLERY_IMAGES = 20;

/** 0 和 false 是有效值；null、空字符串、空列表表示尚未填写。 */
export function isEmptyFieldValue(value: unknown): boolean { return value === undefined || value === null || typeof value === 'string' && !value.trim() || Array.isArray(value) && value.length === 0; }
export const isContentImage = isLocalImagePath;
export function isContentDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 客户端表单与服务器共用字段规则；必填只在发布时强制，草稿仍验证非空值类型。 */
export function validateFieldValue(field: ContentField, value: unknown, options: { required?: boolean } = {}): string[] {
  const fail = (message: string) => [`${field.label}：${message}`];
  if (isEmptyFieldValue(value) && (!Array.isArray(value) || ['gallery', 'multiselect'].includes(field.type)||field.type==='relation'&&field.relation?.multiple===true)) return options.required && field.required ? fail('请填写此必填字段') : [];
  const selected = new Set((field.options || []).map((option) => option.value));
  switch (field.type) {
    case 'text': case 'textarea':
      return typeof value === 'string' && value.length <= (field.type === 'text' ? 2000 : 30000) ? [] : fail(`需为不超过 ${field.type === 'text' ? 2000 : 30000} 字符的文本`);
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('需为有限数字');
      if (field.min !== undefined && value < field.min) return fail(`不能小于 ${field.min}`);
      if (field.max !== undefined && value > field.max) return fail(`不能大于 ${field.max}`);
      return [];
    case 'boolean': return typeof value === 'boolean' ? [] : fail('需选择是或否');
    case 'date': return isContentDate(value) ? [] : fail('需为真实日期 YYYY-MM-DD');
    case 'select': return typeof value === 'string' && selected.has(value) ? [] : fail('所选值不在模型选项中');
    case 'multiselect': return Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === 'string' && selected.has(item)) && new Set(value).size === value.length ? [] : fail('需为模型选项组成的不重复列表');
    case 'image': return isContentImage(value) ? [] : fail('请从素材库选择图片');
    case 'gallery': return Array.isArray(value) && value.length <= MAX_GALLERY_IMAGES && value.every(isContentImage) && new Set(value).size === value.length ? [] : fail(`需为不重复的素材图片列表，最多 ${MAX_GALLERY_IMAGES} 张`);
    case 'url': return typeof value === 'string' && value.length <= 2000 && Boolean(safeLinkHref(value)) ? [] : fail('请输入有效的站内、http(s)、mailto 或 tel 链接');
    case 'relation':{
      if(!isRelationDefinition(field.relation))return fail('关系目标或选择方式无效');
      const valid=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v);
      return field.relation.multiple?Array.isArray(value)&&value.length<=MAX_RELATION_ITEMS&&value.every(valid)&&new Set(value).size===value.length?[]:fail(`请选择不重复的内容记录，最多${MAX_RELATION_ITEMS}条`):valid(value)?[]:fail('请选择一条内容记录');
    }
    default: return fail('字段类型不受支持');
  }
}

export function validateModelValues(model: ContentModel, values: unknown, publishing = false): string[] {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return ['扩展字段值必须是对象'];
  const record = values as Record<string, unknown>, fields = new Map(model.fields.map((field) => [field.id, field]));
  const errors = Object.keys(record).filter((id) => !fields.has(id)).map((id) => `模型“${model.name}”不存在字段 ${id}，请先清除旧值再删除字段`);
  for (const field of model.fields) errors.push(...validateFieldValue(field, record[field.id], { required: publishing }));
  return errors;
}

/** 显示保持 false/0，与缺失区分；选项存稳定值、展示标签，数值单位由模型统一维护。 */
export function formatFieldValue(field: ContentField | undefined, value: FieldValue | undefined): string {
  if (isEmptyFieldValue(value)) return '';
  if (field?.type === 'select') return field.options?.find((option) => option.value === value)?.label || String(value);
  if (field?.type === 'multiselect' && Array.isArray(value)) return value.map((item) => field.options?.find((option) => option.value === item)?.label || item).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return `${value}${field?.unit ? ` ${field.unit}` : ''}`;
  return Array.isArray(value) ? value.join(', ') : String(value);
}
