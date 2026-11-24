import { createHash } from 'node:crypto';
import type { AiSiteDesignPreview, AiSiteDesignRequest } from '../lib/ai-site-design-types';
import { AI_SITE_DESIGN_INSTRUCTIONS } from '../lib/ai-site-design';
import { AI_PAGE_EDIT_INSTRUCTIONS } from '../lib/ai-page-edit';
import { getSharedBlockReferences } from '../lib/shared-blocks';
import { createExternalSiteDesignCandidate, prepareExternalSiteDesignContext, prepareExternalSiteDesignPageContext, readAiSiteDesign, selectAiSiteDesign } from './ai-site-design';
import { revalidateExternalAiGrant, type ExternalAiGrant } from './external-ai-tokens';
import { getDatabase } from './database';
import { getDraftRecord } from './studio';
import { getAuthEnvironment } from './env';
import { ApiError } from './http';
import { object } from './validation';
import { assertDesignGuidanceUnchanged } from './ai-design-guidance';
import { checkExternalGuidanceField, externalGuidanceForRequest, assertExternalGuidedViewAccess, DESIGN_GUIDANCE_SCOPE } from './external-ai-guidance';
import { recordAudit } from './audit';
import type { DraftContent } from './types';
import type { Actor } from './permissions';

export interface ExternalAiDesignSubmission { requestId: string; request: AiSiteDesignRequest & { guidanceRevision?: number }; proposal: unknown; }
export type ExternalAiDesignView = Omit<AiSiteDesignPreview, 'beforeUrl' | 'afterUrl'> & {
  beforeUrl?: string; afterUrl?: string; currentRevision: number;
  source: 'external-ai'; status: 'pending' | 'applied' | 'undone';
  reviewUrl: string; requiresBrowserConfirmation: true; generatedContentEditable: true;
  previewAuthentication: 'creator-browser-session';
  stale: boolean; validation: { nativeValidation: 'passed'; visualInspection: 'not-performed'; layoutMeasurements: 'not-collected' };
  selectionPreviews: { designId: string; status: 'pending' | 'applied' | 'undone'; unitIds: string[]; reviewUrl: string }[];
};
type RequestRow = { request_hash: string; design_id: string };
type Obj = Record<string, unknown>;
const MAX_SUBMISSION_BYTES = 1024 * 1024;
const clip = (value: string, length: number) => value.slice(0, length);
const scopedNotice = '当前连接仅授权所列页面；全站区域、其它页面和完整产品素材库保持隔离。';

function only(value: Obj, names: string[]) { if (Object.keys(value).some(key => !names.includes(key))) throw new ApiError(422, '外部AI请求包含不支持的字段'); }
function requestId(value: unknown): string { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw new ApiError(422, '请提供1–100字符的唯一请求标识'); return value; }
function designRequest(value: unknown) { const input = object(value, '设计请求'); only(input, ['expectedRevision', 'instruction', 'targets', 'preserveText', 'baseDesignId', 'guidanceRevision']); return input; }
function accessOf(value: unknown) {
  const input = designRequest(value), targets = object(input.targets, '设计范围');
  if (!Array.isArray(targets.pageIds) || targets.pageIds.some(id => typeof id !== 'string')) throw new ApiError(422, '设计页面范围无效');
  return { pageIds: targets.pageIds as string[], global: ['header', 'footer', 'navigation', 'style'].some(key => targets[key] === true) };
}
function allowedPageIds(grant: ExternalAiGrant): Set<string> { return new Set(grant.pageIds || getDraftRecord().content.pages.map(page => page.id)); }
function ownDesign(grant: ExternalAiGrant, designId: unknown) {
  if (typeof designId !== 'string' || !/^aisd-[a-f0-9-]{36}$/.test(designId)) throw new ApiError(422, '设计记录标识无效');
  if (!getDatabase().prepare('SELECT 1 FROM cms_external_ai_request WHERE token_id=? AND design_id=?').get(grant.tokenId, designId)) throw new ApiError(404, '当前连接没有这条设计记录');
  return designId;
}
function reviewUrl(designId: string) { const url = new URL('/admin', getAuthEnvironment().baseURL); url.searchParams.set('externalDesign', designId); url.hash = 'global-design'; return url.href; }

