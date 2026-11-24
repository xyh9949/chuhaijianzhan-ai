'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Collapse, Descriptions, Flex, Form, Image, Input, List, Modal, Popconfirm, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import { DeleteOutlined, FileExcelOutlined, FilePdfOutlined, ReloadOutlined, ThunderboltOutlined, UploadOutlined } from '@ant-design/icons';
import type { AiExtractedSource, AiSourceSheet, ExcelSkuChange, ExcelSkuReceipt, ExcelSkuRow } from '@/lib/ai-source-types';
import { AI_SOURCE_LIMITS, EXCEL_UPDATE_PARAMETER_TYPES } from '@/lib/ai-source-types';
import type { AiSiteBrief } from '@/lib/ai-builder-types';
import type { ImportPreview } from '@/lib/content-import';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { readFreshStudio } from '@/lib/refresh-studio';
import { clearLocalRecovery, readLocalRecovery } from '@/lib/local-recovery';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import AiWritingReusePicker from './AiWritingReusePicker';
import type { AiWritingReuseCandidate } from '@/lib/ai-writing-reuse-types';
import type { AiWritingProfile } from '@/lib/ai-writing-types';
import AiSourceEnhance, { sourceImageUrl, sourceImageLocation } from './AiSourceEnhance';
import AiSourceMerge from './AiSourceMerge';
import './ai-source-import.css';

const { Text, Paragraph } = Typography;
type SourceRecord = { id: string; source: AiExtractedSource; expiresAt: string; createdAt?: string };
type SourceSummary = { id: string; fileName?: string; kind?: string; expiresAt: string; source?: Partial<AiExtractedSource> };
type ProductPreview = ImportPreview & { previewId?: string; baseRevision?: number; source?: { fileName: string; sheetName?: string }; updates?: ExcelSkuRow[] };
type BriefResult = { brief: Partial<AiSiteBrief>; warnings: string[]; sources: { pageNumber: number }[]; facts: { field: string; value: string; pageNumbers: number[]; evidence?: { pageNumber: number; quote: string }[] }[] };
type Options = { sourceId: string; modelId?: string; sheetIndex: number; headerRow: number; mapping: Record<string, string>; skipRows: number[]; extraColumns: 'description' | 'ignore'; rowImages?: Record<string, string> };
type ExcelEdits = Record<number, Record<string, string>>;
type RecoveryOptions = Options & { reviewId?: string };
type Props = { open: boolean; onClose: () => void; onRequestOpen: () => void; brief: AiSiteBrief; onApplyBrief: (value: Partial<AiSiteBrief>) => void; onProductsImported?: (ids: string[]) => void; providerEnabled: boolean; onConfigureAi: () => void; onBusyChange?: (busy: boolean) => void; productUpdateOnly?: boolean };
const briefFields = [{ key: 'companyName', label: '公司或品牌名称', max: 120 }, { key: 'description', label: '公司与产品说明', max: 6000 }, { key: 'industry', label: '所属行业与主要产品', max: 300 }, { key: 'audience', label: '主要客户', max: 300 }, { key: 'market', label: '重点市场', max: 300 }, { key: 'styleNotes', label: '设计偏好', max: 2000 }] as const;
const fields = [{ value: 'builtin:name', label: '产品名称', required: true }, { value: 'builtin:sku', label: '产品型号 / 编号', required: true }, { value: 'builtin:category', label: '产品分类' }, { value: 'builtin:description', label: '产品介绍' }, { value: 'builtin:material', label: '材质' }, { value: 'builtin:slug', label: '网址短名' }, { value: 'builtin:seoTitle', label: '搜索标题' }, { value: 'builtin:seoDescription', label: '搜索说明' }];
const emptyOptions: Options = { sourceId: '', sheetIndex: 1, headerRow: 1, mapping: {}, skipRows: [], extraColumns: 'description', rowImages: {} };
const emptyBrief: AiSiteBrief = { companyName: '', description: '', industry: '', audience: '', market: '', language: '', styleNotes: '' };
const updateFields = [{ ...fields[1] }, { ...fields[0], required: false }, ...fields.slice(2, 5), ...fields.slice(6), { value: 'builtin:sortOrder', label: '排序' }];
function validOptions(value: unknown): value is RecoveryOptions {
  const v = value as RecoveryOptions;
  if (v?.reviewId !== undefined && (typeof v.reviewId !== 'string' || !/^aix-[a-f0-9-]{36}$/.test(v.reviewId))) return false;
  return !!v && typeof v.sourceId === 'string' && v.sourceId.length <= 100 && (v.modelId === undefined || /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(v.modelId)) && Number.isSafeInteger(v.sheetIndex) && Number.isSafeInteger(v.headerRow) && !!v.mapping && !Array.isArray(v.mapping) && Object.keys(v.mapping).length <= 64 && Object.entries(v.mapping).every(([key, target]) => /^c\d+$/.test(key) && typeof target === 'string' && (fields.some(field => field.value === target) || target === 'builtin:sortOrder' || /^field:[a-z0-9][a-z0-9_-]{0,99}$/i.test(target))) && Array.isArray(v.skipRows) && v.skipRows.length <= 1000 && v.skipRows.every(Number.isSafeInteger) && ['description', 'ignore'].includes(v.extraColumns) && (v.rowImages === undefined || !!v.rowImages && !Array.isArray(v.rowImages) && Object.keys(v.rowImages).length <= 500 && Object.entries(v.rowImages).every(([row, id]) => /^\d+$/.test(row) && typeof id === 'string' && id.length <= 100));
}
function columnLabel(index: number) { let number = index + 1, label = ''; while (number) { number--; label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26); } return label; }
function suggestMapping(sheet: AiSourceSheet, headerRow: number, update = false) {
  const row = sheet.rows.find(item => item.rowNumber === headerRow), used = new Set<string>(), result: Record<string, string> = {};
  const names: Record<string, string[]> = { name: ['产品名称', '品名', '名称', 'productname', 'product', 'name'], sku: ['sku', '型号', '货号', '产品型号', '产品编号', '编号', 'model', 'modelnumber', 'itemno', 'itemnumber'], category: ['分类', '产品分类', '类别', 'category'], description: ['产品介绍', '产品描述', '介绍', '描述', 'description'], material: ['材质', '材料', 'material'], slug: ['slug', '网址短名'], seoTitle: ['seotitle', '搜索标题'], seoDescription: ['seodescription', '搜索说明'] };
  row?.cells.forEach((cell, index) => { if (sheet.hiddenColumns?.includes(index + 1)) return; const key = cell.trim().toLowerCase().replace(/[\s._\-()（）/]/g, ''); const match = Object.entries(names).find(([, aliases]) => aliases.includes(key)); if (match && !used.has(match[0])) { result[`c${index + 1}`] = `builtin:${match[0]}`; used.add(match[0]); } });
  // 更新时只建议识别列，空着的字段需要站长主动授权，旧表的其余列不会被自动写入。
  return update ? Object.fromEntries(Object.entries(result).filter(([, value]) => value === 'builtin:sku')) : result;
}

