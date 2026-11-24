import { createHash, randomUUID } from 'node:crypto';
import type { AiWritingFact, AiWritingField, AiWritingGenerateInput, AiWritingProposal, AiWritingReceiptInput, AiWritingTarget, AiWritingValue } from '../lib/ai-writing-types';
import type { ExternalAiWritingRequest, ExternalAiWritingView } from '../lib/external-ai-writing-types';
import type { ContentEntry, Product } from '../lib/types';
import { richTextPlainText } from '../lib/presentation-content';
import { createExternalAiWritingCandidate, describeAiWritingField, readAiWritingFieldValue, readAiWritingProfile, readAiWritingProposal, saveAiWritingDraft, undoAiWritingReceipt, writeAiWritingFields } from './ai-writing';
import { writingSourceRefStatus } from './ai-writing-reuse';
import { revalidateExternalAiGrant, type ExternalAiGrant } from './external-ai-tokens';
import { getDatabase } from './database';
import { recordAudit } from './audit';
import { getDraftRecord, getStudioEnvelope, patchStudio } from './studio';
import { getAuthEnvironment } from './env';
import { isMemberDisabled, requirePermission, type Actor, type MemberRow } from './permissions';
import { ApiError } from './http';
import { collectReferences, object, revision, validateDraft } from './validation';
import type { DraftContent } from './types';

