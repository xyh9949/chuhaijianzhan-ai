import type { ActorIdentity } from './types';
import { bundledImage } from '../lib/bundled-media';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { ContentEntry, ContentField, FieldValue, Product } from '../lib/types';
import { validateModelValues } from '../lib/content-models';
import { IMPORT_MAX_BYTES, parseImportFile, type ContentImportSpec, type ImportIssue, type ImportPreview } from '../lib/content-import';
import { PRODUCT_CONTENT_LIMITS } from '../lib/product-content-limits';
import { getAuthEnvironment } from './env';
import { ApiError, readBodyBytes } from './http';
import { getDraftRecord, patchStudio } from './studio';
import { object, revision, text, validateDraft } from './validation';

const productFields = ['name', 'sku', 'category', 'description', 'material', 'image', 'images', 'slug', 'seoTitle', 'seoDescription', 'sortOrder'];
const entryFields = ['title', 'slug', 'seoTitle', 'seoDescription', 'sortOrder'];
/** 批量数据禁止用替换字符猜测编码，避免文件在浏览器外提交时静默损坏。 */
export async function readImportRequest(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, '请使用JSON导入请求');
  const bytes = await readBodyBytes(request, 5 * 1024 * 1024);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new ApiError(400, '导入请求不是有效UTF-8 JSON'); }
}
function canonical(value: unknown): string { return value && typeof value === 'object' && !Array.isArray(value) ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value); }
function signature(spec: ContentImportSpec, rev: number, issuedAt: number) { return createHmac('sha256', getAuthEnvironment().secret).update(`content-import:${rev}:${issuedAt}:${canonical(spec)}`).digest('base64url'); }
function readSpec(value: unknown): { spec: ContentImportSpec; expectedRevision: number; confirmation?: string } {
  const input = object(value, '导入请求');
  if (Object.keys(input).some(k => !['format', 'content', 'target', 'modelId', 'mapping', 'expectedRevision', 'confirmation'].includes(k)) || !['csv', 'json'].includes(String(input.format)) || !['product', 'entry'].includes(String(input.target))) throw new ApiError(422, '导入类型或范围无效');
  const content = text(input.content, '导入文件', IMPORT_MAX_BYTES, true); if (Buffer.byteLength(content) > IMPORT_MAX_BYTES) throw new ApiError(413, '导入文件最多2 MB；请分批导入');
  const mapping = object(input.mapping, '字段映射'); if (Object.keys(mapping).length > 110 || Object.values(mapping).some(v => typeof v !== 'string' || v.length > 130)) throw new ApiError(422, '字段映射无效');
  if (input.modelId !== undefined) text(input.modelId, '内容模型', 100);
  return { spec: { format: input.format as ContentImportSpec['format'], content, target: input.target as ContentImportSpec['target'], modelId: input.modelId as string | undefined, mapping: mapping as Record<string, string> }, expectedRevision: revision(input.expectedRevision), confirmation: input.confirmation as string | undefined };
}
/** Excel 显示值与 CSV 共用数字、布尔和列表的文本转换规则。 */
export function fieldValue(raw: unknown, field: ContentField, csv: boolean): FieldValue | undefined {
  if (raw === undefined || raw === null || csv && raw === '') return undefined;
  const many=field.type==='relation'&&field.relation?.multiple;
  if (csv && (['number', 'boolean', 'multiselect', 'gallery'].includes(field.type)||many)) { try { raw = JSON.parse(String(raw)); } catch { throw new Error('数字/布尔使用JSON字面值，多个值及多条关联使用JSON文本数组'); } }
  if (['number', 'boolean'].includes(field.type)) { if (typeof raw !== field.type || typeof raw === 'number' && !Number.isFinite(raw)) throw new Error(`需要${field.type === 'number' ? '有限数字' : 'true或false'}`); }
  else if (['multiselect', 'gallery'].includes(field.type)||many) { if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string')) throw new Error('需要文本数组'); }
  else if (typeof raw !== 'string') throw new Error('需要文本；日期格式为YYYY-MM-DD');
  return raw as FieldValue;
}
function prepare(spec: ContentImportSpec, expectedRevision: number) {
  const draft = getDraftRecord(); if (draft.revision !== expectedRevision) throw new ApiError(409, '工作区已变化，请重新预检；尚未写入任何记录');
  let parsed: ReturnType<typeof parseImportFile>;
  try { parsed = parseImportFile(spec.format, spec.content, spec.target); } catch (e) { throw new ApiError(422, (e as Error).message); }
  const model = draft.content.contentModels?.find(m => m.id === spec.modelId);
  if (spec.modelId && (!model || model.target !== (spec.target === 'entry' ? 'content' : 'product')) || spec.target === 'entry' && !model) throw new ApiError(422, '请先选择用途匹配的已有内容模型');
  const builtin = spec.target === 'product' ? productFields : entryFields;
  const allowed = new Set(['builtin:key', ...builtin.map(k => `builtin:${k}`), ...(model?.fields.map(f => `field:${f.id}`) || [])]);
  const selected = Object.entries(spec.mapping).filter(([, v]) => v);
  if (selected.some(([k, v]) => !parsed.headers.includes(k) || !allowed.has(v)) || new Set(selected.map(([, v]) => v)).size !== selected.length) throw new ApiError(422, '映射含未知列/字段或多个列映射到同一字段');
  const required = spec.target === 'product' ? ['builtin:name', 'builtin:sku'] : ['builtin:key', 'builtin:title'];
  if (required.some(k => !selected.some(([, v]) => v === k))) throw new ApiError(422, spec.target === 'product' ? '必须映射产品名称和型号SKU' : '必须映射稳定导入key和内容标题');
  const errors: ImportIssue[] = [], products: Product[] = [], entries: ContentEntry[] = [], preview: ImportPreview['rows'] = [];
  const ids = new Set([...draft.content.products, ...(draft.content.contentEntries || [])].map(r => r.id));
  const slugs = new Set([...(spec.target === 'product' ? draft.content.products : (draft.content.contentEntries || []).filter(e => e.modelId === spec.modelId))].map(r => r.slug || r.id));
  const skus = new Set(draft.content.products.map(p => p.sku.trim().toLowerCase())), keys = new Set<string>();
  for (const [i, raw] of parsed.rows.entries()) {
    const row = parsed.lineNumbers[i], values: Record<string, unknown> = {}, customFields: Record<string, FieldValue> = {};
    for (const [source, target] of selected) {
      const v = raw[source];
      try {
        if (target.startsWith('field:')) { const f = model!.fields.find(f => `field:${f.id}` === target)!, converted = fieldValue(v, f, spec.format === 'csv'); if (converted !== undefined) customFields[f.id] = converted; }
        else if(target==='builtin:images'){const converted=fieldValue(v,{id:'images',key:'images',label:'产品图片',type:'gallery',required:false},spec.format==='csv');if(converted!==undefined)values.images=converted;}
        else if (target === 'builtin:sortOrder') { if (v !== '' && v !== null && v !== undefined) { const n = spec.format === 'csv' ? Number(v) : v; if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1000000) throw new Error('排序需为0–1000000整数'); values.sortOrder = n; } }
        else if (v !== null && v !== undefined) { if (typeof v !== 'string') throw new Error('需要文本'); values[target.slice(8)] = v.trim(); }
      } catch (e) { errors.push({ row, field: source, message: (e as Error).message }); }
    }
    const key = String(values.key || (spec.target === 'product' ? values.sku || '' : ''));
    if (values.key && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(String(values.key))) errors.push({ row, field: 'key', message: '自定义导入key需1–64位字母、数字、下划线或短横线' });
    const keyScope = `${spec.target}:${spec.modelId || ''}:${key.toLowerCase()}`, id = `import-${spec.target}-${createHash('sha256').update(keyScope).digest('hex').slice(0, 24)}`;
    if (!key || keys.has(keyScope) || ids.has(id)) errors.push({ row, field: 'key', message: '导入key为空、批内重复或已导入；本功能只新增，不覆盖已有记录' }); keys.add(keyScope); ids.add(id);
    // 原生相册不依赖模型；导入采用首图封面，显式冲突整批拒绝。
    if(spec.target==='product'&&Array.isArray(values.images)){const cover=values.images[0]||'';if(values.image!==undefined&&values.image!==cover)errors.push({row,field:'image',message:'封面必须与产品图片列表的首张一致'});else values.image=cover;}
    const record = spec.target === 'product' ? { id, name: '', sku: '', category: '未分类', image: '', description: '', material: '', status: 'draft' as const, ...values, ...(model ? { modelId: model.id, customFields } : {}) } : { id, modelId: model!.id, title: '', status: 'draft' as const, updated: '', customFields, ...values };
    delete (record as Record<string, unknown>).key;
    const title = spec.target === 'product' ? (record as Product).name : (record as ContentEntry).title;
    const slug = String(values.slug || id);
    if (values.slug && !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(String(values.slug))) errors.push({ row, field: 'slug', message: '短路径需最多100位小写字母、数字、下划线或短横线' });
    if (slugs.has(slug)) errors.push({ row, field: 'slug', message: '短路径与批内或已有记录重复' }); slugs.add(slug);
    if (spec.target === 'product' && !String((record as Product).category).trim()) errors.push({ row, field: 'category', message: '分类不能为空；取消映射可使用“未分类”' });
    const titleLimit = spec.target === 'product' ? PRODUCT_CONTENT_LIMITS.name : 200;
    if (!title || title.length > titleLimit) errors.push({ row, field: spec.target === 'product' ? 'name' : 'title', message: `名称需1–${titleLimit}字符` });
    const { name: _name, ...productLimits } = PRODUCT_CONTENT_LIMITS;
    for (const [k, max] of Object.entries({ ...productLimits, seoTitle: 200, seoDescription: 1000 })) if (typeof values[k] === 'string' && (values[k] as string).length > max) errors.push({ row, field: k, message: `最多${max}字符` });
    if (spec.target === 'product') { const sku = (record as Product).sku.toLowerCase(); if (!sku || skus.has(sku)) errors.push({ row, field: 'sku', message: 'SKU为空或与批内/已有产品重复' }); skus.add(sku); products.push(record as Product); }
    else entries.push(record as ContentEntry);
    if (model) errors.push(...validateModelValues(model, customFields, false).map(message => ({ row, field: 'customFields', message })));
    for (const url of [(record as Product).image,...((record as Product).images||[]), ...model?.fields.filter(f => f.type === 'image' || f.type === 'gallery').flatMap(f => { const v = customFields[f.id]; return Array.isArray(v) ? v : typeof v === 'string' ? [v] : []; }) || []]) if (url && !draft.content.media.some(m => m.url === url && m.kind === 'image') && !bundledImage(url)) errors.push({ row, field: 'image', message: '请选择本实例已有图片地址；不下载远程素材' });
    preview.push({ row, key, title, sku: String(values.sku || ''), slug: String(values.slug || ''), values: { ...values, ...customFields } });
  }
  const patch = { ...(products.length ? { products: [...draft.content.products, ...products] } : {}), ...(entries.length ? { contentEntries: [...(draft.content.contentEntries || []), ...entries] } : {}) };
  if (!errors.length) { try { validateDraft({ ...draft.content, ...patch }); } catch (e) { errors.push({ row: 0, field: '整批', message: (e as Error).message }); } }
  return { draft, patch, headers: parsed.headers, rows: preview, errors, warnings: ['只新增草稿，不更新已有记录、不下载远程图片、不自动发布。', '自定义字段发布必填规则仍在最终发布时检查；CSV日期用YYYY-MM-DD，布尔用true/false，列表用JSON文本数组。', ...(parsed.headers.filter(h => !spec.mapping[h]).length ? [`未映射列将忽略：${parsed.headers.filter(h => !spec.mapping[h]).join('、')}`] : [])] };
}
export function previewContentImport(value: unknown, now = Date.now()): ImportPreview {
  const { spec, expectedRevision } = readSpec(value), plan = prepare(spec, expectedRevision);
  return { revision: expectedRevision, rowCount: plan.rows.length, headers: plan.headers, rows: plan.rows, errors: plan.errors, warnings: plan.warnings, ...(!plan.errors.length ? { confirmation: `1.${expectedRevision}.${now}.${signature(spec, expectedRevision, now)}` } : {}) };
}
/** 确认必须匹配5分钟内的同一文件/映射/版本；最终仍重新校验并用现有SQLite草稿事务原子写入。 */
export function commitContentImport(value: unknown, now = Date.now(), actor?:ActorIdentity) {
  const { spec, expectedRevision, confirmation } = readSpec(value);
  const parts = typeof confirmation === 'string' ? confirmation.split('.') : [], issuedAt = Number(parts[2]), expected = signature(spec, expectedRevision, issuedAt);
  if (parts.length !== 4 || parts[0] !== '1' || parts[1] !== String(expectedRevision) || !Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt > 300000 || !/^[a-zA-Z0-9_-]{43}$/.test(parts[3]) || !timingSafeEqual(Buffer.from(parts[3]), Buffer.from(expected))) throw new ApiError(409, '导入预检已过期或文件/映射已变化，请重新预检');
  const plan = prepare(spec, expectedRevision); if (plan.errors.length) throw new ApiError(422, plan.errors.slice(0, 20).map(e => `第${e.row}行 ${e.field}：${e.message}`).join('；'));
  return patchStudio({ expectedRevision, patch: plan.patch }, actor, 'content.import');
}