export function ExcelSkuUpdate() {
  const runtime = useStudioRuntime(), [open, setOpen] = useState(false);
  if (runtime.actor.role !== 'admin') return null;
  return <><Button icon={<FileExcelOutlined />} onClick={() => setOpen(true)}>按型号更新</Button><AiSourceImport productUpdateOnly open={open} onClose={() => setOpen(false)} onRequestOpen={() => setOpen(true)} brief={emptyBrief} onApplyBrief={() => {}} providerEnabled={false} onConfigureAi={() => {}} /></>;
}

function SkuUpdateValue({ field, value }: { field: string; value: ExcelSkuChange['before'] }) {
  if (field === 'image' || field === 'images') {
    const images = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    return images.length ? <Space wrap>{images.map((url, index) => <Image key={url} width={48} height={48} src={url} alt={`第${index + 1}张图`} style={{ objectFit: 'contain' }} />)}</Space> : <Text type="secondary">未设置</Text>;
  }
  return <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value === null || value === '' ? '未设置' : Array.isArray(value) ? value.join('、') : String(value)}</Text>;
}

/** 原文和明确暂存的 Excel 改值均从本人私有资料读取；浏览器只记录恢复标识和映射。 */
export default function AiSourceImport({ open, onClose, onRequestOpen, brief, onApplyBrief, onProductsImported, providerEnabled, onConfigureAi, onBusyChange, productUpdateOnly = false }: Props) {
  const runtime = useStudioRuntime(), { message, modal } = App.useApp(), admin = runtime.actor.role === 'admin';
  const scope = productUpdateOnly ? 'excel-sku-update' : 'ai-source-import';
  const models = productUpdateOnly ? (runtime.envelope.state.contentModels || []).filter(item => item.target === 'product') : [];
  const [recovered] = useState(() => readLocalRecovery<RecoveryOptions>(runtime.actor.id, scope, validOptions));
  const [options, setOptions] = useState<RecoveryOptions>(recovered?.snapshot || emptyOptions);
  const parameterFields = (models.find(model => model.id === options.modelId)?.fields || []).filter(field => EXCEL_UPDATE_PARAMETER_TYPES.some(type => type === field.type)).map(field => ({ value: `field:${field.id}`, label: field.label }));
  const availableFields = productUpdateOnly ? [...updateFields, ...parameterFields] : fields;
  const [sources, setSources] = useState<SourceSummary[]>([]), [record, setRecord] = useState<SourceRecord>();
  const [ownBusy, setBusy] = useState(''), [enhanceBusy, setEnhanceBusy] = useState(''), [mergeBusy, setMergeBusy] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState(''), [dirty, setDirty] = useState(false);
  const busy = ownBusy || enhanceBusy || mergeBusy;
  const [reuseOpen, setReuseOpen] = useState(false);
  const [mergeRequested,setMergeRequested]=useState(false);
  const [edits, setEdits] = useState<ExcelEdits>({}), [preview, setPreview] = useState<ProductPreview>();
  const [completedRows, setCompletedRows] = useState<number[]>([]);
  const [receipts, setReceipts] = useState<ExcelSkuReceipt[]>([]);
  const [pages, setPages] = useState<number[]>([]), [briefResult, setBriefResult] = useState<BriefResult>(), [briefDraft, setBriefDraft] = useState<Partial<AiSiteBrief>>({}), [briefSelection, setBriefSelection] = useState<string[]>([]);
  const [briefPages, setBriefPages] = useState<number[]>([]);
  const lock = useRef(false), resumed = useRef(false);
  const savedReview = useRef<{ id: string; sourceId: string; sheetIndex: number; headerRow: number; edits: ExcelEdits }>(undefined);
  const sheet = record?.source.sheets?.find(item => item.index === options.sheetIndex && !item.hidden);
  const rows = sheet?.rows.filter(row => row.rowNumber > options.headerRow && !row.hidden && row.cells.some((value, index) => !sheet.hiddenColumns?.includes(index + 1) && value.trim())) || [];
  const chosen = rows.filter(row => !options.skipRows.includes(row.rowNumber) && !completedRows.includes(row.rowNumber));
  const header = sheet?.rows.find(row => row.rowNumber === options.headerRow);
  const columns = sheet ? Array.from({ length: sheet.columnCount }, (_, index) => ({ id: `c${index + 1}`, index, label: `${columnLabel(index)} · ${header?.cells[index]?.trim() || '未命名列'}` })).filter(column => !sheet.hiddenColumns?.includes(column.index + 1)) : [];
  const selectedChars = (record?.source.pages || []).filter(page => pages.includes(page.pageNumber)).reduce((sum, page) => sum + page.text.length, 0);
  const rowImageOptions = (record?.source.images || []).filter(image => image.source.kind === 'xlsx' && image.source.sheetIndex === options.sheetIndex && !image.source.hidden && image.adoptedMediaId && runtime.getEnvelope().state.media.some(media => media.id === image.adoptedMediaId));
  // 直接刷新仍可恢复同一工作表最后明确暂存的版本；再次点保留才提交其后的改值。
  const existingReview = savedReview.current;
  const pinnedReview = existingReview?.sourceId === options.sourceId && existingReview.sheetIndex === options.sheetIndex && existingReview.headerRow === options.headerRow ? existingReview : undefined;
  const snapshot = { ...options, reviewId: pinnedReview?.id };
  const hasExcelEdits = record?.source.kind === 'xlsx' && Object.keys(edits).length > 0;
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope, screen: productUpdateOnly ? 'products' : 'templates', title: productUpdateOnly ? '产品更新选项' : '资料导入选项', dirty: open && dirty, busy: !!busy, snapshot,
    prepareRetention: hasExcelEdits ? async () => {
      if (pinnedReview?.edits === edits) return snapshot;
      const { reviewId } = await request<{ reviewId: string }>(`/api/ai/sources/${encodeURIComponent(options.sourceId)}/review`, { method: 'POST', body: JSON.stringify({ sheetIndex: options.sheetIndex, headerRow: options.headerRow, edits }) });
      savedReview.current = { id: reviewId, sourceId: options.sourceId, sheetIndex: options.sheetIndex, headerRow: options.headerRow, edits };
      return { ...snapshot, reviewId };
    } : undefined,
    retentionNote: hasExcelEdits ? '保留后可以在当前标签页刷新恢复列映射和人工改值，直到这份 Excel 资料到期。改值暂存在本机服务，确认导入前不写入产品。' : record?.source.kind === 'pdf' ? '只保留资料选择。PDF 整理稿请先使用勾选的资料，否则刷新后需要重新整理。' : undefined,
    discard: () => { savedReview.current = undefined; setEdits({}); setPreview(undefined); setBriefResult(undefined); setBriefDraft({}); setBriefSelection([]); setBriefPages([]); setDirty(false); } });
  useEffect(() => { onBusyChange?.(!!busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  function clearReview() { savedReview.current = undefined; setEdits({}); setCompletedRows([]); setPreview(undefined); setBriefResult(undefined); setBriefDraft({}); setBriefSelection([]); setBriefPages([]); setError(''); setSuccess(''); setDirty(false); }
  // 原文核对结果只在内存，切换来源前明确提示，避免丢掉尚未确认的单元格或AI结果。
  function replaceReview(next: () => void) { if (!dirty) { next(); return; } Modal.confirm({ title: '切换资料前请确认', content: '切换后会清除当前未确认的单元格修改和AI整理结果，已上传的来源资料和已保存内容仍保留。', okText: '放弃本次修改并切换', cancelText: '继续核对', onOk: next }); }
  function configure(next: SourceRecord, previous?: RecoveryOptions) {
    setRecord(next); clearReview(); const nextSheet = next.source.sheets?.find(item => !item.hidden), firstRow = nextSheet?.rows.find(row => !row.hidden)?.rowNumber || 1;
    setOptions(previous && previous.sourceId === next.id ? previous : { ...emptyOptions, sourceId: next.id, sheetIndex: nextSheet?.index || 1, headerRow: firstRow, mapping: nextSheet ? suggestMapping(nextSheet, firstRow, productUpdateOnly) : {} });
    setPages((next.source.pages || []).filter(page => !page.needsOcr).map(page => page.pageNumber));
  }
  async function restoreReview(previous: RecoveryOptions) {
    const sourcePath = `/api/ai/sources/${encodeURIComponent(previous.sourceId)}`;
    configure(await request<SourceRecord>(sourcePath), previous);
    if (!previous.reviewId) return;
    const review = await request<{ sheetIndex: number; headerRow: number; edits: ExcelEdits }>(`${sourcePath}/review?id=${encodeURIComponent(previous.reviewId)}`);
    if (review.sheetIndex !== previous.sheetIndex || review.headerRow !== previous.headerRow) throw new Error('暂存改值属于其他工作表或表头，请核对原表。');
    savedReview.current = { id: previous.reviewId, sourceId: previous.sourceId, sheetIndex: previous.sheetIndex, headerRow: previous.headerRow, edits: review.edits };
    setEdits(review.edits); setDirty(true); setSuccess('已恢复 Excel 的人工改值。请重新检查后再确认导入。');
  }
  async function listSources() { const result = await request<{ items: SourceSummary[] }>('/api/ai/sources'); const items = productUpdateOnly ? result.items.filter(item => item.kind === 'xlsx' || item.source?.kind === 'xlsx') : result.items; setSources(items); return items; }
  async function listReceipts() { const data = await request<{ items: ExcelSkuReceipt[] }>('/api/ai/sources/product-updates'); setReceipts(data.items); }
  async function run<T>(name: string, work: () => Promise<T>): Promise<T | undefined> {
    if (!admin || lock.current) return; lock.current = true; setBusy(name); setError(''); setSuccess('');
    try { return await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，当前资料和选项仍保留'); return undefined; }
    finally { lock.current = false; setBusy(''); }
  }
  useEffect(() => {
    if (!open || !admin) return;
    void run('读取资料', async () => { if (productUpdateOnly) await listReceipts(); const items = await listSources(); if (!record && options.sourceId) await restoreReview(options); else if (!record && items[0]) configure(await request<SourceRecord>(`/api/ai/sources/${encodeURIComponent(items[0].id)}`)); });
    // 窗口重新打开读取列表，但不以异步列表覆盖当前人工核对内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, admin, productUpdateOnly]);
  useEffect(() => { const resume = (event: Event) => { if(!productUpdateOnly && (event as CustomEvent).detail?.scope === 'ai-source-merge'){setMergeRequested(true);onRequestOpen();return;} if ((event as CustomEvent).detail?.scope !== scope) return; const item = readLocalRecovery<RecoveryOptions>(runtime.actor.id, scope, validOptions); if (item) { setOptions(item.snapshot); setRecord(undefined); resumed.current = true; onRequestOpen(); } }; window.addEventListener('form-studio:recover-local', resume); return () => window.removeEventListener('form-studio:recover-local', resume); }, [runtime.actor.id, onRequestOpen, scope, productUpdateOnly]);
  async function upload(file: File) {
    replaceReview(() => void run('提取资料', async () => {
      if (!(productUpdateOnly ? /\.xlsx$/i : /\.(pdf|xlsx)$/i).test(file.name)) throw new Error(productUpdateOnly ? '请选择.xlsx产品表；旧.xls请先另存为.xlsx' : '请选择PDF或.xlsx文件；旧.xls请先另存为.xlsx');
      if (file.size > AI_SOURCE_LIMITS.maxFileBytes) throw new Error('每份资料最多10 MB');
      const form = new FormData(); form.set('file', file); const result = await request<SourceRecord>('/api/ai/sources', { method: 'POST', body: form }); configure(result); await listSources(); message.success('资料已在本机提取，尚未调用AI或写入网站内容');
    })); return Upload.LIST_IGNORE;
  }
  function changeSheet(index: number) { if (index === options.sheetIndex) return; replaceReview(() => changeSheetNow(index)); }
  function changeSheetNow(index: number) { const next = record?.source.sheets?.find(item => item.index === index); if (!next || next.hidden) return; const first = next.rows.find(row => !row.hidden)?.rowNumber || 1; setOptions(value => ({ ...value, sheetIndex: index, headerRow: first, mapping: suggestMapping(next, first, productUpdateOnly), skipRows: [], rowImages: {} })); setEdits({}); setCompletedRows([]); setPreview(undefined); setDirty(true); }
  function changeHeader(row: number) { if (row === options.headerRow) return; replaceReview(() => changeHeaderNow(row)); }
  function changeHeaderNow(row: number) { if (!sheet) return; setOptions(value => ({ ...value, headerRow: row, mapping: suggestMapping(sheet, row, productUpdateOnly), skipRows: [], rowImages: {} })); setEdits({}); setPreview(undefined); setDirty(true); }
  function changeModel(modelId?: string) { setOptions(value => ({ ...value, modelId, mapping: Object.fromEntries(Object.entries(value.mapping).filter(([, target]) => !target.startsWith('field:'))) })); setPreview(undefined); setDirty(true); }
  function mapField(field: string, column?: string) { setOptions(value => ({ ...value, mapping: { ...Object.fromEntries(Object.entries(value.mapping).filter(([, target]) => target !== field)), ...(column ? { [column]: field } : {}) } })); setPreview(undefined); setDirty(true); }
  function editCell(row: number, column: string, value: string) { setEdits(current => ({ ...current, [row]: { ...current[row], [column]: value } })); setPreview(undefined); setDirty(true); }
  function selectRows(visibleRows: number[]) { const selected = new Set(visibleRows); setOptions(value => ({ ...value, skipRows: rows.filter(row => !selected.has(row.rowNumber)).map(row => row.rowNumber) })); setPreview(undefined); setDirty(true); }
  async function inspectProducts() {
    if (!record) return;
    await run('检查产品', async () => { await runtime.flush(); const result = await request<ProductPreview>(`/api/ai/sources/${encodeURIComponent(record.id)}/preview`, { method: 'POST', body: JSON.stringify({ expectedRevision: runtime.getEnvelope().revision, ...(productUpdateOnly ? { mode: 'update', modelId: options.modelId } : {}), sheetIndex: options.sheetIndex, headerRow: options.headerRow, mapping: options.mapping, extraColumns: productUpdateOnly ? 'ignore' : options.extraColumns, rowImages: Object.entries(options.rowImages || {}).filter(([row]) => chosen.some(item => item.rowNumber === Number(row))).map(([row,imageId]) => ({row:Number(row),imageId})), skipRows: [...new Set([...options.skipRows, ...completedRows])].filter(row => rows.some(item => item.rowNumber === row)), edits: Object.entries(edits).map(([row, values]) => ({ row: Number(row), values })) }) }); setPreview(result); });
  }
  async function applyProducts() {
    if (!record || !preview?.previewId || preview.errors.length) return;
    await run('保存产品草稿', async () => {
      const expected = preview.revision ?? preview.baseRevision;
      // 服务端先识别同一批次的回执；刷新后仍可确认失联保存，不在客户端提前拒绝幂等重试。
      let importedIds: string[] = [], receipt: ExcelSkuReceipt | undefined;
      await runtime.mutate(async () => { const result = await request<StudioEnvelope & { importedProductIds?: string[]; updateReceipt?: ExcelSkuReceipt }>(`/api/ai/sources/${encodeURIComponent(record.id)}/apply`, { method: 'POST', body: JSON.stringify({ previewId: preview.previewId, expectedRevision: expected }) }); const skus = new Set(preview.rows.map(row => row.sku.trim().toLowerCase())); importedIds = result.importedProductIds || result.state.products.filter(product => skus.has(product.sku.trim().toLowerCase())).map(product => product.id); receipt = result.updateReceipt; return result; });
      const imported = (preview.updates || preview.rows).map(row => row.row), remainingEdits = Object.fromEntries(Object.entries(edits).filter(([row]) => !imported.includes(Number(row))));
      setOptions(value => ({ ...value, skipRows: [...new Set([...value.skipRows, ...imported])] })); setCompletedRows(value => [...new Set([...value, ...imported])]); setEdits(remainingEdits); setDirty(!!Object.keys(remainingEdits).length); clearLocalRecovery(runtime.actor.id, scope); setPreview(undefined);
      if (receipt) { const saved = receipt; setReceipts(current => [saved, ...current.filter(item => item.id !== saved.id)]); setSuccess(`已更新${saved.rowCount}个产品草稿。最近更新中可在7天内撤销。`); }
      else { onProductsImported?.(importedIds); setSuccess(`已新增${preview.rowCount}个产品草稿，原产品保持；关闭窗口即可继续AI建站。`); }
      message.success('产品草稿已保存，尚未发布');
    });
  }
  async function refreshWorkspace() { await run('读取工作区', async () => { if (productUpdateOnly && runtime.getSaveState() === 'error') await runtime.recoverRejectedMutation(); else await readFreshStudio(runtime); setSuccess('已读取最新工作区，文件与本窗口修改仍保留。上次保存结果不确定时可再次确认同一批次；其他修改请重新检查产品。'); }); }
  function undoUpdate(receipt: ExcelSkuReceipt) {
    modal.confirm({ title: `撤销 ${receipt.rowCount} 个产品的这次更新？`, content: '恢复本次更新的草稿字段。如果相同字段后来已保存新值，本次撤销会暂停并保留新修改。', okText: '确认撤销', cancelText: '取消', onOk: () => run('撤销产品更新', async () => {
      let revised: ExcelSkuReceipt | undefined;
      await runtime.mutate(async env => { const result = await request<StudioEnvelope & { updateReceipt: ExcelSkuReceipt }>('/api/ai/sources/product-updates', { method: 'POST', body: JSON.stringify({ id: receipt.id, expectedRevision: env.revision }) }); revised = result.updateReceipt; return result; });
      if (revised) { const updated = revised; setReceipts(current => current.map(item => item.id === updated.id ? updated : item)); }
      // 撤销后仍可选择同一份文件的行继续核对，不沿用旧检查的确认权限。
      setCompletedRows([]); setPreview(undefined); setSuccess('已撤销本次产品草稿更新。');
    }) });
  }
  async function organizeBrief() {
    if (!record) return;
    const sourcePages = [...pages];
    await run('AI整理资料', async () => { const result = await request<BriefResult>('/api/ai/sources/brief', { method: 'POST', body: JSON.stringify({ sourceId: record.id, pageNumbers: sourcePages }) }); setBriefPages(sourcePages); setBriefResult(result); setBriefDraft(result.brief); setBriefSelection(briefFields.filter(field => !!result.brief[field.key] && !brief[field.key]?.trim()).map(field => field.key)); setDirty(true); });
  }
  function useExcerpts() { setBriefPages([...pages]); const text = (record?.source.pages || []).filter(page => pages.includes(page.pageNumber)).map(page => page.text).join('\n\n'); setBriefResult(undefined); setBriefDraft({ description: [brief.description, text].filter(Boolean).join('\n\n') }); setBriefSelection(['description']); setDirty(true); setError(''); }
  // 页码选择只改变下一次提取范围，当前核对稿仍绑定产生它的原页码。
  const briefScopeChanged = briefPages.length > 0 && (briefPages.length !== pages.length || briefPages.some(page => !pages.includes(page)));
  function applyBrief() {
    if (briefScopeChanged) {
      modal.confirm({ title: '使用上一次整理的资料？', content: `当前稿仍来自第 ${briefPages.join('、')} 页，和现在勾选的页码不同。`, okText: '使用上一次的资料', cancelText: '继续核对', onOk: commitBrief });
      return;
    }
    commitBrief();
  }
  function commitBrief() { const patch: Partial<AiSiteBrief> = {}; for (const field of briefFields) if (briefSelection.includes(field.key) && typeof briefDraft[field.key] === 'string') patch[field.key] = briefDraft[field.key]; if (!Object.keys(patch).length) return; onApplyBrief(patch); setDirty(false); clearLocalRecovery(runtime.actor.id, scope); setSuccess('已将勾选的资料带回建站表单；请核对缺失信息后继续。'); message.success('建站资料已带入'); }
  async function saveWritingExcerpts(items: AiWritingReuseCandidate[]) {
    let completed = false;
    await run('保存待确认写作资料', async () => {
      const profile = await request<AiWritingProfile>('/api/ai/writing/profile');
      const additions = items.filter(item => !profile.facts.some(fact => fact.sourceRef?.fingerprint === item.sourceRef.fingerprint));
      if (profile.facts.length + additions.length > 30) throw new Error('共用资料最多30项，请到站点设置移除不用的资料或减少本次选择。');
      // 明确保存也只登记待确认摘录；不改导入审核稿，不将新摘录直接发给模型。
      if (additions.length) await request('/api/ai/writing/profile', { method: 'PATCH', body: JSON.stringify({ expectedRevision: profile.revision, brandName: profile.brandName, audience: profile.audience, market: profile.market, tone: profile.tone, terminology: profile.terminology, avoidedClaims: profile.avoidedClaims, facts: [...profile.facts, ...additions.map(item => ({ id: `fact-${crypto.randomUUID()}`, label: item.label, text: item.text, source: item.source, scope: item.scope, productId: item.productId, sourceRef: item.sourceRef, confirmed: false }))] }) });
      completed = true; setSuccess(additions.length ? `已保存${additions.length}项待确认摘录。请到站点设置 → AI服务 → 写作资料核对并确认，产品和文章才能选择使用；当前导入审核仍保留。` : '所选摘录已在共用资料中，没有重复保存。');
    });
    if (!completed) throw new Error('摘录未保存，请保留选择并核对页面提示。');
  }
  const tooLong = briefFields.some(field => briefSelection.includes(field.key) && (briefDraft[field.key]?.length || 0) > field.max);
  const reviewedFields = briefFields.filter(field => briefDraft[field.key] !== undefined);
  const mappedFields = availableFields.filter(field => Object.values(options.mapping).includes(field.value));
  const mappedSku = mappedFields.some(field => field.value === 'builtin:sku'), mappedName = mappedFields.some(field => field.value === 'builtin:name');
  const hasUpdate = mappedFields.some(field => field.value !== 'builtin:sku') || chosen.some(row => options.rowImages?.[row.rowNumber]);
  const staleUpdate = productUpdateOnly && preview && preview.revision !== runtime.envelope.revision;
  const extension = productUpdateOnly ? '.xlsx' : '.pdf,.xlsx';
  function mappingField(field: { value: string; label: string; required?: boolean }) {
    const id = `ai-source-map-${field.value.split(':')[1]}`;
    return <Form.Item key={field.value} label={field.label} required={field.required} htmlFor={id}><Select id={id} aria-label={`对应${field.label}的列`} allowClear value={Object.entries(options.mapping).find(([, target]) => target === field.value)?.[0]} placeholder={field.required ? '选择对应的列' : '可以不选'} disabled={!!busy} options={columns.map(column => ({ value: column.id, label: column.label, disabled: !!options.mapping[column.id] && options.mapping[column.id] !== field.value }))} onChange={column => mapField(field.value, column)} /></Form.Item>;
  }
  return <>{guard.dialog}<Modal className="ai-source-import-modal" title={productUpdateOnly ? 'Excel 按型号更新产品' : '导入公司资料与产品表'} open={open} width={1180} style={{ top: 24, maxWidth: 'calc(100vw - 32px)' }} styles={{body:{maxHeight:'calc(100dvh - 220px)',overflowY:'auto',overflowX:'hidden'}}} onCancel={() => { if (!busy) guard.ask(onClose); }} maskClosable={!busy} closable={!busy} footer={<Flex justify="space-between" gap={12} wrap><Text type="secondary">{productUpdateOnly ? '确认后保存到产品草稿，公开网站继续使用当前发布版本。' : '上传和本机提取不调用AI；核对并确认后才写入建站资料或产品草稿。'}</Text><Button disabled={!!busy} onClick={() => guard.ask(onClose)}>{productUpdateOnly ? '返回产品' : '返回建站'}</Button></Flex>}>
    <Space orientation="vertical" size={24} style={{ width: '100%' }}>
      <Alert type="info" showIcon title={productUpdateOnly ? '选择型号列和要更新的列，再核对前后差异' : '先读取，再核对，最后使用'} description={productUpdateOnly ? '取消勾选可跳过该行，空单元格保留当前值，产品网址和编号不变。文件仅供当前账号核对，有效期为2小时。' : 'PDF用于整理企业介绍，Excel用于建立产品目录。提取文字和来源信息仅在当前账号的私有区域保留2小时，不会成为公开下载素材；原件只在本人私有区短存，用于按需离线识别和抽图，不产生公开下载地址，也不自动发给模型。'} />
      {record && !productUpdateOnly && <Flex justify="space-between" gap={12} wrap align="center"><Text type="secondary">已整理的PDF或已导入的产品值，也可复用于后续文章和产品写作。</Text><Button disabled={!!busy} onClick={() => setReuseOpen(true)}>选入共用写作资料</Button></Flex>}
      {error && <Alert type="error" showIcon title={error} description={productUpdateOnly ? '核对文件与当前草稿后再操作。' : '原文件和本窗口修改仍保留；模型请求不会自动重试。'} action={<Button size="small" disabled={!!busy} onClick={refreshWorkspace}>读取最新工作区</Button>} />}
      {success && <Alert type="success" showIcon title={success} />}
      {!productUpdateOnly && <AiSourceMerge sources={sources} brief={brief} onApplyBrief={onApplyBrief} disabled={!!ownBusy || !!enhanceBusy} onBusyChange={setMergeBusy} requested={mergeRequested} onRequestHandled={()=>setMergeRequested(false)} />}
      {productUpdateOnly && <Collapse items={[{ key: 'receipts', label: `最近更新 · ${receipts.length} 批`, children: <List dataSource={receipts} locale={{ emptyText: '暂无可查看的更新批次' }} pagination={receipts.length > 6 ? { pageSize: 6 } : undefined} renderItem={receipt => <List.Item actions={[receipt.undone ? <Tag key="done">已撤销</Tag> : <Button key="undo" disabled={!!busy} onClick={() => undoUpdate(receipt)}>撤销本批</Button>]}><List.Item.Meta title={receipt.fileName} description={`${receipt.rowCount} 个产品 · ${new Date(receipt.appliedAt).toLocaleString()} · 撤销有效至 ${new Date(receipt.expiresAt).toLocaleString()}`} /></List.Item>} /> }]} />}
      {(recovered || resumed.current) && <Alert type="info" title="已恢复资料选择和映射选项" description={productUpdateOnly ? '如果保留过 Excel 改值，会随私有资料一并读取。资料过期时请重新上传。' : '如果保留过 Excel 改值，会随私有资料一并读取。未使用的 PDF 整理稿需要重新整理。资料过期时请重新上传。'} />}
      <Flex gap={12} wrap align="center" className="ai-source-toolbar"><Upload accept={extension} showUploadList={false} beforeUpload={upload} disabled={!!busy || !admin}><Button icon={<UploadOutlined />} loading={busy === '提取资料'}>{productUpdateOnly ? '上传产品 Excel' : '上传PDF / Excel'}</Button></Upload><Select aria-label="当前导入资料" placeholder="选择已上传的资料" value={record?.id} style={{ width: 380, maxWidth: '100%' }} disabled={!!busy} options={sources.map(item => ({ value: item.id, label: item.fileName || item.source?.fileName || item.id }))} onChange={id => { if (id === record?.id) return; replaceReview(() => void run('读取资料', async () => configure(await request<SourceRecord>(`/api/ai/sources/${encodeURIComponent(id)}`)))); }} /><Button icon={<ReloadOutlined />} disabled={!!busy} onClick={() => void run('读取列表', async () => { await listSources(); if (productUpdateOnly) await listReceipts(); })}>刷新列表</Button>{record && <Popconfirm title="移除这份私有资料？" description={productUpdateOnly ? '已保存的产品和撤销记录会保留，需要再次核对原文时请重新上传。' : '已保存的产品和建站资料会保留，需要再次读取原文时请重新上传。'} okText="移除" cancelText="取消" onConfirm={() => run('移除资料', async () => { await request(`/api/ai/sources/${encodeURIComponent(record.id)}`, { method: 'DELETE' }); setRecord(undefined); setOptions(emptyOptions); clearReview(); clearLocalRecovery(runtime.actor.id, scope); await listSources(); })}><Button danger icon={<DeleteOutlined />} disabled={!!busy}>移除资料</Button></Popconfirm>}</Flex>
      {!record && <Upload.Dragger accept={extension} multiple={false} showUploadList={false} beforeUpload={upload} disabled={!!busy || !admin}><p className="ant-upload-drag-icon"><UploadOutlined /></p><p className="ant-upload-text">{productUpdateOnly ? '点击或拖入新版产品 Excel' : '点击或拖入公司PDF、产品Excel'}</p><p className="ant-upload-hint">{productUpdateOnly ? '每份最多10 MB。旧.xls请先另存为.xlsx。' : '每份最多10 MB，支持PDF和.xlsx。扫描文字可在上传后选择本机识别，旧.xls请先另存为.xlsx。'}</p></Upload.Dragger>}
      {record && <><Flex justify="space-between" align="center" gap={12} wrap><Space wrap><Tag icon={record.source.kind === 'pdf' ? <FilePdfOutlined /> : <FileExcelOutlined />}>{record.source.kind === 'pdf' ? '公司PDF' : '产品Excel'}</Tag><Text strong>{record.source.fileName}</Text></Space><Text type="secondary">私有资料有效至 {new Date(record.expiresAt).toLocaleString()}</Text></Flex>{!!record.source.warnings.length && <Collapse items={[{ key: 'warnings', label: `读取说明 · ${record.source.warnings.length}项`, children: <Space orientation="vertical">{record.source.warnings.map((warning, index) => <Text key={index}>{warning}</Text>)}</Space> }]} />}
      <AiSourceEnhance record={record} disabled={!!ownBusy} onBusyChange={setEnhanceBusy} onRecord={next => { setRecord(next); setPreview(undefined); setDirty(true); }} />
      {record.source.kind === 'pdf' && <>
        <Flex justify="space-between" align="center" gap={12} wrap><Text strong>选择需要使用的页码</Text><Text type="secondary">已选{pages.length}页 · {selectedChars.toLocaleString()}字</Text></Flex>
        <Checkbox.Group className="ai-source-page-selection" value={pages} disabled={!!busy} onChange={setPages} options={(record.source.pages || []).map(page => ({ value: page.pageNumber, label: `第${page.pageNumber}页${page.needsOcr ? ' · 无文字层' : ''}`, disabled: page.needsOcr }))} />
        {briefScopeChanged && !!reviewedFields.length && <Alert type="info" showIcon title="页码已改变，上次整理稿仍保留" description={`当前稿来自第 ${briefPages.join('、')} 页。可以继续用上一次资料，也可以按现在选的页码重新整理。`} />}
        {!record.source.pages?.some(page => !page.needsOcr) && <Alert type="warning" showIcon title="这份PDF没有可用文字层" description="可能是扫描件。可展开上方“识别扫描文字与提取文件图片”，选择真实页码后在本机识别；识别稿需核对，不会自动当成企业事实。" />}
        <Collapse items={(record.source.pages || []).map(page => ({ key: String(page.pageNumber), label: <Space wrap><Text>第{page.pageNumber}页</Text><Tag>{page.needsOcr ? '需要OCR' : `${page.text.length}字`}</Tag>{page.ocr && <Tag color="orange">本机识别稿 · 待核对</Tag>}</Space>, children: <Space orientation="vertical" size={12} style={{display:'flex'}}>{page.ocr && <Alert type="warning" showIcon title={`文字识别可信度 ${Math.round(page.ocr.confidence)}% · 仍需人工核对`} description="数字、单位、型号和企业名称可能识别错误，请与原件比较；AI整理时只将勾选页面的识别稿作为待核对资料。"/>}{page.originalText !== undefined && <Collapse items={[{key:'original',label:'查看原始文字层',children:<pre className="ai-source-pdf-text">{page.originalText || '原文件此页没有可用文字层。'}</pre>}]}/>}<pre className="ai-source-pdf-text">{page.text || '未提取到文字，请查看原文件。'}</pre></Space> }))} />
        <Flex gap={12} wrap><Button disabled={!!busy || !pages.length} onClick={useExcerpts}>把选中页作为说明草稿</Button><Button type="primary" icon={<ThunderboltOutlined />} loading={busy === 'AI整理资料'} disabled={!!busy || !pages.length || selectedChars > 24000 || !providerEnabled} onClick={organizeBrief}>用我的AI整理公司资料</Button>{!providerEnabled && <Button onClick={onConfigureAi} disabled={!!busy}>AI服务设置</Button>}</Flex>
        <Text type="secondary">AI整理仅发送选中页的文字和页码，使用你配置的模型额度；最多24,000字。缺少的事实会留空，结果需要核对后使用。{selectedChars > 24000 ? ' 当前选择超过上限，请减少页数。' : ''}</Text>
        {briefResult?.warnings.map((warning, index) => <Alert key={index} type="warning" showIcon title={warning} />)}
        {!!reviewedFields.length && <div className="ai-source-brief-review"><Text strong>核对准备带入的资料</Text><Form layout="vertical" disabled={!!busy}>{reviewedFields.map(field => <Form.Item key={field.key} label={<Checkbox checked={briefSelection.includes(field.key)} onChange={event => setBriefSelection(current => event.target.checked ? [...current, field.key] : current.filter(key => key !== field.key))}>{field.label}{brief[field.key]?.trim() ? ' · 已有内容，勾选后替换' : ''}</Checkbox>} validateStatus={briefSelection.includes(field.key) && (briefDraft[field.key]?.length || 0) > field.max ? 'error' : undefined} help={(briefDraft[field.key]?.length || 0) > field.max ? `最多${field.max}字，请先删减再使用；不会自动截断。` : undefined}>{field.key === 'description' ? <Input.TextArea aria-label={`导入${field.label}`} value={briefDraft[field.key]} rows={6} showCount maxLength={field.max} onChange={event => { setBriefDraft(current => ({ ...current, [field.key]: event.target.value })); setDirty(true); }} /> : <Input aria-label={`导入${field.label}`} value={briefDraft[field.key]} maxLength={field.max} onChange={event => { setBriefDraft(current => ({ ...current, [field.key]: event.target.value })); setDirty(true); }} />}</Form.Item>)}</Form>{!!briefResult?.facts.length && <Collapse items={[{ key: 'facts', label: '查看原文依据', children: <Descriptions column={1} size="small" items={briefResult.facts.map((fact, index) => ({ key: index, label: briefFields.find(field => field.key === fact.field)?.label || fact.field, children: <><Paragraph>{fact.value}</Paragraph><Text type="secondary">第{fact.pageNumbers.join('、')}页</Text>{fact.evidence?.map((item, i) => <Paragraph key={i} type="secondary">第{item.pageNumber}页：{item.quote}</Paragraph>)}</> }))} /> }]} />}<Flex justify="end" className="ai-source-section-actions"><Button type="primary" disabled={!!busy || !briefSelection.length || tooLong} onClick={applyBrief}>使用勾选的建站资料</Button></Flex></div>}
      </>}
      {record.source.kind === 'xlsx' && <>
        {!sheet && <Alert type="warning" showIcon title="请选择可见的产品工作表" description="隐藏工作表不会显示或导入。没有可见工作表时，请在Excel中取消需要使用的工作表隐藏后重新上传。" />}
        <Form layout="vertical" className="ai-source-sheet-options"><Flex gap={24} wrap><Form.Item label="产品所在工作表" htmlFor="ai-source-sheet"><Select id="ai-source-sheet" aria-label="产品工作表" value={options.sheetIndex} disabled={!!busy} style={{ width: 300, maxWidth: '100%' }} options={record.source.sheets?.map(item => ({ value: item.index, label: `${item.name}${item.hidden ? ' · 已隐藏，不导入' : ''}`, disabled: item.hidden }))} onChange={changeSheet} /></Form.Item><Form.Item label="哪一行是列名" htmlFor="ai-source-header"><Select id="ai-source-header" aria-label="产品表头行" showSearch optionFilterProp="label" value={options.headerRow} disabled={!!busy} style={{ width: 380, maxWidth: '100%' }} options={sheet?.rows.filter(row => !row.hidden).map(row => ({ value: row.rowNumber, label: `第${row.rowNumber}行 · ${row.cells.filter((value,index) => !sheet.hiddenColumns?.includes(index+1) && !!value).slice(0, 4).join(' / ').slice(0, 100)}` }))} onChange={changeHeader} /></Form.Item></Flex>
          <div className="ai-source-mapping-grid">{(productUpdateOnly ? updateFields : fields).slice(0, 5).map(mappingField)}</div>
          <Collapse items={[{ key: 'extra', label: '其他参数与搜索资料（可选）', children: <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            {!productUpdateOnly && <><Checkbox checked={options.extraColumns === 'description'} disabled={!!busy} onChange={event => { setOptions(value => ({ ...value, extraColumns: event.target.checked ? 'description' : 'ignore' })); setPreview(undefined); setDirty(true); }}>将未映射列保留在产品介绍中</Checkbox><Text type="secondary">参数名、数值和单位按原文保留。所有未映射列都会写入介绍；不希望出现在网站中的内容，请取消此选项，或在原Excel中移除后重新上传。隐藏行列不导入，公式只使用文件内缓存显示值，不重算。</Text></>}
            <div className="ai-source-mapping-grid">{(productUpdateOnly ? updateFields : fields).slice(5).map(mappingField)}</div>
            {productUpdateOnly && !!models.length && <><Select aria-label="产品参数分组" placeholder="选择已有产品的参数分组" value={options.modelId} allowClear style={{ width: 300, maxWidth: '100%' }} disabled={!!busy} options={models.map(model => ({ value: model.id, label: model.name }))} onChange={changeModel} />{options.modelId && <><Text type="secondary">参数写入前核对产品所属分组。数字用数字，布尔用 true / false，多选用 JSON 文本数组，选项用对应值。</Text><div className="ai-source-mapping-grid">{parameterFields.map(mappingField)}</div></>}</>}
          </Space> }]} />
        </Form>
        {sheet && <><Flex justify="space-between" gap={12} wrap align="center"><Text strong>核对产品 · 已选择{chosen.length}行{completedRows.length ? ` · 本窗口已${productUpdateOnly ? '更新' : '导入'}${completedRows.length}行` : ''}</Text><Space wrap><Button size="small" disabled={!!busy} onClick={() => selectRows(rows.filter(row => !completedRows.includes(row.rowNumber)).slice(0, 500).map(row => row.rowNumber))}>{completedRows.length ? '选择下一批（最多500行）' : '选择前500行'}</Button><Button size="small" disabled={!!busy} onClick={() => selectRows([])}>全部跳过</Button></Space></Flex>{chosen.length > 500 && <Alert type="warning" showIcon title={`每次最多${productUpdateOnly ? '更新' : '新增'}500个产品，请先选择一批`} />}
        <Text type="secondary">{productUpdateOnly ? '可手工核对已映射的单元格。修改表中的型号会改变匹配对象，原产品型号保持。文件图片加入素材后可逐行选择新封面，原相册图片会保留。' : '可直接修改已映射的单元格，取消勾选即可跳过该行；0、false和文本编号按显示值保留。修改只在当前窗口内，检查通过后才会新增产品。文件图片可在上方按需提取并明确选入素材；随后在下表逐行选择图片，不会自动按位置猜测关联。'}</Text>
        <Table size="small" rowKey="rowNumber" dataSource={rows} scroll={{ x: Math.max(700, mappedFields.length * 200), y: 380 }} pagination={{ pageSize: 10, showSizeChanger: false }} rowSelection={{ selectedRowKeys: chosen.map(row => row.rowNumber), onChange: values => selectRows(values.map(Number)), getCheckboxProps: row => ({ disabled: !!busy || completedRows.includes(row.rowNumber) }) }} columns={[{ title: '原行号', dataIndex: 'rowNumber', width: 80, fixed: 'left' }, ...mappedFields.map(field => { const column = Object.entries(options.mapping).find(([, target]) => target === field.value)?.[0] || '', index = Number(column.slice(1)) - 1; return { title: field.label, key: field.value, width: field.value === 'builtin:description' ? 300 : 190, render: (_: unknown, row: typeof rows[number]) => <><Input.TextArea aria-label={`第${row.rowNumber}行${field.label}`} value={edits[row.rowNumber]?.[column] ?? row.cells[index] ?? ''} autoSize={{ minRows: 1, maxRows: 3 }} maxLength={6000} disabled={!!busy || options.skipRows.includes(row.rowNumber) || completedRows.includes(row.rowNumber)} onChange={event => editCell(row.rowNumber, column, event.target.value)} />{row.formulaColumns.includes(index + 1) && <Text type="secondary" className="ai-source-formula-note">公式缓存值 · 未重算</Text>}</> }; })]} />
        {!!rowImageOptions.length && <Collapse items={[{key:'row-images',label:'逐行确认产品图片（默认不匹配）',children:<Space orientation="vertical" size={12} style={{display:'flex'}}><Text type="secondary">这里只显示当前工作表已明确保存到素材中心的图片。行列位置仅供核对，不代表产品归属；每行需由你明确选择。</Text><List dataSource={chosen} pagination={{pageSize:8,showSizeChanger:false}} renderItem={row=><List.Item><Space orientation="vertical" size={8} style={{width:'100%'}}><Text strong>第{row.rowNumber}行产品</Text><Select aria-label={`第${row.rowNumber}行产品图片`} style={{width:'100%'}} value={options.rowImages?.[String(row.rowNumber)]} allowClear placeholder="不配图，由我选择" disabled={!!busy} options={rowImageOptions.map(image=>({value:image.id,label:sourceImageLocation(image)}))} optionRender={option=><Space><Image preview={false} width={36} height={36} style={{objectFit:'contain'}} src={sourceImageUrl(record.id,String(option.value))} alt="来源图片缩略图"/>{option.label}</Space>} onChange={imageId=>{setOptions(value=>({...value,rowImages:Object.fromEntries([...Object.entries(value.rowImages||{}).filter(([key])=>key!==String(row.rowNumber)),...(imageId?[[String(row.rowNumber),imageId]]:[])])}));setPreview(undefined);setDirty(true);}}/>{options.rowImages?.[String(row.rowNumber)]&&<Image width={100} height={80} style={{objectFit:'contain'}} src={sourceImageUrl(record.id,options.rowImages[String(row.rowNumber)])} alt={`第${row.rowNumber}行已选产品图`}/>}</Space></List.Item>}/></Space>}]}/>}
        <Flex className="ai-source-section-actions" justify="space-between" gap={12} wrap><Button loading={busy === '检查产品'} disabled={!!busy || !chosen.length || chosen.length > 500 || !mappedSku || (productUpdateOnly ? !hasUpdate : !mappedName)} onClick={inspectProducts}>{productUpdateOnly ? '预览更新差异' : '检查选中的产品'}</Button>{!productUpdateOnly && <Button type="primary" loading={busy === '保存产品草稿'} disabled={!!busy || !preview?.previewId || !!preview.errors.length} onClick={applyProducts}>{preview && !preview.errors.length ? `确认新增${preview.rowCount}个产品草稿` : '确认新增产品草稿'}</Button>}</Flex></>}
        {preview && <>
          <Alert type={preview.errors.length ? 'error' : staleUpdate ? 'warning' : 'success'} showIcon title={preview.errors.length ? `发现${preview.errors.length}处问题，尚未${productUpdateOnly ? '更新' : '新增'}产品` : staleUpdate ? '草稿已变化，请重新预览' : productUpdateOnly && !preview.rowCount ? '所选产品没有需要更新的字段' : `检查通过 · ${preview.rowCount}个产品，5分钟内确认`} description={productUpdateOnly ? '编号、网址及未选择字段保留。未匹配或无效的行可取消勾选后重新检查。' : '只新增草稿，重复型号或无效资料会拒绝整批，不覆盖现有产品，也不会自动发布。'} />
          {!!preview.errors.length && <Table size="small" rowKey={(_, index) => String(index)} dataSource={preview.errors} pagination={{ pageSize: 8 }} columns={[{ title: '原行号', dataIndex: 'row', width: 80 }, { title: '字段', dataIndex: 'field' }, { title: '问题', dataIndex: 'message' }]} />}
          {productUpdateOnly ? <>
            {!!preview.updates?.length && <Table key={preview.previewId || 'invalid'} size="small" rowKey="row" dataSource={preview.updates} pagination={{ pageSize: 5 }} columns={[{ title: '原行号', dataIndex: 'row', width: 80 }, { title: '产品', dataIndex: 'title' }, { title: '型号', dataIndex: 'sku' }]} expandable={{ defaultExpandedRowKeys: [preview.updates[0].row], expandedRowRender: row => <Descriptions column={1} size="small" items={row.changes.map(change => ({ key: change.field, label: change.label, children: <Space orientation="vertical"><Space wrap><Text type="secondary">当前</Text><SkuUpdateValue field={change.field} value={change.before} /></Space><Space wrap><Text strong>更新后</Text><SkuUpdateValue field={change.field} value={change.after} /></Space></Space> }))} /> }} />}
            <Flex justify="end" className="ai-source-section-actions"><Button type="primary" loading={busy === '保存产品草稿'} disabled={!!busy || !preview.previewId || !!preview.errors.length || !!staleUpdate} onClick={applyProducts}>{preview.rowCount ? `确认更新${preview.rowCount}个产品草稿` : '确认更新产品草稿'}</Button></Flex>
          </> : <Collapse items={[{ key: 'preview', label: '查看实际准备写入的产品与参数', children: <Table size="small" rowKey="row" dataSource={preview.rows} pagination={{ pageSize: 5 }} columns={[{ title: '原行号', dataIndex: 'row', width: 80 }, { title: '产品', dataIndex: 'title' }, { title: '型号', dataIndex: 'sku' }]} expandable={{ expandedRowRender: row => <Descriptions column={1} size="small" items={Object.entries(row.values).map(([key, value]) => ({ key, label: fields.find(field => field.value === `builtin:${key}`)?.label || key, children: <Text style={{ whiteSpace: 'pre-wrap' }}>{String(value ?? '')}</Text> }))} /> }} /> }]} />}
          {!!preview.warnings.length && <Collapse items={[{ key: 'warnings', label: productUpdateOnly ? '产品更新说明' : '产品导入说明', children: <Space orientation="vertical">{preview.warnings.map((warning, index) => <Text key={index}>{warning}</Text>)}</Space> }]} />}
        </>}
      </>}
      </>}
      {!!busy && <Alert type="info" showIcon title={`正在${busy}…`} description={busy === 'AI整理资料' ? '正在请求你配置的模型。系统不会自动重试或切换服务。' : '请等待本次操作结果；网站内容不会自动发布。'} />}
    </Space>
  </Modal>{!productUpdateOnly && <AiWritingReusePicker open={reuseOpen} onClose={() => setReuseOpen(false)} onPick={saveWritingExcerpts} initialSourceId={record?.id} actionLabel="保存为待确认写作资料" />}</>;
}
