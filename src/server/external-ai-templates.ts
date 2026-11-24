import { createHash } from 'node:crypto';
import { AI_DETAIL_DESIGN_INSTRUCTIONS } from '../lib/ai-detail-design';
import type { AiDetailDesignPreview } from '../lib/ai-detail-design-types';
import { chooseDetailTemplate } from '../lib/detail-templates';
import { getSharedBlockReferences } from '../lib/shared-blocks';
import { createExternalDetailDesignCandidate, prepareExternalDetailDesignContext, readAiDetailDesign, selectAiDetailDesign } from './ai-detail-design';
import { getDatabase } from './database';
import { getDraftRecord } from './studio';
import { revalidateExternalAiGrant, type ExternalAiGrant } from './external-ai-tokens';
import { getAuthEnvironment } from './env';
import { ApiError } from './http';
import { object } from './validation';
import { assertDesignGuidanceUnchanged } from './ai-design-guidance';
import { checkExternalGuidanceField, externalGuidanceForRequest, assertExternalGuidedViewAccess, DESIGN_GUIDANCE_SCOPE } from './external-ai-guidance';
import { recordAudit } from './audit';
import type { DraftContent } from './types';
import type { Actor } from './permissions';

type Obj = Record<string, unknown>;
const only = (value: Obj, keys: string[]) => { if (Object.keys(value).some(key => !keys.includes(key))) throw new ApiError(422, '详情设计请求包含不支持的字段'); };
const templateOf = (content: DraftContent, id: unknown) => { const template = content.pageTemplates?.find(item => item.id === id && item.kind !== 'page'); if (!template) throw new ApiError(422, '请选择已有详情模板'); return template; };
const recordsOf = (content: DraftContent, kind: string) => kind === 'product' ? content.products : content.contentEntries || [];
const recordAccess = (kind: string, id: string) => kind === 'product' ? { productIds: [id] } : { entryIds: [id] };
const allowedRecord = (grant: ExternalAiGrant, kind: string, id: string) => { const ids = kind === 'product' ? grant.recordIds.productIds : grant.recordIds.entryIds; return ids === null || ids.includes(id); };
const reviewUrl = (id: string) => { const url = new URL('/admin', getAuthEnvironment().baseURL); url.searchParams.set('externalTemplate', id); url.hash = 'templates'; return url.href; };
const safeSample = (sample: AiDetailDesignPreview['sample']) => sample && ({ ...sample, reason: sample.matched ? '真实内容实际命中此模板' : '仅布局预览；网站当前未选用此模板，采用不会更改匹配规则。' });

function own(grant: ExternalAiGrant, value: unknown): string {
  if (typeof value !== 'string' || !/^aitd-[a-f0-9-]{36}$/.test(value)) throw new ApiError(422, '详情设计记录标识无效');
  if (!getDatabase().prepare('SELECT 1 FROM cms_external_ai_template_request WHERE token_id=? AND design_id=?').get(grant.tokenId, value)) throw new ApiError(404, '当前连接没有这条详情设计记录');
  return value;
}
/** 每次操作重读真实凭据，模板和预览记录独立授权，不借页面全站权限扩大范围。 */
function checkedRequest(grant: ExternalAiGrant, value: unknown, action: 'read' | 'propose') {
  const input = object(value, '详情设计请求'); only(input, ['templateId', 'expectedRevision', 'recordId', 'instruction', 'preserveText', 'viewport', 'targetId', 'baseDesignId', 'guidanceRevision']);
  if (typeof input.templateId !== 'string') throw new ApiError(422, '请选择详情模板');
  grant = revalidateExternalAiGrant(grant, action, { templateIds: [input.templateId] });
  const content = getDraftRecord().content, template = templateOf(content, input.templateId);
  let recordId = input.recordId;
  if (input.baseDesignId !== undefined) {
    const parent = readAiDetailDesign(own(grant, input.baseDesignId), grant.actor); assertExternalGuidedViewAccess(grant, parent);
    if (recordId === undefined) recordId = parent.sample?.id;
  }
  // 默认样本只在授权且真正命中的集合中选；不让原生服务先选择任意产品再向模型泄露。
  if (recordId === undefined) {
    const model = template.kind === 'entry' ? template.modelId : template.detailRule?.modelId;
    recordId = recordsOf(content, template.kind).find(record => allowedRecord(grant, template.kind, record.id) && (!model || record.modelId === model) && (() => { const match = chooseDetailTemplate(content, template.kind as 'product' | 'entry', record); return !match.ambiguous && match.template?.id === template.id; })())?.id;
    if (!recordId) throw new ApiError(422, '暂无已授权且实际命中此模板的样本，请从概览明确选择兼容记录做布局预览，或调整后台规则与连接范围');
  }
  if (typeof recordId !== 'string') throw new ApiError(422, '预览记录无效');
  grant = revalidateExternalAiGrant(grant, action, { templateIds: [input.templateId], ...recordAccess(template.kind, recordId) });
  checkExternalGuidanceField(grant, input);
  const { guidanceRevision, ...nativeRequest } = input;
  return { grant, request: { ...nativeRequest, recordId }, guidanceRevision, template, content };
}

