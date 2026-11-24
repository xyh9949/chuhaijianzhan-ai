import protocol from '../lib/protocol.json';
import { recordAudit, type AuditAction } from './audit';
import {localeRecordEvolutionErrors} from '../lib/localization';
import type { ActorIdentity } from './types';
import { getDatabase } from './database';
import { ensureDraft } from './seed';
import { validateModelEvolution } from './model-validation';
import { ApiError } from './http';
import { collectReferences, identifier, object, revision, text, validateDraft } from './validation';
import type { DraftContent, SiteSnapshot } from './types';
import type { Inquiry, Release, StudioState } from '../lib/types';
import { applyInquiryFollowUpPatch, listInquiryAssignees, projectInquiry } from './inquiry-followup';
import type { Actor } from './permissions';

export function getDraftRecord(): { revision: number; content: DraftContent } {
  ensureDraft();
  const row = getDatabase().prepare('SELECT revision, content_json FROM cms_draft WHERE id = 1').get() as { revision: number; content_json: string };
  return { revision: row.revision, content: JSON.parse(row.content_json) };
}
export function getActiveReleaseId(): string | null {
  return (getDatabase().prepare('SELECT active_release_id FROM cms_runtime WHERE id = 1').get() as { active_release_id: string | null }).active_release_id;
}
export function readRelease(id: string): SiteSnapshot {
  const row = getDatabase().prepare('SELECT manifest_json FROM cms_release WHERE id = ?').get(id) as { manifest_json: string } | undefined;
  if (!row) throw new ApiError(404, '找不到这个发布版本');
  return JSON.parse(row.manifest_json);
}
function stableJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new ApiError(422, '数据嵌套过深');
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item, depth + 1)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function comparable(value: Record<string, unknown>, page = false) {
  const copy = { ...value }; delete copy.status;
  if (page) delete copy.updated;
  return stableJson(copy);
}
export function listInquiries() {
  const rows = (getDatabase().prepare('SELECT revision, payload_json FROM cms_inquiry ORDER BY created_at DESC, id DESC').all() as { revision: number; payload_json: string }[])
    .map(row => ({ item: JSON.parse(row.payload_json) as Inquiry, revision: row.revision }));
  const available = new Set(rows.some(({ item }) => item.assignee) ? listInquiryAssignees().map(member => member.id) : []);
  return rows.map(({ item, revision }) => projectInquiry(item, revision, available));
}
export function getStudioEnvelope() {
  const { revision: version, content } = getDraftRecord();
  const activeReleaseId = getActiveReleaseId();
  const active = activeReleaseId ? readRelease(activeReleaseId) : null;
  // 工作台和发布范围仍使用当前公开快照；旧版本只取摘要，打开详情时再读所选快照。
  const releases: Release[] = (getDatabase().prepare('SELECT id, title, created_at, author_name, selection_json FROM cms_release ORDER BY created_at DESC, rowid DESC').all() as { id: string; title: string; created_at: string; author_name: string; selection_json: string }[]).map((row) => {
    const selected = JSON.parse(row.selection_json) as { pageIds?: string[]; productIds?: string[]; sharedBlockIds?: string[]; contentModelIds?: string[]; contentEntryIds?: string[]; includeTheme?: boolean; includeSettings?: boolean; includeLayout?: boolean; includeCode?: boolean; includeForms?: boolean; includeTemplates?: boolean };
    return { id: row.id, title: row.title, date: row.created_at, author: row.author_name, status: row.id === activeReleaseId ? 'current' : 'history',
      changes: [`发布 ${selected.pageIds?.length || 0} 个页面、${selected.productIds?.length || 0} 个产品`, ...(selected.sharedBlockIds?.length ? [`包含 ${selected.sharedBlockIds.length} 个同步区块`] : []), ...(selected.contentModelIds?.length ? [`包含 ${selected.contentModelIds.length} 个内容模型`] : []), ...(selected.contentEntryIds?.length ? [`包含 ${selected.contentEntryIds.length} 条内容`] : []), ...(selected.includeLayout ? ['包含全站页眉页脚'] : []), ...(selected.includeCode ? ['包含全站与页面代码'] : []), ...(selected.includeForms ? ['包含网站表单'] : []), ...(selected.includeTemplates ? ['包含页面模板资源库'] : []), ...(selected.includeTheme ? ['包含全站主题'] : []), ...(selected.includeSettings ? ['包含公开网站设置'] : [])], ...(active && row.id === activeReleaseId ? { snapshot: { ...active } } : {}) };
  });
  // 发布标记由当前线上完整快照计算；客户端不能通过把 status 写成 published 来上线。
  const pages = content.pages.map((page) => {
    const published = active?.pages.find((item) => item.id === page.id);
    const unchanged = published && comparable(page as unknown as Record<string, unknown>, true) === comparable(published as unknown as Record<string, unknown>, true) && stableJson(content.editorData[page.id]) === stableJson(active?.editorData[page.id]);
    return { ...page, status: unchanged ? 'published' as const : 'draft' as const };
  });
  const products = content.products.map((product) => {
    const published = active?.products.find((item) => item.id === product.id);
    // 产品更新时间同页面一样由服务器维护；恢复相同业务内容后，不因时间不同误报待发布。
    return { ...product, status: published && comparable(product as unknown as Record<string, unknown>, true) === comparable(published as unknown as Record<string, unknown>, true) ? 'published' as const : 'draft' as const };
  });
  const contentEntries = content.contentEntries?.map((entry) => {
    const published = active?.contentEntries?.find((item) => item.id === entry.id);
    return { ...entry, status: published && comparable(entry as unknown as Record<string, unknown>, true) === comparable(published as unknown as Record<string, unknown>, true) ? 'published' as const : 'draft' as const };
  });
  const state: StudioState = { ...content, pages, products, ...(contentEntries ? { contentEntries } : {}), inquiries: listInquiries(), releases, activePageId: '' };
  return { state, revision: version, activeReleaseId };
}

