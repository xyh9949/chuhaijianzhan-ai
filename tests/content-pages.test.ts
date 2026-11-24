import protocol from '../src/lib/protocol.json';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getDatabase } from '../src/server/database';
import { ApiError } from '../src/server/http';
import { getDraftRecord, getStudioEnvelope, patchStudio, readRelease } from '../src/server/studio';
import { activateRelease, getActiveSiteSnapshot, previewPublication, publishSite, restoreDraft } from '../src/server/publication';
import { collectReferences } from '../src/server/validation';
import { getContentEntryPath } from '../src/lib/content-routes';
import { getProductPath } from '../src/lib/content-routes';
import { resolveLinkTarget } from '../src/lib/site-links';
import { resolveSitePage } from '../src/lib/site-routing';
import { createContentDesignData } from '../src/lib/content-design-presets';
import type { ContentEntry, ContentModel, PageItem, SharedBlock } from '../src/lib/types';
import type { DraftContent, PublicationSelection, SiteSnapshot } from '../src/server/types';

const actor = { id: 'content-pages-test-admin', name: '内容详情测试管理员' };

test('真实schema5菜单/稳定目标与schema6分类/查询结构均可激活，不依赖新版SEO和重定向字段', () => {
  const base = getDraftRecord().content;
  let active: string | null = null;
  for (const version of [5, 6]) {
    const snapshot: SiteSnapshot = {
      schemaVersion: version,
      pages: [{ id: 'home', title: 'Legacy home', slug: '/', status: 'published', type: '普通页面', updated: '' }, { id: 'detail', title: 'Product', slug: '/products/:slug', status: 'published', type: '动态模板', updated: '' }],
      products: [{ id: 'legacy-product', name: 'Legacy product', slug: 'legacy-slug', sku: 'LEGACY', category: 'Legacy', description: '', material: '', image: '', status: 'published', ...(version === 6 ? { termIds: ['legacy-term'], sortOrder: 0 } : {}) }],
      editorData: { home: pageData(node('ActionButton', 'legacy-target', { text: 'Product', href: '', linkTarget: { kind: 'product', id: 'legacy-product' } }), ...(version === 6 ? [node('ContentLoop', 'legacy-loop', { source: 'product', itemBlockId: 'legacy-card', query: { pageSize: 12, paginate: true, termIds: ['legacy-term'] } })] : [])), detail: pageData(node('ProductDetail', 'legacy-detail')) },
      sharedBlocks: [{ id: 'legacy-card', name: 'Card', updated: '', data: pageData(node('Text', 'legacy-card-copy', { text: 'Legacy' })) as SharedBlock['data'] }],
      siteLayout: { header: { mode: 'default', blockId: '', menuId: 'legacy-menu' }, footer: { mode: 'hidden', blockId: '' }, menus: [{ id: 'legacy-menu', name: 'Menu', items: [{ id: 'legacy-home', label: 'Home', target: { kind: 'page', id: 'home' } }] }] },
      ...(version === 6 ? { taxonomies: [{ id: 'legacy-catalog', name: 'Catalog', source: 'product' as const, terms: [{ id: 'legacy-term', label: 'Term', slug: 'term' }] }] } : {}),
      media: [], theme: base.theme, settings: { name: 'Legacy', description: '', email: 'legacy@example.com', language: 'en' },
    };
    const id = `legacy-actual-${version}`;
    getDatabase().prepare('INSERT INTO cms_release (id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, id, JSON.stringify(snapshot), 'fixture', version, version, actor.id, actor.name, new Date().toISOString(), '{}');
    activateRelease(id, { expectedActiveReleaseId: active }, actor); active = id;
    assert.equal(getActiveSiteSnapshot()?.schemaVersion, version);
    assert.equal(resolveLinkTarget(getActiveSiteSnapshot()!, { kind: 'product', id: 'legacy-product' }), '/products/legacy-slug');
    assert.equal(getActiveSiteSnapshot()?.redirects, undefined);
  }
});

test('独立内容同样支持分类和手动顺序，记录白名单与分类验证一致', () => {
  setup();
  const current = getDraftRecord().content;
  save({ taxonomies: [{ id: 'entry-tax', name: 'Case tags', source: 'entry', modelId: model.id, terms: [{ id: 'entry-term', label: 'Case', slug: 'case' }] }], contentEntries: current.contentEntries!.map(item => ({ ...item, termIds: ['entry-term'], sortOrder: 7 })) });
  const published = publishSite(selection({ includeCatalog: true }), actor);
  assert.deepEqual(readRelease(published.releaseId).contentEntries?.[0].termIds, ['entry-term']);
  assert.equal(readRelease(published.releaseId).contentEntries?.[0].sortOrder, 7);
});

test('分类定义与产品分开发布，缺分类依赖拒绝发布，查询引用参与删除保护和恢复', () => {
  const draft = getDraftRecord().content, product = draft.products[0];
  const taxonomy = { id: 'catalog', name: 'Catalog', source: 'product' as const, terms: [{ id: 'selected-term', label: 'Selected', slug: 'selected' }] };
  save({ taxonomies: [taxonomy], products: draft.products.map(item => item.id === product.id ? { ...item, termIds: ['selected-term'] } : item) });
  const select = (includeCatalog: boolean) => ({ expectedRevision: getDraftRecord().revision, baseReleaseId: getActiveSiteSnapshot()?.releaseId || null, pageIds: draft.pages.map(page => page.id), productIds: [product.id], includeTheme: true, includeSettings: true, includeCatalog });
  assert.match(previewPublication(select(false)).errors.join(), /分类/);
  const first = publishSite(select(true), actor);
  assert.equal(readRelease(first.releaseId).taxonomies?.[0].id, taxonomy.id);
  reject(() => save({ taxonomies: [] }), /分类/);
  save({ taxonomies: [{ ...taxonomy, name: 'Draft catalog' }] });
  const second = publishSite({ ...select(false), productIds: [] }, actor);
  assert.equal(readRelease(second.releaseId).taxonomies?.[0].name, 'Catalog');
  restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: [], includeCatalog: true }, actor);
  assert.equal(getDraftRecord().content.taxonomies?.[0].name, 'Catalog');
  save({ sharedBlocks: [{ id: 'query-validation-card', name: 'Card', updated: '', data: pageData() as SharedBlock['data'] }] });
  const current = getDraftRecord().content;
  reject(() => save({ editorData: { ...current.editorData, home: pageData(node('ContentLoop', 'bad-query', { source: 'product', itemBlockId: 'query-validation-card', query: { sort: 'field:missing' } })) } }), /查询|排序/);
});