export type { ExternalAiWritingRequest, ExternalAiWritingView } from '../lib/external-ai-writing-types';
type RecordValue = Product | ContentEntry;
type Row = { id: string; token_id: string; actor_id: string; request_id: string; request_hash: string; payload_json: string; created_at: string; expires_at: string; applied_revision: number | null; undone_revision: number | null };
type Payload = { request: ExternalAiWritingRequest; proposal: AiWritingProposal; beforeRecord: RecordValue | null; seed: RecordValue; baseRevision: number; depth: number; parentId?: string; receiptIds?: string[]; appliedKeys?: string[]; appliedRecord?: RecordValue };
type Obj = Record<string, unknown>;
const PREVIEW_MS = 40 * 60_000, UNDO_MS = 7 * 24 * 60 * 60_000, MAX_BYTES = 10 * 1024 * 1024;
const TABLE = 'cms_external_ai_writing';
function only(value: Obj, keys: string[]) { if (Object.keys(value).some(key => !keys.includes(key))) throw new ApiError(422, '外部内容请求包含不支持的字段'); }
function text(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== 'string' || value.length > max || required && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<\s*\/?[a-z][\w:-]*(?:\s[^>]*|\s*\/?)>|<!|<\?|(?:javascript|vbscript)\s*:/i.test(value)) throw new ApiError(422, `${label}需为${required ? '非空' : ''}纯文字，最多${max}字符`);
  return value.trim();
}
function identifier(value: unknown, label = '记录ID') { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw new ApiError(422, `${label}无效`); return value; }
function candidateId(value: unknown) { if (typeof value !== 'string' || !/^eaw-[a-f0-9-]{36}$/.test(value)) throw new ApiError(422, '内容候选标识无效'); return value; }
function ids(value: unknown, max: number, label: string): string[] { if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !id || id.length > 120) || new Set(value).size !== value.length) throw new ApiError(422, `${label}无效或重复`); return value as string[]; }
function stable(value: unknown, depth = 0): string {
  if (depth > 48) throw new ApiError(422, '内容资料嵌套过深');
  if (Array.isArray(value)) return `[${value.map(item => stable(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item, depth + 1)}`).join(',')}}`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  throw new ApiError(422, '外部内容只接受JSON资料');
}
const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
function boundedJson(value: unknown) { const json = JSON.stringify(value); if (Buffer.byteLength(json) > 1024 * 1024) throw new ApiError(413, '本次内容候选超过1MB，请减少范围'); return json; }
function owner(actor: Actor): Actor {
  requirePermission(actor, 'manage'); const row = getDatabase().prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as MemberRow | undefined;
  if (!row || isMemberDisabled(row)) throw new ApiError(401, '账号已停用或会话已失效'); if (row.role !== 'admin') throw new ApiError(403, '仅管理员可审核外部内容');
  return { id: row.id, name: row.name, email: row.email, role: 'admin' };
}
function record(content: DraftContent, target: AiWritingTarget): RecordValue | undefined { return target.kind === 'product' ? content.products.find(item => item.id === target.id) : content.contentEntries?.find(item => item.id === target.id); }
function access(request: ExternalAiWritingRequest) { return { ...(request.create ? { createKind: request.target.kind } : request.target.kind === 'product' ? { productIds: [request.target.id] } : { entryIds: [request.target.id] }), ...(request.referenceProductIds.length ? { productIds: [...new Set([...(request.target.kind === 'product' && !request.create ? [request.target.id] : []), ...request.referenceProductIds])] } : {}) }; }
function ownedRow(id: unknown, actor: Actor, tokenId?: string): Row {
  const row = getDatabase().prepare(`SELECT * FROM ${TABLE} WHERE id=? AND actor_id=?${tokenId ? ' AND token_id=?' : ''}`).get(candidateId(id), actor.id, ...(tokenId ? [tokenId] : [])) as Row | undefined;
  if (!row) throw new ApiError(404, '找不到这条连接的本人内容候选'); if (Date.parse(row.expires_at) <= Date.now()) throw new ApiError(410, row.applied_revision === null ? '内容候选已超过40分钟，请从最新内容重新准备' : '内容撤销记录已超过7天'); return row;
}
function parse(row: Row) { return JSON.parse(row.payload_json) as Payload; }
function reviewUrl(id: string) { const url = new URL('/admin', getAuthEnvironment().baseURL); url.searchParams.set('externalContent', id); url.hash = 'ai-content-review'; return url.href; }
function projectedFact({ sourceRef: _private, ...fact }: AiWritingFact) { return fact; }
function undoRevision(row: Row, payload: Payload) {
  if (row.undone_revision !== null) return row.undone_revision;
  if (payload.receiptIds?.length) {
    const receipts = payload.receiptIds.map(id => getDatabase().prepare('SELECT undone_revision FROM cms_ai_writing_receipt WHERE id=? AND actor_id=?').get(id, row.actor_id) as { undone_revision: number | null } | undefined);
    if (receipts.every(item => item?.undone_revision !== null && item?.undone_revision !== undefined)) return Math.max(...receipts.map(item => item!.undone_revision!));
  }
  return null;
}
function undoAvailability(row: Row, payload: Payload, undone: number | null): { canUndo: boolean; undoReason?: string } {
  if (undone !== null) return { canUndo: false, undoReason: '本候选已撤销' };
  if (row.applied_revision === null) return { canUndo: false, undoReason: '尚未采用' };
  const actual = record(getDraftRecord().content, payload.request.target);
  if (!actual) return { canUndo: false, undoReason: '内容已被删除，请在原编辑器核对' };
  if (payload.request.create) {
    if (!equal(actual, payload.appliedRecord)) return { canUndo: false, undoReason: '新建内容已有后续编辑，不能自动删除' };
    const content = getDraftRecord().content, key = payload.request.target.kind === 'product' ? 'products' : 'contentEntries';
    try { collectReferences(validateDraft({ ...content, [key]: (content[key] || []).filter(item => item.id !== payload.request.target.id) })); }
    catch (error) { if (error instanceof ApiError) return { canUndo: false, undoReason: '新建内容仍被页面、导航或其他记录引用，请先移除引用' }; throw error; }
    return { canUndo: true };
  }
  if (payload.receiptIds?.length !== 1) return { canUndo: false, undoReason: '缺少完整撤销回执' };
  const receipt = getDatabase().prepare('SELECT payload_json,expires_at FROM cms_ai_writing_receipt WHERE id=? AND actor_id=?').get(payload.receiptIds[0], row.actor_id) as { payload_json: string; expires_at: string } | undefined;
  if (!receipt || Date.parse(receipt.expires_at) <= Date.now()) return { canUndo: false, undoReason: '撤销回执已过期' };
  const after = (JSON.parse(receipt.payload_json) as { after: Record<string, AiWritingValue> }).after;
  return Object.entries(after).every(([key, value]) => equal(readAiWritingFieldValue(actual, key), value)) ? { canUndo: true } : { canUndo: false, undoReason: '生成字段已有后续人工修改，请在原编辑器核对' };
}
function view(row: Row, actor: Actor): ExternalAiWritingView {
  const payload = parse(row), undone = undoRevision(row, payload), proposal = row.applied_revision === null ? readAiWritingProposal(payload.proposal.id, actor) : payload.proposal;
  return { id: row.id, proposalId: proposal.id, request: payload.request, target: proposal.target, task: proposal.task, fields: proposal.fields, evidence: proposal.evidence.map(projectedFact), warnings: proposal.warnings, missingFacts: proposal.missingFacts,
    baseRevision: payload.baseRevision, currentRevision: getDraftRecord().revision, createdAt: row.created_at, expiresAt: row.expires_at, status: undone !== null ? 'undone' : row.applied_revision !== null ? 'applied' : 'pending', stale: row.applied_revision === null && proposal.stale,
    reviewUrl: reviewUrl(row.id), requiresBrowserConfirmation: true, generatedContentEditable: true, siteModelCalls: false, isNew: !!payload.request.create,
    recordLabel: 'name' in payload.seed ? payload.seed.name : payload.seed.title || '新文章', ...(payload.request.create ? { creation: payload.request.create } : {}), ...(payload.appliedKeys ? { appliedKeys: payload.appliedKeys } : {}), savedRevision: row.applied_revision, undoneRevision: undone, ...undoAvailability(row, payload, undone) };
}
function authorizedFacts(grant: ExternalAiGrant, target: AiWritingTarget, referenceProductIds: string[]) {
  return readAiWritingProfile(grant.actor).facts.filter(fact => fact.confirmed && (fact.scope === 'company' || target.kind === 'product' && fact.productId === target.id || target.kind === 'entry' && !!fact.productId && referenceProductIds.includes(fact.productId)));
}
/** 字段基线只取当前真实草稿；外部不能声明before、模型约束或输入未授权的记录快照。 */
function prepare(grant: ExternalAiGrant, value: unknown) {
  const input = object(value, '内容写作请求'); only(input, ['target', 'expectedRevision', 'profileRevision', 'create', 'task', 'fieldKeys', 'instruction', 'sourceText', 'language', 'audience', 'tone', 'factIds', 'referenceProductIds', 'baseCandidateId']);
  const expectedRevision = input.expectedRevision === undefined ? getDraftRecord().revision : revision(input.expectedRevision);
  if (expectedRevision !== getDraftRecord().revision) throw new ApiError(409, '工作区已在读取上下文后变化，请读取最新上下文再生成');
  const rawTarget = object(input.target, '内容对象'); only(rawTarget, ['kind', 'id', 'modelId']); if (!['product', 'entry'].includes(String(rawTarget.kind))) throw new ApiError(422, '请选择产品或文章');
  const isNew = input.create !== undefined || rawTarget.id === undefined, target: AiWritingTarget = { kind: rawTarget.kind as AiWritingTarget['kind'], id: rawTarget.id === undefined ? `external-${randomUUID()}` : identifier(rawTarget.id), ...(rawTarget.modelId === undefined ? {} : { modelId: identifier(rawTarget.modelId, '栏目ID') }) };
  const earlyReferences = ids(input.referenceProductIds ?? [], 3, '关联产品');
  // 先核对外部范围，再读取真实记录或栏目，避免通过错误分支探测未授权对象。
  grant = revalidateExternalAiGrant(grant, 'content:read', { ...(isNew ? { createKind: target.kind } : target.kind === 'product' ? { productIds: [target.id] } : { entryIds: [target.id] }), ...(earlyReferences.length ? { productIds: [...new Set([...(target.kind === 'product' && !isNew ? [target.id] : []), ...earlyReferences])] } : {}) });
  const content = getDraftRecord().content, existing = record(content, target);
  if (isNew && existing) throw new ApiError(409, '新建记录ID已存在，请重新开始'); if (!isNew && !existing) throw new ApiError(404, '所选产品或文章已不存在');
  if (existing?.modelId) { if (target.modelId !== undefined && existing.modelId !== target.modelId) throw new ApiError(409, '所选记录的栏目已变化'); target.modelId = existing.modelId; }
  if (target.kind === 'entry' && !target.modelId) throw new ApiError(422, '新文章必须指定已有栏目');
  const model = target.modelId ? content.contentModels?.find(item => item.id === target.modelId && item.target === (target.kind === 'entry' ? 'content' : 'product')) : undefined;
  if (target.modelId && !model) throw new ApiError(422, '所选栏目或产品参数模型不存在');
  const task = input.task ?? (target.kind === 'product' ? 'product' : 'article'); if (!['product', 'outline', 'article', 'rewrite', 'summary'].includes(String(task))) throw new ApiError(422, '写作任务无效');
  let create: ExternalAiWritingRequest['create']; let seed: RecordValue;
  if (isNew) {
    const value = input.create === undefined ? {} : object(input.create, '新建基础资料'); only(value, target.kind === 'product' ? ['name', 'sku', 'category', 'material'] : []);
    if (target.kind === 'product') { create = { name: text(value.name, 200, '产品名称', true), sku: text(value.sku, 100, '产品型号', true), category: text(value.category, 100, '产品分类', true), material: text(value.material ?? '', 2000, '产品材质') }; seed = { id: target.id, ...create, status: 'draft', image: '', description: '', ...(target.modelId ? { modelId: target.modelId, customFields: {} } : {}) } as Product; }
    else { create = {}; seed = { id: target.id, modelId: target.modelId!, title: '', status: 'draft', updated: '', customFields: {} }; }
  } else seed = structuredClone(existing!);
  const referenceProductIds = ids(input.referenceProductIds ?? [], 3, '关联产品'); if (referenceProductIds.length && target.kind !== 'entry') throw new ApiError(422, '关联产品只用于文章写作');
  if (referenceProductIds.some(id => !content.products.some(product => product.id === id))) throw new ApiError(422, '关联产品已不存在');
  const defaults = target.kind === 'product' ? ['description'] : ['title', ...(model?.fields.find(field => field.type === 'textarea') ? [`customFields:${model.fields.find(field => field.type === 'textarea')!.id}`] : [])];
  const fieldKeys = ids(input.fieldKeys ?? defaults, 12, '创作字段'); if (!fieldKeys.length) throw new ApiError(422, '请选择至少一个可编辑文字字段');
  const request: ExternalAiWritingRequest = { target, expectedRevision, profileRevision: input.profileRevision === undefined ? readAiWritingProfile(grant.actor).revision : revision(input.profileRevision), ...(create ? { create } : {}), task: task as ExternalAiWritingRequest['task'], fieldKeys, instruction: text(input.instruction ?? '', 2000, '写作要求'), sourceText: text(input.sourceText ?? '', 12000, '本次资料'), language: text(input.language ?? content.settings.language, 35, '语言', true), audience: text(input.audience ?? '', 1000, '目标读者'), tone: text(input.tone ?? '', 1000, '写作语气'), factIds: ids(input.factIds ?? [], 30, '资料选择'), referenceProductIds, ...(input.baseCandidateId === undefined ? {} : { baseCandidateId: candidateId(input.baseCandidateId) }) };
  grant = revalidateExternalAiGrant(grant, 'content:read', access(request));
  const fields: AiWritingField[] = fieldKeys.map(key => { const modelField = key.startsWith('customFields:') ? model?.fields.find(field => field.id === key.slice(13)) : undefined; const description = describeAiWritingField(target, key, key==='detailContent'||target.kind === 'entry' && modelField?.type === 'textarea' ? 'richtext' : 'text'); return { ...description, before: readAiWritingFieldValue(seed, key) }; });
  const profile = readAiWritingProfile(grant.actor), facts = authorizedFacts(grant, target, referenceProductIds);
  // 已确认事实有独立版本，不随网站revision增长；旧上下文不能套用后来改写的同名事实。
  if (request.profileRevision !== profile.revision) throw new ApiError(409, '已确认写作资料在读取上下文后变化，请读取最新上下文再生成');
  if (request.factIds.some(id => !facts.some(fact => fact.id === id))) throw new ApiError(422, '只能选择已确认且适用于本次授权对象的资料');
  let parent: Payload | undefined, parentId: string | undefined;
  if (request.baseCandidateId) {
    const row = ownedRow(request.baseCandidateId, grant.actor, grant.tokenId), parentView = view(row, grant.actor); parent = parse(row); parentId = row.id;
    if (parentView.status !== 'pending' || parentView.stale) throw new ApiError(409, '只能继续调整未采用且仍有效的本人候选');
    if (parent.depth >= 6) throw new ApiError(422, '本轮已继续调整6次，请从当前草稿重新开始');
    if (!equal(parent.request.target, target) || !equal(parent.request.create ?? null, create ?? null) || !equal(parent.request.fieldKeys, fieldKeys) || !equal(parent.request.referenceProductIds, referenceProductIds)) throw new ApiError(422, '继续调整须保持同一对象、创建资料、字段和关联产品范围');
  }
  const generation: AiWritingGenerateInput = { target, task: request.task, fields, outputKeys: fieldKeys, sourceText: request.sourceText, instruction: request.instruction, language: request.language, audience: request.audience, tone: request.tone, factIds: request.factIds, profileRevision: profile.revision, ...(referenceProductIds.length ? { referenceProductIds } : {}) };
  return { grant, request, generation, facts, fields, beforeRecord: existing ? structuredClone(existing) : null, seed, parent, parentId, depth: (parent?.depth ?? 0) + (parent ? 1 : 0), model };
}

export function externalAiWritingOverview(grant: ExternalAiGrant, value: unknown = {}) {
  grant = revalidateExternalAiGrant(grant, 'content:read'); const input = object(value, '内容概览'); only(input, ['kind', 'offset', 'limit']);
  if (input.kind !== undefined && !['product', 'entry'].includes(String(input.kind))) throw new ApiError(422, '内容种类无效');
  const offset = input.offset ?? 0, limit = input.limit ?? 30; if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new ApiError(422, '分页参数无效');
  const content = getDraftRecord().content, allowedProducts = grant.recordIds.productIds, allowedEntries = grant.recordIds.entryIds;
  const products = content.products.filter(item => allowedProducts === null || allowedProducts.includes(item.id)), entries = (content.contentEntries || []).filter(item => allowedEntries === null || allowedEntries.includes(item.id));
  const records = [...(input.kind === 'entry' ? [] : products.map(item => ({ kind: 'product', id: item.id, label: item.name, modelId: item.modelId, sku: item.sku }))), ...(input.kind === 'product' ? [] : entries.map(item => ({ kind: 'entry', id: item.id, label: item.title, modelId: item.modelId })))];
  const modelIds = new Set([...products, ...entries].map(item => item.modelId));
  return { revision: getDraftRecord().revision, items: records.slice(Number(offset), Number(offset) + Number(limit)), total: records.length, nextOffset: Number(offset) + Number(limit) < records.length ? Number(offset) + Number(limit) : null,
    models: (content.contentModels || []).filter(model => model.target === 'content' ? allowedEntries === null || modelIds.has(model.id) : allowedProducts === null || modelIds.has(model.id)).map(model => ({ id: model.id, name: model.name, target: model.target, fields: model.fields.map(({ id, key, label, type, required }) => ({ id, key, label, type, required })) })), permissions: { propose: grant.scopes.includes('content:propose'), createProducts: allowedProducts === null, createEntries: allowedEntries === null, browserConfirmation: true }, next: 'site_content_context' };
}
export function externalAiWritingCapabilities(grant: ExternalAiGrant) {
  grant = revalidateExternalAiGrant(grant, 'content:read');
  return { format: 'form-studio-native-writing-v1', model: 'external-client-model', siteModelCalls: false, editable: true, productFieldKeys:['description','detailContent','seoTitle','seoDescription'], tasks: ['product', 'outline', 'article', 'rewrite', 'summary'], maxFields: 12, maxReferenceProducts: 3, continuations: 6,
    output: { fields: [{ key: 'allowed field key', after: 'plain text or validated native richtext doc' }], warnings: [], missingFacts: [], evidenceIds: [] },
    constraints: ['Only explicitly authorized saved records and confirmed applicable facts are available.', 'No model fields, parameters, media uploads, URLs, publication or arbitrary code.', 'Existing richtext images and link marks must be preserved exactly; no new images or links.', 'New products require create.name, create.sku and create.category; new articles require an existing modelId. Required non-text fields cannot be invented.', 'The owner must inspect and click apply/undo in a real signed-in browser. Machine review only returns the review URL.'] };
}
export function externalAiWritingContext(grant: ExternalAiGrant, value: unknown) {
  grant = revalidateExternalAiGrant(grant, 'content:read'); const prepared = prepare(grant, value), { request, generation, fields, facts, seed } = prepared;
  const content = getDraftRecord().content;
  const productFacts = (product: Product) => ({ id: product.id, name: product.name, sku: product.sku, category: product.category, material: product.material, description: product.description.slice(0, 12000), descriptionIsExcerpt: product.description.length > 12000 });
  const context = { target: request.target, isNew: !!request.create, ...(request.create ? { creation: request.create } : {}), fields: fields.map(field => ({ ...field, current: prepared.parent?.proposal.fields.find(item => item.key === field.key)?.after ?? field.before })),
    confirmedFacts: facts.filter(fact => !fact.sourceRef || writingSourceRefStatus(fact.sourceRef, grant.actor).status !== 'changed').map(projectedFact), profileRevision: generation.profileRevision,
    ...(request.target.kind === 'product' ? { savedProduct: productFacts(seed as Product) } : {}), referenceProducts: request.referenceProductIds.map(id => productFacts(content.products.find(item => item.id === id)!)), untrustedWebsiteData: true,
    instruction: request.instruction, sourceText: request.sourceText, language: request.language, audience: request.audience, tone: request.tone,
    rules: ['Use only supplied facts. Do not invent certifications, capacities, prices, lead times, cases, parameters or search statistics.', 'Each allowed field key must appear exactly once in output.fields.', 'Richtext supports native doc, paragraphs, headings2/3, lists and original protected image/link references; never HTML, scripts or new URLs.', 'before is persisted baseline; current may include the previous private candidate. Continue by submitting cumulative complete fields.'] };
  if (Buffer.byteLength(JSON.stringify(context)) > 256 * 1024) throw new ApiError(413, '写作上下文超过256KB，请减少字段或缩短本次资料');
  revalidateExternalAiGrant(prepared.grant, 'content:read', access(request));
  return { revision: getDraftRecord().revision, request, context, requiresBrowserConfirmation: true, siteModelCalls: false, next: 'site_content_propose' };
}

/** 幂等索引与原生候选写入同一事务；即使模型输出不合规则，也不会改动任何草稿。 */
export function submitExternalAiWriting(grant: ExternalAiGrant, value: unknown): ExternalAiWritingView {
  grant = revalidateExternalAiGrant(grant, 'content:propose'); const input = object(value, '外部内容提交'); only(input, ['requestId', 'request', 'proposal']); const requestId = identifier(input.requestId, '唯一请求标识');
  const hash = createHash('sha256').update(stable({ request: input.request, proposal: input.proposal })).digest('hex'); boundedJson(input);
  return getDatabase().transaction(() => {
    grant = revalidateExternalAiGrant(grant, 'content:propose');
    const previous = getDatabase().prepare(`SELECT * FROM ${TABLE} WHERE token_id=? AND request_id=?`).get(grant.tokenId, requestId) as Row | undefined;
    if (previous) { if (previous.request_hash !== hash) throw new ApiError(409, '此请求标识已用于不同内容，请使用新的请求标识'); return readExternalAiWriting(grant, previous.id); }
    if (object(input.request, '内容请求').expectedRevision === undefined || object(input.request, '内容请求').profileRevision === undefined) throw new ApiError(422, '请先读取内容上下文并原样提交带expectedRevision和profileRevision的request');
    const prepared = prepare(grant, input.request), allowed = access(prepared.request); grant = revalidateExternalAiGrant(grant, 'content:propose', allowed);
    const proposal = createExternalAiWritingCandidate(prepared.generation, input.proposal, grant.actor, () => { grant = revalidateExternalAiGrant(grant, 'content:propose', allowed); });
    const values = Object.fromEntries(proposal.fields.map(field => [field.key, field.after])), candidate = writeAiWritingFields(prepared.seed, values); validateCandidate(getDraftRecord().content, prepared.request.target, candidate, !!prepared.request.create);
    const id = `eaw-${randomUUID()}`, createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + PREVIEW_MS).toISOString(), payload: Payload = { request: prepared.request, proposal, beforeRecord: prepared.beforeRecord, seed: prepared.seed, baseRevision: getDraftRecord().revision, depth: prepared.depth, ...(prepared.parentId ? { parentId: prepared.parentId } : {}) }, json = boundedJson(payload), db = getDatabase();
    db.prepare(`DELETE FROM ${TABLE} WHERE actor_id=? AND expires_at<=?`).run(grant.actor.id, createdAt);
    const usage = db.prepare(`SELECT count(*) count,coalesce(sum(length(CAST(payload_json AS BLOB))),0) bytes FROM ${TABLE} WHERE actor_id=?`).get(grant.actor.id) as { count: number; bytes: number };
    if (usage.count >= 100 || usage.bytes + Buffer.byteLength(json) > MAX_BYTES) throw new ApiError(429, '本人外部内容候选已满，请稍后再试');
    db.prepare(`INSERT INTO ${TABLE}(id,token_id,actor_id,request_id,request_hash,payload_json,created_at,expires_at,applied_revision,undone_revision) VALUES(?,?,?,?,?,?,?,?,NULL,NULL)`).run(id, grant.tokenId, grant.actor.id, requestId, hash, json, createdAt, expiresAt);
    recordAudit(grant.actor, 'external.ai.content.propose', 'success', { objectIds: [grant.tokenId, id, proposal.id], fields: prepared.request.fieldKeys, revision: payload.baseRevision });
    return view(ownedRow(id, grant.actor, grant.tokenId), grant.actor);
  }).immediate();
}
function validateCandidate(content: DraftContent, target: AiWritingTarget, candidate: RecordValue, isNew: boolean) {
  // 原生草稿可暂缺必填值；外部新建必须明确已有资料，不能把缺失的参数或关系伪装成完整内容。
  if (isNew && target.modelId) for (const field of content.contentModels?.find(model => model.id === target.modelId)?.fields || []) {
    const value = candidate.customFields?.[field.id];
    if (field.required && (value === undefined || value === null || value === '' || Array.isArray(value) && !value.length)) throw new ApiError(422, `新建内容缺少必填资料“${field.label}”；请先在原编辑器填写此资料，再让AI优化文字`);
  }
  const key = target.kind === 'product' ? 'products' : 'contentEntries', items = (content[key] || []) as RecordValue[];
  collectReferences(validateDraft({ ...content, [key]: isNew ? [...items, candidate] : items.map(item => item.id === target.id ? candidate : item) }));
}
export function readExternalAiWriting(grant: ExternalAiGrant, id: unknown): ExternalAiWritingView {
  grant = revalidateExternalAiGrant(grant, 'content:read'); const row = ownedRow(id, grant.actor, grant.tokenId), payload = parse(row); grant = revalidateExternalAiGrant(grant, 'content:read', access(payload.request)); return view(row, grant.actor);
}
/** 机器只能请求审核链接，不能以确认布尔值代替负责人点击。 */
export function requestExternalAiWritingReview(grant: ExternalAiGrant, value: unknown) {
  grant = revalidateExternalAiGrant(grant, 'content:propose'); const input = object(value, '内容审核'); only(input, ['candidateId', 'action']); if (!['apply', 'undo'].includes(String(input.action))) throw new ApiError(422, '请选择采用或撤销');
  const proposal = readExternalAiWriting(grant, input.candidateId); if (input.action === 'undo' && proposal.status === 'pending') throw new ApiError(422, '内容尚未采用，无需撤销');
  if (input.action === 'apply' && proposal.status === 'undone') throw new ApiError(409, '本候选已撤销，请重新准备');
  return { candidateId: proposal.id, action: input.action, status: proposal.status, currentRevision: proposal.currentRevision, reviewUrl: proposal.reviewUrl, requiresBrowserConfirmation: true, message: '请负责人在登录的浏览器查看前后内容并确认；本工具没有修改网站草稿或发布网站。' };
}
export function reviewExternalAiWriting(id: unknown, actor: Actor) { actor = owner(actor); return view(ownedRow(id, actor), actor); }
/** 本入口仅供带Origin校验的真实后台会话调用；只采用所选生成字段，不接收客户端整站补丁。 */
export function applyExternalAiWriting(id: unknown, value: unknown, actor: Actor) {
  actor = owner(actor); const input = object(value, '采用外部内容'); only(input, ['expectedRevision', 'selectedKeys']); const expected = revision(input.expectedRevision), keys = ids(input.selectedKeys, 12, '采用字段'); if (!keys.length) throw new ApiError(422, '请选择至少一个采用字段');
  return getDatabase().transaction(() => {
    actor = owner(actor); const row = ownedRow(id, actor), payload = parse(row), current = getDraftRecord();
    if (undoRevision(row, payload) !== null) throw new ApiError(409, '本候选已撤销，请重新准备'); if (row.applied_revision !== null) return { ...getStudioEnvelope(), externalContent: view(row, actor) };
    revalidateExternalAiGrant({ tokenId: row.token_id, actor } as ExternalAiGrant, 'content:propose', access(payload.request));
    const proposal = readAiWritingProposal(payload.proposal.id, actor); if (proposal.stale) throw new ApiError(409, '原内容、栏目或事实依据已变化，请保留输入并重新准备'); if (current.revision !== expected) throw new ApiError(409, '工作区已变化，请读取最新内容后再采用');
    if (keys.some(key => !proposal.fields.some(field => field.key === key))) throw new ApiError(422, '只能采用本次已生成的文字字段');
    const fields = proposal.fields.filter(field => keys.includes(field.key)), original = payload.request.create ? payload.seed : record(current.content, proposal.target)!;
    if (!original) throw new ApiError(404, '原内容已不存在'); const after = Object.fromEntries(fields.map(field => [field.key, field.after])), next = writeAiWritingFields(original, after), key = proposal.target.kind === 'product' ? 'products' : 'contentEntries';
    if (!payload.request.create && fields.every(field => equal(readAiWritingFieldValue(original, field.key), field.after))) throw new ApiError(422, '所选内容与原内容一致，无需采用');
    validateCandidate(current.content, proposal.target, next, !!payload.request.create);
    const items = (current.content[key] || []) as RecordValue[], patch = { [key]: payload.request.create ? [...items, next] : items.map(item => item.id === proposal.target.id ? next : item) }; let result: ReturnType<typeof getStudioEnvelope>;
    if (payload.request.create) {
      // 新记录撤销需删除整条记录；保留实际落库快照，避免把后来人工补充的资料一并删除。
      result = patchStudio({ expectedRevision: expected, patch }, actor, 'ai.writing.save');
    } else {
      const receipt: AiWritingReceiptInput = { proposalId: proposal.id, selectedKeys: keys, before: Object.fromEntries(fields.map(field => [field.key, readAiWritingFieldValue(original, field.key)])), after, beforePresent: Object.fromEntries(fields.map(field => [field.key, field.key.startsWith('customFields:') ? Object.hasOwn(original.customFields || {}, field.key.slice(13)) : Object.hasOwn(original, field.key)])) };
      const saved = saveAiWritingDraft({ expectedRevision: expected, patch, receipts: [receipt], saveAttemptId: `aws-${randomUUID()}` }, actor); payload.receiptIds = saved.writingReceipts.map(receipt => receipt.id); result = saved;
      if (!payload.receiptIds.length) throw new ApiError(409, '所选字段无法建立可靠撤销记录，本次未保存');
    }
    // 保存实际采用范围，刷新或换设备后也不会把未选字段误示为已写入。
    payload.appliedKeys = keys; payload.appliedRecord = record(getDraftRecord().content, proposal.target)!;
    getDatabase().prepare(`UPDATE ${TABLE} SET payload_json=?,applied_revision=?,expires_at=? WHERE id=? AND actor_id=?`).run(boundedJson(payload), result.revision, new Date(Date.now() + UNDO_MS).toISOString(), row.id, actor.id);
    return { ...result, externalContent: view(ownedRow(row.id, actor), actor) };
  }).immediate();
}
/** 已有记录沿用原字段回执；新建记录仅在未被人工修改且通过引用校验时整条撤回。 */
export function undoExternalAiWriting(id: unknown, value: unknown, actor: Actor) {
  actor = owner(actor); const input = object(value, '撤销外部内容'); only(input, ['expectedRevision']); const expected = revision(input.expectedRevision);
  return getDatabase().transaction(() => {
    actor = owner(actor); const row = ownedRow(id, actor), payload = parse(row), undone = undoRevision(row, payload);
    if (undone !== null) return { ...getStudioEnvelope(), externalContent: view(row, actor) }; if (row.applied_revision === null) throw new ApiError(422, '本候选尚未采用');
    const current = getDraftRecord(); if (current.revision !== expected) throw new ApiError(409, '工作区已变化，请读取最新内容后再撤销'); let result: ReturnType<typeof getStudioEnvelope>;
    if (payload.request.create) {
      const actual = record(current.content, payload.request.target); if (!actual || !equal(actual, payload.appliedRecord)) throw new ApiError(409, '新建内容已被后续编辑或删除，不能自动删除；请在原编辑器核对');
      const key = payload.request.target.kind === 'product' ? 'products' : 'contentEntries';
      try { result = patchStudio({ expectedRevision: expected, patch: { [key]: (current.content[key] || []).filter(item => item.id !== payload.request.target.id) } }, actor, 'ai.writing.undo'); }
      catch (error) { if (error instanceof ApiError && error.status === 422) throw new ApiError(409, '新建内容仍被页面、导航或其他记录引用；请先移除引用，再撤销创建'); throw error; }
    } else {
      if (payload.receiptIds?.length !== 1) throw new ApiError(409, '缺少完整撤销回执，请在原编辑器核对'); result = undoAiWritingReceipt(payload.receiptIds[0], { expectedRevision: expected }, actor);
    }
    getDatabase().prepare(`UPDATE ${TABLE} SET undone_revision=? WHERE id=? AND actor_id=?`).run(result.revision, row.id, actor.id);
    return { ...result, externalContent: view(ownedRow(row.id, actor), actor) };
  }).immediate();
}