/** 幂等摘要按JSON语义排序；拒绝非JSON值，避免未知字段或深层对象造成摘要歧义。 */
function stable(value: unknown, depth = 0): unknown {
  if (depth > 48) throw new ApiError(422, '设计请求嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => stable(item, depth + 1));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item, depth + 1)]));
  throw new ApiError(422, '设计请求必须是有效JSON资料');
}
function digest(value: unknown) { const json = JSON.stringify(stable(value)); if (Buffer.byteLength(json) > MAX_SUBMISSION_BYTES) throw new ApiError(413, '外部设计请求超过1MB，请拆分任务'); return createHash('sha256').update(json).digest('hex'); }

/** 限定页面连接仅能读取该布局及其实际引用区块中已经使用的图片元数据。 */
function availableMedia(content: DraftContent, grant: ExternalAiGrant) {
  if (grant.pageIds === null) return content.media.filter(item => item.kind === 'image');
  const pages = Object.fromEntries(grant.pageIds.filter(id => content.editorData[id]).map(id => [id, content.editorData[id]]));
  const references = new Set(getSharedBlockReferences(pages)), visited = new Set<string>(), data: unknown[] = [pages];
  const visit = (id: string) => { if (visited.has(id)) return; visited.add(id); const block = content.sharedBlocks?.find(item => item.id === id); if (block) { data.push(block.data); getSharedBlockReferences(block.data).forEach(visit); } };
  references.forEach(visit); const json = JSON.stringify(data);
  return content.media.filter(item => item.kind === 'image' && item.url && json.includes(JSON.stringify(item.url)));
}
function assertProposalResources(proposal: unknown, content: DraftContent, grant: ExternalAiGrant) {
  if (grant.pageIds === null) return;
  const pages = new Set(grant.pageIds), media = new Set(availableMedia(content, grant).map(item => item.id));
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Obj;
    if (typeof node.mediaId === 'string' && !media.has(node.mediaId)) throw new ApiError(403, '当前连接不能使用授权页面之外的图片素材');
    for (const key of ['target', 'linkTarget']) if (node[key] && typeof node[key] === 'object') { const target = node[key] as Obj; if (target.kind !== 'page' || typeof target.id !== 'string' || !pages.has(target.id)) throw new ApiError(403, '当前连接不能引用授权范围之外的页面或内容'); }
    Object.values(node).forEach(walk);
  };
  walk(proposal);
}
function productSamples(content: DraftContent, instruction: string) {
  const terms = [...new Set(instruction.toLocaleLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,8}/g) || [])].slice(0, 32);
  const score = (product: DraftContent['products'][number]) => terms.reduce((total, term) => total + Number(`${product.name} ${product.category} ${product.material}`.toLocaleLowerCase().includes(term)), 0);
  return [...content.products].sort((a, b) => score(b) - score(a)).slice(0, 6).map(product => ({ id: product.id, name: clip(product.name, 200), category: clip(product.category, 200), material: clip(product.material, 300), descriptionExcerpt: clip(product.description, 400), descriptionIsExcerpt: product.description.length > 400, imageMediaId: content.media.find(item => item.kind === 'image' && item.url === product.image)?.id || null, source: 'saved-product' as const }));
}

