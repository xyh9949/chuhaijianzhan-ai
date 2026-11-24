import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Data } from '@puckeditor/core';
import type { Actor } from '../src/server/permissions';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio, createInquiry } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { saveAiProvider } from '../src/server/ai-provider';
import { ApiError } from '../src/server/http';
import { generateAiSiteDesign, readAiSiteDesign, listAiSiteDesigns, deleteAiSiteDesign, applyAiSiteDesign, undoAiSiteDesign, resolveAiSiteDesignPreview, sameNonNavigationLayout } from '../src/server/ai-site-design';

const admin: Actor = { id: 'site-admin', name: '整站管理员', email: 'site@example.invalid', role: 'admin' };
const other: Actor = { id: 'other-admin', name: '其他管理员', email: 'other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'site-editor', name: '编辑员', email: 'editor@example.invalid', role: 'editor' };
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
const request = (extra: Record<string, unknown> = {}) => ({ expectedRevision: getDraftRecord().revision, instruction: '让整站面向工程采购更专业，统一页眉、导航、页脚和文字层级。', targets: { pageIds: ['home', 'contact'], header: true, footer: true, navigation: true, style: true }, preserveText: false, ...extra });
const themeResult = (primary = '#224466') => ({ summary: '统一全站品牌色，保留页面手工覆盖。', intent: { goal: '面向工程采购更专业', decisions: ['统一品牌主色'], preserve: ['企业真实资料'], assumptions: [] }, operations: [{ kind: 'theme', theme: { primary } }], warnings: [] });
const fullResult = () => ({ ...themeResult(), operations: [
  { kind: 'chrome', slot: 'header', operations: [{ kind: 'design', id: 'site-header-frame', design: { desktop: { paddingTop: 28, paddingBottom: 28 } } }] },
  { kind: 'chrome', slot: 'footer', operations: [{ kind: 'design', id: 'site-footer-frame', design: { desktop: { paddingTop: 64, paddingBottom: 64 } } }] },
  { kind: 'navigation', slot: 'header', items: [{ label: 'Home', pageId: 'home' }, { label: 'Contact us', pageId: 'contact' }] },
  { kind: 'theme', theme: { primary: '#224466' } },
  { kind: 'page', pageId: 'contact', operations: [{ kind: 'text', id: 'contact-copy', text: 'Tell us about your project.' }] },
] });
let directory = '', previous: NodeJS.ProcessEnv, server: Server | undefined;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-ai-site-design-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'site-design-unit-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3296';
  getDraftRecord(); const content = createEmptyDraft();
  content.settings.name = 'Synthetic manufacturer'; content.settings.description = 'User supplied company information.'; content.settings.email = 'factory@example.invalid';
  content.pages.push({ ...content.pages[0], id: 'contact', title: 'Contact', slug: '/contact' });
  content.editorData = Object.fromEntries(content.pages.map(page => [page.id, { root: { props: { title: page.title, brand: '', showChrome: 'yes' } }, zones: {}, content: [{ type: 'Heading', props: { id: `${page.id}-title`, text: page.title, level: 'h1' } }, { type: 'Text', props: { id: `${page.id}-copy`, text: page.id === 'contact' ? 'CONTACT_PRIVATE_SCOPE_TEXT' : 'Home information' } }] }]));
  content.products = [{ id: 'private-product', name: 'PRIVATE_PRODUCT_LIBRARY_NOT_SENT', sku: 'PRIVATE-SKU', category: 'Private', description: 'Private description', material: 'Known material', image: '', status: 'draft' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(content));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(async () => {
  if (server) { const active = server; server = undefined; active.closeAllConnections(); await new Promise<void>(done => active.close(() => done())); }
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-ai-site-design-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function mock(handler: (body: Record<string, unknown>, count: number) => unknown = () => themeResult()) {
  const requests: Record<string, unknown>[] = [];
  server = createServer((incoming, response) => { let raw = ''; incoming.on('data', chunk => raw += chunk); incoming.on('end', () => { const body = JSON.parse(raw); requests.push(body); const value = handler(body, requests.length); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })); }); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  saveAiProvider({ expectedRevision: 0, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-site-design', allowLocal: true, apiKey: 'synthetic-site-design-key' }, admin);
  return requests;
}

test('当前SQL私表独立；错误权限/范围/版本/未配置在外发前拒绝', async () => {
  assert.equal((getDatabase().prepare('SELECT max(version) n FROM cms_schema_migration').get() as { n: number }).n, 19);
  const before = getStudioEnvelope();
  await assert.rejects(generateAiSiteDesign(request(), admin), status(422));
  await assert.rejects(generateAiSiteDesign(request(), editor), status(403));
  await assert.rejects(generateAiSiteDesign(request({ expectedRevision: 99 }), admin), status(409));
  await assert.rejects(generateAiSiteDesign(request({ targets: { pageIds: ['home'], header: true, footer: false, navigation: false, style: false } }), admin), status(422));
  assert.deepEqual(getStudioEnvelope(), before); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n, 0);
});

test('本人候选冻结整站预览，生成不写草稿或外发产品库/询盘/密钥', async () => {
  const sent = await mock(() => fullResult()); createInquiry({ name: 'Buyer', email: 'buyer@example.invalid', message: 'PRIVATE_INQUIRY_NOT_SENT' }); const before = getStudioEnvelope();
  const view = await generateAiSiteDesign(request(), admin);
  assert.equal(sent.length, 1); assert.equal(view.appliedRevision, null); assert.equal(view.affectedPages.length, 2); assert.equal(view.previewPages.filter(page => page.available).length, 2);
  assert.deepEqual(getStudioEnvelope(), before); assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_PRODUCT_LIBRARY_NOT_SENT|PRIVATE_INQUIRY_NOT_SENT|synthetic-site-design-key/);
  assert.equal(listAiSiteDesigns(other).items.length, 0); assert.throws(() => readAiSiteDesign(view.designId, other), status(404)); assert.throws(() => resolveAiSiteDesignPreview(view.designId, 'after', other), status(404));
  const old = resolveAiSiteDesignPreview(view.designId, 'before', admin, ['contact'])!, next = resolveAiSiteDesignPreview(view.designId, 'after', admin, ['contact'])!;
  assert.match(JSON.stringify(old.resolved.data), /CONTACT_PRIVATE_SCOPE_TEXT/); assert.match(JSON.stringify(next.resolved.data), /Tell us about your project/);
  assert.equal(old.snapshot.siteLayout, undefined); assert.equal(next.snapshot.siteLayout?.header.mode, 'block'); assert.equal(next.snapshot.customCode?.global.jsEnabled, false); assert.equal(resolveAiSiteDesignPreview(view.designId, 'after', admin, ['admin']), null);
});

test('采用页/头尾/菜单/主题同事务，重复采用幂等且不改公开指针', async () => {
  await mock(() => fullResult()); const before = getStudioEnvelope(), view = await generateAiSiteDesign(request(), admin);
  const after = applyAiSiteDesign({ designId: view.designId, expectedRevision: before.revision }, admin), repeat = applyAiSiteDesign({ designId: view.designId, expectedRevision: before.revision }, admin);
  assert.equal(after.revision, before.revision + 1); assert.equal(repeat.revision, after.revision); assert.equal(after.activeReleaseId, before.activeReleaseId);
  assert.equal(after.state.theme.primary, '#224466'); assert.equal(after.state.sharedBlocks?.length, 2); assert.equal(after.state.siteLayout?.menus?.length, 2); assert.ok(!after.state.siteLayout?.footer.menuId); assert.deepEqual(after.state.products, before.state.products); assert.deepEqual(after.state.settings, before.state.settings);
  // 品牌首页与主导航各使用真实独立菜单，不能只为匹配数量而留下无引用资产。
  const header = after.state.sharedBlocks!.find(block => block.id === after.state.siteLayout!.header.blockId)!;
  const navigation = header.data.content[0].props.content.filter((node: { type: string }) => node.type === 'Navigation') as { props: { id: string; menuId: string } }[];
  assert.deepEqual([...new Set(navigation.map(node => node.props.menuId))].sort(), after.state.siteLayout!.menus!.map(menu => menu.id).sort());
  const brand = navigation.find(node => node.props.id === 'site-header-brand')!, brandMenu = after.state.siteLayout!.menus!.find(menu => menu.id === brand.props.menuId)!;
  assert.equal(brandMenu.items[0].label, before.state.settings.name); assert.deepEqual(brandMenu.items[0].target, { kind: 'page', id: 'home' });
  assert.deepEqual(after.state.editorData.home, before.state.editorData.home); assert.match(JSON.stringify(after.state.editorData.contact), /Tell us about your project/);
});

test('撤销反转目标字段，保留后加菜单/非目标主题字段及其他业务', async () => {
  await mock(() => fullResult()); const before = getStudioEnvelope(), view = await generateAiSiteDesign(request(), admin); const applied = applyAiSiteDesign({ designId: view.designId, expectedRevision: before.revision }, admin);
  const updated = patchStudio({ expectedRevision: applied.revision, patch: { theme: { ...applied.state.theme, text: '#445566' }, siteLayout: { ...applied.state.siteLayout!, menus: [...(applied.state.siteLayout?.menus || []), { id: 'manual-menu', name: 'Manual', items: [{ id: 'manual-item', label: 'Contact', target: { kind: 'page', id: 'contact' } }] }] } } }, admin);
  const undone = undoAiSiteDesign({ designId: view.designId, expectedRevision: updated.revision }, admin);
  assert.equal(undone.state.theme.primary, before.state.theme.primary); assert.equal(undone.state.theme.text, '#445566'); assert.deepEqual(undone.state.editorData, before.state.editorData); assert.equal(undone.state.sharedBlocks?.length, 0); assert.deepEqual(undone.state.siteLayout?.menus?.map(menu => menu.id), ['manual-menu']);
  assert.equal(undone.activeReleaseId, before.activeReleaseId); assert.equal(undoAiSiteDesign({ designId: view.designId, expectedRevision: updated.revision }, admin).revision, undone.revision);
});

test('页面/主题/菜单/生成块实际手改均阻止撤销，不恢复旧整站快照', async () => {
  await mock(() => fullResult()); const before = getStudioEnvelope(), view = await generateAiSiteDesign(request(), admin), applied = applyAiSiteDesign({ designId: view.designId, expectedRevision: before.revision }, admin);
  const block = structuredClone(applied.state.sharedBlocks![0]); block.name = 'Manually changed header';
  const current = patchStudio({ expectedRevision: applied.revision, patch: { sharedBlocks: applied.state.sharedBlocks!.map(item => item.id === block.id ? block : item) } }, admin);
  assert.throws(() => undoAiSiteDesign({ designId: view.designId, expectedRevision: current.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), current);
});

test('生成资产有新增外部区块引用时撤销拒绝；解除引用可恢复', async () => {
  await mock(() => fullResult()); const view = await generateAiSiteDesign(request(), admin), applied = applyAiSiteDesign({ designId: view.designId, expectedRevision: 0 }, admin), headerId = applied.state.siteLayout!.header.blockId;
  const data = structuredClone(applied.state.editorData.home) as Data; data.content.push({ type: 'SharedBlock', props: { id: 'manual-header-ref', blockId: headerId } });
  const changed = patchStudio({ expectedRevision: applied.revision, patch: { editorData: { ...applied.state.editorData, home: data } } }, admin);
  assert.throws(() => undoAiSiteDesign({ designId: view.designId, expectedRevision: changed.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), changed);
  const released = patchStudio({ expectedRevision: changed.revision, patch: { editorData: { ...changed.state.editorData, home: applied.state.editorData.home } } }, admin);
  assert.equal(undoAiSiteDesign({ designId: view.designId, expectedRevision: released.revision }, admin).state.sharedBlocks?.length, 0);
});

test('新导航被非目标页面引用时撤销拒绝，真实引用不会成为悬空菜单', async () => {
  await mock(() => fullResult()); const view = await generateAiSiteDesign(request(), admin), applied = applyAiSiteDesign({ designId: view.designId, expectedRevision: 0 }, admin), menuId = applied.state.siteLayout!.header.menuId;
  const data = structuredClone(applied.state.editorData.home) as Data; data.content.push({ type: 'Navigation', props: { id: 'manual-menu-ref', menuId, label: 'Manual nav' } });
  const changed = patchStudio({ expectedRevision: applied.revision, patch: { editorData: { ...applied.state.editorData, home: data } } }, admin);
  assert.throws(() => undoAiSiteDesign({ designId: view.designId, expectedRevision: changed.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), changed);
});

test('继续调整沿用最初before，累计效果与预览一致，删除父记录不破坏子候选', async () => {
  const sent = await mock((_body, count) => count === 1 ? fullResult() : themeResult('#335577'));
  const original = getStudioEnvelope(), first = await generateAiSiteDesign(request(), admin), second = await generateAiSiteDesign(request({ baseDesignId: first.designId, instruction: '保留这版头尾导航，把主色再沉稳一点。' }), admin);
  assert.equal(sent.length, 2); assert.equal(second.refinement?.round, 1); assert.deepEqual(getStudioEnvelope(), original);
  deleteAiSiteDesign(first.designId, admin); const after = resolveAiSiteDesignPreview(second.designId, 'after', admin, ['contact'])!, before = resolveAiSiteDesignPreview(second.designId, 'before', admin, ['contact'])!;
  assert.equal(before.snapshot.siteLayout, undefined); assert.equal(after.snapshot.theme.primary, '#335577'); assert.equal(after.snapshot.sharedBlocks?.length, 2); assert.match(JSON.stringify(after.resolved.data), /Tell us about your project/);
  const applied = applyAiSiteDesign({ designId: second.designId, expectedRevision: original.revision }, admin); const undone = undoAiSiteDesign({ designId: second.designId, expectedRevision: applied.revision }, admin);
  assert.deepEqual(undone.state.editorData, original.state.editorData); assert.deepEqual(undone.state.theme, original.state.theme);
});

test('连续任务不能扩大范围/取消保留、跨owner或沿用已应用方案', async () => {
  await mock(); const first = await generateAiSiteDesign(request({ preserveText: true }), admin);
  await assert.rejects(generateAiSiteDesign(request({ baseDesignId: first.designId, preserveText: false }), admin), status(422));
  await assert.rejects(generateAiSiteDesign(request({ baseDesignId: first.designId, targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false } }), admin), status(422));
  await assert.rejects(generateAiSiteDesign(request({ baseDesignId: first.designId }), other), status(404));
  const applied = applyAiSiteDesign({ designId: first.designId, expectedRevision: 0 }, admin); await assert.rejects(generateAiSiteDesign(request({ expectedRevision: applied.revision, baseDesignId: first.designId, preserveText: true }), admin), status(409));
});

test('预览后新版本、同父分支及模型请求中父已采用均拒绝覆盖', async () => {
  let mutate = false, parentId = '';
  await mock((_body, count) => { if (mutate) applyAiSiteDesign({ designId: parentId, expectedRevision: 0 }, admin); return themeResult(count % 2 ? '#224466' : '#335577'); });
  const first = await generateAiSiteDesign(request(), admin); parentId = first.designId; mutate = true;
  await assert.rejects(generateAiSiteDesign(request({ baseDesignId: first.designId }), admin), status(409));
  assert.equal(getDraftRecord().content.theme.primary, '#224466'); assert.equal(listAiSiteDesigns(admin).items.length, 1);
});

test('生成期间降权清理占位，真实角色变化不留下可采用建议', async () => {
  await mock(() => { getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); return themeResult(); });
  await assert.rejects(generateAiSiteDesign(request(), admin), status(403)); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n, 0); assert.equal(getDraftRecord().revision, 0);
});

test('部分页面只送所选正文；旧菜单与其他页面正文/全库产品不进入模型', async () => {
  const sent = await mock(() => ({ summary: '调整首页留白', operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'design', id: 'home-copy', design: { desktop: { fontSize: 20 } } }] }], warnings: [] }));
  const view = await generateAiSiteDesign(request({ targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false } }), admin);
  assert.doesNotMatch(JSON.stringify(sent), /CONTACT_PRIVATE_SCOPE_TEXT|PRIVATE_PRODUCT_LIBRARY_NOT_SENT/); assert.deepEqual(view.affectedPages.map(page => page.pageId), ['home']); assert.equal(view.previewPages.length, 2);
  assert.ok(view.previewPages.find(page => page.pageId === 'contact')?.available); assert.match(JSON.stringify(resolveAiSiteDesignPreview(view.designId, 'after', admin, ['contact'])?.resolved.data), /CONTACT_PRIVATE_SCOPE_TEXT/);
});

