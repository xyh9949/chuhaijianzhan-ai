import { seoContentLinkPublicationErrors } from '../lib/seo-content-links';
import {withPublicUrlState} from './discovery-publication';
import { bundledImage } from '../lib/bundled-media';
import {enqueuePublicChanges} from './discovery-runtime';
import {advancedLayoutErrors} from '../lib/advanced-layout';
import {snapshotComponentErrors} from '../lib/component-contract';
import {extensionSourceErrors} from '../extensions/registry';
import protocol from '../lib/protocol.json';
import { needsGeneratedChrome, publicationDiagnostics } from './publication-diagnostics';
import { publicSettings } from './public-settings';
import {localizationErrors,defaultLanguagePublicationErrors} from '../lib/localization';
import { recordAudit } from './audit';
import { formContentErrors } from '../lib/form-content';
import { requiredProductFormErrors } from '../lib/site-form-availability';
import { presentationMediaErrors } from '../lib/presentation-content';
import { themeDesignErrors } from '../lib/theme-design';
import { redirectErrors, compileRedirects, suggestedRedirects } from '../lib/site-redirects';
import { seoErrors } from '../lib/site-seo';
import { contentQueryErrors } from '../lib/content-query';
import { taxonomyErrors } from '../lib/taxonomy';
import {defaultLanguageMenuErrors,rebaseLocaleMenus,rebaseNavigationLocales} from '../lib/site-navigation';
import {transferRecordLocale,rebaseLayoutPaths} from '../lib/locale-transfer';
import {actualSiteRoutes} from '../lib/site-redirects';
import { navigationErrors } from '../lib/site-navigation';
import { getProductPath } from '../lib/content-routes';
import { siteLinkErrors } from '../lib/site-links';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabase, getDataDirectory } from './database';
import { ApiError } from './http';
import { getActiveReleaseId, getDraftRecord, getStudioEnvelope, readRelease, writeDraft } from './studio';
import { affectedSharedPages, collectReferences, pageTemplateErrors, identifier, object, revision, sharedDependencyErrors, validateDraft, validatePageData, validateSelection } from './validation';
import { validateContentState } from './model-validation';
import { contentBindingErrors } from '../lib/content-binding';
import { contentRouteErrors } from '../lib/content-routes';
import { codeForPages, validateCustomCode } from './site-code';
import type { ActorIdentity, DraftContent, PublicationSelection, SiteSnapshot } from './types';
import type { QueryParams } from '../lib/content-query';
import { hasInvalidLoopPage } from '../lib/loop-pages';
import { resolveSitePage, siteLinkHref } from '../lib/site-routing';
import { requirePermission, type Actor } from './permissions';
export type { SiteSnapshot } from './types';

const PUBLICATION_PREVIEW_MS = 20 * 60 * 1000;
const PUBLICATION_PREVIEW_LIMIT = 100;
type PublicationPreview = { ownerKey: string; selection: PublicationSelection; expires: number };
// 每个检查通过的范围拥有独立令牌，同一账号可在多个标签对照；只存规范化选择，重启后可重新检查。
const runtime = globalThis as typeof globalThis & { formStudioPublicationPreviews?: Map<string, PublicationPreview> };
const publicationPreviews = runtime.formStudioPublicationPreviews ??= new Map();
const previewKey = (actor: Actor) => `${getDataDirectory()}\0${actor.id}`;
const previewPath = (id: string) => `/preview/~publication/${id}`;

function keepPublicationPreview(actor: Actor, selection: PublicationSelection) {
  const now = Date.now();
  for (const [key, entry] of publicationPreviews) if (entry.expires <= now) publicationPreviews.delete(key);
  if (publicationPreviews.size >= PUBLICATION_PREVIEW_LIMIT) publicationPreviews.delete(publicationPreviews.keys().next().value!);
  const id = `pubv-${randomUUID()}`;
  const expires = now + PUBLICATION_PREVIEW_MS;
  publicationPreviews.set(id, { ownerKey: previewKey(actor), selection, expires });
  return { href: previewPath(id), expiresAt: new Date(expires).toISOString() };
}