/** 只投影当前凭据可见页面，浏览器会用负责人本人会话再次校验预览与最终采用。 */
function projectView(grant: ExternalAiGrant, view: AiSiteDesignPreview): ExternalAiDesignView {
  grant = revalidateExternalAiGrant(grant, 'read', accessOf(view.request)); assertExternalGuidedViewAccess(grant, view);
  const allowed = allowedPageIds(grant), previewPages = view.previewPages.filter(page => allowed.has(page.pageId)), first = previewPages.find(page => page.available);
  const { beforeUrl: _before, afterUrl: _after, designGuidance: _guidance, sectionUnits: _sections, detailUnits: _details, propertyUnits: _properties, assetUnits: _assets, ...rest } = view;
  const currentRevision = getDraftRecord().revision;
  const selectionUnits = (view.selectionUnits || []).filter(unit => unit.area === 'page' ? unit.pageIds.every(id => allowed.has(id)) : grant.pageIds === null);
  const pageUnits = new Set(selectionUnits.filter(unit => unit.area === 'page').map(unit => unit.id));
  // 根区块与所属页面沿用同一授权；旧整页单位保持不变，不能通过新增元数据泄露其他页面的节点。
  const sectionUnits = (view.sectionUnits || []).filter(unit => unit.area === 'page' && unit.kind === 'section' && pageUnits.has(unit.parentId) && unit.pageIds.every(id => allowed.has(id)));
  const detailParents = new Map(sectionUnits.filter(unit => unit.nodeIds.length === 1 && unit.pageIds.length === 1 && !unit.id.startsWith('section:g1:')).map(unit => [unit.id, unit]));
  // 细分元数据必须沿真实可见父项过滤；结构组不能借同页ID被当作可拆父项，也不外发未授权节点标识。
  const detailUnits = (view.detailUnits || []).filter(unit => {
    const parent = detailParents.get(unit.parentId);
    return parent && unit.kind === 'detail' && unit.area === 'page' && unit.rootId === parent.nodeIds[0] && unit.pageIds.length === 1 && unit.pageIds[0] === parent.pageIds[0] && allowed.has(unit.pageIds[0]);
  });
  const propertyParents = new Set([...sectionUnits, ...detailUnits].map(unit => unit.id));
  const propertyUnits = (view.propertyUnits || []).filter(unit => unit.area === 'page' && unit.kind === 'property' && propertyParents.has(unit.parentId) && unit.pageIds.every(id => allowed.has(id)));
  // 头尾细分继承旧全站授权，指定页面token绝不能因新元数据读取全局节点。
  const assetUnits = grant.pageIds === null ? (view.assetUnits || []).filter(unit => selectionUnits.some(parent => parent.area === unit.area)) : [];
  // 浏览器从外部方案挑选后仍保留同连接归属；原方案状态保持真实，另外列出派生版本供AI继续核对。
  const children = getDatabase().prepare("SELECT DISTINCT d.id,json_extract(d.payload_json,'$.request') request_json,json_extract(d.payload_json,'$.view.selection.unitIds') units_json,d.applied_revision,d.undone_revision FROM cms_ai_site_design d JOIN cms_external_ai_request r ON r.design_id=d.id WHERE r.token_id=? AND d.actor_id=? AND d.expires_at>? AND json_extract(d.payload_json,'$.view.selection.sourceDesignId')=? ORDER BY d.created_at DESC,d.id DESC LIMIT 20").all(grant.tokenId, grant.actor.id, new Date().toISOString(), view.designId) as { id: string; request_json: string; units_json: string; applied_revision: number | null; undone_revision: number | null }[];
  const selectionPreviews = children.flatMap(row => {
    const request = JSON.parse(row.request_json) as AiSiteDesignRequest;
    try { revalidateExternalAiGrant(grant, 'read', accessOf(request)); }
    catch (error) { if (error instanceof ApiError && error.status === 403) return []; throw error; }
    return [{ designId: row.id, status: row.undone_revision !== null ? 'undone' as const : row.applied_revision !== null ? 'applied' as const : 'pending' as const, unitIds: JSON.parse(row.units_json) as string[], reviewUrl: reviewUrl(row.id) }];
  });
  return { ...rest, ...(grant.scopes.includes(DESIGN_GUIDANCE_SCOPE) && view.designGuidance ? { designGuidance: view.designGuidance } : {}), ...(grant.pageIds !== null ? { warnings: [...view.warnings.filter(warning => !view.scope.warnings.includes(warning)), scopedNotice], scope: { ...view.scope, warnings: [scopedNotice] } } : {}),
    selectionUnits, sectionUnits, detailUnits, propertyUnits, assetUnits, selectionPreviews,
    previewPages, affectedPages: view.affectedPages.filter(page => allowed.has(page.pageId)), ...(first?.beforeUrl ? { beforeUrl: first.beforeUrl } : {}), ...(first?.afterUrl ? { afterUrl: first.afterUrl } : {}),
    currentRevision, source: 'external-ai', status: view.undoneRevision !== null ? 'undone' : view.appliedRevision !== null ? 'applied' : 'pending', stale: view.appliedRevision === null && currentRevision !== view.baseRevision, validation: { nativeValidation: 'passed', visualInspection: 'not-performed', layoutMeasurements: 'not-collected' }, reviewUrl: reviewUrl(view.designId), requiresBrowserConfirmation: true, generatedContentEditable: true, previewAuthentication: 'creator-browser-session' };
}