/** 有限连接仅使用授权模板、页面及本次样本实际引用的图片；新生成卡片仍受同一素材边界约束。 */
function mediaOf(content: DraftContent, grant: ExternalAiGrant, templateId: string, recordId: string) {
  if (grant.pageIds === null) return content.media.filter(item => item.kind === 'image');
  const template = templateOf(content, templateId), record = recordsOf(content, template.kind).find(item => item.id === recordId);
  const pages = Object.fromEntries(grant.pageIds.map(id => [id, content.editorData[id]])), data: unknown[] = [template.data, pages, record], seen = new Set<string>();
  const visit = (id: string) => { if (seen.has(id)) return; seen.add(id); const block = content.sharedBlocks?.find(item => item.id === id); if (block) { data.push(block.data); getSharedBlockReferences(block.data).forEach(visit); } };
  getSharedBlockReferences([template.data, pages]).forEach(visit); const json = JSON.stringify(data);
  return content.media.filter(item => item.kind === 'image' && item.url && json.includes(JSON.stringify(item.url)));
}
function assertResources(proposal: unknown, task: ReturnType<typeof checkedRequest>) {
  if (task.grant.pageIds === null) return;
  const media = new Set(mediaOf(task.content, task.grant, task.template.id, String(task.request.recordId)).map(item => item.id)), pages = new Set(task.grant.pageIds);
  const walk = (value: unknown) => { if (Array.isArray(value)) { value.forEach(walk); return; } if (!value || typeof value !== 'object') return; const node = value as Obj;
    if (typeof node.mediaId === 'string' && !media.has(node.mediaId)) throw new ApiError(403, '当前连接不能使用未授权的图片素材');
    for (const key of ['target', 'linkTarget']) if (node[key] && typeof node[key] === 'object') { const link = node[key] as Obj; if (link.kind !== 'page' || !pages.has(String(link.id))) throw new ApiError(403, '当前连接不能引用未授权页面'); }
    Object.values(node).forEach(walk);
  }; walk(proposal);
}
function viewOf(grant: ExternalAiGrant, view: AiDetailDesignPreview) {
  grant = revalidateExternalAiGrant(grant, 'read', { templateIds: [view.templateId], ...(view.sample ? recordAccess(view.sample.kind, view.sample.id) : {}) });
  assertExternalGuidedViewAccess(grant, view);
  const revision = getDraftRecord().revision, { designGuidance: _guidance, ...publicView } = view;
  return { ...publicView, ...(grant.scopes.includes(DESIGN_GUIDANCE_SCOPE) && view.designGuidance ? { designGuidance: view.designGuidance } : {}), sample: safeSample(view.sample), warnings: [...view.warnings.filter(warning => warning !== view.sample?.reason), ...(!view.sample?.matched ? [safeSample(view.sample)?.reason || '仅布局预览'] : [])], currentRevision: revision, status: view.undoneRevision !== null ? 'undone' : view.appliedRevision !== null ? 'applied' : 'pending', stale: view.appliedRevision === null && revision !== view.baseRevision,
    source: 'external-ai', reviewUrl: reviewUrl(view.designId), requiresBrowserConfirmation: true, generatedContentEditable: true, previewAuthentication: 'creator-browser-session', validation: { nativeValidation: 'passed', visualInspection: 'not-performed', layoutMeasurements: 'not-collected' } };
}