export function writeDraft(content: DraftContent, expectedRevision: number) {
  // 仅在真实保存时标记新详情/循环数据版本；启动升级不批量重写已有客户草稿。
  const result = getDatabase().prepare('UPDATE cms_draft SET content_json = ?, schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?')
    .run(JSON.stringify(content), protocol.snapshot, new Date().toISOString(), expectedRevision);
  if (result.changes !== 1) throw new ApiError(409, '内容已被其他窗口修改，请保留当前输入并重新加载最新数据');
}

export function patchStudio(value: unknown, actor?: ActorIdentity, auditAction:AuditAction='draft.update',options:{allowDefaultLocaleMigration?:boolean;checkAccess?:()=>void;removeEmptyCollections?:('forms'|'pageTemplates'|'sharedBlocks')[];removeSiteLayout?:boolean}={}) {
  const input = object(value, '保存请求'); const expected = revision(input.expectedRevision); const patch = object(input.patch, '保存内容');
  const expectedActiveReleaseId = input.expectedActiveReleaseId == null ? input.expectedActiveReleaseId : identifier(input.expectedActiveReleaseId, '当前线上版本');
  const allowed = ['pages', 'products', 'media', 'theme', 'settings', 'editorData', 'sharedBlocks', 'siteLayout', 'customCode', 'contentModels', 'contentEntries', 'taxonomies', 'redirects', 'forms', 'pageTemplates'];
  if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new ApiError(422, '保存请求包含不允许直接修改的字段');
  const db = getDatabase();
  db.transaction(() => {
    // HTTP入口在读取请求体后及真正写事务内复核授权，旧管理员请求不能越过后来的降权/撤会话。
    options.checkAccess?.();
    const current = getDraftRecord();
    if (current.revision !== expected) throw new ApiError(409, '内容已被其他窗口修改，请保留当前输入并重新加载最新数据');
    // 发布和回退独立于草稿修订。按确认时显示的线上版本核对，在同一写事务内拦住过期移除。
    if (expectedActiveReleaseId !== undefined && expectedActiveReleaseId !== getActiveReleaseId()) {
      throw new ApiError(409, '线上版本已变化，请重新加载并核对产品发布状态后再移除。');
    }
    const next = { ...current.content, ...patch } as DraftContent;
    // 仅内部安全撤销可还原原来缺省的空集合；HTTP不接受此选项，非空资料不能被顺带删除。
    for (const field of options.removeEmptyCollections || []) {
      if (!['forms','pageTemplates','sharedBlocks'].includes(field) || !Array.isArray(next[field]) || next[field]!.length) throw new ApiError(409, '集合仍包含内容，不能还原为空缺状态');
      delete next[field];
    }
    // 安全撤销可恢复原来未配置的全站布局；普通HTTP保存没有这个内部开关。
    if (options.removeSiteLayout) {
      if (!Object.hasOwn(patch,'siteLayout') || patch.siteLayout !== undefined) throw new ApiError(409,'全站布局仍包含内容，不能还原为空缺状态');
      delete next.siteLayout;
    }
    if(next.settings&&current.content.settings.language!==next.settings.language&&(current.content.settings.locales||next.settings.locales)&&!options.allowDefaultLocaleMigration)throw new ApiError(422,'修改默认语言会迁移网址，请先在语言管理中检查并明确应用迁移方案');
    if (Array.isArray(next.pages)) next.pages = next.pages.map((page) => {
      if (!page || typeof page !== 'object') return page;
      const previous = current.content.pages.find((item) => item.id === page.id);
      const changed = !previous || comparable(page as unknown as Record<string, unknown>, true) !== comparable(previous as unknown as Record<string, unknown>, true) || stableJson(next.editorData?.[page.id]) !== stableJson(current.content.editorData[page.id]);
      // 更新时间属于服务端事实：只有页面资料或设计真正变化才更新，忽略客户端“刚刚”等显示文案。
      return { ...page, updated: changed ? new Date().toISOString() : previous.updated };
    });
    // 产品更新时间也由服务端判定；旧记录未变化时不凭空补写日期。
    if(Array.isArray(next.products))next.products=next.products.map(p=>{const old=current.content.products.find(x=>x.id===p.id);const copy={...p};if(!old||comparable(p as unknown as Record<string,unknown>,true)!==comparable(old as unknown as Record<string,unknown>,true))copy.updated=new Date().toISOString();else if(old.updated)copy.updated=old.updated;else delete copy.updated;return copy;});
    // 删除页面时同步移除它的设计 JSON；已发布快照独立保留，删除草稿不会直接下线。
    if (Array.isArray(next.pages) && next.editorData && typeof next.editorData === 'object' && !Array.isArray(next.editorData)) next.editorData = Object.fromEntries(Object.entries(next.editorData).filter(([key]) => key === '__themeControls' || next.pages.some((page) => page?.id === key)));
    if (Array.isArray(next.sharedBlocks)) next.sharedBlocks = next.sharedBlocks.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const previous = current.content.sharedBlocks?.find((item) => item.id === block.id);
      const changed = !previous || previous.name !== block.name || stableJson(previous.data) !== stableJson(block.data);
      return { ...block, updated: changed ? new Date().toISOString() : previous.updated };
    });
    // 页面删除清理对应源码；同步区块引用由整体草稿验证，禁止留下悬空引用。
    if (Array.isArray(next.pages) && next.customCode?.pages && typeof next.customCode.pages === 'object') {
      const removedIds = new Set(current.content.pages.filter((page) => !next.pages.some((item) => item?.id === page.id)).map((page) => page.id));
      next.customCode = { ...next.customCode, pages: Object.fromEntries(Object.entries(next.customCode.pages).filter(([id]) => !removedIds.has(id))) };
    }
    // 模型和独立内容的更新时间也由服务器生成，客户端不能伪造变更时间。
    const timestamped = <T extends { id: string; updated: string }>(items: T[] | undefined, previous: T[] | undefined): T[] | undefined => {
      if (!Array.isArray(items)) return items;
      const old = new Map((previous || []).map((item) => [item.id, item]));
      return items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const before = old.get(item.id);
        const changed = !before || comparable(item as unknown as Record<string, unknown>, true) !== comparable(before as unknown as Record<string, unknown>, true);
        return { ...item, updated: changed ? new Date().toISOString() : before.updated };
      });
    };
    if (next.pageTemplates !== undefined) next.pageTemplates = timestamped(next.pageTemplates, current.content.pageTemplates);
    if (next.contentModels !== undefined) next.contentModels = timestamped(next.contentModels, current.content.contentModels);
    if (next.contentEntries !== undefined) next.contentEntries = timestamped(next.contentEntries, current.content.contentEntries);
    const validated = validateDraft(next);
    validateModelEvolution(current.content, validated);
    const languageEvolution=localeRecordEvolutionErrors(current.content,validated);if(languageEvolution.length)throw new ApiError(422,languageEvolution.join('；'));
    for (const media of validated.media) {
      const old = current.content.media.find((item) => item.id === media.id);
      if (!old || old.url !== media.url || old.kind !== media.kind || old.size !== media.size || ['width', 'height', 'bytes', 'pages', 'variants'].some(key => stableJson((old as unknown as Record<string, unknown>)[key]) !== stableJson((media as unknown as Record<string, unknown>)[key]))) throw new ApiError(422, '素材文件必须通过上传接口新增，不能直接修改文件地址、类型、大小或固有尺寸');
    }
    const refs = collectReferences(validated).urls;
    for (const media of current.content.media) if (!validated.media.some((item) => item.id === media.id) && refs.has(media.url)) throw new ApiError(422, `素材“${media.name}”仍被草稿引用，请先替换引用`);
    writeDraft(validated, expected);
    if(actor) { const objectIds=Object.values(patch).flatMap(v=>Array.isArray(v)?v.filter(x=>x&&typeof x.id==='string').map(x=>x.id as string):[]);const before=current.content.customCode,after=validated.customCode;const jsEnabledScopes=[...(after?.global.jsEnabled&&!before?.global.jsEnabled?['global']:[]),...Object.entries(after?.pages||{}).filter(([id,c])=>c.jsEnabled&&!before?.pages[id]?.jsEnabled).map(([id])=>id)];recordAudit(actor,auditAction,'success',{objectIds,fields:Object.keys(patch),revision:expected+1,jsEnabledScopes}); }

  }).immediate();
  return getStudioEnvelope();
}