export function externalAiOverview(grant: ExternalAiGrant, value: unknown = {}) {
  grant = revalidateExternalAiGrant(grant, 'read'); const input = object(value, '页面概览'); only(input, ['offset', 'limit']);
  const offset = input.offset ?? 0, limit = input.limit ?? 50;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new ApiError(422, '分页需为非负起点和1–100条');
  const current = getDraftRecord(), allowed = allowedPageIds(grant), pages = current.content.pages.filter(page => allowed.has(page.id));
  return { revision: current.revision, site: { name: clip(current.content.settings.name, 200), description: clip(current.content.settings.description, 1500), language: current.content.settings.language, locales: current.content.settings.locales },
    pages: pages.slice(Number(offset), Number(offset) + Number(limit)).map(page => ({ id: page.id, title: page.title, slug: page.slug, locale: page.locale || current.content.settings.language, dynamic: page.slug.includes(':') })), total: pages.length, offset, limit, nextOffset: Number(offset) + Number(limit) < pages.length ? Number(offset) + Number(limit) : null,
    permissions: { read: true, propose: grant.scopes.includes('propose'), wholeSite: grant.pageIds === null, confirmInOwnerBrowser: true }, next: 'site_design_context', limits: { selectedPages: 100, contextCharacters: 120000, operationGroups: 32, continuations: 6 } };
}

