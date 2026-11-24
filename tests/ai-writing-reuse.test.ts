import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../src/server/permissions';
import type { AiExtractedSource } from '../src/lib/ai-source-types';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { readWritingReuse, validateWritingSourceRef, writingSourceRefStatus } from '../src/server/ai-writing-reuse';
import { ApiError } from '../src/server/http';

const actor: Actor = { id: 'reuse-admin', name: '资料管理员', email: 'reuse@example.invalid', role: 'admin' }, other: Actor = { id: 'reuse-other', name: '另一管理员', email: 'reuse-other@example.invalid', role: 'admin' };
let directory: string, previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-writing-reuse-')); process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data');
  getDatabase().exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const item of [actor, other]) getDatabase().prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(item.id, item.name, item.email, item.role);
  patchStudio({ expectedRevision: getDraftRecord().revision, patch: { products: [{ id: 'reuse-product', name: 'Test cabinet', sku: 'CAB-01', category: 'Cabinets', status: 'draft', material: 'Steel', description: 'Original description', image: '/images/studio.jpg' }] } }, actor);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-writing-reuse-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
function source(kind: 'pdf' | 'xlsx') {
  const id = `ais-${randomUUID()}`, stamp = new Date().toISOString(), expires = new Date(Date.now() + 3_600_000).toISOString();
  const value: AiExtractedSource = { kind, fileName: `company.${kind}`, mime: 'application/octet-stream', bytes: 100, sha256: 'a'.repeat(64), textChars: 50, warnings: [], ...(kind === 'pdf' ? { pages: [{ pageNumber: 1, text: 'Actual company quote', needsOcr: false }] } : { sheets: [] }) };
  getDatabase().prepare("INSERT INTO cms_ai_source(id,actor_id,kind,source_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,'source',NULL,-1,?,?,?)").run(id, actor.id, JSON.stringify(value), stamp, expires);
  return { id, stamp, expires };
}
function pdf() {
  const original = source('pdf'), id = `aib-${randomUUID()}`;
  const payload = { briefId: id, brief: { companyName: 'Actual company quote' }, warnings: [], sources: [{ pageNumber: 1 }], facts: [{ field: 'companyName', value: 'Actual company quote', pageNumbers: [1], evidence: [{ pageNumber: 1, quote: 'Actual company quote' }] }] };
  getDatabase().prepare("INSERT INTO cms_ai_source(id,actor_id,kind,source_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,'brief',?,-1,?,?,?)").run(id, actor.id, original.id, JSON.stringify(payload), original.stamp, original.expires);
  return { ...original, briefId: id };
}
function excel(applied = true) {
  const original = source('xlsx'), id = `aix-${randomUUID()}`;
  const payload = { spec: { format: 'json', target: 'product', content: JSON.stringify({ schemaVersion: 1, kind: 'product', rows: [{ c1: 'Test cabinet', c2: 'CAB-01', c3: 'Steel' }] }), mapping: { c1: 'builtin:name', c2: 'builtin:sku', c3: 'builtin:material' } }, sourceRows: [7], source: { sheetName: 'Products' }, productSkus: ['CAB-01'], importedProductIds: ['reuse-product'] };
  getDatabase().prepare("INSERT INTO cms_ai_source(id,actor_id,kind,source_id,base_revision,payload_json,created_at,expires_at,applied_revision) VALUES(?,?,'products',?,-1,?,?,?,?)").run(id, actor.id, original.id, JSON.stringify(payload), original.stamp, original.expires, applied ? getDraftRecord().revision : null);
  return { ...original, previewId: id };
}