export function getActiveSiteSnapshot(): SiteSnapshot | null {
  const id = getActiveReleaseId();
  if(!id)return null;const snapshot=readRelease(id),errors=snapshotComponentErrors(snapshot);if(errors.length)throw new ApiError(503,'当前网站需要兼容组件，请由管理员检查本地扩展：'+errors.join('；'));return snapshot;
}
export function getDraftSiteSnapshot(): SiteSnapshot {
  const { content } = getDraftRecord();
  // 草稿预览有意包含未发布产品；公开渲染只能调用 active 版本读取函数。
  return { schemaVersion: protocol.snapshot, pageTemplates: content.pageTemplates || [], forms: content.forms || [], pages: content.pages, editorData: content.editorData, products: content.products.map((product) => ({ ...product, status: 'published' })), media: content.media, theme: content.theme, settings: publicSettings(content.settings), sharedBlocks: content.sharedBlocks || [], siteLayout: content.siteLayout, customCode: content.customCode, redirects: content.redirects || [], taxonomies: content.taxonomies || [], contentModels: content.contentModels || [], contentEntries: (content.contentEntries || []).map((entry) => ({ ...entry, status: 'published' })) };
}
function requireBase(selection: PublicationSelection) {
  const draft = getDraftRecord(); const active = getActiveReleaseId();
  if (selection.expectedRevision !== draft.revision) throw new ApiError(409, '草稿已变化，请重新检查发布内容');
  if (selection.baseReleaseId !== active) throw new ApiError(409, '线上版本已变化，请重新检查发布内容');
  return { draft: draft.content, active: active ? readRelease(active) : null };
}
function mergeById<T extends { id: string }>(base: T[], draft: T[], chosen: string[], removed: string[], errors: string[], label: string): T[] {
  const byId = new Map(base.filter((item) => !removed.includes(item.id)).map((item) => [item.id, item]));
  for (const id of chosen) { const item = draft.find((value) => value.id === id); if (!item) errors.push(`${label} ${id} 不存在于当前草稿`); else byId.set(id, structuredClone(item)); }
  for (const id of removed) if (!base.some((item) => item.id === id)) errors.push(`要下线的${label} ${id} 不在当前线上版本`);
  return [...byId.values()];
}
function mediaExists(url: string): boolean {
  const bundled = bundledImage(url);
  if (bundled) return existsSync(join(process.cwd(), 'public', bundled.url));
  if (!/^\/api\/media\/[a-zA-Z0-9_-]+$/.test(url)) return false;
  const id = url.split('/').pop();
  const row = getDatabase().prepare('SELECT filename FROM cms_media_file WHERE id = ?').get(id) as { filename: string } | undefined;
  return !!row && existsSync(join(getDataDirectory(), 'media', row.filename));
}
function preparePublication(selection: PublicationSelection) {
  const { draft, active } = requireBase(selection); validateDraft(draft);
  const errors: string[] = []; const warnings: string[] = [];
  if (!active && (!selection.includeTheme || !selection.includeSettings)) errors.push('首次发布必须明确包含网站主题与公开设置');
  if (!selection.pageIds.length && !selection.productIds?.length && !selection.removePageIds?.length && !selection.removeProductIds?.length && !selection.sharedBlockIds?.length && !selection.removeSharedBlockIds?.length && !selection.contentModelIds?.length && !selection.removeContentModelIds?.length && !selection.contentEntryIds?.length && !selection.removeContentEntryIds?.length && !selection.includeTheme && !selection.includeSettings && !selection.includeLayout && !selection.includeCode && !selection.includeCatalog && !selection.includeRedirects && !selection.includeForms && !selection.includeTemplates) errors.push('请至少选择一项需要发布的更改');
  const pages = mergeById(active?.pages || [], draft.pages, selection.pageIds, selection.removePageIds || [], errors, '页面').map((page) => ({ ...page, status: 'published' as const }));
  const products = mergeById(active?.products || [], draft.products, selection.productIds || [], selection.removeProductIds || [], errors, '产品').map((product) => ({ ...product, status: 'published' as const }));
  const contentModels = mergeById(active?.contentModels || [], draft.contentModels || [], selection.contentModelIds || [], selection.removeContentModelIds || [], errors, '内容模型');
  const contentEntries = mergeById(active?.contentEntries || [], draft.contentEntries || [], selection.contentEntryIds || [], selection.removeContentEntryIds || [], errors, '内容记录').map((entry) => ({ ...entry, status: 'published' as const }));
  const editorData: Record<string, unknown> = {};
  for (const page of pages) editorData[page.id] = selection.pageIds.includes(page.id) ? structuredClone(draft.editorData[page.id]) : structuredClone(active?.editorData[page.id]);
  const controls = selection.includeTheme ? draft.editorData.__themeControls : active?.editorData.__themeControls;
  if (controls !== undefined) editorData.__themeControls = structuredClone(controls);
  // 同步区块与代码都属于独立发布范围；页面引用绝不会自动携带未选中的草稿区块。
  const sharedBlocks = mergeById(active?.sharedBlocks || [], draft.sharedBlocks || [], selection.sharedBlockIds || [], selection.removeSharedBlockIds || [], errors, '同步区块');
  const siteLayout = structuredClone(selection.includeLayout ? draft.siteLayout : active?.siteLayout);
  const customCode = codeForPages(selection.includeCode ? draft.customCode : active?.customCode, new Set(pages.map((page) => page.id)));
  const candidate: SiteSnapshot = { schemaVersion: protocol.snapshot, pageTemplates: structuredClone(selection.includeTemplates ? draft.pageTemplates || [] : active?.pageTemplates || []), forms: structuredClone(selection.includeForms ? draft.forms || [] : active?.forms || []), redirects: structuredClone(selection.includeRedirects ? draft.redirects || [] : active?.redirects || []), taxonomies: structuredClone(selection.includeCatalog ? draft.taxonomies || [] : active?.taxonomies || []), pages, products, contentModels, contentEntries, editorData, media: [], sharedBlocks, siteLayout, customCode, theme: structuredClone(selection.includeTheme || !active ? draft.theme : active.theme), settings: selection.includeSettings || !active ? publicSettings(draft.settings) : structuredClone(active.settings) };
  if (needsGeneratedChrome(draft,candidate,selection.pageIds)) errors.push('所选AI页面使用新的共享头尾，请一并选择网站页眉、页脚与导航菜单设置');
  for (const page of pages) { try { validatePageData(editorData[page.id], page.title, true); } catch (error) { if (error instanceof ApiError) errors.push(error.message); else throw error; } }
  for (const block of sharedBlocks) { try { validatePageData(block.data, `同步区块“${block.name}”`, true); } catch (error) { if (error instanceof ApiError) errors.push(error.message); else throw error; } }
  errors.push(...sharedDependencyErrors(candidate),...seoContentLinkPublicationErrors(candidate,draft,active));
  // 以最终公开清单验证字段，而不是借用未选择的草稿定义或记录补齐依赖。
  try { validateContentState(candidate, true); } catch (error) { if (error instanceof ApiError) errors.push(error.message); else throw error; }
  errors.push(...contentBindingErrors(candidate, true));
  errors.push(...localizationErrors(candidate,true),...advancedLayoutErrors(candidate),...snapshotComponentErrors(candidate));
  errors.push(...defaultLanguagePublicationErrors(active||undefined,candidate),...defaultLanguageMenuErrors(active||undefined,candidate));
  // 模板、内容地址和未选择的线上记录一起验证，部分发布不能生成重叠地址。
  errors.push(...contentRouteErrors(candidate), ...siteLinkErrors(candidate), ...navigationErrors(candidate, true), ...taxonomyErrors(candidate), ...contentQueryErrors(candidate), ...redirectErrors(candidate), ...seoErrors(candidate), ...themeDesignErrors(candidate));
  candidate.publicRedirects = compileRedirects(candidate);
  try { validateCustomCode(customCode, new Set(pages.map((page) => page.id))); } catch (error) { if (error instanceof ApiError) errors.push(error.message); else throw error; }
  if (!pages.some((page) => page.slug === '/')) errors.push('发布清单必须包含首页 /');
  if (new Set(pages.map((page) => page.slug)).size !== pages.length) errors.push('选中草稿与当前线上页面存在路径冲突，请同时处理冲突页面');
  if (products.length && !pages.some((page) => page.slug === '/products/:slug')) warnings.push('发布清单没有产品详情模板，产品详情地址暂不可用');
  for (const product of products) if (pages.some((page) => page.slug === getProductPath(candidate, product))) errors.push(`静态页面占用了产品地址 /products/${product.id}`);
  const refs = collectReferences(candidate);
  for (const productId of refs.productIds) if (!products.some((product) => product.id === productId)) errors.push(`页面绑定了未在发布清单中的产品 ${productId}，请明确选择该产品或修改绑定`);
  if (refs.usesProductList && !products.length) warnings.push('产品集合当前为空；如需展示产品，请明确选择需要发布的产品');
  const selectedRefs = collectReferences({ pages: pages.filter((page) => selection.pageIds.includes(page.id)), editorData, products: products.filter((product) => selection.productIds?.includes(product.id)), contentModels, contentEntries: contentEntries.filter((entry) => selection.contentEntryIds?.includes(entry.id)), sharedBlocks: sharedBlocks.filter((block) => selection.sharedBlockIds?.includes(block.id)), pageTemplates: selection.includeTemplates ? candidate.pageTemplates : undefined, theme: selection.includeTheme ? candidate.theme : undefined, customCode: selection.includeCode ? customCode : undefined }).urls;
  const oldMedia = new Map((active?.media || []).map((item) => [item.url, item])); const draftMedia = new Map(draft.media.map((item) => [item.url, item]));
  // 只有选中内容的素材依赖使用草稿元数据；仅被未选线上内容引用的素材保持原快照。
  for (const url of refs.urls) {
    const item = selectedRefs.has(url) ? draftMedia.get(url) || oldMedia.get(url) : oldMedia.get(url);
    if (!item || !mediaExists(url)) errors.push(`引用素材不存在或文件不可读：${url}`); else candidate.media.push(structuredClone(item));
  }
  errors.push(...extensionSourceErrors(candidate),...presentationMediaErrors(candidate), ...formContentErrors(candidate, true), ...pageTemplateErrors(candidate, true));
  // 使用最终候选的实际页面和语言，不借用本次未纳入发布的草稿产品。
  if (!errors.length) errors.push(...requiredProductFormErrors(candidate));
  // 模板路径及关联变化也会改写未选页面的动态链接；同时检查新旧版本，包含取消关联和下线。
  const changedPageIds = new Set([...selection.pageIds, ...(selection.removePageIds || [])]);
  const changesContentTemplate = [...draft.pages, ...(active?.pages || [])].some(page => page.contentModelId && changedPageIds.has(page.id));
  const affectedPages = changesContentTemplate || selection.includeForms || selection.includeTheme || selection.includeRedirects || selection.includeCatalog || selection.includeLayout || selection.includeCode || selection.productIds?.length || selection.contentModelIds?.length || selection.removeContentModelIds?.length || selection.contentEntryIds?.length || selection.removeContentEntryIds?.length ? pages.map(({ id, title }) => ({ id, title })) : affectedSharedPages(candidate, new Set(selection.sharedBlockIds));
  // 模板、模型与记录能通过集合间接使用，因此这里保守提示可能影响的页面。
  if (affectedPages.length) warnings.push(`本次全站内容可能影响 ${affectedPages.length} 个页面：${affectedPages.map((page) => page.title).join('、')}`);
  return { candidate, errors, warnings, suggestedRedirects: suggestedRedirects(active, candidate), summary: { includeTemplates: selection.includeTemplates, totalPageTemplates: candidate.pageTemplates?.length || 0, pageIds: selection.pageIds, productIds: selection.productIds || [], removedPageIds: selection.removePageIds || [], removedProductIds: selection.removeProductIds || [], sharedBlockIds: selection.sharedBlockIds || [], removeSharedBlockIds: selection.removeSharedBlockIds || [], includeLayout: selection.includeLayout === true, includeCode: selection.includeCode === true, includeTheme: selection.includeTheme, includeSettings: selection.includeSettings, totalPages: pages.length, totalProducts: products.length, totalSharedBlocks: sharedBlocks.length, totalContentModels: contentModels.length, totalContentEntries: contentEntries.length, contentModelIds: selection.contentModelIds || [], contentEntryIds: selection.contentEntryIds || [], removeContentModelIds: selection.removeContentModelIds || [], removeContentEntryIds: selection.removeContentEntryIds || [], affectedPages } };
}
export function previewPublication(value: unknown, actor?: Actor, checkAccess?: () => void) {
  if (actor) requirePermission(actor, 'publish');
  const selection = validateSelection(value);
  return getDatabase().transaction(()=>{
    checkAccess?.();
    const prepared=preparePublication(selection),draft=getDraftRecord().content,active=getActiveSiteSnapshot();
    const diagnostics = publicationDiagnostics(draft,active,prepared.candidate,prepared.errors,selection.pageIds);
    const preview = actor && !prepared.errors.length ? keepPublicationPreview(actor, selection) : undefined;
    return {expectedRevision:selection.expectedRevision,baseReleaseId:selection.baseReleaseId,errors:prepared.errors,warnings:prepared.warnings,summary:prepared.summary,suggestedRedirects:prepared.suggestedRedirects,diagnostics,...(preview ? { preview } : {})};
  })();
}

