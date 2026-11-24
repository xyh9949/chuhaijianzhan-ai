import protocol from '../src/lib/protocol.json';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Script } from 'node:vm';
import type { Data } from '@puckeditor/core';
import sharp from 'sharp';
import { getDatabase } from '../src/server/database';
import { ApiError } from '../src/server/http';
import { deleteMedia, isPublishedMedia, uploadMedia } from '../src/server/media';
import { activateRelease, getActiveSiteSnapshot, previewPublication, publishSite, restoreDraft } from '../src/server/publication';
import { getDraftRecord, getStudioEnvelope, patchStudio, readRelease } from '../src/server/studio';
import { collectReferences, validatePageData } from '../src/server/validation';
import { EMPTY_CODE, siteCodeResponse, validateSnippet } from '../src/server/site-code';
import type { DraftContent, PublicationSelection, SiteSnapshot } from '../src/server/types';
import type { SharedBlock, SiteCustomCode } from '../src/lib/types';

const actor = { id: 'shared-test-admin', name: '同步区块测试管理员' };
let directory = ''; let previousDirectory: string | undefined;
beforeEach(() => { previousDirectory = process.env.FORM_STUDIO_DATA_DIR; directory = mkdtempSync(join(tmpdir(), 'form-studio-shared-test-')); process.env.FORM_STUDIO_DATA_DIR = directory; });
afterEach(() => {
  getDatabase().close();
  // 只清理本测试生成的隔离实例；不触碰正在运行的客户数据库。
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-shared-test-`)) rmSync(directory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.FORM_STUDIO_DATA_DIR; else process.env.FORM_STUDIO_DATA_DIR = previousDirectory;
});
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const page = (...content: Data['content']): Data => ({ root: { props: { title: '测试页面' } }, content });
const reference = (id: string, blockId: string) => node('SharedBlock', id, { blockId });
const block = (id = 'shared-main', data = page(node('Text', 'shared-text', { text: '第一版' }))): SharedBlock => ({ id, name: id, data, updated: '' });
function save(patch: Partial<DraftContent>) { return patchStudio({ expectedRevision: getDraftRecord().revision, patch }); }
function selection(overrides: Partial<PublicationSelection> = {}): PublicationSelection {
  const current = getStudioEnvelope();
  return { expectedRevision: current.revision, baseReleaseId: current.activeReleaseId, pageIds: ['home', 'about'], productIds: [], includeTheme: true, includeSettings: true, ...overrides };
}
function setup(blocks = [block()]) {
  const draft = getDraftRecord().content;
  save({ sharedBlocks: blocks, editorData: { ...draft.editorData, home: page(reference('home-ref', blocks[0].id)), about: page(reference('about-ref', blocks[0].id)) } });
}
function rejects422(action: () => unknown, message?: RegExp) {
  assert.throws(action, (error) => error instanceof ApiError && error.status === 422 && (!message || message.test(error.message)));
}
async function upload(name: string) {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#223344' } }).png().toBuffer();
  const form = new FormData(); form.set('file', new File([bytes], `${name}.png`, { type: 'image/png' })); form.set('expectedRevision', String(getDraftRecord().revision));
  return (await uploadMedia(form)).media;
}

test('同步区块必须显式发布；仅发布区块会同步所有引用页并保留未选页面草稿', () => {
  setup();
  assert.ok(previewPublication(selection()).errors.some((error) => error.includes('shared-main')));
  rejects422(() => publishSite(selection(), actor));
  const first = publishSite(selection({ sharedBlockIds: ['shared-main'] }), actor);
  const before = readRelease(first.releaseId);
  const draft = getDraftRecord().content;
  save({ sharedBlocks: [block('shared-main', page(node('Text', 'shared-text', { text: '第二版' })))], editorData: { ...draft.editorData, about: page(reference('about-ref', 'shared-main'), node('Text', 'private-text', { text: '未发布的页面文字' })) } });
  const scope = selection({ pageIds: [], sharedBlockIds: ['shared-main'], includeTheme: false, includeSettings: false });
  assert.deepEqual(previewPublication(scope).summary.affectedPages.map((item) => item.id), ['home', 'about']);
  publishSite(scope, actor);
  assert.deepEqual(getActiveSiteSnapshot()!.editorData.about, before.editorData.about);
  assert.equal(getActiveSiteSnapshot()!.sharedBlocks![0].data.content[0].props.text, '第二版');
  assert.equal(readRelease(first.releaseId).sharedBlocks![0].data.content[0].props.text, '第一版');
  assert.equal(getActiveSiteSnapshot()!.schemaVersion, protocol.snapshot);
});

test('新引用不能携带未选草稿依赖；删除被页面、区块或全站布局引用的区块被拒绝', () => {
  setup(); publishSite(selection({ sharedBlockIds: ['shared-main'] }), actor);
  save({ sharedBlocks: [block('shared-main', page(reference('nested-reference', 'shared-next'))), block('shared-next')] });
  const scope = selection({ pageIds: [], sharedBlockIds: ['shared-main'], includeTheme: false, includeSettings: false });
  assert.ok(previewPublication(scope).errors.some((error) => error.includes('shared-next')));
  rejects422(() => publishSite(scope, actor));
  const before = getDraftRecord(); rejects422(() => save({ sharedBlocks: [] }), /不存在/); assert.equal(getDraftRecord().revision, before.revision);
  rejects422(() => publishSite(selection({ pageIds: [], removeSharedBlockIds: ['shared-main'], includeTheme: false, includeSettings: false }), actor), /不存在/);
  save({ siteLayout: { header: { mode: 'block', blockId: 'shared-next' }, footer: { mode: 'hidden', blockId: '' } } });
  rejects422(() => save({ sharedBlocks: [block()] }), /页眉/);
});

test('空引用可暂存，循环及超过八层引用不能保存，根节点支持独立隐藏头尾', () => {
  const draft = getDraftRecord().content;
  const empty = page(reference('empty-reference', ''));
  save({ editorData: { ...draft.editorData, home: empty } });
  rejects422(() => publishSite(selection(), actor), /同步区块引用/);
  rejects422(() => save({ sharedBlocks: [block('loop-a', page(reference('loop-ref-a', 'loop-b'))), block('loop-b', page(reference('loop-ref-b', 'loop-a')))] }), /循环/);
  const deep = Array.from({ length: 9 }, (_, index) => block(`depth-${index}`, index < 8 ? page(reference(`depth-ref-${index}`, `depth-${index + 1}`)) : page()));
  rejects422(() => save({ sharedBlocks: deep }), /8 层/);
  const repeated = [block('repeat-main', page(...Array.from({ length: 100 }, (_, index) => reference(`repeat-a-${index}`, 'repeat-child')))), block('repeat-child', page(...Array.from({ length: 100 }, (_, index) => reference(`repeat-b-${index}`, 'repeat-leaf')))), block('repeat-leaf')];
  rejects422(() => save({ sharedBlocks: repeated }), /10000 个组件/);
  const independent = { root: { props: { title: '独立头尾', headerMode: 'hidden', footerMode: 'inherit' } }, content: [] };
  assert.doesNotThrow(() => validatePageData(independent, '头尾', true));
});

test('布局显式发布，未选布局保持线上原值；共享页眉的依赖影响统计包含继承页', () => {
  setup();
  save({ siteLayout: { header: { mode: 'block', blockId: 'shared-main' }, footer: { mode: 'hidden', blockId: '' } } });
  publishSite(selection({ sharedBlockIds: ['shared-main'] }), actor);
  assert.equal(getActiveSiteSnapshot()!.siteLayout, undefined);
  publishSite(selection({ pageIds: [], includeTheme: false, includeSettings: false, includeLayout: true }), actor);
  assert.equal(getActiveSiteSnapshot()!.siteLayout?.header.blockId, 'shared-main');
  save({ siteLayout: { header: { mode: 'hidden', blockId: '' }, footer: { mode: 'default', blockId: '' } } });
  publishSite(selection({ pageIds: ['home'], includeTheme: false, includeSettings: false }), actor);
  assert.equal(getActiveSiteSnapshot()!.siteLayout?.header.mode, 'block');
});

test('嵌套代码不能绕过管理员入口，禁用的残缺 JS 可保存，启用时给出语法位置且不执行', () => {
  const draft = getDraftRecord().content;
  const attempted = page(node('Text', 'unsafe', { text: '正文', options: { javascript: 'globalThis.bad = true' } }));
  rejects422(() => save({ editorData: { ...draft.editorData, home: attempted } }), /管理员自定义代码/);
  const code: SiteCustomCode = { global: { ...EMPTY_CODE, css: '@layer brand { :root { --fluid: clamp(1rem, 2vw, 2rem); } }', cssEnabled: true, js: 'const incomplete =' }, pages: {} };
  save({ customCode: code });
  rejects422(() => save({ customCode: { ...code, global: { ...code.global, jsEnabled: true } } }), /第 1 行/);
  validateSnippet({ ...EMPTY_CODE, jsEnabled: true, js: 'globalThis.__cmsServerShouldNeverRun = true;' });
  assert.equal((globalThis as Record<string, unknown>).__cmsServerShouldNeverRun, undefined);
  rejects422(() => validateSnippet({ ...EMPTY_CODE, css: '中'.repeat(40_000) }), /100 KB/);
  const before = getDraftRecord();
  rejects422(() => save({ customCode: { global: { ...EMPTY_CODE }, pages: { 'missing-page': { ...EMPTY_CODE } } } }), /对应页面/);
  assert.equal(getDraftRecord().revision, before.revision);
});

test('全站与页面代码按整套显式发布，公共资源只读历史快照且禁用源码不输出', async () => {
  setup();
  const oldCode: SiteCustomCode = { global: { ...EMPTY_CODE, css: 'body {color:red}', cssEnabled: true, js: 'window.oldVersion = true;', jsEnabled: true }, pages: { home: { ...EMPTY_CODE, js: 'window.homeVersion = true;', jsEnabled: true }, about: { ...EMPTY_CODE, js: 'privateDisabledCode', jsEnabled: false } } };
  save({ customCode: oldCode });
  const first = publishSite(selection({ sharedBlockIds: ['shared-main'], includeCode: true }), actor);
  save({ customCode: { ...oldCode, global: { ...oldCode.global, js: 'window.newDraft = true;' } } });
  publishSite(selection({ pageIds: ['home'], includeTheme: false, includeSettings: false }), actor);
  const active = getActiveSiteSnapshot()!;
  assert.equal(active.customCode!.global.js, oldCode.global.js);
  const globalAsset = siteCodeResponse(active, 'global', 'js');
  assert.match(globalAsset.headers.get('content-type')!, /javascript/); assert.equal(globalAsset.headers.get('x-content-type-options'), 'nosniff'); assert.match(globalAsset.headers.get('cache-control')!, /immutable/);
  const source = await globalAsset.text(); assert.match(source, /try/); assert.match(source, /oldVersion/); assert.doesNotMatch(source, /homeVersion|newDraft/);
  assert.equal(await siteCodeResponse(active, 'about', 'js').text(), '');
  assert.match(await siteCodeResponse(active, 'home', 'js').text(), /homeVersion/);
  assert.throws(() => siteCodeResponse(active, 'contact', 'js'), (error) => error instanceof ApiError && error.status === 404);
  assert.throws(() => siteCodeResponse(active, 'global', 'map'), (error) => error instanceof ApiError && error.status === 404);
  const hashbang = structuredClone(active); hashbang.customCode!.global.js = '#!/usr/bin/env node\n"use strict";\nwindow.hashbangExample = true;';
  const wrapped = await siteCodeResponse(hashbang, 'global', 'js').text();
  assert.doesNotThrow(() => new Script(wrapped)); assert.match(wrapped, /function \(\) \{\n\/\/\/usr\/bin\/env node\n"use strict"/);
  publishSite(selection({ pageIds: [], includeTheme: false, includeSettings: false, includeCode: true, removePageIds: ['about'] }), actor);
  assert.equal(getActiveSiteSnapshot()!.customCode!.pages.about, undefined);
  assert.equal(readRelease(first.releaseId).customCode!.global.js, oldCode.global.js);
});

test('同步区块三端背景及 CSS 素材受删除保护，未选草稿素材与元数据不泄漏', async () => {
  const used = await upload('shared-background'); const codeMedia = await upload('code-background'); const privateMedia = await upload('private-background');
  const design = { desktop: { backgroundImage: used.url }, tablet: { backgroundImage: used.url }, mobile: { backgroundImage: used.url } };
  setup([block('shared-main', page(node('Container', 'shared-container', { content: [], design })))]);
  save({ customCode: { global: { ...EMPTY_CODE, css: `.banner {background-image:url('${codeMedia.url}');}`, cssEnabled: true }, pages: {} } });
  assert.ok(collectReferences(getDraftRecord().content).urls.has(codeMedia.url));
  rejects422(() => deleteMedia(codeMedia.id, { expectedRevision: getDraftRecord().revision }), /仍被/);
  rejects422(() => deleteMedia(used.id, { expectedRevision: getDraftRecord().revision }), /仍被/);
  publishSite(selection({ sharedBlockIds: ['shared-main'] }), actor);
  assert.equal(isPublishedMedia(used.id), true); assert.equal(isPublishedMedia(codeMedia.id), false); assert.equal(isPublishedMedia(privateMedia.id), false);
  const draft = getDraftRecord().content;
  save({ media: draft.media.map((item) => item.id === used.id ? { ...item, alt: '未发布素材说明' } : item), sharedBlocks: [...draft.sharedBlocks!, block('private-block', page(node('Image', 'private-image', { src: privateMedia.url })))] });
  publishSite(selection({ pageIds: ['about'], includeTheme: false, includeSettings: false }), actor);
  assert.equal(getActiveSiteSnapshot()!.media.find((item) => item.id === used.id)!.alt, '');
  assert.equal(isPublishedMedia(privateMedia.id), false);
  publishSite(selection({ pageIds: [], includeTheme: false, includeSettings: false, includeCode: true }), actor);
  assert.equal(isPublishedMedia(codeMedia.id), true); assert.equal(isPublishedMedia(privateMedia.id), false);
});

test('恢复区块、布局、代码范围彼此独立；缺少历史依赖时整次恢复回滚', () => {
  setup();
  const layout = { header: { mode: 'block' as const, blockId: 'shared-main' }, footer: { mode: 'hidden' as const, blockId: '' } };
  save({ siteLayout: layout, customCode: { global: { ...EMPTY_CODE, css: 'body {color:green}', cssEnabled: true }, pages: {} } });
  const first = publishSite(selection({ sharedBlockIds: ['shared-main'], includeLayout: true, includeCode: true }), actor);
  save({ sharedBlocks: [], siteLayout: { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' } }, editorData: { ...getDraftRecord().content.editorData, home: page(), about: page() }, customCode: { global: { ...EMPTY_CODE, css: 'body {color:blue}', cssEnabled: true }, pages: {} } });
  const before = getDraftRecord();
  rejects422(() => restoreDraft(first.releaseId, { expectedRevision: before.revision, pageIds: ['home'] }, actor), /shared-main/);
  assert.deepEqual(getDraftRecord(), before);
  restoreDraft(first.releaseId, { expectedRevision: before.revision, pageIds: ['home'], sharedBlockIds: ['shared-main'], includeLayout: true }, actor);
  assert.deepEqual(getDraftRecord().content.siteLayout, layout);
  assert.equal(getDraftRecord().content.customCode!.global.css, 'body {color:blue}');
  restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: [], includeCode: true }, actor);
  assert.equal(getDraftRecord().content.customCode!.global.css, 'body {color:green}');
  assert.equal(getStudioEnvelope().activeReleaseId, first.releaseId);
});

test('旧 schemaVersion 1 发布仍可读取、激活和恢复，不要求迁移客户草稿', async () => {
  const first = publishSite(selection(), actor);
  const legacy: SiteSnapshot = { ...readRelease(first.releaseId), schemaVersion: 1, releaseId: 'legacy-release' };
  delete legacy.sharedBlocks; delete legacy.siteLayout; delete legacy.customCode; delete legacy.contentModels; delete legacy.contentEntries;
  getDatabase().prepare('INSERT INTO cms_release (id, title, manifest_json, manifest_hash, schema_version, renderer_version, created_by, author_name, created_at, selection_json) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)').run('legacy-release', '旧发布', JSON.stringify(legacy), 'legacy-test-hash', actor.id, actor.name, new Date().toISOString(), JSON.stringify(selection()));
  activateRelease('legacy-release', { expectedActiveReleaseId: first.releaseId }, actor);
  assert.equal(getActiveSiteSnapshot()!.schemaVersion, 1);
  assert.equal(await siteCodeResponse(readRelease('legacy-release'), 'global', 'js').text(), '');
  restoreDraft('legacy-release', { expectedRevision: getDraftRecord().revision, pageIds: ['home'], includeCode: true, includeLayout: true }, actor);
  assert.equal(getDraftRecord().content.siteLayout, undefined);
  assert.equal(getDraftRecord().content.customCode!.global.css, '');
});

test('真实 schemaVersion 2 快照保留同步区块、布局与代码，仍可读取、激活和选择恢复', async () => {
  setup();
  const layout = { header: { mode: 'block' as const, blockId: 'shared-main' }, footer: { mode: 'hidden' as const, blockId: '' } };
  const code: SiteCustomCode = { global: { ...EMPTY_CODE, css: '.legacy-v2 {color:green}', cssEnabled: true, js: 'window.legacyV2 = true;', jsEnabled: true }, pages: { home: { ...EMPTY_CODE, css: '.legacy-home {color:blue}', cssEnabled: true } } };
  save({ siteLayout: layout, customCode: code });
  const first = publishSite(selection({ sharedBlockIds: ['shared-main'], includeLayout: true, includeCode: true }), actor);
  // 按旧版本真实结构构造历史记录：含全站设计数据，不含本轮新增的模型与内容集合。
  const legacy: SiteSnapshot = { ...readRelease(first.releaseId), schemaVersion: 2, releaseId: 'legacy-v2-release' };
  delete legacy.contentModels; delete legacy.contentEntries;
  getDatabase().prepare('INSERT INTO cms_release (id, title, manifest_json, manifest_hash, schema_version, renderer_version, created_by, author_name, created_at, selection_json) VALUES (?, ?, ?, ?, 2, 2, ?, ?, ?, ?)').run(legacy.releaseId, '旧全站设计发布', JSON.stringify(legacy), 'legacy-v2-test-hash', actor.id, actor.name, new Date().toISOString(), JSON.stringify({ pageIds: ['home', 'about'], sharedBlockIds: ['shared-main'], includeLayout: true, includeCode: true }));
  const loaded = readRelease('legacy-v2-release');
  assert.equal(loaded.schemaVersion, 2);
  assert.equal(loaded.contentModels, undefined); assert.equal(loaded.contentEntries, undefined);
  assert.deepEqual(getDatabase().prepare('SELECT schema_version, renderer_version FROM cms_release WHERE id = ?').get('legacy-v2-release'), { schema_version: 2, renderer_version: 2 });
  assert.deepEqual(loaded.siteLayout, layout); assert.deepEqual(loaded.customCode, code);
  assert.match(await siteCodeResponse(loaded, 'global', 'js').text(), /legacyV2/);

  save({ sharedBlocks: [block('shared-main', page(node('Text', 'shared-text', { text: '当前未发布草稿' })))], siteLayout: { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' } }, customCode: { global: { ...EMPTY_CODE, css: 'body {color:red}', cssEnabled: true }, pages: {} } });
  const before = getDraftRecord();
  activateRelease('legacy-v2-release', { expectedActiveReleaseId: first.releaseId }, actor);
  assert.equal(getActiveSiteSnapshot()!.schemaVersion, 2);
  assert.equal(getActiveSiteSnapshot()!.sharedBlocks![0].data.content[0].props.text, '第一版');
  assert.deepEqual(getDraftRecord(), before);

  restoreDraft('legacy-v2-release', { expectedRevision: before.revision, pageIds: ['home'], sharedBlockIds: ['shared-main'], includeCode: true, includeLayout: true }, actor);
  const restored = getDraftRecord().content;
  assert.deepEqual(restored.editorData.home, loaded.editorData.home);
  assert.equal(restored.sharedBlocks![0].data.content[0].props.text, '第一版');
  assert.deepEqual(restored.siteLayout, layout); assert.deepEqual(restored.customCode, code);
  assert.equal(getStudioEnvelope().activeReleaseId, 'legacy-v2-release');
});