test('全局采用后新增锁定节点会保护继承样式，不能借撤销间接改掉新锁', async () => {
  await mock(); const view = await generateAiSiteDesign(request(), admin), applied = applyAiSiteDesign({ designId: view.designId, expectedRevision: 0 }, admin);
  const data = structuredClone(applied.state.editorData.home) as Data; data.content.push({ type: 'Text', props: { id: 'manual-locked', text: 'Manual locked area', locked: true } });
  const changed = patchStudio({ expectedRevision: applied.revision, patch: { editorData: { ...applied.state.editorData, home: data } } }, admin);
  assert.throws(() => undoAiSiteDesign({ designId: view.designId, expectedRevision: changed.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), changed);
});

test('连续修改最多六次，达到上限在外发前停止，不偷偷重试模型', async () => {
  const sent = await mock((_body, count) => themeResult(`#${String(count).padStart(6, '0')}`));
  let view = await generateAiSiteDesign(request(), admin);
  for (let round = 1; round <= 6; round++) { view = await generateAiSiteDesign(request({ baseDesignId: view.designId }), admin); assert.equal(view.refinement?.round, round); }
  await assert.rejects(generateAiSiteDesign(request({ baseDesignId: view.designId }), admin), status(422)); assert.equal(sent.length, 7); assert.equal(getDraftRecord().revision, 0);
});

test('过期记录不再读取或列出，主动生成清除过期记录且不沿用旧候选', async () => {
  await mock(); const view = await generateAiSiteDesign(request(), admin);
  getDatabase().prepare('UPDATE cms_ai_site_design SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), view.designId);
  assert.throws(() => readAiSiteDesign(view.designId, admin), status(410)); assert.equal(listAiSiteDesigns(admin).items.length, 0);
  await assert.rejects(generateAiSiteDesign(request({ baseDesignId: view.designId }), admin), status(410));
  await generateAiSiteDesign(request(), admin); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n, 1);
});

test('容量先预留、非法模型只调用一次并清占位，失败不会改变网站', async () => {
  const sent = await mock(() => ({ summary: '无效模型输出', operations: [{ kind: 'execute', script: 'do not run' }], warnings: [] })), db = getDatabase(), stamp = new Date().toISOString(), expiry = new Date(Date.now() + 60000).toISOString();
  for (let index = 0; index < 30; index++) db.prepare('INSERT INTO cms_ai_site_design(id,actor_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(`aisd-${randomUUID()}`, admin.id, 0, '{"pending":true}', stamp, expiry);
  await assert.rejects(generateAiSiteDesign(request(), admin), status(429)); assert.equal(sent.length, 0); db.prepare('DELETE FROM cms_ai_site_design').run();
  const before = getStudioEnvelope(); await assert.rejects(generateAiSiteDesign(request(), admin), status(422)); assert.equal(sent.length, 1); assert.deepEqual(getStudioEnvelope(), before); assert.equal((db.prepare('SELECT count(*) n FROM cms_ai_site_design').get() as { n: number }).n, 0);
});

test('同父两个分支只能采用一个，另一分支不能覆盖最新草稿', async () => {
  await mock((_body, count) => themeResult(`#${String(count).padStart(6, '0')}`)); const parent = await generateAiSiteDesign(request(), admin), first = await generateAiSiteDesign(request({ baseDesignId: parent.designId }), admin), second = await generateAiSiteDesign(request({ baseDesignId: parent.designId }), admin);
  const applied = applyAiSiteDesign({ designId: first.designId, expectedRevision: 0 }, admin);
  const unchanged = getStudioEnvelope(); assert.throws(() => applyAiSiteDesign({ designId: second.designId, expectedRevision: applied.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), unchanged);
});

test('继续调整可携带新一版有界排版反馈，反馈不改变任务范围或授权', async () => {
  const sent = await mock((_body, count) => themeResult(count === 1 ? '#224466' : '#335577'));
  const first = await generateAiSiteDesign(request(), admin);
  const reports = [{ viewport: 'mobile', width: 390, horizontalOverflow: true, brokenImages: 0, pendingImages: 0, smallText: 0, smallTargets: 0, headingCount: 1, inspectedElements: 10, truncated: false, issues: [{ code: 'horizontal-overflow', count: 1, nodeId: 'home-title' }] }];
  const next = await generateAiSiteDesign(request({ baseDesignId: first.designId, previewFeedback: [{ pageId: 'home', reports }] }), admin);
  assert.deepEqual(next.request.targets, first.request.targets); assert.equal(next.refinement?.baseDesignId, first.designId); assert.match(JSON.stringify(sent[1]), /browserMeasurements|horizontal-overflow/);
  await assert.rejects(generateAiSiteDesign(request({ baseDesignId: next.designId, previewFeedback: [{ pageId: 'not-in-task', reports }] }), admin), status(422)); assert.equal(sent.length, 2);
});

test('只改导航可克隆已有自定义页眉，布局/节点ID/文字保持且原共享引用不改', async () => {
  const content = getDraftRecord().content;
  const oldData = { root: { props: { showChrome: 'no' } }, content: [{ type: 'Container', props: { id: 'custom-header-frame', layout: 'grid', columns: 2, mobileColumns: 1, gap: 17, padding: 23, inset: 29, background: '#ffffff', image: '', minHeight: 0, align: 'start', design: { desktop: { borderWidth: 1, borderColor: '#112233', borderStyle: 'solid' } }, content: [{ type: 'Text', props: { id: 'custom-header-brand', text: 'Original independent brand', size: 22, align: 'left', maxWidth: 900 } }, { type: 'Navigation', props: { id: 'custom-header-nav', menuId: 'original-menu', label: 'Original navigation' } }] } }] } as Data;
  content.sharedBlocks = [{ id: 'original-header', name: 'Original header asset', data: oldData, updated: '2026-01-01T00:00:00Z' }];
  content.siteLayout = { header: { mode: 'block', blockId: 'original-header', menuId: 'original-menu' }, footer: { mode: 'default', blockId: '' }, menus: [{ id: 'original-menu', name: 'Original menu', items: [{ id: 'original-item', label: 'Home', target: { kind: 'page', id: 'home' } }] }] };
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  await mock(() => ({ summary: '保留原页眉设计，仅整理导航', operations: [{ kind: 'navigation', slot: 'header', items: [{ label: 'Contact', pageId: 'contact' }, { label: 'Home', pageId: 'home' }] }], warnings: [] }));
  const before = getStudioEnvelope(), view = await generateAiSiteDesign(request({ targets: { pageIds: ['home', 'contact'], header: false, footer: false, navigation: true, style: false } }), admin);
  const applied = applyAiSiteDesign({ designId: view.designId, expectedRevision: 0 }, admin);
  assert.notEqual(applied.state.siteLayout?.header.blockId, 'original-header'); assert.deepEqual(applied.state.sharedBlocks?.find(block => block.id === 'original-header'), before.state.sharedBlocks?.[0]);
  const cloned = applied.state.sharedBlocks!.find(block => block.id === applied.state.siteLayout!.header.blockId)!.data;
  assert.equal(cloned.content[0].props.id, 'custom-header-frame'); assert.equal(cloned.content[0].props.gap, 17); assert.deepEqual(cloned.content[0].props.design, oldData.content[0].props.design); assert.deepEqual(cloned.content[0].props.content[0], oldData.content[0].props.content[0]);
  assert.equal(sameNonNavigationLayout(oldData, cloned), true);
  for (const alter of [(value: Data) => { value.content[0].props.gap = 99; }, (value: Data) => { value.content[0].props.id = 'rewritten-non-nav-id'; }, (value: Data) => { value.content[0].props.content[0].props.text = 'Unexpected rewritten brand'; }, (value: Data) => { value.content[0].props.metadata = { type: 'Navigation', props: { menuId: 'cannot-hide-in-ordinary-props' } }; }]) { const changed = structuredClone(cloned); alter(changed); assert.equal(sameNonNavigationLayout(oldData, changed), false, '导航授权不能借克隆更换非导航属性、文字或稳定ID'); }
  const undone = undoAiSiteDesign({ designId: view.designId, expectedRevision: applied.revision }, admin); assert.deepEqual(undone.state.sharedBlocks, before.state.sharedBlocks); assert.deepEqual(undone.state.siteLayout, before.state.siteLayout);
});