test('候选读取不确认资料、不改CMS，产品事实保持指定范围', () => {
  const before = getStudioEnvelope(), value = readWritingReuse(actor, undefined, 'reuse-product');
  assert.ok(value.candidates.length >= 4); assert.ok(value.candidates.every(item => item.scope === 'product' && item.productId === 'reuse-product' && item.sourceRef.snapshot === item.text));
  assert.equal(value.candidates.find(item => item.sourceRef.locator === 'material')?.text, '材质：Steel'); assert.deepEqual(getStudioEnvelope(), before);
  assert.equal((getDatabase().prepare('SELECT config_json FROM cms_ai_writing_profile WHERE id=1').get() as { config_json: string }).config_json, '{}');
});
test('产品来源校验拒绝伪造快照、定位和跨产品范围', () => {
  const item = readWritingReuse(actor, undefined, 'reuse-product').candidates[0], fact = { text: item.text, scope: item.scope, productId: item.productId };
  assert.deepEqual(validateWritingSourceRef(item.sourceRef, actor, fact), item.sourceRef);
  assert.throws(() => validateWritingSourceRef({ ...item.sourceRef, snapshot: 'Fake source' }, actor, fact), status(409));
  assert.throws(() => validateWritingSourceRef({ ...item.sourceRef, locator: 'unknown' }, actor, fact), status(409));
  assert.throws(() => validateWritingSourceRef(item.sourceRef, actor, { ...fact, scope: 'company', productId: undefined }), status(409));
  assert.throws(() => validateWritingSourceRef({ ...item.sourceRef, unwanted: true }, actor, fact), status(422));
});
test('当前产品值变化标记changed，删除后只保留摘录状态', () => {
  const ref = readWritingReuse(actor, undefined, 'reuse-product').candidates.find(item => item.sourceRef.locator === 'material')!.sourceRef;
  assert.equal(writingSourceRefStatus(ref, actor).status, 'available');
  let env = getStudioEnvelope(); patchStudio({ expectedRevision: env.revision, patch: { products: [{ ...env.state.products[0], material: 'Aluminium' }] } }, actor);
  assert.equal(writingSourceRefStatus(ref, actor).status, 'changed');
  env = getStudioEnvelope(); patchStudio({ expectedRevision: env.revision, patch: { products: [] } }, actor);
  assert.equal(writingSourceRefStatus(ref, actor).status, 'unavailable');
});
test('PDF整理来源保留页码/版本/原快照，其他管理员不能读取原件', () => {
  const original = pdf(), item = readWritingReuse(actor, original.id).candidates[0];
  assert.equal(item.text, 'Actual company quote'); assert.equal(item.sourceRef.kind, 'pdf'); assert.equal(item.sourceRef.recordId, original.briefId); assert.match(item.source, /第1页/); assert.match(item.source, /SHA256/);
  assert.deepEqual(item.sourceRef.quotes, [{ pageNumber: 1, quote: 'Actual company quote' }]);
  assert.throws(() => validateWritingSourceRef({ ...item.sourceRef, quotes: [{ pageNumber: 1, quote: 'Fake quote' }] }, actor, { text: item.text, scope: 'company' }), status(409));
  assert.throws(() => readWritingReuse(other, original.id), status(404));
  assert.throws(() => validateWritingSourceRef(item.sourceRef, other, { text: item.text, scope: 'company' }), status(404));
  assert.equal(writingSourceRefStatus(item.sourceRef, other).status, 'unavailable');
});
test('PDF来源到期只报告不可回查，不删除已经保存的摘录', () => {
  const original = pdf(), item = readWritingReuse(actor, original.id).candidates[0];
  getDatabase().prepare('UPDATE cms_ai_writing_profile SET config_json=? WHERE id=1').run(JSON.stringify({ facts: [{ id: 'fact-existing', text: item.text, sourceRef: item.sourceRef }] }));
  getDatabase().prepare('UPDATE cms_ai_source SET expires_at=?').run('2000-01-01T00:00:00Z');
  assert.equal(readWritingReuse(actor).states['fact-existing'].status, 'unavailable');
  assert.match((getDatabase().prepare('SELECT config_json FROM cms_ai_writing_profile WHERE id=1').get() as { config_json: string }).config_json, /Actual company quote/);
});
test('Excel仅复用已应用批次的审核值，保留原行号且不猜未导入行', () => {
  const original = excel(false); assert.equal(readWritingReuse(actor, original.id).candidates.length, 0);
  getDatabase().prepare('UPDATE cms_ai_source SET applied_revision=? WHERE id=?').run(getDraftRecord().revision, original.previewId);
  const candidates = readWritingReuse(actor, original.id).candidates, material = candidates.find(item => item.sourceRef.locator.endsWith('material'))!;
  assert.equal(material.text, '材质：Steel'); assert.match(material.sourceRef.locator, /第7行/); assert.equal(material.productId, 'reuse-product');
  assert.equal(writingSourceRefStatus(material.sourceRef, actor).status, 'available');
  const env = getStudioEnvelope(); patchStudio({ expectedRevision: env.revision, patch: { products: [{ ...env.state.products[0], material: 'Aluminium' }] } }, actor);
  assert.equal(writingSourceRefStatus(material.sourceRef, actor).status, 'changed'); assert.equal(readWritingReuse(actor, original.id).candidates.find(item => item.id === material.id)?.text, '材质：Steel');
});
test('新来源不能同时选择文件和产品，停用及降权角色不能复用', () => {
  assert.throws(() => readWritingReuse(actor, 'any', 'reuse-product'), status(422));
  getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(actor.id); assert.throws(() => readWritingReuse(actor), status(403));
  getDatabase().prepare('UPDATE auth_user SET banned=1 WHERE id=?').run(other.id); assert.throws(() => readWritingReuse(other), status(401));
});