export function updateInquiry(id: string, value: unknown, actor?: Actor) {
  const input = object(value, '询盘更新'); const expected = revision(input.expectedRevision);
  if (Object.keys(input).some(k => !['expectedRevision', 'status', 'notes', 'assigneeId', 'priority', 'nextFollowUpAt', 'qualification', 'followUpNote'].includes(k))) throw new ApiError(422, '询盘更新字段无效');
  if (input.status !== undefined && (typeof input.status !== 'string' || !['new', 'contacted', 'archived'].includes(input.status))) throw new ApiError(422, '询盘状态不正确');
  return getDatabase().transaction(() => {
    const row = getDatabase().prepare('SELECT revision, payload_json FROM cms_inquiry WHERE id = ?').get(id) as { revision: number; payload_json: string } | undefined;
    if (!row) throw new ApiError(404, '询盘不存在');
    if (row.revision !== expected) throw new ApiError(409, '询盘状态已变更，请刷新后重试');
    const stamp = new Date().toISOString();
    const item = applyInquiryFollowUpPatch({ ...JSON.parse(row.payload_json), ...(input.status !== undefined ? { status: input.status } : {}), ...(input.notes !== undefined ? { notes: text(input.notes, '处理备注', 10000) } : {}) }, input, actor, stamp);
    const result = getDatabase().prepare('UPDATE cms_inquiry SET revision = revision + 1, payload_json = ?, updated_at = ? WHERE id = ? AND revision = ?').run(JSON.stringify(item), stamp, id, expected);
    if (result.changes !== 1) throw new ApiError(409, '询盘状态已变更，请刷新后重试');
    return { item: projectInquiry(item, expected + 1) };
  }).immediate();
}

export function createInquiry(value: unknown) {
  const input = object(value, '询盘');
  const email = text(input.email, '邮箱', 254, true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, '邮箱格式不正确');
  const item: Inquiry = { id: `iq-${crypto.randomUUID()}`, name: text(input.name, '联系人', 150, true), company: text(input.company ?? '', '公司', 200), email,
    country: text(input.country ?? '', '国家或地区', 100), product: text(input.product ?? '', '产品', 200), message: text(input.message, '留言', 10000, true), date: new Date().toISOString(), status: 'new', origin: 'manual' };
  getDatabase().prepare('INSERT INTO cms_inquiry (id, revision, payload_json, created_at, updated_at) VALUES (?, 0, ?, ?, ?)').run(item.id, JSON.stringify(item), item.date, item.date);
  return { item: projectInquiry(item, 0) };
}
