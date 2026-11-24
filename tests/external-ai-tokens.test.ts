import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';
import { createExternalAiToken, listExternalAiTokens, revokeExternalAiToken, requireExternalAiGrant, revalidateExternalAiGrant } from '../src/server/external-ai-tokens';

const admin: Actor = { id: 'external-owner', name: '连接管理员', email: 'owner@example.invalid', role: 'admin' };
const other: Actor = { id: 'external-other', name: '其他管理员', email: 'other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'external-editor', name: '编辑员', email: 'editor@example.invalid', role: 'editor' };
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
let previous: NodeJS.ProcessEnv, directory = '';
const credential = (extra: Record<string, unknown> = {}) => createExternalAiToken({ name: '外部设计助手', ...extra }, admin);
const request = (token: string, extra: Record<string, string> = {}) => new Request('http://127.0.0.1:3295/mcp', { headers: { Authorization: `Bearer ${token}`, ...extra } });
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-ai-tokens-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'external-token-unit-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3295';
  getDraftRecord(); const draft = createEmptyDraft(); draft.pages.push({ ...draft.pages[0], id: 'contact', title: 'Contact', slug: '/contact' });
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(draft));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-external-ai-tokens-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('连接只一次返回随机明文，列表/私表/审计不泄露完整凭据，网站内容不变', () => {
  const before = getStudioEnvelope(), result = credential(), second = credential();
  assert.match(result.token, /^fsai_[A-Za-z0-9_-]{43}$/); assert.notEqual(result.token, second.token);
  assert.deepEqual(result.credential.scopes, ['read', 'propose']); assert.equal(result.credential.pageIds, null);
  assert.deepEqual(result.credential.recordIds, { productIds: [], entryIds: [] });
  const row = getDatabase().prepare('SELECT * FROM cms_external_ai_token WHERE id=?').get(result.credential.id) as { token_hash: string };
  assert.equal(row.token_hash, createHash('sha256').update(result.token).digest('hex'));
  const visible = listExternalAiTokens(admin); assert.equal(visible.length, 2);
  assert.equal(JSON.stringify(visible).includes(result.token), false); assert.equal(JSON.stringify(visible).includes(row.token_hash), false);
  assert.equal(JSON.stringify(row).includes(result.token), false);
  assert.equal(JSON.stringify(getDatabase().prepare('SELECT * FROM cms_audit').all()).includes(result.token), false);
  assert.deepEqual(getStudioEnvelope(), before);
});

test('文章与搜索权限独立授权，不以旧全站设计或伪造grant扩大内容范围', () => {
  const old = credential(), oldGrant = requireExternalAiGrant(request(old.token));
  for (const scope of ['content:read', 'content:propose', 'seo:read', 'seo:propose'] as const) assert.throws(() => revalidateExternalAiGrant(oldGrant, scope), status(403));
  assert.throws(() => credential({ scopes: ['read', 'content:read'] }), status(422));
  assert.throws(() => credential({ scopes: ['read', 'content:propose'], recordIds: { productIds: null, entryIds: null } }), status(422));
  const selected = credential({ scopes: ['read', 'content:read', 'content:propose', 'seo:read'], recordIds: { productIds: [], entryIds: [] } });
  const grant = requireExternalAiGrant(request(selected.token));
  assert.throws(() => revalidateExternalAiGrant(grant, 'content:propose', { createKind: 'entry' }), status(403));
  assert.throws(() => revalidateExternalAiGrant({ ...grant, recordIds: { productIds: null, entryIds: null } }, 'content:propose', { productIds: ['private'] }), status(403));
  assert.throws(() => revalidateExternalAiGrant(grant, 'seo:propose'), status(403));
  const all = credential({ scopes: ['read', 'content:read', 'content:propose', 'seo:read', 'seo:propose'], recordIds: { productIds: null, entryIds: null } });
  const whole = requireExternalAiGrant(request(all.token));
  assert.equal(revalidateExternalAiGrant(whole, 'content:propose', { createKind: 'product' }).tokenId, whole.tokenId);
  getDatabase().prepare('UPDATE cms_external_ai_token SET record_ids_json=? WHERE id=?').run('{"productIds":[],"entryIds":[]}', all.credential.id);
  assert.throws(() => revalidateExternalAiGrant(whole, 'content:propose', { createKind: 'product' }), status(403));
  assert.throws(() => revalidateExternalAiGrant(whole, 'seo:read', { entryIds: ['previously-authorized'] }), status(403));
});