/** 静态契约按需发现，不把整份网站、账号或模型配置夹带进能力说明。 */
export function externalAiCapabilities(grant: ExternalAiGrant) {
  grant = revalidateExternalAiGrant(grant, 'read');
  return { format: 'form-studio-native-design-v1', editable: true, model: 'external-client-model', siteModelCalls: false, wholeSiteAllowed: grant.pageIds === null,
    workflow: ['site_overview', 'site_capabilities', 'site_design_context', 'site_design_propose', 'site_design_status', 'site_design_select', 'site_design_review'],
    fineSelection: { pageProperties: 'propertyUnits', globalNativeTrees: grant.pageIds === null ? 'assetUnits' : null, units: ['complete-native-subtree', 'unbound-text', 'per-device-layout-group', 'per-device-typography-group', 'per-device-appearance-group', 'per-device-image-crop-group'], selectedIdsLimit: 103, rawPropsOrPathsWritable: false, dependencyGroupsAtomic: true, confirmation: 'Submit only server-listed opaque ids. Selecting an internal item excludes its whole parent; never widen fine choices automatically. Prepare and inspect the NEW real preview before owner confirmation. Inverse masks preserve unselected later safe edits; changed selected values, bindings, resources, structure or locks can still block undo.' },
    ...(grant.scopes.includes(DESIGN_GUIDANCE_SCOPE) ? { designGuidance: { discovery: 'site_design_guidance', scope: DESIGN_GUIDANCE_SCOPE, sharedAcrossPages: true, editableByMachine: false, advisory: true } } : {}),
    selectiveAdoption: { available: grant.scopes.includes('propose'), units: ['page', 'header-with-navigation', 'footer-with-navigation', 'site-style'], rootSections: { field: 'sectionUnits', parentField: 'parentId', nodeField: 'nodeIds', kind: 'section', dependencyGrouping: true, availability: 'Server-issued groups can include root insertions, removals, reorderings and cross-root descendant moves. Each root unit selects complete affected subtrees, and g1 structure groups cannot be split. Only stable single-root sections can advertise finer choices separately in detailUnits. Shared page settings, unsafe legacy structures or exceeded budgets still fall back to the whole page with a reason.', nodeIdsMeaning: 'Union of the group roots before and after the design; removed roots may not exist in the after preview. These are descriptive identities, not selection ids.', unavailableReasonField: 'selectionUnits[].sectionSelectionUnavailableReason', maximumUnits: 200, maximumGroupRootIds: 200, selectedIdsLimit: 103, selection: 'Choose a whole-page unit or its descendants, not both. Whole-site select-all continues to use selectionUnits only.' }, detailSubtrees: { field: 'detailUnits', parentField: 'parentId', rootField: 'rootId', nodeField: 'nodeIds', kind: 'detail', maximumUnits: 200, unavailableReasonField: 'sectionUnits[].detailSelectionUnavailableReason', availability: 'Only server-listed non-overlapping subtree choices inside stable single-root sections are selectable. Ancestor type, own properties, slots and direct-child identities/order must be stable to descend; the nearest changed structure or own-property boundary stays atomic. g1 structure groups never expose these choices.', selection: 'Never mix a page with its sections/details, a section with its details, or overlapping subtrees. Even when all detail choices are selected, keep their fine ids; do not expand them to the whole section, which would include unselected siblings and later manual work.', overBudget: 'The whole affected root falls back to its section unit; no partial frontier is silently truncated.' }, dependencies: 'Coupled root structures remain atomic. Referenced generated cards and menus are included automatically from the selected trees. Submit only the opaque selectionUnits, sectionUnits, detailUnits, propertyUnits or assetUnits ids returned for this candidate; never infer membership from the after preview, invent ids or select primitive change-log entries. An obsolete id must be refreshed, not expanded into another group automatically.', confirmation: 'site_design_select creates a new preview without model invocation or draft writes. Review and track the NEW designId; the source remains unchanged.' },
    confirmation: 'The external tool only creates a private preview. A real owner browser session must inspect and confirm apply/undo; no confirmation boolean or token can replace that click.',
    contextPolicy: grant.pageIds === null ? 'Bounded website facts, authorized page structures, matched saved-product samples and image metadata.' : scopedNotice,
    wholeSiteOperations: AI_SITE_DESIGN_INSTRUCTIONS, nativePageOperations: AI_PAGE_EDIT_INSTRUCTIONS,
    detailTemplates: { available: grant.templateIds === null || grant.templateIds.length > 0, discovery: 'site_template_overview', note: 'Independent template and preview-record grants are required. Template data only; matching rules and record values are preserved.' },
    unsupported: ['automatic-publication', 'arbitrary-code', 'credentials-or-inquiries', 'detail-template-rule-rewrite', 'unlisted-descendant-or-property-partial-acceptance', 'unverified-layout-measurements'] };
}

