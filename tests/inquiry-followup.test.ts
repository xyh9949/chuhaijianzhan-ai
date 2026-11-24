import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type { InquiryFollowUp } from '../src/lib/types';
import protocol from '../src/lib/protocol.json';
import { getDatabase } from '../src/server/database';
import { ApiError } from '../src/server/http';
import { listInquiryAssignees, listInquiryFollowUps } from '../src/server/inquiry-followup';
import { listNotificationJobs } from '../src/server/notification-jobs';
import type { Actor } from '../src/server/permissions';
import { activateRelease, publishSite, restoreDraft } from '../src/server/publication';
import { createEmptyDraft } from '../src/server/seed';
import { exportSitePackage } from '../src/server/site-package';
import { createInquiry, getDraftRecord, getStudioEnvelope, listInquiries, patchStudio, readRelease, updateInquiry } from '../src/server/studio';

const ops = createRequire(import.meta.url)('../scripts/operations.cjs');
const admin: Actor = { id: 'admin-1', name: '管理员原名', email: 'admin@example.invalid', role: 'admin' };
const editor: Actor = { id: 'editor-1', name: '销售原名', email: 'editor@example.invalid', role: 'editor' };
const viewer: Actor = { id: 'viewer-1', name: '只读成员', email: 'viewer@example.invalid', role: 'viewer' };
let directory = ''; let previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-followup-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data');
  process.env.BETTER_AUTH_SECRET = 'followup-test-secret-'.repeat(4);
  process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3299';
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock';
  getDraftRecord();
  // 独立临时库只建跟进规则所需的成员列，不使用客户实例或真实通知服务。
  const db = getDatabase();
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const member of [admin, editor, viewer]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(member.id, member.name, member.email, member.role);
});
afterEach(() => {
  getDatabase().close();
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
  Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-followup-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function create() { return createInquiry({ name: '合成买家', email: 'buyer@example.invalid', message: '仅供跟进验收' }).item; }
function row(id: string) { return getDatabase().prepare('SELECT revision,payload_json,created_at,updated_at FROM cms_inquiry WHERE id=?').get(id) as { revision: number; payload_json: string; created_at: string; updated_at: string }; }
function errorStatus(status: number) { return (error: unknown) => error instanceof ApiError && error.status === status; }
function history(count: number): InquiryFollowUp[] { return Array.from({ length: count }, (_, index) => ({ id: `prior-${index}`, note: '历史备注'.repeat(200), createdAt: new Date(Date.parse('2026-11-01T00:00:00.000Z') + index * 1000).toISOString(), actorId: editor.id, actorName: editor.name })); }

test('旧询盘只读不回填默认值，来源不凭空补为人工录入', () => {
  const item = create(); const stored = JSON.parse(row(item.id).payload_json); delete stored.origin;
  getDatabase().prepare('UPDATE cms_inquiry SET payload_json=? WHERE id=?').run(JSON.stringify(stored), item.id);
  const before = row(item.id), summary = listInquiries()[0];
  assert.equal(summary.followUpCount, 0); assert.equal(summary.priority, undefined); assert.equal(summary.qualification, undefined);
  assert.equal(summary.assigneeAvailable, undefined); assert.equal(summary.origin, undefined);
  assert.deepEqual(listInquiryFollowUps(item.id), { items: [], revision: 0 });
  assert.deepEqual(getStudioEnvelope().state.inquiries[0], summary); assert.deepEqual(row(item.id), before);
  assert.equal(create().origin, 'manual');
});

test('负责人仅为活跃管理或编辑成员，改名降权停用和删除保留历史姓名', () => {
  const db = getDatabase();
  db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,1,?)').run('expired-editor', '过期停用', 'expired@example.invalid', 'editor', Date.now() - 1000);
  db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,1,NULL)').run('disabled-editor', '停用销售', 'disabled@example.invalid', 'editor');
  const candidates = listInquiryAssignees();
  assert.deepEqual(candidates.map(member => member.id).sort(), [admin.id, editor.id, 'expired-editor'].sort());
  assert.ok(candidates.every(member => Object.keys(member).sort().join(',') === 'id,name,role'));
  const item = create();
  for (const assigneeId of [viewer.id, 'disabled-editor', 'missing']) assert.throws(() => updateInquiry(item.id, { expectedRevision: 0, assigneeId }, admin), errorStatus(422));
  updateInquiry(item.id, { expectedRevision: 0, assigneeId: editor.id, followUpNote: '已由销售接手' }, admin);
  db.prepare('UPDATE auth_user SET name=? WHERE id=?').run('销售新名', editor.id);
  assert.equal(listInquiries()[0].assignee?.name, editor.name); assert.equal(listInquiries()[0].assigneeAvailable, true);
  db.prepare('UPDATE auth_user SET role=? WHERE id=?').run('viewer', editor.id);
  assert.equal(listInquiries()[0].assigneeAvailable, false);
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 1, assigneeId: editor.id }, admin), errorStatus(422));
  updateInquiry(item.id, { expectedRevision: 1, status: 'contacted' }, admin);
  db.prepare('UPDATE auth_user SET role=?,banned=1 WHERE id=?').run('editor', editor.id);
  assert.equal(listInquiries()[0].assigneeAvailable, false);
  db.prepare('DELETE FROM auth_user WHERE id=?').run(editor.id);
  assert.deepEqual(listInquiries()[0].assignee, { id: editor.id, name: editor.name }); assert.equal(listInquiries()[0].assigneeAvailable, false);
  assert.equal(listInquiryFollowUps(item.id).items[0].actorName, admin.name);
  const cleared = updateInquiry(item.id, { expectedRevision: 2, assigneeId: null }, admin).item;
  assert.equal(cleared.assignee, undefined); assert.equal(cleared.assigneeAvailable, undefined);
});