test('菜单与头尾显式发布，未选菜单不泄漏，回滚与布局恢复保留历史菜单', () => {
  const draft = getDraftRecord().content;
  const target = draft.pages.find(page => page.slug === '/about')!;
  const layout = { header: { mode: 'default' as const, blockId: '', menuId: 'main' }, footer: { mode: 'default' as const, blockId: '' }, menus: [{ id: 'main', name: 'Main', items: [{ id: 'about-link', label: 'About', target: { kind: 'page' as const, id: target.id } }] }] };
  save({ siteLayout: layout, editorData: { ...draft.editorData, home: pageData(node('Navigation', 'menu-nav', { menuId: 'main' })) } });
  const choose = (includeLayout: boolean) => ({ expectedRevision: getDraftRecord().revision, baseReleaseId: getActiveSiteSnapshot()?.releaseId || null, pageIds: ['home', target.id], productIds: [], includeTheme: true, includeSettings: true, includeLayout });
  assert.match(previewPublication(choose(false)).errors.join(), /菜单/);
  const first = publishSite(choose(true), actor);
  save({ siteLayout: { ...layout, menus: [{ ...layout.menus[0], name: 'Draft only' }] } });
  const unselected = publishSite(choose(false), actor);
  assert.equal(readRelease(unselected.releaseId).siteLayout?.menus?.[0].name, 'Main');
  const second = publishSite(choose(true), actor);
  assert.equal(readRelease(second.releaseId).siteLayout?.menus?.[0].name, 'Draft only');
  activateRelease(first.releaseId, { expectedActiveReleaseId: second.releaseId }, actor);
  assert.equal(getActiveSiteSnapshot()?.siteLayout?.menus?.[0].name, 'Main');
  restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: [], includeLayout: true }, actor);
  assert.equal(getDraftRecord().content.siteLayout?.menus?.[0].name, 'Main');
  reject(() => save({ pages: getDraftRecord().content.pages.filter(page => page.id !== target.id) }), /菜单/);
});