export function externalAiContext(grant: ExternalAiGrant, value: unknown) {
  const input = object(value, '设计上下文'), { detailPageId, ...requestValue } = input;
  grant = revalidateExternalAiGrant(grant, 'read', accessOf(requestValue));
  if (detailPageId !== undefined && (typeof detailPageId !== 'string' || !grant.pageIds?.includes(detailPageId) && grant.pageIds !== null)) throw new ApiError(403, '详细页面超出这条连接的授权范围');
  if (input.baseDesignId !== undefined) assertExternalGuidedViewAccess(grant, readAiSiteDesign(ownDesign(grant, input.baseDesignId), grant.actor));
  const options = externalGuidanceForRequest(grant, requestValue), { guidanceRevision: _guidanceRevision, ...nativeRequest } = requestValue;
  const result = prepareExternalSiteDesignContext(nativeRequest, grant.actor, options), content = getDraftRecord().content, allowed = allowedPageIds(grant), media = availableMedia(content, grant);
  const imageLibrary = media.slice(0, 24).map(({ id, name, alt, width, height }) => ({ id, name, alt, width, height }));
  // 网站读取授权不包含站内写作私有指引；仅全站连接可读取已确认的公司事实，不外发受众/市场/语气/禁用说法。
  const website = { company: result.context.website.company, ...(grant.pageIds === null ? { confirmedFacts: result.context.website.confirmedFacts } : {}) };
  const { designGuidance: _privateGuidance, ...nativeContext } = result.context as typeof result.context & { designGuidance?: unknown };
  const context = { ...nativeContext, ...(options.guidance?.context ? { designGuidance: options.guidance.context } : {}), website, globalOperationsAllowed: grant.pageIds === null && result.context.globalOperationsAllowed, pageLinks: result.context.pageLinks.filter(page => allowed.has(page.pageId)), imageLibrary,
    ...(grant.pageIds === null ? { productSamples: productSamples(content, result.request.instruction) } : { constraints: [scopedNotice], productSamples: [] }), untrustedWebsiteData: true };
  const pageDetail = detailPageId === undefined ? undefined : prepareExternalSiteDesignPageContext(nativeRequest, grant.actor, detailPageId, options);
  if (pageDetail) {
    pageDetail.context.pageLinks = pageDetail.context.pageLinks.filter(page => allowed.has(page.id)); pageDetail.context.imageLibrary = imageLibrary;
    // 总数和明细共用授权集合；不能借原生全库计数泄露未授权素材，也不把24项展示上限当作总量。
    pageDetail.context.imageLibraryTotal = media.length;
    if (grant.pageIds !== null) {
      const slugs = new Set(content.pages.filter(page => allowed.has(page.id)).map(page => page.slug));
      pageDetail.context.nodes = pageDetail.context.nodes.map(node => {
        if (!node.currentLink) return node;
        const link = { ...node.currentLink };
        if (link.target && (link.target.kind !== 'page' || !allowed.has(link.target.id))) { delete link.target; link.referenceOmitted = true; }
        if (link.href?.startsWith('/') && !slugs.has(link.href)) { delete link.href; link.referenceOmitted = true; }
        return { ...node, currentLink: link };
      });
    }
    if (JSON.stringify(pageDetail.context).length > 120_000) throw new ApiError(413, '该页详细上下文超过12万字符，请缩小设计任务');
  }
  revalidateExternalAiGrant(grant, 'read', accessOf(result.request));
  if (options.guidance) { revalidateExternalAiGrant(grant, DESIGN_GUIDANCE_SCOPE); assertDesignGuidanceUnchanged(options.guidance, grant.actor); }
  return { revision: getDraftRecord().revision, request: { ...result.request, ...(options.guidance ? { guidanceRevision: options.guidance.revision } : {}) }, scope: grant.pageIds === null ? result.scope : { ...result.scope, warnings: [scopedNotice] }, context, ...(pageDetail ? { pageDetail } : {}), requiresBrowserConfirmation: true, next: 'site_design_propose' };
}

