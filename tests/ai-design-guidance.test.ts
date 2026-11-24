import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { readAiDesignGuidance, saveAiDesignGuidance, captureDesignGuidance, assertDesignGuidanceUnchanged, designGuidanceStamp } from '../src/server/ai-design-guidance';
import type { Actor } from '../src/server/permissions';
import { ApiError } from '../src/server/http';
const admin: Actor = { id: 'guidance-admin', name: 'Synthetic admin', email: 'admin@example.invalid', role: 'admin' };
const editor: Actor = { id: 'guidance-editor', name: 'Synthetic editor', email: 'editor@example.invalid', role: 'editor' };
const viewer: Actor = { id: 'guidance-viewer', name: 'Synthetic viewer', email: 'viewer@example.invalid', role: 'viewer' };
let directory = '', previous: NodeJS.ProcessEnv;
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
const input = (extra = {}) => ({ expectedRevision: readAiDesignGuidance(admin).revision, enabled: true, preferredStyle: 'Synthetic private preferred style', preserveNotes: 'Keep the product references', avoidStyles: 'Avoid dense hero copy', feedback: [{ id: 'feedback-1', text: 'Make mobile product cards clearer' }], ...extra });
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-design-guidance-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3293'; process.env.BETTER_AUTH_SECRET = 'synthetic-guidance-fixed-secret-'.repeat(3); process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'none';
  getDraftRecord(); const db = getDatabase(); db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, editor, viewer]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-design-guidance-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('首次读取为空且不插默认行，未配置约定不会发送伪造偏好', () => {
  assert.deepEqual(readAiDesignGuidance(admin), { revision: 0, enabled: true, preferredStyle: '', preserveNotes: '', avoidStyles: '', feedback: [], updatedAt: '' });
  assert.deepEqual(captureDesignGuidance(admin), { revision: 0, active: false }); assert.equal(designGuidanceStamp(undefined, admin), undefined);
  assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_design_guidance').get() as { n: number }).n, 0);
});
test('管理员显式保存私有约定，草稿/公开指针不变且审计不存正文', () => {
  const before = getStudioEnvelope(), result = saveAiDesignGuidance(input(), admin); assert.equal(result.revision, 1); assert.ok(Date.parse(result.updatedAt));
  assert.deepEqual(getStudioEnvelope(), before); assert.doesNotMatch(JSON.stringify(before), /Synthetic private preferred style/);
  assert.doesNotMatch(JSON.stringify(getDatabase().prepare('SELECT details_json FROM cms_audit').all()), /Synthetic private preferred style|Keep the product references|Make mobile/);
  const capture = captureDesignGuidance(admin); assert.equal(capture.active, true); assert.deepEqual(capture.context?.feedback, ['Make mobile product cards clearer']); assert.equal(capture.context?.advisory, true);
});
test('关闭或清空参考不把旧文字继续送给模型，已保存内容可由管理员修改删除', () => {
  saveAiDesignGuidance(input(), admin); const disabled = saveAiDesignGuidance(input({ enabled: false }), admin);
  assert.equal(disabled.preferredStyle, 'Synthetic private preferred style'); assert.deepEqual(captureDesignGuidance(admin), { revision: 2, active: false });
  const cleared = saveAiDesignGuidance(input({ enabled: true, preferredStyle: '', preserveNotes: '', avoidStyles: '', feedback: [] }), admin); assert.equal(cleared.revision, 3); assert.deepEqual(captureDesignGuidance(admin), { revision: 3, active: false });
});
test('独立版本冲突保留已保存文字，生成途中变更时明确拒绝旧上下文', () => {
  const original = captureDesignGuidance(admin); saveAiDesignGuidance(input(), admin);
  assert.throws(() => saveAiDesignGuidance(input({ expectedRevision: 0, preferredStyle: 'must not overwrite' }), admin), status(409));
  assert.equal(readAiDesignGuidance(admin).revision, 1); assert.equal(readAiDesignGuidance(admin).preferredStyle, 'Synthetic private preferred style');
  assert.throws(() => assertDesignGuidanceUnchanged(original, admin), status(409)); assert.deepEqual(designGuidanceStamp(original, admin), { revision: 0, active: false, stale: true });
  assert.doesNotMatch(JSON.stringify(designGuidanceStamp(captureDesignGuidance(admin), admin)), /Synthetic|Keep|feedback/);
});
test('所有字段与反馈严格有界，不接受脚本、未知字段、重复标识或非确认的自动学习载荷', () => {
  for (const extra of [{ preferredStyle: 'x'.repeat(1201) }, { preferredStyle: '<script>bad()</script>' }, { preserveNotes: 'bad\u0000control' }, { enabled: 'true' }, { autoLearn: true }, { feedback: Array.from({ length: 9 }, (_, index) => ({ id: `f-${index}`, text: 'x' })) }, { feedback: [{ id: 'f-1', text: '' }] }, { feedback: [{ id: 'f-1', text: 'x'.repeat(601) }] }, { feedback: [{ id: 'f-1', text: 'first' }, { id: 'f-1', text: 'second' }] }, { feedback: [{ id: '../bad', text: 'x' }] }]) assert.throws(() => saveAiDesignGuidance(input(extra), admin), status(422));
  assert.equal(readAiDesignGuidance(admin).revision, 0);
});
test('编辑和只读无管理权，旧管理员缓存也不能越过当前降权/停用状态', () => {
  for (const actor of [editor, viewer]) { assert.throws(() => readAiDesignGuidance(actor), status(403)); assert.throws(() => saveAiDesignGuidance(input(), actor), status(403)); }
  getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); assert.throws(() => readAiDesignGuidance(admin), status(403));
  getDatabase().prepare("UPDATE auth_user SET role='admin',banned=1 WHERE id=?").run(admin.id); assert.throws(() => captureDesignGuidance(admin), status(401));
  assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_design_guidance').get() as { n: number }).n, 0);
});
test('关闭并重新打开实例仍读回约定，读取不会自己学习或增加修订', () => {
  const saved = saveAiDesignGuidance(input(), admin); getDatabase().close(); assert.deepEqual(readAiDesignGuidance(admin), saved); assert.deepEqual(readAiDesignGuidance(admin), saved);
});
