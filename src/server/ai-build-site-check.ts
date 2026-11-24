import type { AiBuildSiteCheckReport } from '../lib/ai-build-site-check-types';
import { getContentEntryPath, getProductPath, getTemplatePreviewPath } from '../lib/content-routes';
import type { QueryParams } from '../lib/content-query';
import { editorNodes } from '../lib/editor-layout';
import { hasInvalidLoopPage } from '../lib/loop-pages';
import { localeOf, siteLocales } from '../lib/localization';
import { resolveSitePage } from '../lib/site-routing';
import { readAiBuildRun, resolveAiSitePreview } from './ai-builder';
import { inspectAiBuildSite, type BuildBrowserTarget } from './ai-build-site-browser';
import { reserveVisualBrowser } from './ai-visual-browser';
import { getDatabase } from './database';
import { ApiError } from './http';
import { requirePermission, type Actor } from './permissions';
import { getDraftSiteSnapshot } from './publication';
import { getDraftRecord } from './studio';
import type { SiteSnapshot } from './types';
import { identifier, object, revision } from './validation';

const segmentsFor = (path: string) => path.split('/').filter(Boolean).map(decodeURIComponent);
const PAGE_LIMIT = 12;

/** 完整语言范围按最终公开路径统计；一个详情模板的一个样本不代表其他记录或译文。 */
function countLanguageCoverage(snapshot: SiteSnapshot, sampled: ReadonlySet<string>) {
  const paths = new Map<string, string>();
  const add = (path: string | undefined, locale: string) => { if (path && !paths.has(path)) paths.set(path, locale); };
  for (const page of snapshot.pages) if (!page.slug.includes(':')) add(page.slug, localeOf(snapshot.settings, page));
  for (const product of snapshot.products) if (product.status === 'published') add(getProductPath(snapshot, product), localeOf(snapshot.settings, product));
  for (const entry of snapshot.contentEntries || []) if (entry.status === 'published') add(getContentEntryPath(snapshot, entry), localeOf(snapshot.settings, entry));
  const counts = new Map(siteLocales(snapshot.settings).map(({ code }) => [code, 0]));
  for (const [path, code] of paths) if (!sampled.has(path)) counts.set(code, (counts.get(code) || 0) + 1);
  return [...counts].map(([code, notSampled]) => ({ code, notSampled }));
}

/** 只从本人冻结候选取路径，包含生成页和由原生解析器确认的详情样本。 */
export function readBuildCheckTarget(id: unknown, actor: Actor) {
  if (typeof id !== 'string' || !/^aiv-[a-f0-9-]{36}$/.test(id)) throw new ApiError(422, '请选择有效的建站预览');
  const run = readAiBuildRun(id, actor);
  if (run.kind !== 'preview' || run.operation) throw new ApiError(422, '请选择首次建站的预览方案');
  const home = run.pages.find(page => page.slug === (run.prefix || '/'));
  if (!home) throw new ApiError(422, '当前候选缺少可检查的首页');
  const first = resolveAiSitePreview(id, segmentsFor(home.slug), actor);
  if (!first) throw new ApiError(422, '当前候选的首页不能打开，请重新生成预览');
  const { snapshot, previewPrefix } = first;
  const pages = snapshot.pages.filter(page => run.pages.some(candidate => candidate.id === page.id));
  const existingProductPage = snapshot.pages.find(page => page.slug === '/products/:slug');
  // 若现有站只收到一个未启用的新详情版式，沿候选链接看到的是仍生效的详情。
  const existingDetailUsed = !!existingProductPage && !pages.includes(existingProductPage) && !!run.inspection?.pages.some(page => page.kind === 'template' && page.path === '/products/:slug');
  if (existingDetailUsed) pages.push(existingProductPage!);
  const targets: BuildBrowserTarget[] = pages.map(page => {
    const dynamic = page.slug.includes(':'), product = page.slug === '/products/:slug';
    const path = dynamic ? getTemplatePreviewPath(snapshot, page) : page.slug;
    const actual = path ? resolveAiSitePreview(id, segmentsFor(path), actor) : null;
    return {
      pageId: page.id,
      title: existingDetailUsed && page === existingProductPage ? `${page.title}（当前可访问样例）` : page.title,
      path: actual?.resolved.page.id === page.id ? path : undefined,
      dynamic,
      ...(page.id === home.id ? { entry: 'home' } : product ? { entry: 'product' } : {}),
      ...(path && !actual ? { skipReason: '该页暂时没有可打开的冻结路径。' } : {}),
    };
  });
  return { run, previewPrefix, targets, existingDetailUsed, snapshot };
}