test('内部目标随页面路径更新，发布保留未选草稿，回滚和恢复保持原产品网址', () => {
  const draft = getDraftRecord().content;
  const targetPage = draft.pages.find(page => !page.slug.includes(':') && page.id !== 'home')!;
  const product = draft.products[0];
  const template = draft.pages.find(page => page.slug === '/products/:slug')!;
  save({ editorData: { ...draft.editorData, home: pageData(node('ActionButton', 'stable-link', { text: 'Read', href: '', linkTarget: { kind: 'product', id: product.id } })) } });
  const publish = (extra: Partial<PublicationSelection> = {}) => publishSite({ expectedRevision: getDraftRecord().revision, baseReleaseId: getActiveSiteSnapshot()?.releaseId || null, pageIds: ['home', targetPage.id, template.id], productIds: [product.id], includeTheme: true, includeSettings: true, ...extra }, actor);
  const first = publish(), original = readRelease(first.releaseId);
  assert.equal(resolveLinkTarget(original, { kind: 'product', id: product.id }), `/products/${product.id}`);
  const current = getDraftRecord().content;
  save({ products: current.products.map(item => item.id === product.id ? { ...item, slug: 'new-product' } : item), pages: current.pages.map(page => page.id === targetPage.id ? { ...page, title: '新标题', slug: '/renamed-page' } : page) });
  assert.equal(resolveLinkTarget(getDraftRecord().content, { kind: 'page', id: targetPage.id }), '/renamed-page');
  const unchanged = publish({ pageIds: [], productIds: [] , includeTheme: true });
  assert.equal(resolveLinkTarget(readRelease(unchanged.releaseId), { kind: 'product', id: product.id }), `/products/${product.id}`);
  const second = publish({ pageIds: [], productIds: [product.id] }), snapshot = readRelease(second.releaseId);
  assert.equal(getProductPath(snapshot, snapshot.products[0]), '/products/new-product');
  assert.equal(resolveSitePage(snapshot, ['products', 'new-product'])?.product?.id, product.id);
  assert.equal(resolveSitePage(snapshot, ['products', product.id]), null);
  assert.equal(resolveSitePage(original, ['products', product.id])?.product?.id, product.id);
  activateRelease(first.releaseId, { expectedActiveReleaseId: second.releaseId }, actor);
  assert.equal(resolveLinkTarget(getActiveSiteSnapshot()!, { kind: 'product', id: product.id }), `/products/${product.id}`);
  restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: [], productIds: [product.id] }, actor);
  assert.equal(getDraftRecord().content.products.find(item => item.id === product.id)?.slug, undefined);
});

test('内部链接拒绝删目标、缺失模板和歧义绑定，产品短路径拒绝冲突及不合法输入', () => {
  const draft = getDraftRecord().content, product = draft.products[0];
  const button = (linkTarget: unknown, extra = {}) => ({ ...draft.editorData, home: pageData(node('ActionButton', 'target', { text: 'Read', href: '', linkTarget, ...extra })) });
  reject(() => save({ editorData: button({ kind: 'page', id: 'missing' }) }), /内部链接/);
  reject(() => save({ editorData: button({ kind: 'page', id: 'home', url: 'javascript:alert(1)' }) }), /内部链接/);
  reject(() => save({ editorData: button({ kind: 'page', id: 'home' }, { bindings: { href: { source: 'product', mode: 'current', field: 'builtin:url' } } }) }), /同时使用/);
  for (const slug of ['../x', 'UPPER', 'x/y', 'a'.repeat(101), 12]) reject(() => save({ products: draft.products.map(item => item.id === product.id ? { ...item, slug } : item) as DraftContent['products'] }), /短路径/);
  reject(() => save({ products: draft.products.map(item => ({ ...item, slug: 'same' })) }), /重复/);
  save({ editorData: button({ kind: 'product', id: product.id }) });
  reject(() => save({ products: draft.products.filter(item => item.id !== product.id) }), /内部链接/);
  const latest = getDraftRecord().content;
  reject(() => save({ pages: latest.pages.filter(page => page.slug !== '/products/:slug') }), /内部链接/);
});