test('机器入口只读取Bearer，不使用Cookie或URL凭据；非法scheme和随机凭据均拒绝', () => {
  const created = credential();
  assert.equal(requireExternalAiGrant(request(created.token)).actor.id, admin.id);
  assert.equal(requireExternalAiGrant(new Request('http://127.0.0.1:3295/mcp', { headers: { Authorization: `bearer ${created.token}` } })).tokenId, created.credential.id);
  for (const value of [
    new Request(`http://127.0.0.1:3295/mcp?access_token=${created.token}`),
    new Request('http://127.0.0.1:3295/mcp', { headers: { Cookie: 'better-auth.session_token=not-a-machine-token' } }),
    request(created.token, { Authorization: `Basic ${created.token}` }),
    request(created.token, { Authorization: `Bearer ${created.token},Bearer ${created.token}` }),
    request(`fsai_${'A'.repeat(43)}`),
  ]) assert.throws(() => requireExternalAiGrant(value), status(401));
});

test('只读和限定页面凭据不能扩大为生成、其他页面或全站操作', () => {
  const read = credential({ scopes: ['read'], pageIds: ['home'] }), grant = requireExternalAiGrant(request(read.token));
  assert.throws(() => requireExternalAiGrant(request(read.token), 'propose'), status(403));
  assert.equal(revalidateExternalAiGrant(grant, 'read', { pageIds: ['home'] }).tokenId, grant.tokenId);
  assert.throws(() => revalidateExternalAiGrant(grant, 'read', { pageIds: ['contact'] }), status(403));
  assert.throws(() => revalidateExternalAiGrant(grant, 'read', { global: true }), status(403));
  assert.throws(() => revalidateExternalAiGrant({ ...grant, scopes: ['read', 'propose'], pageIds: null }, 'propose'), status(403));
});

test('长任务提交前重新检查吊销、权限收窄和负责人角色，不信任缓存grant', () => {
  const created = credential(), grant = requireExternalAiGrant(request(created.token), 'propose');
  getDatabase().prepare('UPDATE cms_external_ai_token SET scopes_json=? WHERE id=?').run('["read"]', created.credential.id);
  assert.throws(() => revalidateExternalAiGrant(grant, 'propose'), status(403));
  getDatabase().prepare('UPDATE cms_external_ai_token SET scopes_json=?,page_ids_json=? WHERE id=?').run('["read","propose"]', '["home"]', created.credential.id);
  assert.throws(() => revalidateExternalAiGrant(grant, 'propose', { pageIds: ['contact'] }), status(403));
  getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('editor', admin.id);
  assert.throws(() => revalidateExternalAiGrant(grant, 'read'), status(403));
  getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('admin', admin.id);
  revokeExternalAiToken(created.credential.id, admin);
  assert.throws(() => revalidateExternalAiGrant(grant, 'read'), status(401));
});

test('过期、停用、负责人删除与无效私有策略立即使凭据失效', () => {
  const created = credential(), db = getDatabase();
  db.prepare('UPDATE cms_external_ai_token SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', created.credential.id);
  assert.throws(() => requireExternalAiGrant(request(created.token)), status(401));
  db.prepare('UPDATE cms_external_ai_token SET expires_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', created.credential.id);
  db.prepare('UPDATE auth_user SET banned=1,banExpires=NULL WHERE id=?').run(admin.id);
  assert.throws(() => requireExternalAiGrant(request(created.token)), status(401));
  db.prepare('UPDATE auth_user SET banned=0 WHERE id=?').run(admin.id);
  db.prepare('UPDATE cms_external_ai_token SET page_ids_json=? WHERE id=?').run('[]', created.credential.id);
  assert.throws(() => requireExternalAiGrant(request(created.token)), status(401));
  db.prepare('UPDATE cms_external_ai_token SET page_ids_json=? WHERE id=?').run('null', created.credential.id);
  db.prepare('DELETE FROM auth_user WHERE id=?').run(admin.id);
  assert.throws(() => requireExternalAiGrant(request(created.token)), status(401));
});

test('管理员只能查看与撤销自己的连接；幂等撤销不重复写审计', () => {
  const created = credential();
  assert.equal(listExternalAiTokens(other).length, 0); assert.throws(() => revokeExternalAiToken(created.credential.id, other), status(404));
  const first = revokeExternalAiToken(created.credential.id, admin), second = revokeExternalAiToken(created.credential.id, admin);
  assert.ok(first.revokedAt); assert.deepEqual(first, second);
  assert.equal((getDatabase().prepare("SELECT count(*) n FROM cms_audit WHERE action='external.ai.token.revoke'").get() as { n: number }).n, 1);
  assert.throws(() => requireExternalAiGrant(request(created.token)), status(401));
});