export function externalAiTemplateOverview(grant: ExternalAiGrant, value: unknown = {}) {
  grant = revalidateExternalAiGrant(grant, 'read'); const input = object(value, '详情模板概览'); only(input, ['offset', 'limit']); const offset = input.offset ?? 0, limit = input.limit ?? 50;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new ApiError(422, '分页需为非负起点和1–100条');
  const current = getDraftRecord(), templates = (current.content.pageTemplates || []).filter(item => item.kind !== 'page' && (grant.templateIds === null || grant.templateIds.includes(item.id)));
  return { revision: current.revision, templates: templates.slice(Number(offset), Number(offset) + Number(limit)).map(template => {
    const model = template.kind === 'entry' ? template.modelId : template.detailRule?.modelId;
    const samples = recordsOf(current.content, template.kind).filter(record => allowedRecord(grant, template.kind, record.id) && (!model || record.modelId === model)).slice(0, 12).map(record => { const matched = chooseDetailTemplate(current.content, template.kind as 'product' | 'entry', record); return { id: record.id, label: 'name' in record ? record.name : record.title, matched: !matched.ambiguous && matched.template?.id === template.id }; });
    return { id: template.id, name: template.name, kind: template.kind, ...(model ? { modelId: model } : {}), enabled: Boolean(template.detailRule?.enabled), samples };
  }), total: templates.length, offset, limit, nextOffset: Number(offset) + Number(limit) < templates.length ? Number(offset) + Number(limit) : null,
    format: 'form-studio-native-detail-design-v1', siteModelCalls: false, editable: true, nativeOperations: AI_DETAIL_DESIGN_INSTRUCTIONS, workflow: ['site_template_context', 'site_template_propose', 'site_template_status', 'site_template_select', 'site_template_review'], selectiveAdoption: { available: grant.scopes.includes('propose'), field: 'selectionUnits', kinds: ['section', 'detail', 'property'], opaqueIdsOnly: true, rawPropsOrPathsWritable: false, selectedIdsLimit: 103, dependencyGroupsAtomic: true, requiresNewRealPreview: true }, limits: { continuations: 6, pendingMinutes: 40, undoDays: 7 }, requiresBrowserConfirmation: true };
}

export function externalAiTemplateContext(grant: ExternalAiGrant, value: unknown) {
  const input = object(value, '详情设计上下文'); only(input, ['request']); const task = checkedRequest(grant, input.request, 'read');
  const options = externalGuidanceForRequest(task.grant, object(input.request, '详情设计请求'));
  const result = prepareExternalDetailDesignContext(task.request, task.grant.actor, options), ctx = result.context;
  revalidateExternalAiGrant(task.grant, 'read', { templateIds: [result.template.id], ...recordAccess(result.sample.kind, result.sample.id) });
  const media = mediaOf(task.content, task.grant, task.template.id, result.sample.id);
  // 明确投影原生有界节点与选中事实；不向外部模型转发整个草稿、记录集合或私有写作配置。
  const context = { ...(options.guidance?.context ? { designGuidance: options.guidance.context } : {}), page: ctx.page, scope: result.scope, instruction: ctx.instruction, mode: ctx.mode, preserveText: ctx.preserveText, viewport: ctx.viewport, brand: ctx.brand, nodes: ctx.nodes,
    imageLibrary: media.slice(0, 24).map(({ id, name, alt, width, height }) => ({ id, name, alt, width, height })), imageLibraryTotal: media.length,
    pageLinks: ctx.pageLinks.filter(page => task.grant.pageIds === null || task.grant.pageIds.includes(page.id)), currentRecordFields: 'currentRecordFields' in ctx ? ctx.currentRecordFields : undefined,
    // 只投影当前详情模型的图库字段定义；授权样本的实际图片仍留在本人预览中。
    ...('galleryFields' in ctx && ctx.galleryFields ? { galleryFields: ctx.galleryFields } : {}),
    dynamicBindingContext: 'dynamicBindingContext' in ctx ? ctx.dynamicBindingContext : undefined, template: result.template, templateRulesEditable: false, recordValuesEditable: false, company: ctx.company,
    sample: safeSample(result.sample), sampleValues: ctx.sampleValues, ...('refinement' in ctx ? { refinement: ctx.refinement } : {}), untrustedWebsiteData: true };
  if (options.guidance) { revalidateExternalAiGrant(task.grant, DESIGN_GUIDANCE_SCOPE); assertDesignGuidanceUnchanged(options.guidance, task.grant.actor); }
  return { revision: getDraftRecord().revision, request: { ...result.request, ...(options.guidance ? { guidanceRevision: options.guidance.revision } : {}) }, template: result.template, scope: result.scope, sample: safeSample(result.sample), context, requiresBrowserConfirmation: true, next: 'site_template_propose' };
}