test('链接解析拒绝未知类型与原型属性，旧schema4保持原href且可激活', () => {
  const draft = getDraftRecord().content;
  assert.equal(resolveLinkTarget(draft, { kind: '__proto__', id: 'home' }), undefined);
  assert.equal(resolveLinkTarget(draft, { kind: 'page', id: '../home' }), undefined);
  const snapshot: SiteSnapshot = { ...draft, schemaVersion: 4, settings: { name: 'Legacy', description: '', email: 'a@example.com', language: 'en' } };
  const id = 'legacy-real-schema4';
  getDatabase().prepare('INSERT INTO cms_release (id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES (?,?,?,?,4,4,?,?,?,?)').run(id, 'Legacy 4', JSON.stringify(snapshot), 'fixture', actor.id, actor.name, new Date().toISOString(), '{}');
  activateRelease(id, { expectedActiveReleaseId: null }, actor);
  assert.equal(getActiveSiteSnapshot()?.schemaVersion, 4);
  assert.deepEqual(getActiveSiteSnapshot()?.editorData, draft.editorData);
});
let directory = ''; let previousDirectory: string | undefined;
beforeEach(() => { previousDirectory = process.env.FORM_STUDIO_DATA_DIR; directory = mkdtempSync(join(tmpdir(), 'form-studio-content-pages-test-')); process.env.FORM_STUDIO_DATA_DIR = directory; });
afterEach(() => {
  getDatabase().close();
  // 清理范围锁定为本用例临时数据库，不能触碰当前客户实例。
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-content-pages-test-`)) rmSync(directory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.FORM_STUDIO_DATA_DIR; else process.env.FORM_STUDIO_DATA_DIR = previousDirectory;
});
const save = (patch: Partial<DraftContent>) => patchStudio({ expectedRevision: getDraftRecord().revision, patch });
const pageData = (...content: unknown[]) => ({ root: { props: { title: '内容详情验收' } }, content });
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const model: ContentModel = { id: 'case-model', name: '项目案例', target: 'content', fields: [], description: '', updated: '' };
const template: PageItem = { id: 'case-detail', title: '案例详情', slug: '/projects/cases/:slug', contentModelId: model.id, status: 'draft', type: '动态模板', updated: '' };
const entry = (id: string, slug?: string): ContentEntry => ({ id, modelId: model.id, title: id, customFields: {}, updated: '', status: 'draft', ...(slug !== undefined ? { slug } : {}) });
const bound = (field: string) => ({ source: 'entry', mode: 'current', modelId: model.id, field, fallback: '' });
const card: SharedBlock = { id: 'case-card', name: '案例循环卡片', updated: '', data: pageData(node('Heading', 'card-title', { text: '', bindings: { text: bound('builtin:title') } }), node('ActionButton', 'card-link', { text: 'Read more', href: '/', bindings: { href: bound('builtin:url') } })) as SharedBlock['data'] };
const loop = (props: Record<string, unknown> = {}) => node('ContentLoop', 'case-loop', { source: 'entry', modelId: model.id, itemBlockId: card.id, count: 6, columns: 3, mobileColumns: 1, gap: 20, padding: 32, title: '案例', emptyText: '', ...props });
function setup(options: { withLoop?: boolean; records?: ContentEntry[] } = {}) {
  const draft = getDraftRecord().content;
  save({ contentModels: [model], contentEntries: options.records || [entry('case-a', 'coastal'), entry('case-b')], pages: [...draft.pages, template], sharedBlocks: options.withLoop ? [card] : [], editorData: { ...draft.editorData, [template.id]: pageData(node('Heading', 'case-title', { text: '', bindings: { text: bound('builtin:title') } })), ...(options.withLoop ? { home: pageData(loop()) } : {}) } });
}
function selection(extra: Partial<PublicationSelection> = {}): PublicationSelection {
  const state = getStudioEnvelope();
  return { expectedRevision: state.revision, baseReleaseId: state.activeReleaseId, pageIds: ['home', template.id], productIds: [], contentModelIds: [model.id], contentEntryIds: ['case-a', 'case-b'], includeTheme: true, includeSettings: true, ...extra };
}
function reject(action: () => unknown, pattern?: RegExp) { assert.throws(action, error => error instanceof ApiError && error.status === 422 && (!pattern || pattern.test(error.message))); }

test('独立内容详情使用模型模板与同快照记录，保留自定义地址、ID后备和SEO', () => {
  setup({ records: [{ ...entry('case-a', 'coastal'), seoTitle: 'Coastal project', seoDescription: 'Project overview' }, entry('case-b')] });
  const result = publishSite(selection(), actor), snapshot = readRelease(result.releaseId);
  assert.equal(snapshot.schemaVersion, protocol.snapshot);
  assert.deepEqual(getDatabase().prepare('SELECT schema_version, renderer_version FROM cms_release WHERE id = ?').get(result.releaseId), { schema_version: protocol.snapshot, renderer_version: protocol.renderer });
  assert.equal(getContentEntryPath(snapshot, snapshot.contentEntries![0]), '/projects/cases/coastal');
  assert.equal(getContentEntryPath(snapshot, snapshot.contentEntries![1]), '/projects/cases/case-b');
  assert.equal(snapshot.contentEntries![0].seoTitle, 'Coastal project');
  const draft = getDraftRecord().content;
  save({ contentEntries: draft.contentEntries!.map(item => item.id === 'case-a' ? { ...item, slug: 'unpublished', seoTitle: '未发布标题' } : item) });
  assert.equal(getContentEntryPath(getActiveSiteSnapshot()!, getActiveSiteSnapshot()!.contentEntries![0]), '/projects/cases/coastal');
  assert.equal(readRelease(result.releaseId).contentEntries![0].seoTitle, 'Coastal project');
});

test('记录地址仅接受安全单段，SEO长度和错误字段类型在草稿保存时拒绝', () => {
  setup(); const initial = getDraftRecord();
  for (const slug of ['/other', 'nested/path', '%2e%2e', '../', 'UpperCase', 'a?b', 'a#b', 'a\\b', 'x'.repeat(101), 0, false, null]) reject(() => save({ contentEntries: [{ ...entry('case-a'), slug } as ContentEntry] }));
  reject(() => save({ contentEntries: [{ ...entry('case-a'), seoTitle: 'x'.repeat(201) }] }));
  reject(() => save({ contentEntries: [{ ...entry('case-a'), seoDescription: 'x'.repeat(1001) }] }));
  assert.deepEqual(getDraftRecord(), initial);
  save({ contentEntries: [entry('case-a', '')] });
  assert.equal(getContentEntryPath(getDraftRecord().content, getDraftRecord().content.contentEntries![0]), '/projects/cases/case-a');
});

test('详情模板与内容模型一一绑定，不允许缺失、产品模型、系统路径或多模板', () => {
  setup(); const draft = getDraftRecord().content;
  const replace = (page: PageItem) => save({ pages: draft.pages.map(item => item.id === template.id ? page : item) });
  reject(() => replace({ ...template, contentModelId: 'missing-model' }));
  reject(() => save({ contentModels: [{ ...model, target: 'product' }] }));
  reject(() => replace({ ...template, slug: '/products/:slug' }));
  for (const slug of ['/api/cases/:slug', '/admin/:slug', '/preview/:slug', '/images/:slug', '/fonts/:slug', '/_next/:slug']) reject(() => replace({ ...template, slug }));
  reject(() => replace({ ...template, slug: '/ordinary' }));
  reject(() => save({ pages: [...draft.pages, { ...template, id: 'second-template', slug: '/other-cases/:slug' }], editorData: { ...draft.editorData, 'second-template': pageData() } }));
});

test('有效slug需在模型内唯一，且实际生成地址不能被静态页面占用', () => {
  setup(); const draft = getDraftRecord().content;
  reject(() => save({ contentEntries: [entry('case-a', 'duplicate'), entry('case-b', 'duplicate')] }));
  reject(() => save({ contentEntries: [entry('case-a', 'case-b'), entry('case-b')] }));
  reject(() => save({ pages: [...draft.pages, { id: 'static-collision', title: '冲突静态页', slug: '/projects/cases/coastal', type: '普通页面', status: 'draft', updated: '' }], editorData: { ...draft.editorData, 'static-collision': pageData() } }));
  const second: ContentModel = { ...model, id: 'team-model', name: '团队' };
  save({ contentModels: [model, second], contentEntries: [...draft.contentEntries!, { ...entry('team-a', 'coastal'), modelId: second.id }] });
  assert.equal(getContentEntryPath(getDraftRecord().content, getDraftRecord().content.contentEntries!.at(-1)!), undefined);
});

test('部分发布按最终公开记录检查地址冲突，兼容的两条记录必须一起发布', () => {
  setup({ records: [entry('case-a', 'coastal')] });
  const first = publishSite(selection({ contentEntryIds: ['case-a'] }), actor);
  save({ contentEntries: [entry('case-a', 'new-coastal'), entry('case-b', 'coastal')] });
  const partial = selection({ pageIds: [], contentModelIds: [], contentEntryIds: ['case-b'], includeTheme: false, includeSettings: false });
  assert.ok(previewPublication(partial).errors.length);
  reject(() => publishSite(partial, actor));
  assert.equal(getStudioEnvelope().activeReleaseId, first.releaseId);
  publishSite({ ...partial, contentEntryIds: ['case-a', 'case-b'] }, actor);
  assert.deepEqual(getActiveSiteSnapshot()!.contentEntries!.map(item => item.slug), ['new-coastal', 'coastal']);
  assert.equal(readRelease(first.releaseId).contentEntries![0].slug, 'coastal');
});

test('循环卡片、模型、详情链接的模板依赖均需显式加入发布', () => {
  setup({ withLoop: true });
  assert.ok(previewPublication(selection()).errors.some(message => message.includes(card.id)));
  assert.ok(previewPublication(selection({ sharedBlockIds: [card.id], pageIds: ['home'] })).errors.length);
  const first = publishSite(selection({ sharedBlockIds: [card.id] }), actor);
  const snapshot = readRelease(first.releaseId);
  assert.equal(snapshot.sharedBlocks![0].id, card.id);
  reject(() => save({ sharedBlocks: [] }));
  const references = collectReferences(getDraftRecord().content);
  assert.ok(references.modelIds.has(model.id));
  assert.ok(previewPublication(selection({ pageIds: [], contentModelIds: [], contentEntryIds: [], sharedBlockIds: [], removePageIds: [template.id], includeTheme: false, includeSettings: false })).errors.length);
});

test('真实界面预设的空静态链接可由有效动态详情绑定接管，仍检查模板依赖', () => {
  setup({ withLoop: true }); const draft = getDraftRecord().content;
  const presetCard = { ...card, data: createContentDesignData({ name: '案例自由卡片', source: 'entry', model, kind: 'card' }) };
  const presetDetail = createContentDesignData({ name: '案例详情模板', source: 'entry', model, kind: 'detail', recordId: 'case-a' });
  // 使用实际 UI 工厂，避免测试手写的非空 href 掩盖动态按钮的发布契约。
  const button = presetCard.data.content[0].props.content.find((item: { type: string }) => item.type === 'ActionButton');
  assert.equal(button.props.href, '');
  save({ sharedBlocks: [presetCard], editorData: { ...draft.editorData, [template.id]: presetDetail } });
  const request = selection({ sharedBlockIds: [card.id] });
  assert.deepEqual(previewPublication(request).errors, []);
  assert.ok(previewPublication({ ...request, pageIds: ['home'] }).errors.some(message => message.includes('详情模板')));
  const result = publishSite(request, actor);
  assert.deepEqual(readRelease(result.releaseId).sharedBlocks![0].data, presetCard.data);
});

test('空链接不能借缺失或残缺绑定通过发布，动态绑定也不能掩盖恶意静态链接', () => {
  setup({ withLoop: true });
  const preset = createContentDesignData({ name: '动态链接边界', source: 'entry', model, kind: 'card' });
  const buttonOf = (data: typeof preset) => data.content[0].props.content.find((item: { type: string }) => item.type === 'ActionButton');
  for (const binding of [undefined, { ...bound('builtin:url'), field: '' }]) {
    const data = structuredClone(preset), button = buttonOf(data);
    if (binding) button.props.bindings.href = binding; else delete button.props.bindings;
    save({ sharedBlocks: [{ ...card, data }] });
    const request = selection({ sharedBlockIds: [card.id] });
    assert.ok(previewPublication(request).errors.length);
    reject(() => publishSite(request, actor));
  }
  for (const href of ['javascript:alert(1)', '//evil.example', 'data:text/html,test']) {
    const data = structuredClone(preset); buttonOf(data).props.href = href;
    reject(() => save({ sharedBlocks: [{ ...card, data }] }), /链接/);
  }
});

test('仅发布详情模板前缀时提示未选列表页影响，线上记录和卡片链接使用新路径', () => {
  setup({ withLoop: true }); const first = publishSite(selection({ sharedBlockIds: [card.id] }), actor);
  const draft = getDraftRecord().content;
  save({ pages: draft.pages.map(page => page.id === template.id ? { ...page, slug: '/portfolio/:slug' } : page) });
  const partial = selection({ pageIds: [template.id], contentModelIds: [], contentEntryIds: [], sharedBlockIds: [], includeTheme: false, includeSettings: false });
  const preview = previewPublication(partial);
  assert.deepEqual(preview.errors, []);
  assert.ok(preview.summary.affectedPages.some(page => page.id === 'home'));
  assert.ok(preview.warnings.some(message => message.includes('可能影响')));
  publishSite(partial, actor);
  const live = getActiveSiteSnapshot()!;
  assert.equal(getContentEntryPath(live, live.contentEntries![0]), '/portfolio/coastal');
  assert.deepEqual(live.editorData.home, readRelease(first.releaseId).editorData.home);
  assert.deepEqual(live.sharedBlocks, readRelease(first.releaseId).sharedBlocks);
});

test('详情模板重新关联、取消关联和下线均按新旧模板提示间接影响', () => {
  setup(); const draft = getDraftRecord().content, second = { ...model, id: 'team-model', name: '团队' };
  save({ contentModels: [model, second], editorData: { ...draft.editorData, [template.id]: pageData() } });
  publishSite(selection({ contentModelIds: [model.id, second.id] }), actor);
  save({ pages: draft.pages.map(page => page.id === template.id ? { ...page, contentModelId: second.id } : page) });
  const partial = () => selection({ pageIds: [template.id], contentModelIds: [], contentEntryIds: [], includeTheme: false, includeSettings: false });
  const reassociated = previewPublication(partial());
  assert.deepEqual(reassociated.errors, []);
  assert.ok(reassociated.summary.affectedPages.some(page => page.id === 'home'));
  publishSite(partial(), actor);
  save({ pages: draft.pages.map(page => page.id === template.id ? { ...page, contentModelId: '', slug: '/showcase' } : page) });
  for (const request of [partial(), { ...partial(), pageIds: [], removePageIds: [template.id] }]) {
    const preview = previewPublication(request);
    assert.deepEqual(preview.errors, []);
    assert.ok(preview.summary.affectedPages.some(page => page.id === 'home'));
  }
});

test('详情模板编辑样本不成为发布依赖，普通页面上下文与显式固定绑定仍需所选记录', () => {
  setup(); const draft = getDraftRecord().content;
  const templateData = { ...pageData(node('Heading', 'template-title', { text: '', bindings: { text: bound('builtin:title') } })), root: { props: { title: '编辑样本', bindingContext: { source: 'entry', modelId: model.id, recordId: 'case-a' } } } };
  save({ editorData: { ...draft.editorData, [template.id]: templateData } });
  const partial = selection({ contentEntryIds: ['case-b'] });
  assert.deepEqual(previewPublication(partial).errors, []);
  const first = publishSite(partial, actor);
  const snapshot = readRelease(first.releaseId);
  assert.deepEqual(snapshot.contentEntries!.map(item => item.id), ['case-b']);
  assert.equal(getContentEntryPath(snapshot, snapshot.contentEntries![0]), '/projects/cases/case-b');

  const current = getDraftRecord().content;
  save({ editorData: { ...current.editorData, home: templateData } });
  assert.ok(previewPublication(selection({ contentEntryIds: ['case-b'] })).errors.some(message => message.includes('case-a')));
  save({ editorData: { ...current.editorData, [template.id]: pageData(node('Heading', 'fixed-title', { text: '', bindings: { text: { ...bound('builtin:title'), mode: 'fixed', recordId: 'case-a' } } })) } });
  assert.ok(previewPublication(selection({ contentEntryIds: ['case-b'] })).errors.some(message => message.includes('case-a')));
});

test('循环卡片及模板在部分发布、回滚和选择恢复中保持各自版本', () => {
  setup({ withLoop: true }); const first = publishSite(selection({ sharedBlockIds: [card.id] }), actor);
  const draft = getDraftRecord().content;
  save({ sharedBlocks: [{ ...card, name: '未发布卡片标题' }], contentEntries: draft.contentEntries!.map(item => item.id === 'case-a' ? { ...item, slug: 'changed' } : item) });
  const second = publishSite(selection({ pageIds: [], contentModelIds: [], contentEntryIds: ['case-a'], includeTheme: false, includeSettings: false }), actor);
  assert.equal(getActiveSiteSnapshot()!.sharedBlocks![0].name, card.name);
  assert.equal(getContentEntryPath(getActiveSiteSnapshot()!, getActiveSiteSnapshot()!.contentEntries![0]), '/projects/cases/changed');
  const before = getDraftRecord();
  activateRelease(first.releaseId, { expectedActiveReleaseId: second.releaseId }, actor);
  assert.deepEqual(getDraftRecord(), before);
  restoreDraft(first.releaseId, { expectedRevision: before.revision, pageIds: [template.id], sharedBlockIds: [card.id], contentEntryIds: ['case-a'] }, actor);
  assert.equal(getDraftRecord().content.sharedBlocks![0].name, card.name);
  assert.equal(getDraftRecord().content.contentEntries![0].slug, 'coastal');
  assert.equal(getStudioEnvelope().activeReleaseId, first.releaseId);
});

test('循环卡片禁止直接和间接再循环，数量范围和展开预算不能绕过', () => {
  setup({ withLoop: true }); const draft = getDraftRecord().content;
  reject(() => save({ sharedBlocks: [{ ...card, data: pageData(loop({ itemBlockId: 'inner-card' })) as SharedBlock['data'] }, { id: 'inner-card', name: '内层卡片', data: pageData(node('Text', 'inner-text', { text: 'Nested' })) as SharedBlock['data'], updated: '' }] }));
  reject(() => save({ sharedBlocks: [{ ...card, data: pageData(node('SharedBlock', 'indirect', { blockId: 'inner-card' })) as SharedBlock['data'] }, { id: 'inner-card', name: '内层卡片', data: pageData(loop({ itemBlockId: 'other-card' })) as SharedBlock['data'], updated: '' }, { id: 'other-card', name: '更深卡片', data: pageData() as SharedBlock['data'], updated: '' }] }));
  for (const count of [0, 51, 1.5]) reject(() => save({ editorData: { ...draft.editorData, home: pageData(loop({ count })) } }));
  const huge = { ...card, data: pageData(...Array.from({ length: 250 }, (_, i) => node('Text', `item-${i}`, { text: 'Large' }))) as SharedBlock['data'] };
  reject(() => save({ sharedBlocks: [huge], editorData: { ...draft.editorData, home: pageData(loop({ count: 50 })) } }), /10000/);
});

test('真实旧schema3模型记录快照可激活与恢复，不要求补详情模板或slug', () => {
  const draft = getDraftRecord().content;
  save({ contentModels: [model], contentEntries: [entry('case-a')], editorData: { ...draft.editorData, home: pageData(node('ContentList', 'old-list', { source: 'entry', modelId: model.id, count: 6, columns: 3, mobileColumns: 1, titleField: 'builtin:title', descriptionField: '', imageField: '', linkField: '', padding: 32, emptyText: '' })) } });
  const first = publishSite(selection({ pageIds: ['home'], contentEntryIds: ['case-a'] }), actor);
  const legacy: SiteSnapshot = { ...readRelease(first.releaseId), schemaVersion: 3, releaseId: 'legacy-content-v3' };
  getDatabase().prepare('INSERT INTO cms_release (id, title, manifest_json, manifest_hash, schema_version, renderer_version, created_by, author_name, created_at, selection_json) VALUES (?, ?, ?, ?, 3, 3, ?, ?, ?, ?)').run(legacy.releaseId, '旧内容模型版本', JSON.stringify(legacy), 'legacy-content-v3-hash', actor.id, actor.name, new Date().toISOString(), JSON.stringify({ pageIds: ['home'], contentModelIds: [model.id], contentEntryIds: ['case-a'] }));
  activateRelease(legacy.releaseId!, { expectedActiveReleaseId: first.releaseId }, actor);
  assert.equal(getActiveSiteSnapshot()!.schemaVersion, 3);
  assert.equal(getContentEntryPath(getActiveSiteSnapshot()!, legacy.contentEntries![0]), undefined);
  restoreDraft(legacy.releaseId!, { expectedRevision: getDraftRecord().revision, pageIds: ['home'], contentModelIds: [model.id], contentEntryIds: ['case-a'] }, actor);
  assert.equal(getDraftRecord().content.contentEntries![0].slug, undefined);
});