/** 同凭据的请求幂等与候选写入在同一事务；失败不留下孤立方案，也不修改网站草稿。 */
export function submitExternalAiDesign(grant: ExternalAiGrant, value: unknown): ExternalAiDesignView {
  grant = revalidateExternalAiGrant(grant, 'propose'); const input = object(value, '外部设计提交'); only(input, ['requestId', 'request', 'proposal']);
  const id = requestId(input.requestId), hash = digest({ request: input.request, proposal: input.proposal }), access = accessOf(input.request);
  grant = revalidateExternalAiGrant(grant, 'propose', access);
  const request = object(input.request, '设计请求');
  return getDatabase().transaction(() => {
    grant = revalidateExternalAiGrant(grant, 'propose', access);
    const old = getDatabase().prepare('SELECT request_hash,design_id FROM cms_external_ai_request WHERE token_id=? AND request_id=?').get(grant.tokenId, id) as RequestRow | undefined;
    if (old) { if (old.request_hash !== hash) throw new ApiError(409, '此请求标识已用于不同设计，请生成新的请求标识'); return projectView(grant, readAiSiteDesign(old.design_id, grant.actor)); }
    // 成功回执以冻结候选和实时授权为准；后来的图片引用变化不能重做旧请求的素材校验。
    assertProposalResources(input.proposal, getDraftRecord().content, grant);
    // 成功子方案的重试不重新依赖父方案存活；只有真正的新提案才读取父方案并检查私有输入授权。
    if (request.baseDesignId !== undefined) assertExternalGuidedViewAccess(grant, readAiSiteDesign(ownDesign(grant, request.baseDesignId), grant.actor));
    checkExternalGuidanceField(grant, request);
    const options = externalGuidanceForRequest(grant, request, true), { guidanceRevision: _guidanceRevision, ...nativeRequest } = request;
    const view = createExternalSiteDesignCandidate(nativeRequest, input.proposal, grant.actor, () => { grant = revalidateExternalAiGrant(grant, 'propose', access); if (options.guidance) grant = revalidateExternalAiGrant(grant, DESIGN_GUIDANCE_SCOPE, access); }, options);
    getDatabase().prepare('INSERT INTO cms_external_ai_request(token_id,request_id,request_hash,design_id,created_at) VALUES(?,?,?,?,?)').run(grant.tokenId, id, hash, view.designId, new Date().toISOString());
    recordAudit(grant.actor, 'external.ai.design.propose', 'success', { objectIds: [grant.tokenId, view.designId], revision: view.baseRevision });
    grant = revalidateExternalAiGrant(grant, 'propose', access);
    return projectView(grant, view);
  }).immediate();
}

export function readExternalAiDesign(grant: ExternalAiGrant, designId: unknown): ExternalAiDesignView {
  grant = revalidateExternalAiGrant(grant, 'read'); return projectView(grant, readAiSiteDesign(ownDesign(grant, designId), grant.actor));
}

/** 浏览器挑选的外部来源方案继续归同一连接，索引仅授予归属，不替代实时scope/owner校验。 */
export function inheritExternalAiDesignSelection(view: AiSiteDesignPreview, actor: Actor): void {
  if (!view.selection) throw new ApiError(422, '缺少选中范围的来源方案');
  const rows = getDatabase().prepare('SELECT DISTINCT r.token_id FROM cms_external_ai_request r JOIN cms_external_ai_token t ON t.id=r.token_id JOIN cms_ai_site_design d ON d.id=r.design_id WHERE r.design_id=? AND t.actor_id=? AND d.actor_id=?').all(view.selection.sourceDesignId, actor.id, actor.id) as { token_id: string }[];
  const id = `selection-auto-${view.designId.slice(5)}`, hash = digest({ sourceDesignId: view.selection.sourceDesignId, designId: view.designId });
  for (const row of rows) getDatabase().prepare('INSERT INTO cms_external_ai_request(token_id,request_id,request_hash,design_id,created_at) VALUES(?,?,?,?,?)').run(row.token_id, id, hash, view.designId, new Date().toISOString());
}