test('管理操作重查当前角色和停用状态，旧Actor不能保留管理员权限', () => {
  const created = credential();
  assert.throws(() => createExternalAiToken({ name: '无权创建' }, editor), status(403));
  getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('viewer', admin.id);
  assert.throws(() => listExternalAiTokens(admin), status(403));
  assert.throws(() => credential(), status(403));
  assert.throws(() => revokeExternalAiToken(created.credential.id, admin), status(403));
  getDatabase().prepare('UPDATE auth_user SET role=?,banned=1 WHERE id=?').run('admin', admin.id);
  assert.throws(() => listExternalAiTokens(admin), status(401));
});

test('无效scope、期限、页面和未知字段在创建前拒绝，不能以空范围冒充全站', () => {
  for (const value of [
    { name: '' }, { name: 'x', scopes: ['propose'] }, { name: 'x', scopes: ['read', 'publish'] }, { name: 'x', scopes: ['read', 'read'] },
    { name: 'x', scopes: null }, { name: 'x', expiresInDays: 0 }, { name: 'x', expiresInDays: 366 }, { name: 'x', expiresInDays: null },
    { name: 'x', pageIds: [] }, { name: 'x', pageIds: ['home', 'home'] }, { name: 'x', pageIds: ['not-a-page'] }, { name: 'x', script: 'untrusted' },
  ]) assert.throws(() => createExternalAiToken(value, admin), status(422));
  assert.equal(listExternalAiTokens(admin).length, 0);
});

test('页面被删除后原限定仍保留，不将空的有效页面集合解释成全站', () => {
  const created = credential({ pageIds: ['contact'] }), db = getDatabase();
  const draft = getDraftRecord().content; draft.pages = draft.pages.filter(page => page.id !== 'contact');
  db.prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(draft));
  const grant = requireExternalAiGrant(request(created.token)); assert.deepEqual(grant.pageIds, ['contact']);
  assert.throws(() => revalidateExternalAiGrant(grant, 'read', { global: true }), status(403));
  assert.throws(() => credential({ pageIds: ['contact'] }), status(422));
});

test('最近使用时间只保留私有时间戳；无权限调用不写使用记录', () => {
  const created = credential({ scopes: ['read'] }), db = getDatabase();
  assert.throws(() => requireExternalAiGrant(request(created.token), 'propose'), status(403));
  assert.equal(listExternalAiTokens(admin)[0].lastUsedAt, null);
  requireExternalAiGrant(request(created.token)); const first = listExternalAiTokens(admin)[0].lastUsedAt; assert.ok(first);
  requireExternalAiGrant(request(created.token)); assert.equal(listExternalAiTokens(admin)[0].lastUsedAt, first);
  db.prepare('UPDATE cms_external_ai_token SET last_used_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', created.credential.id);
  requireExternalAiGrant(request(created.token)); assert.notEqual(listExternalAiTokens(admin)[0].lastUsedAt, '2000-01-01T00:00:00.000Z');
});

test('限制同时可用连接数量，撤销后可创建新连接而保留历史', () => {
  const issued = Array.from({ length: 50 }, () => credential());
  assert.throws(() => credential(), status(429));
  revokeExternalAiToken(issued[0].credential.id, admin); const next = credential();
  assert.equal(listExternalAiTokens(admin).length, 51); assert.equal(requireExternalAiGrant(request(next.token)).actor.id, admin.id);
});

test('超过100条最新撤销历史也不会遮住较早的可用连接，管理员仍能撤销', () => {
  const active = credential(), db = getDatabase();
  db.prepare('UPDATE cms_external_ai_token SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', active.credential.id);
  const insert = db.prepare('INSERT INTO cms_external_ai_token(id,actor_id,name,token_hash,token_hint,scopes_json,page_ids_json,created_at,expires_at,revoked_at,last_used_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)');
  for (let index = 0; index < 105; index++) insert.run(`eait-${randomUUID()}`, admin.id, `已撤销连接${index}`, createHash('sha256').update(`synthetic-revoked-history-${index}`).digest('hex'), 'fsai_••••test', '["read"]', 'null', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  const visible = listExternalAiTokens(admin);
  assert.equal(visible.length, 100); assert.equal(visible[0].id, active.credential.id); assert.ok(visible.slice(1).every(item => item.revokedAt));
  revokeExternalAiToken(active.credential.id, admin);
  assert.throws(() => requireExternalAiGrant(request(active.token)), status(401));
});
