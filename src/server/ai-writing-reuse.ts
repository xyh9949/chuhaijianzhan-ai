import { createHash } from 'node:crypto';
import type { AiWritingReuseCandidate, AiWritingReuseResponse, AiWritingSourceRef, AiWritingSourceState } from '../lib/ai-writing-reuse-types';
import type { AiSourceBriefResult } from '../lib/ai-source-brief-types';
import type { ContentImportSpec } from '../lib/content-import';
import type { Product } from '../lib/types';
import { parseImportFile } from '../lib/content-import';
import { getDatabase } from './database';
import { getDraftRecord } from './studio';
import { listAiSources, readAiSource } from './ai-source-import';
import { ApiError } from './http';
import { object } from './validation';
import { isMemberDisabled, requirePermission, type Actor, type MemberRow } from './permissions';

type SourceRow = { id: string; source_id: string | null; payload_json: string; created_at: string; expires_at: string; applied_revision: number | null };
const labels: Record<string, string> = { companyName: '公司称谓', description: '介绍', industry: '行业与产品', audience: '主要买家', market: '重点市场', styleNotes: '表达偏好', name: '产品名称', sku: '产品型号', category: '产品分类', material: '材质' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function admin(actor: Actor) {
  requirePermission(actor, 'manage');
  const row = getDatabase().prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as MemberRow | undefined;
  if (!row || isMemberDisabled(row)) throw new ApiError(401, '账号已停用或会话失效');
  if (row.role !== 'admin') throw new ApiError(403, '资料复用由管理员操作');
}
function candidate(label: string, text: string, source: string, scope: 'company' | 'product', ref: Omit<AiWritingSourceRef, 'snapshot' | 'fingerprint'>, productId?: string): AiWritingReuseCandidate | undefined {
  // 不静默截断长摘录；超出单条事实限制时让用户回原页选择更小的范围。
  if (!text.trim() || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<\s*\/?[a-z][\w:-]*(?:\s[^>]*|\s*\/?)>|<!|<\?/i.test(text)) return;
  const sourceRef: AiWritingSourceRef = { ...ref, snapshot: text, fingerprint: hash([ref.kind, ref.recordId, ref.sourceId, ref.locator, text, scope, productId, ref.quotes]) };
  return { id: sourceRef.fingerprint, label: label.slice(0, 120), text, source: source.slice(0, 500), scope, ...(productId ? { productId } : {}), sourceRef };
}
function productValues(product: Product) {
  const content = getDraftRecord().content, model = content.contentModels?.find(item => item.id === product.modelId && item.target === 'product');
  const values: { key: string; label: string; text: string }[] = ['name', 'sku', 'category', 'material', 'description'].map(key => ({ key, label: labels[key], text: String(product[key as keyof Product] ?? '') }));
  // 只提供可见文字/参数供用户明确挑选，不从图片、网址、关系或未知字段推断事实。
  for (const field of model?.fields || []) {
    if (!['text', 'textarea', 'number', 'boolean', 'select'].includes(field.type)) continue;
    const value = product.customFields?.[field.id];
    if (value === undefined || value === null || value === '') continue;
    values.push({ key: `customFields:${field.id}`, label: field.label, text: `${Array.isArray(value) ? value.join('、') : String(value)}${field.unit || ''}` });
  }
  return values.filter(item => item.text.trim());
}
function productCandidates(id: string): AiWritingReuseCandidate[] {
  const product = getDraftRecord().content.products.find(item => item.id === id);
  if (!product) throw new ApiError(404, '产品已不存在，请重新选择');
  return productValues(product).flatMap(item => {
    const next = candidate(`${product.name} · ${item.label}`, `${item.label}：${item.text}`, `当前产品 ${product.name}（${product.sku}）· ${item.label} · 选入时快照`, 'product', { kind: 'product', recordId: product.id, locator: item.key, capturedAt: new Date().toISOString() }, product.id);
    return next ? [next] : [];
  });
}
function sourceCandidates(id: string, actor: Actor): { candidates: AiWritingReuseCandidate[]; warnings: string[] } {
  const record = readAiSource(id, actor), rows = getDatabase().prepare("SELECT * FROM cms_ai_source WHERE actor_id=? AND source_id=? AND kind IN ('brief','products') AND expires_at>? ORDER BY created_at DESC,id DESC").all(actor.id, id, new Date().toISOString()) as SourceRow[];
  const candidates: AiWritingReuseCandidate[] = [], warnings: string[] = [];
  for (const row of rows) {
    if (record.source.kind === 'pdf') {
      const result = JSON.parse(row.payload_json) as Partial<AiSourceBriefResult>;
      for (const fact of result.facts || []) {
        const text = fact.value, locator = `${fact.field} · 第${fact.pageNumbers.join('、')}页`;
        const next = candidate(labels[fact.field] || fact.field, text, `${record.source.fileName} · ${locator} · 原文件SHA256 ${record.source.sha256.slice(0, 12)} · 整理建议待人工核对`, 'company', { kind: 'pdf', recordId: row.id, sourceId: id, locator, capturedAt: row.created_at, quotes: fact.evidence.map(item => ({ pageNumber: item.pageNumber, quote: item.quote })) });
        if (next) candidates.push(next); else warnings.push(`${labels[fact.field] || fact.field}超过单条范围或格式限制，请从原资料手工选取需要的文字。`);
      }
    } else if (row.applied_revision !== null) {
      const payload = JSON.parse(row.payload_json) as { spec: ContentImportSpec; sourceRows: number[]; importedProductIds?: string[]; productSkus: string[]; source: { sheetName: string } };
      const imported = parseImportFile(payload.spec.format, payload.spec.content, 'product');
      imported.rows.forEach((cells, index) => {
        const skuColumn = Object.keys(payload.spec.mapping).find(key => payload.spec.mapping[key] === 'builtin:sku'), sku = String(cells[skuColumn || ''] || '').trim().toLowerCase();
        const product = getDraftRecord().content.products.find(item => payload.importedProductIds?.includes(item.id) && item.sku.trim().toLowerCase() === sku);
        if (!product) return;
        for (const [column, target] of Object.entries(payload.spec.mapping)) {
          const key = target.replace(/^builtin:/, ''); if (!Object.hasOwn(labels, key) || ['styleNotes', 'audience', 'market', 'industry', 'companyName'].includes(key)) continue;
          const value = cells[column]; if (value === undefined || value === null || String(value).trim() === '') continue;
          const label = labels[key], locator = `${payload.source.sheetName} · 第${payload.sourceRows[index]}行 · ${key}`;
          const next = candidate(`${product.name} · ${label}`, `${label}：${String(value).trim()}`, `${record.source.fileName} · ${locator} · 原文件SHA256 ${record.source.sha256.slice(0, 12)} · 已导入时审核值`, 'product', { kind: 'xlsx', recordId: row.id, sourceId: id, locator, capturedAt: row.created_at }, product.id);
          if (next) candidates.push(next); else warnings.push(`${product.name}的${label}超过单条范围或格式限制，请手工选取。`);
        }
      });
    }
  }
  if (!candidates.length) warnings.push(record.source.kind === 'pdf' ? '还没有可复用的PDF整理结果；请先在资料导入中整理并核对，或手工填写有来源的摘录。' : '这里只列已确认导入的产品值；可先完成产品导入，或直接选择当前产品参数。');
  if (candidates.length > 200) warnings.push('本次候选超过200项，仅列前200项；可选择具体产品继续核对。');
  return { candidates: candidates.slice(0, 200), warnings: [...new Set(warnings)] };
}
function refValue(value: unknown): AiWritingSourceRef {
  const input = object(value, '来源引用');
  if (Object.keys(input).some(key => !['kind', 'recordId', 'sourceId', 'fingerprint', 'locator', 'snapshot', 'capturedAt', 'quotes'].includes(key)) || !['pdf', 'xlsx', 'product'].includes(String(input.kind)) || typeof input.recordId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(input.recordId) || typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint) || typeof input.locator !== 'string' || !input.locator || input.locator.length > 180 || typeof input.snapshot !== 'string' || !input.snapshot || input.snapshot.length > 2000 || typeof input.capturedAt !== 'string' || !Number.isFinite(Date.parse(input.capturedAt)) || Date.parse(input.capturedAt) > Date.now() + 60_000 || input.sourceId !== undefined && (typeof input.sourceId !== 'string' || !/^ais-[a-f0-9-]{36}$/.test(input.sourceId))) throw new ApiError(422, '来源引用无效，请重新选择资料');
  if (input.quotes !== undefined && (input.kind !== 'pdf' || !Array.isArray(input.quotes) || input.quotes.length > 6 || input.quotes.some(value => { if (!value || typeof value !== 'object' || Array.isArray(value)) return true; const quote = value as Record<string, unknown>; return Object.keys(quote).some(key => !['pageNumber', 'quote'].includes(key)) || !Number.isSafeInteger(quote.pageNumber) || Number(quote.pageNumber) < 1 || Number(quote.pageNumber) > 100 || typeof quote.quote !== 'string' || !quote.quote.trim() || quote.quote.length > 400; }))) throw new ApiError(422, '原文引用无效，请重新选择资料');
  if (input.kind !== 'product' && !input.sourceId || input.kind === 'product' && input.sourceId !== undefined) throw new ApiError(422, '来源引用类型不匹配');
  return input as unknown as AiWritingSourceRef;
}
function resolve(ref: AiWritingSourceRef, actor: Actor) {
  const options = ref.kind === 'product' ? productCandidates(ref.recordId) : sourceCandidates(ref.sourceId!, actor).candidates;
  return options.find(item => item.sourceRef.kind === ref.kind && item.sourceRef.recordId === ref.recordId && item.sourceRef.locator === ref.locator && item.sourceRef.fingerprint === ref.fingerprint && item.sourceRef.snapshot === ref.snapshot && JSON.stringify(item.sourceRef.quotes) === JSON.stringify(ref.quotes));
}
/** 新增/修改引用必须与本人可读的当前候选一致；旧的已保存摘录可由调用方保留，不冒充仍有原件。 */
export function validateWritingSourceRef(value: unknown, actor: Actor, fact: { text: string; scope: 'company' | 'product'; productId?: string }): AiWritingSourceRef {
  admin(actor); const ref = refValue(value), actual = resolve(ref, actor);
  if (!actual || actual.text !== fact.text || actual.scope !== fact.scope || actual.productId !== fact.productId) throw new ApiError(409, '资料来源或适用范围已变化，请重新选择；手工修改可清除来源引用后重新确认。');
  return { ...actual.sourceRef, capturedAt: ref.capturedAt };
}
/** 来源状态不读取其他账号原文；失效时只说明摘录仍保留，不能将来源缺失误报为内容错误。 */
export function writingSourceRefStatus(value: unknown, actor: Actor): AiWritingSourceState {
  admin(actor);
  try {
    const ref = refValue(value), actual = resolve(ref, actor);
    if (actual && ref.kind === 'xlsx') {
      // Excel审核快照不随产品编辑改写；当前参数变更时明确提示，不能继续冒充旧值仍有效。
      const key = ref.locator.split(' · ').at(-1), product = getDraftRecord().content.products.find(item => item.id === actual.productId), current = product && productValues(product).find(item => item.key === key);
      if (!current || `${current.label}：${current.text.trim()}` !== ref.snapshot) return { status: 'changed', message: '产品当前值已不同于Excel审核摘录，请核对并重新选入' };
    }
    return actual ? { status: 'available', message: ref.kind === 'product' ? '当前产品值与选入时一致' : '本人暂存来源仍可回查；事实仍需企业核实' } : { status: 'changed', message: '来源内容已变化，请核对摘录并重新确认' };
  }
  catch (error) { if (error instanceof ApiError && [401, 403].includes(error.status)) throw error; return { status: 'unavailable', message: '原来源已失效、移除或当前账号不可回查；仅保留已确认摘录' }; }
}
/** 资料候选与状态仅为本机只读投影；不会确认事实、调用模型或修改网站。 */
export function readWritingReuse(actor: Actor, sourceId?: string, productId?: string): AiWritingReuseResponse {
  admin(actor); if (sourceId && productId) throw new ApiError(422, '一次只选择一份来源或一个产品');
  const result = sourceId ? sourceCandidates(sourceId, actor) : { candidates: productId ? productCandidates(productId) : [], warnings: [] };
  const row = getDatabase().prepare('SELECT config_json FROM cms_ai_writing_profile WHERE id=1').get() as { config_json: string };
  const saved = JSON.parse(row.config_json) as { facts?: { id: string; sourceRef?: AiWritingSourceRef }[] };
  return { sources: listAiSources(actor).items.map(item => ({ id: item.id, fileName: item.fileName, kind: item.kind, expiresAt: item.expiresAt })), ...result, states: Object.fromEntries((saved.facts || []).filter(fact => fact.sourceRef).map(fact => [fact.id, writingSourceRefStatus(fact.sourceRef, actor)])) };
}
