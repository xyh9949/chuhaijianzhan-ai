import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { getActiveSiteSnapshot, publishSite } from '../src/server/publication';

let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env };
  directory = mkdtempSync(join(tmpdir(), 'studio-product-status-review-'));
  process.env.FORM_STUDIO_DATA_DIR = directory;
});
afterEach(() => {
  getDatabase().close();
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
  Object.assign(process.env, previous);
  // 只清理由本测试新建的临时实例，绝不写入或删除正式站点数据。
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-product-status-review-`)) rmSync(directory, { recursive: true, force: true });
});
function publishProduct() {
  const current = getStudioEnvelope();
  return publishSite({ expectedRevision: current.revision, baseReleaseId: current.activeReleaseId, pageIds: ['home', 'about', 'product-detail'], productIds: ['p1'], includeTheme: true, includeSettings: true }, { id: 'status-review', name: '状态审查' });
}
function editProduct(id: string, name: string) {
  const current = getDraftRecord();
  return patchStudio({ expectedRevision: current.revision, patch: { products: current.content.products.map(item => item.id === id ? { ...item, name } : item) } });
}

test('产品内容恢复为线上原值后应显示已发布，不把服务端更新时间当成待发布改动', () => {
  publishProduct();
  const active = getActiveSiteSnapshot()!, original = active.products.find(item => item.id === 'p1')!;
  assert.equal(getStudioEnvelope().state.products.find(item => item.id === 'p1')!.status, 'published');
  assert.equal(editProduct('p1', `${original.name} changed`).state.products.find(item => item.id === 'p1')!.status, 'draft');
  const restored = editProduct('p1', original.name);
  assert.ok(getDraftRecord().content.products.find(item => item.id === 'p1')!.updated);
  assert.equal(restored.state.products.find(item => item.id === 'p1')!.status, 'published');
  assert.deepEqual(getActiveSiteSnapshot(), active);
  assert.equal(restored.state.releases.length, 1);
});

test('产品业务字段有差异时仍标记草稿，其他产品编辑和重新发布不影响准确状态', () => {
  publishProduct();
  const original = getDraftRecord().content.products.find(item => item.id === 'p1')!;
  const current = getDraftRecord();
  patchStudio({ expectedRevision: current.revision, patch: { products: current.content.products.map(item => item.id === 'p1' ? { ...item, seoDescription: 'Reviewed actual change' } : item) } });
  assert.equal(getStudioEnvelope().state.products.find(item => item.id === 'p1')!.status, 'draft');
  publishProduct();
  assert.equal(getStudioEnvelope().state.products.find(item => item.id === 'p1')!.status, 'published');
  const other = getDraftRecord().content.products.find(item => item.id === 'p2')!;
  const edited = editProduct('p2', `${other.name} changed`);
  assert.equal(edited.state.products.find(item => item.id === 'p1')!.status, 'published');
  assert.equal(edited.state.products.find(item => item.id === 'p2')!.status, 'draft');
  assert.equal(getActiveSiteSnapshot()!.products.find(item => item.id === 'p1')!.name, original.name);
});