test('跟进与普通状态共享版本和事务，作者时间由服务端生成且不通知', () => {
  const item = create(), beforeDraft = getDraftRecord().revision, lower = Date.now();
  const updated = updateInquiry(item.id, { expectedRevision: 0, assigneeId: editor.id, priority: 'urgent', qualification: 'qualified', nextFollowUpAt: '2026-11-12T01:30:00.000Z', followUpNote: '  已确认需求，等待图纸  ', status: 'contacted', notes: '旧处理备注保留' }, editor).item;
  const detail = listInquiryFollowUps(item.id), saved = JSON.parse(row(item.id).payload_json);
  assert.equal(updated.revision, 1); assert.equal(detail.revision, 1); assert.equal(updated.followUpCount, 1); assert.equal(updated.status, 'contacted');
  assert.equal(updated.priority, 'urgent'); assert.equal(updated.qualification, 'qualified'); assert.equal(updated.assigneeAvailable, true);
  assert.equal(detail.items[0].note, '已确认需求，等待图纸'); assert.equal(detail.items[0].actorId, editor.id); assert.equal(detail.items[0].actorName, editor.name);
  assert.match(detail.items[0].id, /^follow-up-/); assert.ok(Date.parse(detail.items[0].createdAt) >= lower && Date.parse(detail.items[0].createdAt) <= Date.now());
  assert.equal(updated.lastFollowUpAt, detail.items[0].createdAt); assert.equal(Object.hasOwn(updated, 'followUps'), false);
  assert.equal(Object.hasOwn(saved, 'assigneeAvailable'), false); assert.equal(Object.hasOwn(saved, 'followUpCount'), false); assert.equal(Object.hasOwn(saved, 'lastFollowUpAt'), false);
  const beforeConflict = row(item.id);
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 0, followUpNote: '冲突不能追加', priority: 'normal', notes: '冲突不能覆盖' }, admin), errorStatus(409));
  assert.deepEqual(row(item.id), beforeConflict);
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 1, followUpNote: '非法负责人不能半保存', assigneeId: viewer.id, status: 'archived' }, editor), errorStatus(422));
  assert.deepEqual(row(item.id), beforeConflict);
  const legacy = updateInquiry(item.id, { expectedRevision: 1, notes: '旧入口更新' }).item;
  assert.equal(legacy.followUpCount, 1); assert.equal(legacy.notes, '旧入口更新'); assert.deepEqual(listInquiryFollowUps(item.id).items, detail.items);
  assert.equal(getDraftRecord().revision, beforeDraft); assert.deepEqual(listNotificationJobs(), []);
});