/** 本次检查和所有页面请求共用同一个草稿版本；任一保存、还原或并发更新都会使旧入口失效。 */
function draftSnapshotAt(expectedRevision: number) {
  return getDatabase().transaction(() => {
    if (getDraftRecord().revision !== expectedRevision) throw new ApiError(409, '草稿已保存更新，请重新检查当前版本');
    return getDraftSiteSnapshot();
  })();
}

export function resolveDraftBuildCheckPreview(value: string, segments: string[], actor: Actor, query: QueryParams = {}) {
  requirePermission(actor, 'manage');
  if (!/^(?:0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
  const snapshot = draftSnapshotAt(Number(value));
  const resolved = resolveSitePage(snapshot, segments);
  if (!resolved || hasInvalidLoopPage(snapshot, resolved, query)) return null;
  // 保留 CSS 检查实际排版；隔离检查无需执行客户脚本。
  if (snapshot.customCode) {
    if (snapshot.customCode.global) snapshot.customCode.global.jsEnabled = false;
    for (const code of Object.values(snapshot.customCode.pages || {})) code.jsEnabled = false;
  }
  return { snapshot, resolved, previewPrefix: `/preview/~draft-check/${value}` };
}

/** 先检查用户所编辑的页面及买家入口。标识从实际模板与同步块原始数据复核，避免猜测目标。 */
export function readDraftCheckTarget(expectedRevision: number, focusedPageId?: string) {
  const snapshot = draftSnapshotAt(expectedRevision), previewPrefix = `/preview/~draft-check/${expectedRevision}`;
  const pages = snapshot.pages;
  const home = pages.find(page => page.slug === '/'), product = pages.find(page => page.slug === '/products/:slug');
  const focused = focusedPageId ? pages.find(page => page.id === focusedPageId) : undefined;
  if (focusedPageId && !focused) throw new ApiError(409, '当前页面已不可用，请重新读取草稿');
  const likelyEntrances = pages.filter(page => ['/products', '/contact', '/collections'].includes(page.slug));
  const ordered = [...new Set([focused, home, product, ...likelyEntrances, ...pages].filter((page): page is (typeof pages)[number] => !!page))];
  const blockNodes = new Map<string, Set<string>>();
  let pathCount = 0;
  const targets: BuildBrowserTarget[] = ordered.map(page => {
    const dynamic = page.slug.includes(':'), destination = dynamic ? getTemplatePreviewPath(snapshot, page) : page.slug;
    const basic: BuildBrowserTarget = { pageId: page.id, title: page.title, dynamic, entry: page === home ? 'home' : page === product ? 'product' : undefined };
    if (!destination) return basic;
    if (pathCount >= PAGE_LIMIT) return { ...basic, skipReason: `本次已达到 ${PAGE_LIMIT} 页上限。可打开这页后重新检查。` };
    let resolved: ReturnType<typeof resolveSitePage> = null;
    try { resolved = resolveSitePage(snapshot, segmentsFor(destination)); }
    catch { return { ...basic, skipReason: '页面布局或样本不可用，请在编辑器核对。' }; }
    if (!resolved || resolved.page.id !== page.id) return { ...basic, skipReason: '页面的当前网址没有匹配到该布局。' };
    pathCount++;
    const nodes = new Set(editorNodes(resolved.data).map(node => node.id)), templateId = resolved.detailTemplateId;
    return {
      ...basic, path: destination,
      editableNode(reference) {
        if (reference.blockId) {
          if (!reference.sourceId) return undefined;
          const block = snapshot.sharedBlocks?.find(item => item.id === reference.blockId);
          if (!block) return undefined;
          let ids = blockNodes.get(block.id);
          if (!ids) { ids = new Set(editorNodes(block.data).map(node => node.id)); blockNodes.set(block.id, ids); }
          if (ids.has(reference.sourceId)) return { kind: 'block', id: block.id, nodeId: reference.sourceId };
          return undefined;
        }
        if (nodes.has(reference.renderedId)) return { kind: templateId ? 'template' : 'page', id: templateId || page.id, nodeId: reference.renderedId };
        return undefined;
      },
    };
  });
  return { previewPrefix, targets, snapshot };
}

/** BYOK截图始终使用整站检查认可的页面与同一冻结样本，客户端只传页面ID。 */
export function resolveBuildVisualPage(id: string, pageId: string | undefined, actor: Actor) {
  const { run, previewPrefix, targets } = readBuildCheckTarget(id, actor);
  const target = targets.find(page => pageId ? page.pageId === pageId : page.entry === 'home');
  if (!target?.path) throw new ApiError(422, '所选建站页面暂时没有可用的预览样本');
  const source = resolveAiSitePreview(id, segmentsFor(target.path), actor);
  if (!source) throw new ApiError(422, '所选建站页面的预览不可用');
  return { source, path: `${previewPrefix}${target.path === '/' ? '' : target.path}`, baseRevision: run.baseRevision, expiresAt: run.expiresAt };
}

/** 两种检查都只读，版本或会话变化时舍弃旧结果。 */
export async function checkAiBuildSite(input: unknown, actor: Actor, cookie: string, signal?: AbortSignal, checkAccess?: () => void): Promise<AiBuildSiteCheckReport> {
  requirePermission(actor, 'manage');
  const value = object(input, '整站检查请求');
  const draft = Object.hasOwn(value, 'draftRevision');
  const keys = draft ? ['draftRevision', 'draftPageId'] : ['previewId'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ApiError(422, '整站检查只接受一个已保存草稿版本或建站预览');
  checkAccess?.();
  const frozen = draft ? undefined : readBuildCheckTarget(value.previewId, actor);
  const baseRevision = frozen?.run.baseRevision ?? revision(value.draftRevision);
  const { previewPrefix, targets, snapshot } = frozen || readDraftCheckTarget(baseRevision, value.draftPageId === undefined ? undefined : identifier(value.draftPageId, '检查页面'));
  const release = reserveVisualBrowser();
  const deadline = AbortSignal.timeout(120_000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const result = await inspectAiBuildSite(targets, previewPrefix, cookie, combined);
    if (combined.aborted) throw new ApiError(499, '整站检查已取消');
    checkAccess?.();
    if (frozen) readBuildCheckTarget(frozen.run.previewId, actor);
    else if (getDraftRecord().revision !== baseRevision) throw new ApiError(409, '草稿已保存更新，请重新检查当前版本');
    return {
      source: frozen ? 'build' : 'draft', ...(frozen ? { previewId: frozen.run.previewId } : {}), checkedAt: new Date().toISOString(), baseRevision,
      ...result, pageLimit: PAGE_LIMIT, languages: countLanguageCoverage(snapshot, new Set(result.pages.flatMap(page => page.path && page.status !== 'skipped' ? [page.path] : []))), coverage: [
        ...result.coverage,
        frozen ? '按冻结预览实际样式检查；若旧候选未包含自定义 CSS，可从原方案重新生成预览。客户脚本和实际提交未检查。' : '检查使用私有草稿预览，保留页面 CSS。客户脚本和实际提交未检查。',
        ...(frozen?.existingDetailUsed ? ['详情抽查的是站点已有入口，未启用的新详情模板可在模板库单独预览。'] : []),
      ],
    };
  } catch (error) {
    if (signal?.aborted) throw new ApiError(499, '整站检查已取消');
    if (deadline.aborted) throw new ApiError(504, '整站检查超时，可以继续人工预览或稍后重试');
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, '无法完成整站检查，请核对服务器浏览器并重试');
  } finally { release(); }
}