/** 每次点击都按同一发布选择读取同一版本；范围不合法、草稿或线上版本已变时不回退到实时草稿。 */
export function resolvePublicationPreview(id: string, segments: string[], actor: Actor, query: QueryParams = {}) {
  requirePermission(actor, 'publish');
  const entry = publicationPreviews.get(id);
  if (!entry || entry.ownerKey !== previewKey(actor)) throw new ApiError(404, '找不到本次发布范围预览，请回发布窗口重新检查');
  if (entry.expires <= Date.now()) {
    publicationPreviews.delete(id);
    throw new ApiError(410, '发布范围预览已过期，请重新检查');
  }
  return getDatabase().transaction(() => {
    const { candidate: snapshot, errors } = preparePublication(entry.selection);
    if (errors.length) throw new ApiError(422, '当前范围已不能发布，请重新检查依赖');
    const previewPrefix = previewPath(id);
    const requestedPath = `/${segments.map(segment => encodeURIComponent(segment)).join('/')}`;
    const redirect = snapshot.publicRedirects?.find(rule => rule.from === requestedPath);
    // 旧网址也能核对，目标和查询参数保留在同一私有组合内。
    if (redirect) {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(query)) {
        if (typeof value === 'string') params.append(name, value);
        else for (const item of value || []) params.append(name, item);
      }
      const destination = siteLinkHref(redirect.to, previewPrefix);
      if (!destination || !destination.startsWith(`${previewPrefix}/`) && destination !== previewPrefix) return null;
      return { redirectTo: `${destination}${params.size ? `?${params}` : ''}` };
    }
    const resolved = resolveSitePage(snapshot, segments);
    if (!resolved || hasInvalidLoopPage(snapshot, resolved, query)) return null;
    return { snapshot, resolved, previewPrefix };
  })();
}
export function publishSite(value: unknown, actor: ActorIdentity, checkAccess?: () => void) {
  const selection = validateSelection(value);
  let releaseId = '';
  getDatabase().transaction(() => {
    // HTTP提交携带同步授权复核；内部CLI/服务测试仍可使用已有可信身份调用。
    checkAccess?.();
    // 预检不是授权凭据；提交在同一写事务重新验证草稿与线上指针，避免检查后发生覆盖。
    const prepared = preparePublication(selection);
    if (prepared.errors.length) throw new ApiError(422, prepared.errors.join('；'));
    releaseId = `release-${randomUUID()}`;
    const previous=getActiveSiteSnapshot();const now=new Date().toISOString();
    const snapshot=withPublicUrlState({...prepared.candidate,releaseId},previous,now);const json=JSON.stringify(snapshot);
    getDatabase().prepare('INSERT INTO cms_release (id, title, manifest_json, manifest_hash, schema_version, renderer_version, created_by, author_name, created_at, selection_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(releaseId, selection.title?.trim() || '网站内容更新', json, createHash('sha256').update(json).digest('hex'), protocol.snapshot, protocol.renderer, actor.id, actor.name, now, JSON.stringify(selection));
    getDatabase().prepare('UPDATE cms_runtime SET active_release_id = ? WHERE id = 1').run(releaseId);
    getDatabase().prepare('INSERT INTO cms_release_event (action, release_id, actor_id, created_at) VALUES (?, ?, ?, ?)').run('publish', releaseId, actor.id, now);
    enqueuePublicChanges(previous,snapshot,releaseId);
    recordAudit(actor,'release.publish','success',{releaseId,objectIds:[...selection.pageIds,...selection.productIds||[],...selection.contentEntryIds||[],...selection.contentModelIds||[],...selection.sharedBlockIds||[]],fields:Object.entries(selection).filter(([k,v])=>k.startsWith('include')&&v===true).map(([k])=>k)});
  }).immediate();
  return { ...getStudioEnvelope(), releaseId };
}
export function activateRelease(id: string, value: unknown, actor: ActorIdentity, checkAccess?: () => void) {
  const input = object(value, '版本回滚');
  if (input.expectedActiveReleaseId !== null) identifier(input.expectedActiveReleaseId, '当前线上版本');
  getDatabase().transaction(() => {
    checkAccess?.();
    if (input.expectedActiveReleaseId !== getActiveReleaseId()) throw new ApiError(409, '线上版本已变化，请刷新后重新选择');
    const snapshot = readRelease(id);
    if (!(Number.isInteger(snapshot.schemaVersion)&&snapshot.schemaVersion>=protocol.minReadable&&snapshot.schemaVersion<=protocol.snapshot)) throw new ApiError(422, '此历史版本需要迁移后才能使用当前渲染器');
    const compatibility=snapshotComponentErrors(snapshot);if(compatibility.length)throw new ApiError(422,compatibility.join('；'));
    validateContentState(snapshot, true);
    // 回退保留历史路由语义；新的保留地址校验仅约束新写入和待发布候选。
    const dependencyErrors = [...sharedDependencyErrors(snapshot), ...contentBindingErrors(snapshot, true), ...contentRouteErrors(snapshot, { historicalRelease: true }), ...siteLinkErrors(snapshot), ...navigationErrors(snapshot, true), ...taxonomyErrors(snapshot), ...contentQueryErrors(snapshot), ...redirectErrors(snapshot), ...seoErrors(snapshot), ...themeDesignErrors(snapshot), ...presentationMediaErrors(snapshot), ...formContentErrors(snapshot, true), ...pageTemplateErrors(snapshot, true),...extensionSourceErrors(snapshot),...advancedLayoutErrors(snapshot)];
    if (dependencyErrors.length) throw new ApiError(422, dependencyErrors.join('；'));
    for (const media of snapshot.media) if (!mediaExists(media.url)) throw new ApiError(422, `历史素材文件缺失：${media.name}`);
    const before=getActiveSiteSnapshot();
    enqueuePublicChanges(before,withPublicUrlState(snapshot,before),`activate-${randomUUID()}`);
    getDatabase().prepare('UPDATE cms_runtime SET active_release_id = ? WHERE id = 1').run(id);
    getDatabase().prepare('INSERT INTO cms_release_event (action, release_id, actor_id, created_at) VALUES (?, ?, ?, ?)').run('activate', id, actor.id, new Date().toISOString());
    recordAudit(actor,'release.activate','success',{releaseId:id});
  }).immediate();
  return getStudioEnvelope();
}
/** 恢复预检和确认共用候选构建；读取依赖失败时不写任何草稿或运行记录。 */
function prepareRestoreDraft(id:string,value:unknown) {
  const input = object(value, '恢复草稿'); const expected = revision(input.expectedRevision);
  for (const key of ['includeTheme', 'includeSettings', 'includeLayout', 'includeCode', 'includeCatalog', 'includeRedirects', 'includeForms', 'includeTemplates']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiError(422, '恢复主题、设置、页眉页脚及代码必须使用明确的是/否选项');
  const current = getDraftRecord(); if (current.revision !== expected) throw new ApiError(409, '草稿已变化，请刷新后重新选择恢复范围');
  const snapshot = readRelease(id); const errors: string[] = [];
  if (!(Number.isInteger(snapshot.schemaVersion)&&snapshot.schemaVersion>=protocol.minReadable&&snapshot.schemaVersion<=protocol.snapshot)) throw new ApiError(422, '此历史版本需要迁移后才能恢复');
  const ids = (value: unknown, fallback: string[]) => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.length > 2000) throw new ApiError(422, '恢复范围必须是不超过 2000 项的列表');
    const result = value.map((item) => identifier(item));
    if (new Set(result).size !== result.length) throw new ApiError(422, '恢复范围不能重复');
    return result;
  };
  const pageIds = ids(input.pageIds, snapshot.pages.map((page) => page.id)); const productIds = ids(input.productIds, []); const sharedBlockIds = ids(input.sharedBlockIds, []);
  const contentModelIds = ids(input.contentModelIds, []); const contentEntryIds = ids(input.contentEntryIds, []);
  const next = structuredClone(current.content);
  const targetSettings=input.includeSettings===true?{...next.settings,...snapshot.settings}:next.settings;
  const clearsPublicUrl = input.includeSettings === true && !!next.settings.publicUrl && !snapshot.settings.publicUrl;
  const localeRebased=targetSettings.language!==snapshot.settings.language&&!!(targetSettings.locales||snapshot.settings.locales);
  next.pages = mergeById(next.pages, snapshot.pages, pageIds, [], errors, '页面').map((page) => pageIds.includes(page.id) ? { ...page, status: 'draft', updated: new Date().toISOString() } : page);
  next.products = mergeById(next.products, snapshot.products, productIds, [], errors, '产品').map((product) => productIds.includes(product.id) ? { ...product, status: 'draft' } : product);
  next.sharedBlocks = mergeById(next.sharedBlocks || [], snapshot.sharedBlocks || [], sharedBlockIds, [], errors, '同步区块').map((block) => sharedBlockIds.includes(block.id) ? { ...block, updated: new Date().toISOString() } : block);
  next.contentModels = mergeById(next.contentModels || [], snapshot.contentModels || [], contentModelIds, [], errors, '内容模型').map((model) => contentModelIds.includes(model.id) ? { ...model, updated: new Date().toISOString() } : model);
  next.contentEntries = mergeById(next.contentEntries || [], snapshot.contentEntries || [], contentEntryIds, [], errors, '内容记录').map((entry) => contentEntryIds.includes(entry.id) ? { ...entry, status: 'draft', updated: new Date().toISOString() } : entry);
  if (errors.length) throw new ApiError(422, errors.join('；'));
  for (const pageId of pageIds) next.editorData[pageId] = structuredClone(snapshot.editorData[pageId]);
  if (input.includeTheme === true) { next.theme = structuredClone(snapshot.theme); if (snapshot.editorData.__themeControls !== undefined) next.editorData.__themeControls = structuredClone(snapshot.editorData.__themeControls); else delete next.editorData.__themeControls; }
  if (input.includeSettings === true) {
    next.settings = targetSettings;
    // 历史快照没有可选公开字段时应清除，不能沿用后来添加的规范域名或语言设置。
    if (snapshot.settings.locales === undefined) delete next.settings.locales;
    if (snapshot.settings.discovery === undefined) delete next.settings.discovery;
    if (!snapshot.settings.publicUrl) delete next.settings.publicUrl;
  }
  if (input.includeTemplates === true) next.pageTemplates = structuredClone(snapshot.pageTemplates || []);
  if (input.includeForms === true) next.forms = structuredClone(snapshot.forms || []);
  if (input.includeRedirects === true) next.redirects = structuredClone(snapshot.redirects || []);
  if (input.includeCatalog === true) next.taxonomies = structuredClone(snapshot.taxonomies || []);
  if (input.includeLayout === true) { if (snapshot.siteLayout) next.siteLayout = structuredClone(snapshot.siteLayout); else delete next.siteLayout; }
  if (input.includeCode === true) next.customCode = codeForPages(snapshot.customCode, new Set(next.pages.map((page) => page.id)));
  if(localeRebased&&input.includeCode===true&&[snapshot.customCode?.global,...Object.values(snapshot.customCode?.pages||{})].some(c=>c&&(c.css.trim()||c.js.trim())))throw new ApiError(422,'默认语言不同，恢复代码需同时恢复语言配置；也可取消代码恢复，按新网址人工核对');
  next.pages=next.pages.map(p=>pageIds.includes(p.id)?transferRecordLocale(p,'page',snapshot.settings,next.settings):p);
  next.products=next.products.map(p=>productIds.includes(p.id)?transferRecordLocale(p,'product',snapshot.settings,next.settings):p);
  next.contentEntries=(next.contentEntries||[]).map(e=>contentEntryIds.includes(e.id)?transferRecordLocale(e,'entry',snapshot.settings,next.settings):e);
  if(localeRebased){
    const routes=new Map(actualSiteRoutes(next).map(r=>[`${r.target.kind}:${r.target.id}`,r.path])),paths=new Map(actualSiteRoutes(snapshot).flatMap(r=>routes.has(`${r.target.kind}:${r.target.id}`)?[[r.path,routes.get(`${r.target.kind}:${r.target.id}`)!] as [string,string]]:[]));
    for(const pageId of pageIds)next.editorData[pageId]=rebaseLayoutPaths(rebaseNavigationLocales(next.editorData[pageId],snapshot.settings,next.settings),paths);
    next.sharedBlocks=next.sharedBlocks?.map(b=>sharedBlockIds.includes(b.id)?{...b,data:rebaseLayoutPaths(rebaseNavigationLocales(b.data,snapshot.settings,next.settings),paths)}:b);
    if(input.includeTemplates)next.pageTemplates=next.pageTemplates?.map(t=>({...t,data:rebaseLayoutPaths(rebaseNavigationLocales(t.data,snapshot.settings,next.settings),paths)}));
    if(input.includeLayout&&next.siteLayout){next.siteLayout=rebaseLayoutPaths(next.siteLayout,paths);next.siteLayout.header=rebaseLocaleMenus(next.siteLayout.header,snapshot.settings,next.settings);next.siteLayout.footer=rebaseLocaleMenus(next.siteLayout.footer,snapshot.settings,next.settings);}
  }
  // 主题默认值和复用样式也可引用历史图片；只在明确恢复主题时补回它们，不携带未选历史素材。
  const restoredRefs = collectReferences({ pages: next.pages.filter((page) => pageIds.includes(page.id)), editorData: next.editorData, products: next.products.filter((product) => productIds.includes(product.id)), contentModels: next.contentModels, contentEntries: next.contentEntries.filter((entry) => contentEntryIds.includes(entry.id)), sharedBlocks: next.sharedBlocks.filter((block) => sharedBlockIds.includes(block.id)), pageTemplates: input.includeTemplates === true ? next.pageTemplates : undefined, theme: input.includeTheme === true ? next.theme : undefined, customCode: input.includeCode === true ? next.customCode : undefined }).urls;
  for (const url of restoredRefs) {
    const media = snapshot.media.find((item) => item.url === url);
    if (!media || !mediaExists(url)) throw new ApiError(422, `历史素材缺失，未修改草稿：${url}`);
    if (!next.media.some((item) => item.url === media.url)) next.media.push(structuredClone(media));
  }
  return { next:validateDraft(next), expected,localeRebased,clearsPublicUrl, objectIds:[...pageIds,...productIds,...contentModelIds,...contentEntryIds,...sharedBlockIds], fields:Object.entries(input).filter(([k,v])=>k.startsWith('include')&&v===true).map(([k])=>k) };
}
export function previewRestoreDraft(id:string,value:unknown) {
  const expected=revision(object(value,'恢复预检').expectedRevision);
  try {return getDatabase().transaction(()=>{const plan=prepareRestoreDraft(id,value);return {expectedRevision:expected,releaseId:id,errors:[] as string[],summary:{objectIds:plan.objectIds,fields:plan.fields,totalPages:plan.next.pages.length,totalProducts:plan.next.products.length,totalEntries:plan.next.contentEntries?.length||0},warnings:['仅覆盖选中草稿，当前公开版本/账号/询盘/通知/审计保持不变。',...(plan.clearsPublicUrl?['此历史版本未设置网站规范地址。恢复将清除当前草稿的规范地址，公开版本保持不变。']:[]),...(plan.localeRebased?['当前默认语言与历史不同：已保留历史正文语言，并将选中静态页/已知链接/菜单映射转换到当前语言前缀。需要历史原网址时请明确包含历史语言设置，核对其他译文依赖。']:[])]};})();}
  catch(error){if(error instanceof ApiError&&error.status===422)return {expectedRevision:expected,releaseId:id,errors:[error.message],summary:null,warnings:[]};throw error;}
}
export function restoreDraft(id:string,value:unknown,actor:ActorIdentity,checkAccess?:()=>void) {
  getDatabase().transaction(()=>{
    checkAccess?.();
    const plan=prepareRestoreDraft(id,value);writeDraft(plan.next,plan.expected);
    getDatabase().prepare('INSERT INTO cms_release_event(action,release_id,actor_id,created_at) VALUES(?,?,?,?)').run('restore-draft',id,actor.id,new Date().toISOString());
    recordAudit(actor,'draft.restore','success',{releaseId:id,objectIds:plan.objectIds,revision:plan.expected+1,fields:plan.fields});
  }).immediate();return getStudioEnvelope();
}