test('拒绝伪造历史作者和派生字段，校验权限枚举时间与文本后不写半成品', () => {
  const item = create(), original = row(item.id);
  const invalid = [ { followUps: [] }, { actorId: 'someone' }, { actorName: '假作者' }, { createdAt: '2020-01-01' }, { followUpCount: 9 }, { lastFollowUpAt: '2020-01-01' }, { assigneeAvailable: true }, { assignee: { id: editor.id, name: '伪造姓名' } }, { status: ['new'] }, { priority: ['normal'] }, { priority: 'low' }, { qualification: ['qualified'] }, { qualification: 'won' }, { followUpNote: '' }, { followUpNote: '   ' }, { followUpNote: '字'.repeat(2001) }, { nextFollowUpAt: '' }, { nextFollowUpAt: '2026-11-12T01:30' }, { nextFollowUpAt: '2026-11-12T09:30:00.000+08:00' }, { nextFollowUpAt: '2026-02-30T01:30:00.000Z' } ];
  for (const patch of invalid) {
    assert.throws(() => updateInquiry(item.id, { expectedRevision: 0, status: 'contacted', ...patch }, admin), errorStatus(422));
    assert.deepEqual(row(item.id), original);
  }
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 0, followUpNote: '只读不可写' }, viewer), errorStatus(403));
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 0, notes: '只读不可改旧备注' }, viewer), errorStatus(403));
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 0, followUpNote: '无身份' }), errorStatus(401));
  assert.deepEqual(row(item.id), original);
  assert.throws(() => listInquiryFollowUps('missing'), errorStatus(404));
});

test('200条上限不截断历史，列表和PATCH仅投影摘要，2000字边界可保存', () => {
  const item = create(); const stored = { ...JSON.parse(row(item.id).payload_json), followUps: history(199) };
  getDatabase().prepare('UPDATE cms_inquiry SET payload_json=? WHERE id=?').run(JSON.stringify(stored), item.id);
  const updated = updateInquiry(item.id, { expectedRevision: 0, followUpNote: '字'.repeat(2000), nextFollowUpAt: null }, admin).item;
  assert.equal(updated.followUpCount, 200); assert.equal(updated.nextFollowUpAt, null);
  assert.equal(listInquiryFollowUps(item.id).items.length, 200); assert.deepEqual(listInquiryFollowUps(item.id).items.slice(0, 199), stored.followUps);
  const before = row(item.id);
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 1, followUpNote: '第201条', priority: 'high' }, admin), errorStatus(422));
  assert.deepEqual(row(item.id), before);
  const summary = listInquiries(); assert.equal(summary[0].followUpCount, 200);
  assert.ok(JSON.stringify(summary).length < 2000); assert.equal(JSON.stringify(summary).includes('历史备注'), false);
  assert.equal(Object.hasOwn(getStudioEnvelope().state.inquiries[0], 'followUps'), false);
  const statusOnly = updateInquiry(item.id, { expectedRevision: 1, status: 'archived' }, admin).item;
  assert.equal(statusOnly.followUpCount, 200); assert.equal(Object.hasOwn(statusOnly, 'followUps'), false);
});

