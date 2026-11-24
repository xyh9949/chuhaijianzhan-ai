import type { FormDefinition, FormFieldDefinition, StudioState } from './types';
type Source = Pick<StudioState, 'editorData'> & Partial<Pick<StudioState, 'forms' | 'sharedBlocks'>>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (v: unknown) => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(v) && !['constructor', 'prototype', '__proto__'].includes(v);
const text = (v: unknown, max: number, required = false) => typeof v === 'string' && v.length <= max && (!required || !!v.trim());
export const FORM_FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'select', 'checkbox', 'country', 'product'] as const;
const mapTypes: Record<string, string[]> = { name: ['text'], company: ['text'], email: ['email'], phone: ['phone'], country: ['country', 'text', 'select'], product: ['product'], message: ['textarea', 'text'] };

/** 定义与视觉分开版本化；禁止把收件人、凭据或可执行配置混入公开表单定义。 */
export function formContentErrors(source: Source, publishing = false): string[] {
  const errors: string[] = [], forms = source.forms || [];
  if (!Array.isArray(forms) || forms.length > 100) return ['表单定义最多100个'];
  const ids = new Set();
  for (const form of forms) {
    if (!record(form) || !validId(form.id) || ids.has(form.id) || !text(form.name, 120, true) || typeof form.enabled !== 'boolean' || form.multiProduct !== undefined && typeof form.multiProduct !== 'boolean' || !text(form.submitLabel, 80, true) || !text(form.successMessage, 500, true) || Object.keys(form).some(k => !['id', 'name', 'enabled', 'fields', 'submitLabel', 'successMessage', 'multiProduct'].includes(k))) { errors.push('表单ID、名称、开关或公开定义无效'); continue; }
    ids.add(form.id);
    if (!Array.isArray(form.fields) || !form.fields.length || form.fields.length > 32) { errors.push(`表单${form.name}需要1–32个字段`); continue; }
    const fieldIds = new Set(), mappings = new Set();
    for (const field of form.fields) {
      if (!record(field) || !validId(field.id) || fieldIds.has(field.id) || !text(field.label, 200, true) || !FORM_FIELD_TYPES.includes(field.type as never) || typeof field.required !== 'boolean' || Object.keys(field).some(k => !['id', 'label', 'type', 'required', 'placeholder', 'maxLength', 'options', 'mapTo'].includes(k))) { errors.push(`表单${form.name}的字段ID、名称或类型无效`); continue; }
      fieldIds.add(field.id);
      if (field.placeholder !== undefined && !text(field.placeholder, 300)) errors.push('字段提示最多300字符');
      if (field.maxLength !== undefined && (['select', 'product', 'checkbox'].includes(String(field.type)) || !Number.isInteger(field.maxLength) || Number(field.maxLength) < 1 || Number(field.maxLength) > (field.type === 'textarea' ? 10000 : field.type === 'email' ? 254 : field.type === 'phone' ? 40 : field.type === 'country' ? 100 : 2000))) errors.push('字段长度必须为允许范围内的整数');
      if (field.mapTo !== undefined && (typeof field.mapTo !== 'string' || !Object.hasOwn(mapTypes, field.mapTo) || !mapTypes[field.mapTo].includes(field.type) || mappings.has(field.mapTo))) errors.push('系统资料映射重复或与字段类型不兼容');
      if (field.mapTo !== undefined) mappings.add(field.mapTo);
      if (field.type === 'select') {
        if (!Array.isArray(field.options) || !field.options.length || field.options.length > 100) errors.push('下拉字段需要1–100个选项');
        else { const options = new Set(); for (const option of field.options) if (!record(option) || !validId(option.id) || options.has(option.id) || !text(option.label, 200, true) || Object.keys(option).some(k => !['id', 'label'].includes(k))) errors.push('下拉选项ID、名称无效或重复'); else options.add(option.id); }
      } else if (field.options !== undefined && (!Array.isArray(field.options) || field.options.length)) errors.push('只有下拉字段可配置选项');
    }
  }
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; } if (!record(v)) return;
    if (v.type === 'Form' && record(v.props)) {
      const id = v.props.formId;
      if (v.props.buttonAlign !== undefined && (typeof v.props.buttonAlign !== 'string' || !['left', 'center', 'right'].includes(v.props.buttonAlign))) errors.push('表单按钮对齐无效');
      if (v.props.wideFields !== undefined && (!Array.isArray(v.props.wideFields) || v.props.wideFields.length > 32 || new Set(v.props.wideFields).size !== v.props.wideFields.length || v.props.wideFields.some(f => !validId(f)))) errors.push('表单整行字段配置无效');
      if (id !== undefined && id !== '' && !forms.some(f => f?.id === id) || publishing && !forms.some(f => f?.id === id)) errors.push('页面引用的表单不存在，请同时发布定义或解除引用');
    }
    Object.values(v).forEach(walk);
  };
  Object.values(source.editorData).forEach(walk); source.sharedBlocks?.forEach(b => walk(b.data));
  return [...new Set(errors)];
}
export function createFormDefinition(id = `form-${crypto.randomUUID()}`): FormDefinition {
  const field = (label: string, type: FormFieldDefinition['type'], mapTo: FormFieldDefinition['mapTo'], required = true): FormFieldDefinition => ({ id: `field-${crypto.randomUUID()}`, label, type, mapTo, required, maxLength: type === 'textarea' ? 4000 : type === 'email' ? 254 : 150 });
  return { id, name: '网站询盘', enabled: true, submitLabel: 'Send inquiry', successMessage: 'Thank you. Your inquiry has been received.', fields: [field('Name', 'text', 'name'), field('Email', 'email', 'email'), field('Company', 'text', 'company', false), field('Message', 'textarea', 'message')] };
}
/** 导出面向Excel时防止公式执行，保留UTF-8中文与原始换行，字段内容不拼接成公式。 */
export function safeCsvCell(value: unknown): string {
  let cell = value == null ? '' : String(value);
  if (/^[\s\u0000]*[=+@-]/.test(cell) || /^[\t\r\n]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}
export function csvDocument(rows: unknown[][]): string { return '\ufeff' + rows.map(row => row.map(safeCsvCell).join(',')).join('\r\n'); }