function stable(value: unknown, depth = 0): unknown { if (depth > 48) throw new ApiError(422, '详情设计请求嵌套过深'); if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value; if (Array.isArray(value)) return value.map(item => stable(item, depth + 1)); if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item, depth + 1)])); throw new ApiError(422, '详情设计请求必须是有效JSON'); }
/** 同连接幂等索引与私有候选原子写入；外部模型产物通过同一原生编译器，不调用站内模型。 */
export function submitExternalAiTemplate(grant: ExternalAiGrant, value: unknown) {
  const input = object(value, '详情设计提交'); only(input, ['requestId', 'request', 'proposal']);
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(input.requestId)) throw new ApiError(422, '请提供1–100字符的唯一请求标识');
  const json = JSON.stringify(stable({ request: input.request, proposal: input.proposal })); if (Buffer.byteLength(json) > 512 * 1024) throw new ApiError(413, '详情设计提交超过512KB，请拆分任务'); const hash = createHash('sha256').update(json).digest('hex');
  return getDatabase().transaction(() => {
    // 已成功的请求只重读其独立子候选；父方案删除、到期或目标后改不能破坏断线恢复。
    // 当前连接的动作、模板和样本授权仍复查，绝不以幂等记录绕过撤权。
    grant = revalidateExternalAiGrant(grant, 'propose');
    const old = getDatabase().prepare('SELECT request_hash,design_id FROM cms_external_ai_template_request WHERE token_id=? AND request_id=?').get(grant.tokenId, input.requestId as string) as { request_hash: string; design_id: string } | undefined;
    if (old) { if (old.request_hash !== hash) throw new ApiError(409, '此请求标识已用于不同方案，请使用新的请求标识'); return viewOf(grant, readAiDetailDesign(old.design_id, grant.actor)); }
    const task = checkedRequest(grant, input.request, 'propose'); assertResources(input.proposal, task);
    const options = externalGuidanceForRequest(task.grant, object(input.request, '详情设计请求'), true);
    const recheck = () => { const access = { templateIds: [task.template.id], ...recordAccess(task.template.kind, String(task.request.recordId)) }; revalidateExternalAiGrant(task.grant, 'propose', access); if (options.guidance) revalidateExternalAiGrant(task.grant, DESIGN_GUIDANCE_SCOPE, access); }; recheck();
    const view = createExternalDetailDesignCandidate(task.request, input.proposal, task.grant.actor, recheck, options);
    revalidateExternalAiGrant(task.grant, 'propose', { templateIds: [view.templateId], ...(view.sample ? recordAccess(view.sample.kind, view.sample.id) : {}) });
    getDatabase().prepare('INSERT INTO cms_external_ai_template_request(token_id,request_id,request_hash,design_id,created_at) VALUES(?,?,?,?,?)').run(task.grant.tokenId, input.requestId as string, hash, view.designId, new Date().toISOString());
    recordAudit(task.grant.actor, 'external.ai.template.propose', 'success', { objectIds: [task.grant.tokenId, view.designId], revision: view.baseRevision }); return viewOf(task.grant, view);
  }).immediate();
}
export function readExternalAiTemplate(grant: ExternalAiGrant, id: unknown) { grant = revalidateExternalAiGrant(grant, 'read'); return viewOf(grant, readAiDetailDesign(own(grant, id), grant.actor)); }
/** 浏览器选择保留同一连接归属；权限仍在每次读取/续调时复查，不借索引扩大授权。 */
export function inheritExternalAiTemplateSelection(view: AiDetailDesignPreview, actor: Actor) {
  if (!view.selection) throw new ApiError(422, '缺少详情范围来源');
  const rows = getDatabase().prepare('SELECT DISTINCT r.token_id FROM cms_external_ai_template_request r JOIN cms_external_ai_token t ON t.id=r.token_id JOIN cms_ai_template_design d ON d.id=r.design_id WHERE r.design_id=? AND t.actor_id=? AND d.actor_id=?').all(view.selection.sourceDesignId, actor.id, actor.id) as { token_id: string }[];
  const requestId = `selection-auto-${view.designId.slice(5)}`, hash = createHash('sha256').update(JSON.stringify({ sourceDesignId: view.selection.sourceDesignId, designId: view.designId })).digest('hex');
  for (const row of rows) getDatabase().prepare('INSERT INTO cms_external_ai_template_request(token_id,request_id,request_hash,design_id,created_at) VALUES(?,?,?,?,?)').run(row.token_id, requestId, hash, view.designId, new Date().toISOString());
}
/** 外部选择只创建可确认的新预览；模板/样本scope、幂等和归属与候选同事务。 */
export function selectExternalAiTemplate(grant: ExternalAiGrant, value: unknown) {
  const input = object(value, '选择详情范围'); only(input, ['requestId', 'designId', 'expectedRevision', 'unitIds']);
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(input.requestId)) throw new ApiError(422, '请提供有效唯一请求标识');
  if (!Array.isArray(input.unitIds) || !input.unitIds.length || input.unitIds.length > 103 || input.unitIds.some(id => typeof id !== 'string' || !id || id.length > 110) || new Set(input.unitIds).size !== input.unitIds.length) throw new ApiError(422, '请选择有效且不重复的详情范围');
  const unitIds = [...input.unitIds as string[]].sort(), hash = createHash('sha256').update(JSON.stringify(stable({ operation: 'select', designId: input.designId, expectedRevision: input.expectedRevision, unitIds }))).digest('hex');
  return getDatabase().transaction(() => {
    grant = revalidateExternalAiGrant(grant, 'propose');
    const previous = getDatabase().prepare('SELECT request_hash,design_id FROM cms_external_ai_template_request WHERE token_id=? AND request_id=?').get(grant.tokenId, input.requestId as string) as { request_hash: string; design_id: string } | undefined;
    if (previous) { if (previous.request_hash !== hash) throw new ApiError(409, '此请求标识已用于不同详情范围'); return viewOf(grant, readAiDetailDesign(own(grant, previous.design_id), grant.actor)); }
    const source = readAiDetailDesign(own(grant, input.designId), grant.actor); assertExternalGuidedViewAccess(grant, source);
    const access = { templateIds: [source.templateId], ...(source.sample ? recordAccess(source.sample.kind, source.sample.id) : {}) }, recheck = () => { grant = revalidateExternalAiGrant(grant, 'propose', access); }; recheck();
    const view = selectAiDetailDesign({ designId: source.designId, expectedRevision: input.expectedRevision, unitIds }, grant.actor, recheck);
    inheritExternalAiTemplateSelection(view, grant.actor); recheck();
    getDatabase().prepare('INSERT INTO cms_external_ai_template_request(token_id,request_id,request_hash,design_id,created_at) VALUES(?,?,?,?,?)').run(grant.tokenId, input.requestId as string, hash, view.designId, new Date().toISOString());
    recordAudit(grant.actor, 'external.ai.template.select', 'success', { objectIds: [grant.tokenId, source.designId, view.designId], revision: view.baseRevision }); return viewOf(grant, view);
  }).immediate();
}
export function requestExternalAiTemplateReview(grant: ExternalAiGrant, value: unknown) { const input = object(value, '详情方案审核'); only(input, ['designId', 'action']); if (input.action !== 'apply' && input.action !== 'undo') throw new ApiError(422, '请选择采用或撤销'); const view = readExternalAiTemplate(grant, input.designId); if (input.action === 'undo' && view.appliedRevision === null) throw new ApiError(422, '方案尚未采用，无需撤销'); return { designId: view.designId, action: input.action, status: view.status, reviewUrl: view.reviewUrl, requiresBrowserConfirmation: true, message: '请由本人打开后台查看真实预览，再确认采用或撤销；此操作未修改网站。' }; }
