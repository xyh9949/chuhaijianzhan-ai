import { randomUUID } from 'node:crypto';
import type { AiExtractedSource, ExcelSkuReceipt, ExcelSkuRow } from '../lib/ai-source-types';
import type { ContentImportSpec, ImportPreview } from '../lib/content-import';
import { IMPORT_MAX_ROWS } from '../lib/content-import';
import { getDatabase } from './database';
import { ApiError, readBodyBytes } from './http';
import { extractAiSourceFile } from './ai-source-files';
import { previewContentImport, commitContentImport } from './content-import';
import { getDraftRecord, getStudioEnvelope, patchStudio } from './studio';
import { object, revision } from './validation';
import { isMemberDisabled, requirePermission, type Actor, type MemberRow } from './permissions';
import { recordAudit } from './audit';
import { cleanAiSourcePrivate, deleteAiSourcePrivate, writeAiSourcePrivate } from './ai-source-private';
import { allowsExcelParameter, patchExcelSkuProducts, planExcelSkuUpdate } from './excel-sku-update';

const SOURCE_LIFETIME = 2 * 60 * 60 * 1000;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPDATE_PREVIEW_LIFETIME = 5 * 60 * 1000;
const UPDATE_UNDO_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const PRODUCT_TARGETS = new Set(['builtin:name', 'builtin:sku', 'builtin:category', 'builtin:description', 'builtin:material', 'builtin:slug', 'builtin:seoTitle', 'builtin:seoDescription', 'builtin:sortOrder']);
type SourceRow = { id: string; actor_id: string; kind: 'source' | 'products' | 'brief'; source_id: string | null; base_revision: number; payload_json: string; created_at: string; expires_at: string; applied_revision: number | null; applied_at: string | null };
export interface AiSourceRecord { id: string; source: AiExtractedSource; createdAt: string; expiresAt: string; }
export interface AiSourceListItem { id: string; fileName: string; kind: AiExtractedSource['kind']; bytes: number; textChars: number; createdAt: string; expiresAt: string; }
export interface AiSourceProductRequest { expectedRevision: number; mode?: 'update'; modelId?: string; sheetIndex: number; headerRow: number; mapping: Record<string, string>; extraColumns: 'description' | 'ignore'; skipRows?: number[]; edits?: { row: number; values: Record<string, string> }[]; rowImages?: { row: number; imageId: string }[]; }
export interface AiSourceProductPreview extends ImportPreview { previewId?: string; baseRevision: number; source: { id: string; fileName: string; sheetName: string; sheetIndex: number; headerRow: number }; columns: { id: string; label: string; index: number }[]; updates?: ExcelSkuRow[]; }
type ImportPayload = { spec: ContentImportSpec; confirmation: string; sourceRows: number[]; source: AiSourceProductPreview['source']; productSkus: string[]; importedProductIds?: string[]; };
type UpdatePayload = { operation: 'sku-update'; source: AiSourceProductPreview['source']; changes: ExcelSkuRow[]; undone?: boolean; };

