import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { getDatabase, getDataDirectory } from '../database';
import { getDraftRecord, getStudioEnvelope, patchStudio, createInquiry, updateInquiry } from '../studio';
import { activateRelease, getActiveSiteSnapshot, getDraftSiteSnapshot, previewPublication, publishSite, restoreDraft } from '../publication';
import { deleteMedia, isPublishedMedia, readMediaFile, uploadMedia } from '../media';
import { ApiError } from '../http';
import { validateDraft } from '../validation';
import type { PublicationSelection } from '../types';

const actor = { id: 'test-admin', name: '测试管理员' };
let directory = '';
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'form-studio-test-')); process.env.FORM_STUDIO_DATA_DIR = directory; });
afterEach(() => {
  getDatabase().close();
  // 仅清理当前测试创建、且仍位于系统临时目录中的实例，不触碰真实客户数据目录。
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}form-studio-test-`)) rmSync(directory, { recursive: true, force: true });
});
function selection(overrides: Partial<PublicationSelection> = {}): PublicationSelection {
  const envelope = getStudioEnvelope();
  return { expectedRevision: envelope.revision, baseReleaseId: envelope.activeReleaseId, pageIds: ['home', 'about', 'product-detail'], productIds: ['p1'], includeTheme: true, includeSettings: true, ...overrides };
}
function rejectsStatus(action: () => unknown, status: number) { assert.throws(action, (error) => error instanceof ApiError && error.status === status); }

test('初始化物化全部页面 JSON，实际线上版本及询盘为空', () => {
  const envelope = getStudioEnvelope();
  assert.equal(envelope.revision, 0); assert.equal(envelope.activeReleaseId, null);
  assert.deepEqual(envelope.state.releases, []); assert.deepEqual(envelope.state.inquiries, []);
  assert.ok(envelope.state.pages.every((page) => page.status === 'draft' && envelope.state.editorData[page.id]));
  assert.doesNotThrow(() => validateDraft(getDraftRecord().content));
  assert.equal(getActiveSiteSnapshot(), null);
  assert.ok(getDraftSiteSnapshot().products.every((product) => product.status === 'published'));
});

test('保存保留规格、SEO 和主题扩展；旧 revision 无法覆盖', () => {
  const initial = getStudioEnvelope();
  const products = initial.state.products.map((product, index) => index ? product : { ...product, seoTitle: '测试 SEO', seoDescription: '描述', specifications: [{ label: '颜色', value: '黑色' }] });
  const result = patchStudio({ expectedRevision: 0, patch: { products, editorData: { ...initial.state.editorData, __themeControls: { contentWidth: 1240, buttonStyle: 'outline', buttonSize: 'large' } } } });
  assert.equal(result.revision, 1); assert.equal((getDraftRecord().content.products[0]).seoTitle, '测试 SEO');
  assert.deepEqual(getDraftRecord().content.products[0].specifications, [{ label: '颜色', value: '黑色' }]);
  rejectsStatus(() => patchStudio({ expectedRevision: 0, patch: { products: [] } }), 409);
  assert.equal(getDraftRecord().content.products.length, 4);
});

test('部分发布是完整快照，未选产品、主题、设置和页面保持线上旧值', () => {
  const first = publishSite(selection(), actor); const snapshot = getActiveSiteSnapshot()!;
  const original = getDraftRecord(); const next = structuredClone(original.content);
  (next.editorData.about as { root: { props: { title: string } } }).root.props.title = '未选中的新关于页';
  (next.editorData.home as { root: { props: { title: string } } }).root.props.title = '首页第二版';
  next.products[0].name = '未选中的产品改名'; next.theme.primary = '#112233'; next.settings.email = 'changed@example.com';
  patchStudio({ expectedRevision: original.revision, patch: next });
  const second = publishSite(selection({ pageIds: ['home'], productIds: [], includeTheme: false, includeSettings: false }), actor);
  const current = getActiveSiteSnapshot()!;
  assert.notEqual(first.releaseId, second.releaseId); assert.equal(current.pages.length, 3);
  assert.deepEqual(current.editorData.about, snapshot.editorData.about); assert.deepEqual(current.products, snapshot.products);
  assert.deepEqual(current.theme, snapshot.theme); assert.deepEqual(current.settings, snapshot.settings);
  assert.equal('domain' in current.settings, false); assert.equal('timezone' in current.settings, false); assert.equal('inquiries' in current, false);
  assert.equal(second.state.pages.find((page) => page.id === 'about')?.status, 'draft');
  assert.throws(() => getDatabase().prepare('UPDATE cms_release SET title = ? WHERE id = ?').run('tamper', first.releaseId), /immutable/);
});

test('线上回滚不改草稿；恢复草稿不切线上，不回退询盘', () => {
  const first = publishSite(selection(), actor); const original = getDraftRecord();
  const changed = structuredClone(original.content.editorData);
  (changed.home as { root: { props: { title: string } } }).root.props.title = '新版草稿';
  patchStudio({ expectedRevision: original.revision, patch: { editorData: changed } });
  const second = publishSite(selection({ pageIds: ['home'], productIds: [], includeTheme: false, includeSettings: false }), actor);
  const inquiry = createInquiry({ name: '测试客户', email: 'test@example.com', message: '测试留言' });
  const draftBefore = getDraftRecord();
  activateRelease(first.releaseId, { expectedActiveReleaseId: second.releaseId }, actor);
  assert.deepEqual(getDraftRecord(), draftBefore);
  restoreDraft(first.releaseId, { expectedRevision: draftBefore.revision, pageIds: ['home'] }, actor);
  assert.equal(getStudioEnvelope().activeReleaseId, first.releaseId); assert.equal(getDraftRecord().revision, draftBefore.revision + 1);
  assert.equal(getStudioEnvelope().state.inquiries[0].id, inquiry.item.id);
  assert.deepEqual(getDraftRecord().content.editorData.about, draftBefore.content.editorData.about);
});

test('发布检测草稿和 active 双重冲突，失败不产生版本', () => {
  const old = selection(); const first = publishSite(old, actor);
  rejectsStatus(() => publishSite(old, actor), 409);
  const staleDraft = selection(); patchStudio({ expectedRevision: 0, patch: { theme: { ...getDraftRecord().content.theme, primary: '#223344' } } });
  rejectsStatus(() => publishSite(staleDraft, actor), 409);
  assert.equal(getStudioEnvelope().state.releases.length, 1); assert.equal(getStudioEnvelope().activeReleaseId, first.releaseId);
  rejectsStatus(() => activateRelease(first.releaseId, { expectedActiveReleaseId: null }, actor), 409);
});

test('无效路径和链接拒绝，未知组件草稿保留但发布阻止', () => {
  const current = getDraftRecord();
  rejectsStatus(() => patchStudio({ expectedRevision: 0, patch: { pages: [{ ...current.content.pages[0], slug: '/api/studio' }] } }), 422);
  rejectsStatus(() => patchStudio({ expectedRevision: 0, patch: { pages: 'bad' } }), 422);
  const editorData = structuredClone(current.content.editorData);
  (editorData.home as { content: unknown[] }).content.push({ type: 'ActionButton', props: { id: 'malicious', href: 'javascript:alert(1)', text: 'bad' } });
  rejectsStatus(() => patchStudio({ expectedRevision: 0, patch: { editorData } }), 422);
  (editorData.home as { content: unknown[] }).content.pop();
  (editorData.home as { content: unknown[] }).content.push({ type: 'FutureComponent', props: { id: 'future', text: '必须保留' } });
  patchStudio({ expectedRevision: 0, patch: { editorData } });
  const preflight = previewPublication(selection()); assert.ok(preflight.errors.some((error) => error.includes('组件类型')));
  rejectsStatus(() => publishSite(selection(), actor), 422); assert.equal(getActiveSiteSnapshot(), null);
});

test('显式产品绑定缺少依赖时发布阻止，不自动携带草稿产品', () => {
  const current = getDraftRecord(); const editorData = structuredClone(current.content.editorData);
  (editorData['product-detail'] as { content: { props: Record<string, unknown> }[] }).content[0].props.productId = 'p2';
  patchStudio({ expectedRevision: 0, patch: { editorData } });
  const preview = previewPublication(selection({ productIds: ['p1'] }));
  assert.ok(preview.errors.some((error) => error.includes('p2')));
  rejectsStatus(() => publishSite(selection({ productIds: ['p1'] }), actor), 422);
  assert.equal(getStudioEnvelope().state.releases.length, 0);
});

test('询盘独立 revision，不影响草稿版本；非法状态无法保存', () => {
  const item = createInquiry({ name: '测试客户', email: 'test@example.com', message: '留言' }).item;
  const changed = updateInquiry(item.id, { expectedRevision: 0, status: 'contacted' }).item;
  assert.equal(changed.revision, 1); assert.equal(getDraftRecord().revision, 0);
  rejectsStatus(() => updateInquiry(item.id, { expectedRevision: 0, status: 'archived' }), 409);
  rejectsStatus(() => updateInquiry(item.id, { expectedRevision: 1, status: 'invalid' }), 422);
});

test('真实上传解码、草稿引用保护及历史文件保留', async () => {
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const form = new FormData(); form.set('file', new File([new Uint8Array(bytes)], 'test.png', { type: 'image/png' })); form.set('expectedRevision', '0');
  const upload = await uploadMedia(form); const media = upload.media;
  assert.equal(readMediaFile(media.id).mime, 'image/webp'); assert.equal(isPublishedMedia(media.id), false);
  const editorData = structuredClone(getDraftRecord().content.editorData);
  (editorData.home as { content: unknown[] }).content.push({ type: 'Image', props: { id: 'uploaded', src: media.url, alt: '测试图片', height: 200, radius: 0, fit: 'cover' } });
  patchStudio({ expectedRevision: upload.revision, patch: { editorData } });
  rejectsStatus(() => deleteMedia(media.id, { expectedRevision: getDraftRecord().revision }), 422);
  publishSite(selection(), actor); assert.equal(isPublishedMedia(media.id), true);
  (editorData.home as { content: unknown[] }).content.pop();
  patchStudio({ expectedRevision: getDraftRecord().revision, patch: { editorData } });
  deleteMedia(media.id, { expectedRevision: getDraftRecord().revision });
  assert.equal(getDraftRecord().content.media.some((item) => item.id === media.id), false);
  assert.ok(readMediaFile(media.id).bytes.length > 0); assert.equal(isPublishedMedia(media.id), true);
});

test('SVG 和伪装成 PNG 的文本不可进入素材库', async () => {
  const form = new FormData(); form.set('file', new File(['<svg></svg>'], 'bad.svg', { type: 'image/svg+xml' })); form.set('expectedRevision', '0');
  await assert.rejects(uploadMedia(form), (error) => error instanceof ApiError && error.status === 415);
  form.set('file', new File(['<script>bad</script>'], 'bad.png', { type: 'image/png' }));
  await assert.rejects(uploadMedia(form), (error) => error instanceof ApiError && error.status === 422);
  assert.equal(getDraftRecord().revision, 0);
});

test('删除草稿不会下线旧页面，明确选择下线才从完整清单移除', () => {
  publishSite(selection(), actor);
  const current = getDraftRecord();
  patchStudio({ expectedRevision: current.revision, patch: { pages: current.content.pages.filter((page) => page.id !== 'about') } });
  publishSite(selection({ pageIds: ['home'], productIds: [], includeTheme: false, includeSettings: false }), actor);
  assert.ok(getActiveSiteSnapshot()!.pages.some((page) => page.id === 'about'));
  publishSite(selection({ pageIds: [], productIds: [], removePageIds: ['about'], includeTheme: false, includeSettings: false }), actor);
  assert.equal(getActiveSiteSnapshot()!.pages.some((page) => page.id === 'about'), false);
  assert.ok(getActiveSiteSnapshot()!.pages.some((page) => page.id === 'home'));
});

test('编辑中的空链接可以保存，发布前要求补齐；非法协议始终拒绝', () => {
  const current = getDraftRecord(); const editorData = structuredClone(current.content.editorData);
  (editorData.home as { content: unknown[] }).content.push({ type: 'ActionButton', props: { id: 'empty-link', text: '待填写', href: '' } });
  assert.doesNotThrow(() => patchStudio({ expectedRevision: current.revision, patch: { editorData } }));
  assert.ok(previewPublication(selection()).errors.some((error) => error.includes('链接')));
});

test('未选内容的素材元数据不泄漏进新版本，关闭并重开数据库仍保留快照与指针', () => {
  const first = publishSite(selection(), actor);
  const original = getActiveSiteSnapshot()!;
  const current = getDraftRecord();
  patchStudio({ expectedRevision: current.revision, patch: { media: current.content.media.map((media) => media.url === '/images/chair.jpg' ? { ...media, alt: '未选择的新说明', name: 'not-published.jpg' } : media) } });
  // chair 仅被未选中的 p1 产品引用，不能因发布 about 页面带入其草稿素材说明。
  const second = publishSite(selection({ pageIds: ['about'], productIds: [], includeTheme: false, includeSettings: false }), actor);
  assert.deepEqual(getActiveSiteSnapshot()!.media.find((media) => media.url === '/images/chair.jpg'), original.media.find((media) => media.url === '/images/chair.jpg'));
  const draftBefore = getDraftRecord(); getDatabase().close();
  assert.equal(getStudioEnvelope().activeReleaseId, second.releaseId); assert.deepEqual(getDraftRecord(), draftBefore);
  assert.equal(getStudioEnvelope().state.releases.length, 2);
  assert.throws(() => getDatabase().prepare('DELETE FROM cms_release WHERE id = ?').run(first.releaseId), /retained/);
});

test('历史资源可重新加入素材库；物理文件缺失则恢复失败且不更改草稿', async () => {
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
  const form = new FormData(); form.set('file', new File([new Uint8Array(bytes)], 'restore.png', { type: 'image/png' })); form.set('expectedRevision', '0');
  const upload = await uploadMedia(form); const editorData = structuredClone(getDraftRecord().content.editorData);
  (editorData.home as { content: unknown[] }).content.push({ type: 'Image', props: { id: 'history-image', src: upload.media.url, height: 200, alt: '历史素材' } });
  patchStudio({ expectedRevision: upload.revision, patch: { editorData } });
  const release = publishSite(selection(), actor);
  (editorData.home as { content: unknown[] }).content.pop();
  patchStudio({ expectedRevision: getDraftRecord().revision, patch: { editorData } });
  deleteMedia(upload.media.id, { expectedRevision: getDraftRecord().revision });
  restoreDraft(release.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: ['home'] }, actor);
  assert.ok(getDraftRecord().content.media.some((media) => media.id === upload.media.id));
  const before = getDraftRecord();
  const file = getDatabase().prepare('SELECT filename FROM cms_media_file WHERE id = ?').get(upload.media.id) as { filename: string };
  const path = join(getDataDirectory(), 'media', file.filename); renameSync(path, `${path}.missing`);
  rejectsStatus(() => restoreDraft(release.releaseId, { expectedRevision: before.revision, pageIds: ['home'] }, actor), 422);
  assert.deepEqual(getDraftRecord(), before);
  rejectsStatus(() => activateRelease(release.releaseId, { expectedActiveReleaseId: release.releaseId }, actor), 422);
});

test('页面更新时间由服务端记录，客户端显示文案不能覆盖未变更页面时间', () => {
  const current = getDraftRecord(); const previousAbout = current.content.pages.find((page) => page.id === 'about')!.updated;
  const next = patchStudio({ expectedRevision: current.revision, patch: { pages: current.content.pages.map((page) => ({ ...page, title: page.id === 'home' ? '更改首页名称' : page.title, updated: '刚刚' })) } });
  assert.match(next.state.pages.find((page) => page.id === 'home')!.updated, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(next.state.pages.find((page) => page.id === 'about')!.updated, previousAbout);
  const reordered = next.state.pages.map((page) => Object.fromEntries(Object.entries(page).reverse()));
  const afterReorder = patchStudio({ expectedRevision: next.revision, patch: { pages: reordered } });
  assert.equal(afterReorder.state.pages.find((page) => page.id === 'home')!.updated, next.state.pages.find((page) => page.id === 'home')!.updated);
});