test('写事务重查操作人身份，旧会话角色和姓名不能绕过当前成员状态', () => {
  const item = create(), db = getDatabase(), original = row(item.id);
  db.prepare('UPDATE auth_user SET role=? WHERE id=?').run('viewer', editor.id);
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 0, followUpNote: '旧编辑角色' }, editor), errorStatus(403));
  assert.deepEqual(row(item.id), original);
  db.prepare('UPDATE auth_user SET role=?,banned=1 WHERE id=?').run('editor', editor.id);
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 0, followUpNote: '停用旧会话' }, editor), errorStatus(401));
  assert.deepEqual(row(item.id), original);
  db.prepare('UPDATE auth_user SET banned=0,name=? WHERE id=?').run('销售当前姓名', editor.id);
  updateInquiry(item.id, { expectedRevision: 0, followUpNote: '使用事务内查到的当前姓名' }, editor);
  assert.equal(listInquiryFollowUps(item.id).items[0].actorName, '销售当前姓名');
  const beforeDelete = row(item.id); db.prepare('DELETE FROM auth_user WHERE id=?').run(editor.id);
  assert.throws(() => updateInquiry(item.id, { expectedRevision: 1, notes: '已删除成员不可写' }, editor), errorStatus(401));
  assert.deepEqual(row(item.id), beforeDelete);
});

test('网站发布切换恢复与分发均隔离跟进运行数据，快照协议继续兼容', () => {
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(createEmptyDraft()));
  const item = create(); updateInquiry(item.id, { expectedRevision: 0, assigneeId: editor.id, followUpNote: '私密跟进标记-NOT-PORTABLE', qualification: 'qualified' }, admin);
  const selection = () => ({ expectedRevision: getDraftRecord().revision, baseReleaseId: getStudioEnvelope().activeReleaseId, pageIds: ['home'], productIds: [], includeTheme: true, includeSettings: true });
  const first = publishSite(selection(), admin);
  const draft = getDraftRecord(); patchStudio({ expectedRevision: draft.revision, patch: { pages: draft.content.pages.map(page => ({ ...page, title: '第二版' })) } });
  publishSite(selection(), admin); const before = row(item.id);
  activateRelease(first.releaseId, { expectedActiveReleaseId: getStudioEnvelope().activeReleaseId }, admin);
  restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: ['home'] }, admin);
  assert.deepEqual(row(item.id), before);
  const snapshot = readRelease(first.releaseId), pkg = exportSitePackage({ name: '合成导出', description: '', license: '仅测试自有资料' });
  for (const data of [snapshot, pkg, getDraftRecord().content]) {
    const json = JSON.stringify(data); assert.equal(json.includes('私密跟进标记'), false); assert.equal(json.includes('followUps'), false); assert.equal(Object.hasOwn(data, 'inquiries'), false);
  }
  assert.equal(protocol.database, 19); assert.equal(protocol.snapshot, 28); assert.equal((db.prepare('SELECT count(*) AS count FROM cms_schema_migration').get() as { count: number }).count, 19);
});

test('在线备份和全新目录恢复保留完整跟进及负责人快照', async () => {
  const item = create(); updateInquiry(item.id, { expectedRevision: 0, assigneeId: editor.id, priority: 'high', followUpNote: '完整备份应保留此内部记录' }, admin);
  const before = row(item.id), backup = join(directory, 'backup'), restored = join(directory, 'restored');
  await ops.backup(process.env.FORM_STUDIO_DATA_DIR, backup);
  assert.equal(ops.restore(backup, restored).status, 'restored');
  const copy = new Database(join(restored, 'studio.sqlite'), { readonly: true });
  try { assert.deepEqual(copy.prepare('SELECT revision,payload_json,created_at,updated_at FROM cms_inquiry WHERE id=?').get(item.id), before); }
  finally { copy.close(); }
});

test('新增负责人目录与历史详情HTTP入口拒绝未登录请求并禁止缓存', async () => {
  const item = create();
  const directoryRoute = await import('../src/app/api/inquiries/assignees/route');
  const historyRoute = await import('../src/app/api/inquiries/[id]/follow-ups/route');
  const anonymous = new Request(`${process.env.BETTER_AUTH_URL}/api/inquiries/assignees`);
  for (const response of [await directoryRoute.GET(anonymous), await historyRoute.GET(anonymous, { params: Promise.resolve({ id: item.id }) })]) {
    assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: '请先登录' });
  }
});
