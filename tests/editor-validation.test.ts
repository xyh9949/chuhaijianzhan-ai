import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { createPageData } from '../src/lib/page-data';
import { getDatabase } from '../src/server/database';
import { ApiError } from '../src/server/http';
import { deleteMedia, isPublishedMedia, uploadMedia } from '../src/server/media';
import { activateRelease, getActiveSiteSnapshot, previewPublication, publishSite, restoreDraft } from '../src/server/publication';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { collectReferences, validatePageData } from '../src/server/validation';
import type { PublicationSelection } from '../src/server/types';

type TestNode = { type: string; props: Record<string, unknown> & { id: string; content?: TestNode[] } };
type TestPage = { root: { props: Record<string, unknown> }; content: TestNode[] };
const actor = { id: 'editor-test-admin', name: '编辑器测试管理员' };
let directory = '';
let previousDirectory: string | undefined;
beforeEach(() => {
  previousDirectory = process.env.FORM_STUDIO_DATA_DIR;
  directory = mkdtempSync(join(tmpdir(), 'form-studio-editor-test-'));
  process.env.FORM_STUDIO_DATA_DIR = directory;
});
afterEach(() => {
  getDatabase().close();
  // 只清理本用例创建的临时实例，真实客户数据库与父进程环境均保持不变。
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-editor-test-`)) rmSync(directory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.FORM_STUDIO_DATA_DIR;
  else process.env.FORM_STUDIO_DATA_DIR = previousDirectory;
});
function rejects422(action: () => unknown) { assert.throws(action, (error) => error instanceof ApiError && error.status === 422); }
function page(): TestPage {
  return {
    root: { props: { title: '响应式测试页', showChrome: 'no', design: { desktop: { backgroundColor: '#ffffff' }, mobile: { paddingLeft: 12 } } } },
    content: [{ type: 'Container', props: { id: 'test-container', design: { desktop: { display: 'grid', columns: 3, gap: 32 }, tablet: { columns: 2 }, mobile: { columns: 1, gap: 12 } }, content: [
      { type: 'Heading', props: { id: 'test-heading', text: '可编辑标题', design: { desktop: { fontSize: 64, width: '75%', color: '#112233' }, tablet: { fontSize: 42 }, mobile: { fontSize: 28, width: '100%' } } } },
    ] } }],
  };
}
function selection(overrides: Partial<PublicationSelection> = {}): PublicationSelection {
  const state = getStudioEnvelope();
  return { expectedRevision: state.revision, baseReleaseId: state.activeReleaseId, pageIds: ['home', 'about'], productIds: [], includeTheme: true, includeSettings: true, ...overrides };
}
function savePages(home: TestPage, about: TestPage = page()) {
  const current = getDraftRecord();
  return patchStudio({ expectedRevision: current.revision, patch: { editorData: { ...current.content.editorData, home, about } } });
}

test('旧页面无需迁移；页面和多层组件的三端覆盖可以保存', () => {
  assert.doesNotThrow(() => validatePageData(createPageData('home'), '旧首页', true));
  const designed = page();
  designed.content[0].props.content!.push({ type: 'Container', props: { id: 'nested-container', design: { desktop: { display: 'flex', flexDirection: 'row' }, mobile: { flexDirection: 'column' } }, content: [{ type: 'Text', props: { id: 'nested-text', text: '嵌套正文', design: { mobile: { marginTop: 16 } } } }] } });
  assert.doesNotThrow(() => validatePageData(designed, '响应式页面', true));
  savePages(designed);
  getDatabase().close();
  assert.deepEqual(getDraftRecord().content.editorData.home, designed);
});

test('非法断点、任意 CSS、危险背景和错误类型在根节点与嵌套节点均被拒绝', () => {
  const invalidDesigns = [
    null, [], { widescreen: { fontSize: 20 } }, { desktop: [] },
    { desktop: { position: 'fixed' } }, { desktop: { width: 'calc(100% - 1px)' } },
    { mobile: { fontSize: '28px' } }, { tablet: { opacity: 2 } },
    { mobile: { backgroundImage: 'url(javascript:alert(1))' } },
    { mobile: { backgroundImage: 'https://example.com/private.jpg' } },
    { mobile: { backgroundImage: 'data:image/svg+xml,<svg/>' } },
    { mobile: { color: '#fff;display:none' } },
  ];
  for (const invalid of invalidDesigns) {
    const root = page(); root.root.props.design = invalid;
    const nested = page(); nested.content[0].props.content![0].props.design = invalid;
    rejects422(() => validatePageData(root, '根节点测试'));
    rejects422(() => validatePageData(nested, '嵌套测试', true));
  }
  const current = getDraftRecord(); const invalid = page(); invalid.root.props.design = { mobile: { columns: 99 } };
  rejects422(() => savePages(invalid));
  assert.equal(getDraftRecord().revision, current.revision);
});

test('响应式扩展继续保护重复 ID 和未知组件，不静默丢掉未来组件数据', () => {
  const duplicate = page();
  duplicate.content[0].props.content![0].props.id = duplicate.content[0].props.id;
  rejects422(() => validatePageData(duplicate, '重复标识'));
  const future = page(); future.content.push({ type: 'FutureBlock', props: { id: 'future-block', design: { mobile: { display: 'none' } }, customValue: '保留数据' } });
  savePages(future);
  assert.deepEqual(getDraftRecord().content.editorData.home, future);
  assert.ok(previewPublication(selection()).errors.some((error) => error.includes('组件类型')));
  rejects422(() => publishSite(selection(), actor));
  assert.equal(getActiveSiteSnapshot(), null);
});

test('选择发布保留未选页面样式；线上回滚与恢复草稿分别保留完整断点数据', () => {
  const originalHome = page(); const originalAbout = page();
  savePages(originalHome, originalAbout);
  const first = publishSite(selection(), actor);
  const newHome = page(); const newAbout = page();
  newHome.content[0].props.content![0].props.design = { desktop: { fontSize: 88 }, mobile: { fontSize: 33, color: '#ff6600' } };
  newAbout.root.props.design = { mobile: { backgroundColor: '#eef2ff' } };
  savePages(newHome, newAbout);
  const second = publishSite(selection({ pageIds: ['home'], includeTheme: false, includeSettings: false }), actor);
  assert.deepEqual(getActiveSiteSnapshot()!.editorData.home, newHome);
  assert.deepEqual(getActiveSiteSnapshot()!.editorData.about, originalAbout);
  const draftBeforeRollback = getDraftRecord();
  activateRelease(first.releaseId, { expectedActiveReleaseId: second.releaseId }, actor);
  assert.deepEqual(getActiveSiteSnapshot()!.editorData.home, originalHome);
  assert.deepEqual(getDraftRecord(), draftBeforeRollback);
  restoreDraft(first.releaseId, { expectedRevision: draftBeforeRollback.revision, pageIds: ['home'], productIds: [] }, actor);
  assert.deepEqual(getDraftRecord().content.editorData.home, originalHome);
  assert.deepEqual(getDraftRecord().content.editorData.about, newAbout);
  assert.equal(getStudioEnvelope().activeReleaseId, first.releaseId);
});

test('根节点和所有断点背景都参与依赖收集，明确清空背景不产生空地址', () => {
  const designed = page();
  designed.root.props.design = { desktop: { backgroundImage: '/images/interior.jpg' }, tablet: { backgroundImage: '/images/studio.jpg' }, mobile: { backgroundImage: '' } };
  designed.content[0].props.content![0].props.design = { mobile: { backgroundImage: '/api/media/mobile-only-image' } };
  assert.doesNotThrow(() => validatePageData(designed, '背景引用'));
  const references = collectReferences({ pages: getDraftRecord().content.pages.filter((item) => item.id === 'home'), products: [], editorData: { home: designed } });
  assert.deepEqual([...references.urls].sort(), ['/api/media/mobile-only-image', '/images/interior.jpg', '/images/studio.jpg']);
  savePages(designed);
  assert.ok(previewPublication(selection()).errors.some((error) => error.includes('/api/media/mobile-only-image')));
  rejects422(() => publishSite(selection(), actor));
});

test('仅手机端使用的上传背景受删除保护，并随发布与历史恢复保留', async () => {
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'mobile-background.png', { type: 'image/png' }));
  form.set('expectedRevision', String(getDraftRecord().revision));
  const uploaded = await uploadMedia(form);
  const designed = page(); designed.content[0].props.design = { mobile: { backgroundImage: uploaded.media.url } };
  savePages(designed);
  rejects422(() => deleteMedia(uploaded.media.id, { expectedRevision: getDraftRecord().revision }));
  const current = getDraftRecord();
  rejects422(() => patchStudio({ expectedRevision: current.revision, patch: { media: current.content.media.filter((media) => media.id !== uploaded.media.id) } }));
  const release = publishSite(selection(), actor);
  assert.equal(isPublishedMedia(uploaded.media.id), true);
  assert.ok(getActiveSiteSnapshot()!.media.some((media) => media.id === uploaded.media.id));
  savePages(page());
  deleteMedia(uploaded.media.id, { expectedRevision: getDraftRecord().revision });
  restoreDraft(release.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: ['home'] }, actor);
  assert.ok(getDraftRecord().content.media.some((media) => media.id === uploaded.media.id));
  assert.deepEqual(getDraftRecord().content.editorData.home, designed);
});
