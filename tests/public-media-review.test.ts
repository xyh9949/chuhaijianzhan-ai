import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio, readRelease } from '../src/server/studio';
import { deleteMedia, uploadMedia } from '../src/server/media';
import { mediaInventory } from '../src/server/media-operations';
import { previewRestoreDraft, publishSite, restoreDraft } from '../src/server/publication';
import { buildSitePackage, commitSitePackage, previewSitePackage } from '../src/server/site-package';
import { createStarterSnapshot } from '../src/lib/starter-kits';

let directory = '', previous: NodeJS.ProcessEnv;
const actor = { id: 'public-media-review-admin', name: '公开素材审查' };
beforeEach(() => {
  previous = { ...process.env };
  directory = mkdtempSync(join(tmpdir(), 'form-studio-public-media-review-'));
  process.env.FORM_STUDIO_DATA_DIR = directory;
  process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3201';
  process.env.BETTER_AUTH_SECRET = 'public-media-review-'.repeat(4);
});
afterEach(() => {
  getDatabase().close();
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
  Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-public-media-review-`)) rmSync(directory, { recursive: true, force: true });
});
const save = (patch: object) => patchStudio({ expectedRevision: getDraftRecord().revision, patch });
async function themeHistory() {
  const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#102030' } }).png().toBuffer();
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'theme-background.png', { type: 'image/png' }));
  form.set('expectedRevision', String(getDraftRecord().revision));
  const media = (await uploadMedia(form)).media;
  const base = getDraftRecord().content;
  save({ theme: { ...base.theme, defaults: { desktop: { backgroundImage: media.url } }, presets: [{ id: 'review-background', name: '手机背景', design: { mobile: { backgroundImage: media.url } } }] } });
  const release = publishSite({ expectedRevision: getDraftRecord().revision, baseReleaseId: null, pageIds: ['home'], includeTheme: true, includeSettings: true }, actor);
  save({ theme: base.theme });
  deleteMedia(media.id, { expectedRevision: getDraftRecord().revision });
  return { media, release, theme: readRelease(release.releaseId).theme };
}

test('只恢复历史主题时补回默认样式和复用样式引用的素材，预检只读且不改公开指针', async () => {
  const { media, release, theme } = await themeHistory();
  const input = { expectedRevision: getDraftRecord().revision, pageIds: [], includeTheme: true };
  const before = getDraftRecord();
  assert.deepEqual(previewRestoreDraft(release.releaseId, input).errors, []);
  assert.deepEqual(getDraftRecord(), before);
  restoreDraft(release.releaseId, input, actor);
  assert.deepEqual(getDraftRecord().content.theme, theme);
  assert.ok(getDraftRecord().content.media.some(item => item.id === media.id), '历史主题的图片必须回到草稿素材库');
  assert.equal(getStudioEnvelope().activeReleaseId, release.releaseId);
  assert.deepEqual(getDraftRecord().content.editorData, before.content.editorData);
});

test('历史主题背景文件缺失时预检及恢复均拒绝，不能写入无法发布的主题', async () => {
  const { media, release } = await themeHistory();
  const row = getDatabase().prepare('SELECT filename FROM cms_media_file WHERE id=?').get(media.id) as { filename: string };
  unlinkSync(join(directory, 'media', row.filename));
  const before = getDraftRecord(), events = getDatabase().prepare('SELECT count(*) n FROM cms_release_event').get();
  const input = { expectedRevision: before.revision, pageIds: [], includeTheme: true };
  assert.ok(previewRestoreDraft(release.releaseId, input).errors.some(error => error.includes('历史素材缺失')));
  assert.throws(() => restoreDraft(release.releaseId, input, actor), /历史素材缺失/);
  assert.deepEqual(getDraftRecord(), before);
  assert.deepEqual(getDatabase().prepare('SELECT count(*) n FROM cms_release_event').get(), events);
});

test('真实整站包导入的JPEG和PNG原文件完整计入容量，保留项不列为清理候选', async () => {
  const source = createStarterSnapshot('manufacturing');
  source.media.push({ id: 'review-jpeg', name: 'JPEG示例', url: '/images/interior.jpg', kind: 'image', folder: '', size: '', alt: '' });
  const pkg = buildSitePackage(source, { name: '容量审查', description: '隔离测试', license: '示例素材测试' });
  assert.ok(pkg.files.some(file => file.mime === 'image/jpeg'));
  assert.ok(pkg.files.some(file => file.mime === 'image/png'));
  const input = { package: pkg, options: { mode: 'fresh', prefix: 'review', skuPrefix: '', enableJs: false }, expectedRevision: 0 };
  const preview = await previewSitePackage(input);
  await commitSitePackage({ ...input, confirmation: preview.confirmation });
  const filenames = readdirSync(join(directory, 'media'));
  const bytes = filenames.reduce((sum, filename) => sum + statSync(join(directory, 'media', filename)).size, 0);
  const inventory = mediaInventory(true);
  assert.equal(inventory.physicalFiles, filenames.length);
  assert.equal(inventory.physicalBytes, bytes);
  assert.equal(inventory.originalBytes, bytes);
  assert.equal(inventory.derivativeBytes, 0);
  assert.equal(inventory.candidateCount, 0);
});

test('真实上传的WebP原图和两张变体按完整文件后缀分别统计，不能把.webp当作变体标记', async () => {
  const bytes = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#102030' } }).png().toBuffer();
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'large-background.png', { type: 'image/png' }));
  form.set('expectedRevision', String(getDraftRecord().revision));
  const media = (await uploadMedia(form)).media;
  const original = getDatabase().prepare('SELECT filename FROM cms_media_file WHERE id=?').get(media.id) as { filename: string };
  const filenames = readdirSync(join(directory, 'media'));
  assert.equal(filenames.length, 3);
  const originalBytes = statSync(join(directory, 'media', original.filename)).size;
  const derivativeBytes = filenames.filter(filename => filename !== original.filename).reduce((sum, filename) => sum + statSync(join(directory, 'media', filename)).size, 0);
  assert.ok(originalBytes > 0 && derivativeBytes > 0);
  const inventory = mediaInventory(true);
  assert.equal(inventory.originalBytes, originalBytes);
  assert.equal(inventory.derivativeBytes, derivativeBytes);
  assert.equal(inventory.physicalBytes, originalBytes + derivativeBytes);
  assert.equal(inventory.physicalFiles, 3);
  assert.equal(inventory.candidateCount, 0);
});