/** 资料只属于创建它的管理员；写入前重查角色，防止上传/解析期间权限被撤销。 */
function currentAdmin(actor: Actor): Actor {
  requirePermission(actor, 'manage');
  const row = getDatabase().prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as MemberRow | undefined;
  if (!row || isMemberDisabled(row)) throw new ApiError(401, '账号已停用或会话已失效');
  if (row.role !== 'admin') throw new ApiError(403, '资料导入仅管理员可操作');
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}
function sourceId(value: unknown, prefix: 'ais' | 'aix' = 'ais'): string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}-[a-f0-9-]{36}$`).test(value)) throw new ApiError(422, '资料记录标识无效');
  return value;
}
function only(input: Record<string, unknown>, fields: string[]) {
  if (Object.keys(input).some(key => !fields.includes(key))) throw new ApiError(422, '资料导入请求包含不支持的字段');
}
function readRecord(id: string, kind: SourceRow['kind'], actor: Actor, now = Date.now()) {
  const row = getDatabase().prepare('SELECT * FROM cms_ai_source WHERE id=? AND actor_id=? AND kind=?').get(id, actor.id, kind) as SourceRow | undefined;
  if (!row) throw new ApiError(404, '找不到当前账号的资料记录');
  if (Date.parse(row.expires_at) <= now) throw new ApiError(410, kind === 'products' ? '产品检查或撤销记录已过期，请重新检查' : '资料记录已超过2小时，请重新上传或检查');
  return row;
}
function assertCapacity(actor: Actor, now = Date.now()) {
  const count = getDatabase().prepare('SELECT count(*) n FROM cms_ai_source WHERE actor_id=? AND expires_at>?').get(actor.id, new Date(now).toISOString()) as { n: number };
  if (count.n >= 30) throw new ApiError(429, '暂存资料或检查记录已达30条，请移除不用的资料或等待记录过期');
}
function storeRecord(kind: SourceRow['kind'], actor: Actor, payload: unknown, baseRevision: number, parentId?: string, expiresAt?: string) {
  const db = getDatabase(), stamp = new Date().toISOString();
  // 过期暂存不属于网站内容；只在用户主动写操作时清理，不产生公开素材地址。
  db.prepare('DELETE FROM cms_ai_source WHERE expires_at<=?').run(stamp);
  assertCapacity(actor);
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) throw new ApiError(413, '资料检查结果过大，请拆分文件后再上传');
  const id = `${kind === 'source' ? 'ais' : 'aix'}-${randomUUID()}`;
  db.prepare('INSERT INTO cms_ai_source(id,actor_id,kind,source_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id, actor.id, kind, parentId || null, baseRevision, encoded, stamp, expiresAt || new Date(Date.now() + SOURCE_LIFETIME).toISOString());
  return id;
}

/** 受限worker提取文字，原件短存本人私有目录供按需增强；数据库不存二进制，也不生成公开原件地址。 */
export async function uploadAiSource(request: Request, actor: Actor, checkAccess?: () => void): Promise<AiSourceRecord> {
  actor = currentAdmin(actor); cleanAiSourcePrivate(actor.id); assertCapacity(actor);
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw new ApiError(415, '请选择PDF或Excel文件上传');
  const bytes = await readBodyBytes(request, MAX_UPLOAD_BYTES + 1024 * 1024);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
  catch { throw new ApiError(400, '文件上传表单无效'); }
  if ([...form.keys()].some(key => key !== 'file') || form.getAll('file').length !== 1) throw new ApiError(422, '一次只能上传一个资料文件');
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) throw new ApiError(422, '请选择非空PDF或Excel文件');
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, '单个资料文件最多10 MB，请拆分后上传');
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  // HTTP资料完整到达后再核对会话，提取结束后的落库事务也不能沿用已撤销的会话授权。
  checkAccess?.();
  const extracted = await extractAiSourceFile(fileBytes, file.name, file.type, request.signal);
  return getDatabase().transaction(() => {
    checkAccess?.();
    actor = currentAdmin(actor);
    const id = storeRecord('source', actor, { ...extracted, enhancementAvailable: true }, -1);
    // 原件仅在本人私有目录短存，供按需离线OCR/抽图；不产生公开地址，不进入网站包。
    writeAiSourcePrivate(actor.id, id, 'original.bin', fileBytes);
    recordAudit(actor, 'ai.source', 'success', { objectIds: [id], fields: ['upload'] });
    return readAiSource(id, actor);
  }).immediate();
}

/** 完整来源只允许本人管理员读取；公开工作区、发布快照和整站包不会读取此表。 */
export function readAiSource(id: string, actor: Actor): AiSourceRecord {
  actor = currentAdmin(actor);
  const row = readRecord(sourceId(id), 'source', actor);
  return { id: row.id, source: JSON.parse(row.payload_json) as AiExtractedSource, createdAt: row.created_at, expiresAt: row.expires_at };
}
export function listAiSources(actor: Actor): { items: AiSourceListItem[] } {
  actor = currentAdmin(actor);
  const rows = getDatabase().prepare("SELECT * FROM cms_ai_source WHERE actor_id=? AND kind='source' AND expires_at>? ORDER BY created_at DESC,id DESC LIMIT 30").all(actor.id, new Date().toISOString()) as SourceRow[];
  return { items: rows.map(row => { const source = JSON.parse(row.payload_json) as AiExtractedSource; return { id: row.id, fileName: source.fileName, kind: source.kind, bytes: source.bytes, textChars: source.textChars, createdAt: row.created_at, expiresAt: row.expires_at }; }) };
}
export function deleteAiSource(id: string, actor: Actor): { ok: true } {
  actor = currentAdmin(actor); id = sourceId(id);
  getDatabase().transaction(() => {
    actor = currentAdmin(actor); readRecord(id, 'source', actor);
    // 删除原资料时同时撤回尚未应用的派生检查；已应用产品本身仍是普通独立草稿。
    // 多来源候选不能用单一source_id表达依赖，逐项撤回含此来源的未确认合并；已确认回执供安全撤销保留。
    for (const row of getDatabase().prepare("SELECT id,payload_json FROM cms_ai_source WHERE actor_id=? AND kind='brief'").all(actor.id) as { id: string; payload_json: string }[]) { const payload = JSON.parse(row.payload_json) as { operation?: string; hashes?: Record<string, string>; confirmed?: boolean }; if (['merge-evidence', 'merge-preview'].includes(payload.operation || '') && payload.hashes && Object.hasOwn(payload.hashes, id) && !payload.confirmed) getDatabase().prepare('DELETE FROM cms_ai_source WHERE id=? AND actor_id=?').run(row.id, actor.id); }
    getDatabase().prepare('DELETE FROM cms_ai_source WHERE actor_id=? AND (id=? OR source_id=?)').run(actor.id, id, id);
    deleteAiSourcePrivate(actor.id, id);
    recordAudit(actor, 'ai.source', 'success', { objectIds: [id], fields: ['delete'] });
  }).immediate();
  return { ok: true };
}
export async function readAiSourceJsonRequest(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, '请使用JSON资料检查请求');
  const bytes = await readBodyBytes(request, 2 * 1024 * 1024);
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), '资料检查请求'); }
  catch { throw new ApiError(400, '资料检查请求不是有效JSON对象'); }
}

/** Excel 核对仅暂存人工改值，继承原件的本人权限和过期时间。不同标签页各自持有独立回执。 */
export function saveAiSourceReview(id: string, value: Record<string, unknown>, actor: Actor) {
  only(value, ['sheetIndex', 'headerRow', 'edits']);
  return getDatabase().transaction(() => {
    const owner = currentAdmin(actor);
    const source = readAiSource(id, owner);
    const sheet = source.source.sheets?.find(item => !item.hidden && item.index === value.sheetIndex);
    const header = sheet?.rows.find(row => !row.hidden && row.rowNumber === value.headerRow);
    if (!sheet || !header) throw new ApiError(422, '请选择当前Excel中有效的工作表和表头');
    const rows = new Set(sheet.rows.filter(row => !row.hidden && row.rowNumber > header.rowNumber).map(row => String(row.rowNumber)));
    const edits = object(value.edits, '核对改值');
    for (const [row, cells] of Object.entries(edits)) {
      if (!rows.has(row)) throw new ApiError(422, '核对改值包含不可用的行');
      for (const [column, text] of Object.entries(object(cells, '核对单元格'))) {
        const index = Number(column.slice(1));
        if (!/^c[1-9]\d*$/.test(column) || index > sheet.columnCount || sheet.hiddenColumns?.includes(index) || typeof text !== 'string' || text.length > 6000) throw new ApiError(422, '核对改值包含不可用的列或超长文字');
      }
    }
    return { reviewId: storeRecord('brief', owner, { operation: 'excel-review', ...value }, -1, source.id, source.expiresAt) };
  }).immediate();
}

export function readAiSourceReview(id: string, reviewId: string, actor: Actor) {
  const owner = currentAdmin(actor);
  const source = readAiSource(id, owner);
  const row = readRecord(sourceId(reviewId, 'aix'), 'brief', owner);
  const { operation, sheetIndex, headerRow, edits } = JSON.parse(row.payload_json);
  if (row.source_id !== source.id || operation !== 'excel-review') throw new ApiError(404, '找不到这份Excel的核对记录');
  return { sheetIndex, headerRow, edits };
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new ApiError(422, `${label}无效`);
  return Number(value);
}
function productSpec(record: AiSourceRecord, value: unknown) {
  const input = object(value, '产品资料检查');
  only(input, ['expectedRevision', 'mode', 'modelId', 'sheetIndex', 'headerRow', 'mapping', 'extraColumns', 'skipRows', 'edits', 'rowImages']);
  const expectedRevision = revision(input.expectedRevision);
  if (input.mode !== undefined && input.mode !== 'update') throw new ApiError(422, '产品资料操作模式无效');
  const update = input.mode === 'update';
  const draft = getDraftRecord();
  if (draft.revision !== expectedRevision) throw new ApiError(409, '工作区已变化，请读取最新工作区再检查产品');
  const model = input.modelId === undefined ? undefined : draft.content.contentModels?.find(item => item.id === input.modelId && item.target === 'product');
  if (input.modelId !== undefined && (!update || !model)) throw new ApiError(422, '请选择匹配的产品参数分组');
  const allowed = update ? new Set([...PRODUCT_TARGETS].filter(target => target !== 'builtin:slug').concat((model?.fields || []).filter(allowsExcelParameter).map(field => `field:${field.id}`))) : PRODUCT_TARGETS;
  if (record.source.kind !== 'xlsx' || !record.source.sheets) throw new ApiError(422, '产品表映射仅支持Excel资料，请先选择工作表');
  const sheetIndex = positiveInteger(input.sheetIndex, '工作表', 10), headerRow = positiveInteger(input.headerRow, '表头行', 1048576);
  const sheet = record.source.sheets.find(item => item.index === sheetIndex);
  if (!sheet) throw new ApiError(422, '所选工作表不存在');
  if (sheet.hidden) throw new ApiError(422, '隐藏工作表不自动导入，请在原表格中确认并取消隐藏后重新上传');
  const header = sheet.rows.find(row => row.rowNumber === headerRow);
  if (!header || header.hidden) throw new ApiError(422, '表头行为空、隐藏或不在提取范围，请重新选择');
  const hiddenColumns = new Set(sheet.hiddenColumns || []);
  const columns = Array.from({ length: sheet.columnCount }, (_, index) => ({ id: `c${index + 1}`, index: index + 1, label: header.cells[index]?.trim() || `第${index + 1}列` })).filter(column => !hiddenColumns.has(column.index));
  const columnIds = new Set(columns.map(column => column.id));
  const mappingValue = object(input.mapping, '产品列映射');
  if (Object.keys(mappingValue).length > 64 || Object.entries(mappingValue).some(([key, target]) => !columnIds.has(key) || typeof target !== 'string' || target !== '' && !allowed.has(target))) throw new ApiError(422, '产品列映射包含无效列或字段');
  const mapping = mappingValue as Record<string, string>;
  const targets = Object.values(mapping).filter(Boolean);
  if (new Set(targets).size !== targets.length || !targets.includes('builtin:sku') || !update && !targets.includes('builtin:name')) throw new ApiError(422, update ? '请映射型号列；每个字段只能选择一列' : '产品名称和型号SKU必须各映射一列，且不能把多列映射到同一字段');
  if (update ? input.extraColumns !== 'ignore' : input.extraColumns !== 'description' && input.extraColumns !== 'ignore') throw new ApiError(422, '请明确选择未映射参数的处理方式');
  // 与审核表采用相同可见范围；只有隐藏列有内容的行不能成为用户看不到、无法取消的产品。
  const available = sheet.rows.filter(row => row.rowNumber > headerRow && !row.hidden && columns.some(column => row.cells[column.index - 1]?.trim())), availableIds = new Set(available.map(row => row.rowNumber));
  const skips = input.skipRows ?? [];
  if (!Array.isArray(skips) || skips.length > 1000 || skips.some(row => !Number.isSafeInteger(row) || !availableIds.has(Number(row))) || new Set(skips).size !== skips.length) throw new ApiError(422, '跳过行列表无效');
  const skipSet = new Set(skips as number[]), selected = available.filter(row => !skipSet.has(row.rowNumber));
  if (!selected.length || selected.length > IMPORT_MAX_ROWS) throw new ApiError(422, `请勾选1–${IMPORT_MAX_ROWS}个产品行；更多资料请分批导入，不会静默截断`);
  const edits = input.edits ?? [];
  if (!Array.isArray(edits) || edits.length > 1000) throw new ApiError(422, '产品行修改过多');
  const edited = new Map<number, Record<string, string>>();
  for (const item of edits) {
    const edit = object(item, '产品行修改'); only(edit, ['row', 'values']);
    if (!Number.isSafeInteger(edit.row) || !availableIds.has(Number(edit.row)) || edited.has(Number(edit.row))) throw new ApiError(422, '产品行修改含未知或重复行');
    const values = object(edit.values, '产品单元格');
    if (Object.keys(values).length > 64 || Object.entries(values).some(([key, cell]) => !columnIds.has(key) || typeof cell !== 'string' || cell.length > 100000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cell))) throw new ApiError(422, '产品单元格内容无效或过长');
    edited.set(Number(edit.row), values as Record<string, string>);
  }
  const unmapped = columns.filter(column => !mapping[column.id]);
  const imageSelections = input.rowImages ?? [];
  if (!Array.isArray(imageSelections) || imageSelections.length > 500) throw new ApiError(422, '请逐行确认产品配图');
  const rowImages = new Map<number, string>();
  for (const item of imageSelections) {
    const selection = object(item, '产品行配图'); only(selection, ['row', 'imageId']);
    const image = record.source.images?.find(image => image.id === selection.imageId), media = draft.content.media.find(media => media.id === image?.adoptedMediaId && media.kind === 'image');
    if (!selected.some(row => row.rowNumber === selection.row) || rowImages.has(Number(selection.row)) || !image || !media || update && (image.source.kind !== 'xlsx' || image.source.sheetIndex !== sheetIndex || image.source.hidden)) throw new ApiError(422, '配图必须为所选行明确选择且已加入素材库的来源图片');
    rowImages.set(Number(selection.row), media.url);
  }
  const descriptionColumn = Object.keys(mapping).find(key => mapping[key] === 'builtin:description');
  const rows = selected.map(row => {
    const cells = Object.fromEntries(columns.map(column => [column.id, row.cells[column.index - 1] ?? '']));
    Object.assign(cells, edited.get(row.rowNumber) || {});
    if (rowImages.has(row.rowNumber)) cells.__sourceImage = rowImages.get(row.rowNumber)!;
    if (input.extraColumns === 'description' && unmapped.length) {
      const additional = unmapped.filter(column => cells[column.id].trim() !== '').map(column => `${column.label}：${cells[column.id]}`).join('\n');
      if (additional) cells.__extraDescription = [descriptionColumn ? cells[descriptionColumn] : '', additional].filter(Boolean).join('\n\n');
    }
    return cells;
  });
  const finalMapping = { ...mapping };
  if (rowImages.size) finalMapping.__sourceImage = 'builtin:image';
  if (update && targets.length === 1 && !rowImages.size) throw new ApiError(422, '请再选择至少一列要更新的内容，或为需要的行选择封面');
  if (rows.some(row => Object.hasOwn(row, '__extraDescription'))) {
    if (descriptionColumn) delete finalMapping[descriptionColumn];
    finalMapping.__extraDescription = 'builtin:description';
    // 其余行也提供合并后的同名字段，避免有的行漏掉原描述。
    rows.forEach(row => { if (!Object.hasOwn(row, '__extraDescription')) row.__extraDescription = descriptionColumn ? row[descriptionColumn] : ''; });
  }
  const orderColumn = Object.keys(mapping).find(key => mapping[key] === 'builtin:sortOrder');
  // Excel其余显示值始终保留文本；只有明确映射的排序字段转换为数字供原导入器校验。
  const importRows = rows.map(row => ({ ...row, ...(orderColumn && row[orderColumn].trim() !== '' && Number.isFinite(Number(row[orderColumn])) ? { [orderColumn]: Number(row[orderColumn]) } : {}) }));
  const spec: ContentImportSpec = { format: 'json', target: 'product', content: JSON.stringify({ schemaVersion: 1, kind: 'product', rows: importRows }), mapping: finalMapping };
  const formulaCount = selected.reduce((count, row) => count + row.formulaColumns.filter(column => columnIds.has(`c${column}`)).length, 0);
  // 只统计服务器已核对且属于本次选中产品行的配图；未选行不计入提示。
  const unassignedImages = selected.length - rowImages.size;
  const warnings = [
    update ? '只更新已匹配产品的所选字段。空单元格保留原值，确认前不会修改网站。' : '只新增产品草稿，未确认前不修改网站。',
    update ? `本次明确指定 ${rowImages.size} 行的封面，其余产品图片保留。` : `本次已配图 ${rowImages.size} 行，未配图 ${unassignedImages} 行。${unassignedImages ? '未配图的产品可在产品管理中补图。' : ''}`,
    ...(unmapped.length ? [input.extraColumns === 'description' ? '未映射的非空参数已按原列名与显示值附加到产品描述，保留单位、0和false。' : `已明确忽略${unmapped.length}列未映射参数；原始提取结果仍可回看。`] : []),
    ...(hiddenColumns.size || sheet.rows.some(row => row.hidden) ? ['原文件中的隐藏行和隐藏列没有进入产品导入，请在原表格中确认后再另行上传需要的资料。'] : []),
    ...(formulaCount ? [`所选行含${formulaCount}个公式单元格，只使用提取时已有的缓存显示值，不执行公式或刷新外部链接，请核对结果。`] : []),
  ];
  return { spec, update, model, draft, importRows, expectedRevision, sourceRows: selected.map(row => row.rowNumber), columns, warnings, source: { id: record.id, fileName: record.source.fileName, sheetName: sheet.name, sheetIndex, headerRow } };
}

/** 本人审核后的列/行才进入既有导入校验，错误行号映射回原工作表，预检不改产品。 */
export function previewAiSourceProducts(id: string, value: unknown, actor: Actor, now = Date.now()): AiSourceProductPreview {
  actor = currentAdmin(actor); const source = readAiSource(id, actor), parsed = productSpec(source, value);
  if (parsed.update) {
    const plan = planExcelSkuUpdate(parsed.draft.content, parsed.importRows, parsed.sourceRows, parsed.spec.mapping, parsed.model);
    const result: AiSourceProductPreview = { revision: parsed.expectedRevision, baseRevision: parsed.expectedRevision, rowCount: plan.changes.length, headers: parsed.columns.map(column => column.id), rows: [], updates: plan.changes, errors: plan.errors, warnings: [...parsed.warnings, ...(plan.unchanged ? [`${plan.unchanged} 行与当前值相同，无需保存。`] : [])], source: parsed.source, columns: parsed.columns };
    if (plan.changes.length && !plan.errors.length) {
      result.previewId = getDatabase().transaction(() => {
        actor = currentAdmin(actor); readRecord(source.id, 'source', actor, now);
        if (getDraftRecord().revision !== parsed.expectedRevision) throw new ApiError(409, '检查期间工作区已变化，请重新检查');
        return storeRecord('products', actor, { operation: 'sku-update', source: parsed.source, changes: plan.changes } satisfies UpdatePayload, parsed.expectedRevision, source.id, new Date(Math.min(Date.parse(source.expiresAt), now + UPDATE_PREVIEW_LIFETIME)).toISOString());
      }).immediate();
    }
    return result;
  }
  const preview = previewContentImport({ ...parsed.spec, expectedRevision: parsed.expectedRevision }, now);
  const result: AiSourceProductPreview = { ...preview, baseRevision: preview.revision, source: parsed.source, columns: parsed.columns,
    rows: preview.rows.map(row => ({ ...row, row: parsed.sourceRows[row.row - 1] || row.row })),
    errors: preview.errors.map(error => ({ ...error, row: error.row ? parsed.sourceRows[error.row - 1] || error.row : 0 })),
    warnings: [...parsed.warnings, ...preview.warnings.filter(warning => !warning.startsWith('未映射列将忽略'))],
  };
  if (preview.confirmation && !preview.errors.length) {
    result.previewId = getDatabase().transaction(() => {
      actor = currentAdmin(actor); readRecord(source.id, 'source', actor, now);
      return storeRecord('products', actor, { spec: parsed.spec, confirmation: preview.confirmation!, sourceRows: parsed.sourceRows, source: parsed.source, productSkus: preview.rows.map(row => row.sku) } satisfies ImportPayload, parsed.expectedRevision, source.id, source.expiresAt);
    }).immediate();
  }
  // 客户端只提交previewId；底层确认签名与原始spec保存在私有记录，不能被修改后继续应用。
  delete result.confirmation;
  return result;
}

/** 保存与幂等回执同事务。更新回执与短期资料分离，删除原文件或刷新页面仍可撤销。 */
export function applyAiSourceProducts(id: string, value: unknown, actor: Actor, now = Date.now()) {
  actor = currentAdmin(actor); id = sourceId(id);
  const input = object(value, '产品导入保存'); only(input, ['previewId', 'expectedRevision']);
  const expected = revision(input.expectedRevision), previewId = sourceId(input.previewId, 'aix');
  return getDatabase().transaction(() => {
    actor = currentAdmin(actor);
    const row = readRecord(previewId, 'products', actor, now);
    const payload = JSON.parse(row.payload_json) as ImportPayload | UpdatePayload;
    if ('operation' in payload) {
      if (payload.source.id !== id) throw new ApiError(422, '预检与所选资料不匹配，请重新检查');
      if (payload.undone) throw new ApiError(409, '本批已撤销，请重新检查后确认更新');
      if (row.applied_revision !== null) return { ...getStudioEnvelope(), importedProductIds: [], updateReceipt: updateReceipt(row, payload) };
      readRecord(id, 'source', actor, now);
      const current = getDraftRecord();
      if (row.base_revision !== expected || current.revision !== expected) throw new ApiError(409, '工作区已变化，请重新检查产品；当前资料和选项仍保留');
      const result = patchStudio({ expectedRevision: expected, patch: { products: patchExcelSkuProducts(current.content.products, payload.changes) } }, actor);
      const appliedAt = new Date(now).toISOString(), expiresAt = new Date(now + UPDATE_UNDO_LIFETIME).toISOString();
      getDatabase().prepare('UPDATE cms_ai_source SET applied_revision=?,applied_at=?,expires_at=?,source_id=NULL WHERE id=? AND applied_revision IS NULL').run(result.revision, appliedAt, expiresAt, row.id);
      recordAudit(actor, 'ai.source', 'success', { objectIds: payload.changes.map(item => item.productId), fields: ['updateProductsBySku'], operationId: row.id, revision: result.revision });
      return { ...result, importedProductIds: [], updateReceipt: updateReceipt({ ...row, applied_at: appliedAt, expires_at: expiresAt }, payload) };
    }
    readRecord(id, 'source', actor, now);
    if (row.source_id !== id) throw new ApiError(422, '预检与所选资料不匹配，请重新检查');
    if (row.applied_revision !== null) return { ...getStudioEnvelope(), importedProductIds: payload.importedProductIds || [] };
    if (row.base_revision !== expected || getDraftRecord().revision !== expected) throw new ApiError(409, '工作区已变化，请重新检查产品；当前资料与审核内容仍保留');
    const result = commitContentImport({ ...payload.spec, expectedRevision: expected, confirmation: payload.confirmation }, now, actor);
    const skus = new Set(payload.productSkus.map(sku => sku.trim().toLowerCase()));
    // 回执保留本批实际ID，失联后重试也能准确交给建站规划，不依赖客户端旧产品差集。
    const importedProductIds = result.state.products.filter(product => skus.has(product.sku.trim().toLowerCase())).map(product => product.id);
    getDatabase().prepare('UPDATE cms_ai_source SET applied_revision=?,applied_at=?,payload_json=? WHERE id=? AND applied_revision IS NULL').run(result.revision, new Date(now).toISOString(), JSON.stringify({ ...payload, importedProductIds }), row.id);
    return { ...result, importedProductIds };
  }).immediate();
}

function updateReceipt(row: SourceRow, payload: UpdatePayload): ExcelSkuReceipt {
  return { id: row.id, fileName: payload.source.fileName, rowCount: payload.changes.length, appliedAt: row.applied_at!, expiresAt: row.expires_at, undone: !!payload.undone };
}

/** 列表只读取本账号已采用回执，无需原件，也不向浏览器返回整份历史字段内容。 */
export function listExcelSkuUpdates(actor: Actor, now = Date.now()): { items: ExcelSkuReceipt[] } {
  actor = currentAdmin(actor);
  const rows = getDatabase().prepare("SELECT * FROM cms_ai_source WHERE actor_id=? AND kind='products' AND source_id IS NULL AND applied_revision IS NOT NULL AND expires_at>? ORDER BY applied_at DESC,id DESC LIMIT 30").all(actor.id, new Date(now).toISOString()) as SourceRow[];
  return { items: rows.map(row => updateReceipt(row, JSON.parse(row.payload_json) as UpdatePayload)) };
}

export function undoExcelSkuUpdate(value: unknown, actor: Actor, now = Date.now()) {
  const input = object(value, '撤销产品更新'); only(input, ['id', 'expectedRevision']);
  const expected = revision(input.expectedRevision), id = sourceId(input.id, 'aix');
  return getDatabase().transaction(() => {
    actor = currentAdmin(actor);
    const row = readRecord(id, 'products', actor, now);
    const payload = JSON.parse(row.payload_json) as ImportPayload | UpdatePayload;
    if (!('operation' in payload) || row.applied_revision === null) throw new ApiError(422, '仅可撤销已经确认的型号更新');
    if (payload.undone) return { ...getStudioEnvelope(), updateReceipt: updateReceipt(row, payload) };
    const current = getDraftRecord();
    if (expected !== current.revision) throw new ApiError(409, '工作区已变化，请读取最新版本后再确认撤销');
    const result = patchStudio({ expectedRevision: expected, patch: { products: patchExcelSkuProducts(current.content.products, payload.changes, true) } }, actor);
    payload.undone = true;
    getDatabase().prepare('UPDATE cms_ai_source SET payload_json=? WHERE id=? AND actor_id=?').run(JSON.stringify(payload), id, actor.id);
    recordAudit(actor, 'ai.source', 'success', { objectIds: payload.changes.map(item => item.productId), fields: ['undoProductsBySku'], operationId: id, revision: result.revision });
    return { ...result, updateReceipt: updateReceipt(row, payload) };
  }).immediate();
}