/** 外部AI只能派生可核对的范围方案；幂等、原生候选及同token归属必须一起提交。 */
export function selectExternalAiDesign(grant: ExternalAiGrant, value: unknown): ExternalAiDesignView {
  const input = object(value, '选择设计范围'); only(input, ['requestId', 'designId', 'expectedRevision', 'unitIds']);
  const id = requestId(input.requestId);
  if (!Array.isArray(input.unitIds) || !input.unitIds.length || input.unitIds.length > 103 || input.unitIds.some(unit => typeof unit !== 'string' || !unit || unit.length > 150) || new Set(input.unitIds).size !== input.unitIds.length) throw new ApiError(422, '请选择有效且不重复的设计范围');
  const unitIds = [...input.unitIds as string[]].sort(), hash = digest({ operation: 'select', designId: input.designId, expectedRevision: input.expectedRevision, unitIds });
  return getDatabase().transaction(() => {
    grant = revalidateExternalAiGrant(grant, 'propose');
    const old = getDatabase().prepare('SELECT request_hash,design_id FROM cms_external_ai_request WHERE token_id=? AND request_id=?').get(grant.tokenId, id) as RequestRow | undefined;
    if (old) {
      if (old.request_hash !== hash) throw new ApiError(409, '此请求标识已用于不同设计，请使用新的请求标识');
      const saved = readAiSiteDesign(ownDesign(grant, old.design_id), grant.actor);
      grant = revalidateExternalAiGrant(grant, 'propose', accessOf(saved.request));
      return projectView(grant, saved);
    }
    const source = readAiSiteDesign(ownDesign(grant, input.designId), grant.actor), sourceAccess = accessOf(source.request); assertExternalGuidedViewAccess(grant, source);
    grant = revalidateExternalAiGrant(grant, 'propose', sourceAccess);
    const view = selectAiSiteDesign({ designId: source.designId, expectedRevision: input.expectedRevision, unitIds }, grant.actor, () => { grant = revalidateExternalAiGrant(grant, 'propose', sourceAccess); });
    grant = revalidateExternalAiGrant(grant, 'propose', accessOf(view.request));
    inheritExternalAiDesignSelection(view, grant.actor);
    getDatabase().prepare('INSERT INTO cms_external_ai_request(token_id,request_id,request_hash,design_id,created_at) VALUES(?,?,?,?,?)').run(grant.tokenId, id, hash, view.designId, new Date().toISOString());
    recordAudit(grant.actor, 'external.ai.design.select', 'success', { objectIds: [grant.tokenId, source.designId, view.designId], revision: view.baseRevision });
    return projectView(grant, view);
  }).immediate();
}

/** 请求采用/撤销仅交接到本人后台审核，外部AI没有直接更改草稿的执行入口。 */
export function requestExternalAiReview(grant: ExternalAiGrant, value: unknown) {
  grant = revalidateExternalAiGrant(grant, 'propose'); const input = object(value, '设计审核'); only(input, ['designId', 'action']);
  if (input.action !== 'apply' && input.action !== 'undo') throw new ApiError(422, '请选择采用或撤销设计');
  const view = readExternalAiDesign(grant, input.designId);
  if (input.action === 'undo' && view.status === 'pending') throw new ApiError(422, '方案尚未采用，无需撤销');
  if (input.action === 'apply' && view.status === 'undone') throw new ApiError(409, '这条方案已撤销，请从当前草稿开始新设计');
  return { designId: view.designId, action: input.action, status: view.status, currentRevision: view.currentRevision, reviewUrl: view.reviewUrl, requiresBrowserConfirmation: true,
    message: input.action === 'apply' ? '请在负责人登录的后台查看真实前后预览并确认采用，再查询设计状态。网站尚未发布。' : '请在负责人登录的后台核对后续修改并确认撤销，再查询设计状态。' };
}
