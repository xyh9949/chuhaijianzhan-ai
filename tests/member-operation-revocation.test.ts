import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { getAuth } from '../src/server/auth';
import { getDatabase } from '../src/server/database';
import { createInquiry, getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { getInquiryPolicy, previewInquiryCleanup, saveInquiryPolicy } from '../src/server/inquiry-operations';
import { enqueueNotification } from '../src/server/notification-jobs';
import { PATCH as member } from '../src/app/api/members/[id]/route';
import { PATCH as policy } from '../src/app/api/inquiries/policy/route';
import { POST as cleanup } from '../src/app/api/inquiries/cleanup/route';
import { POST as create } from '../src/app/api/inquiries/route';
import { PATCH as update, DELETE as remove } from '../src/app/api/inquiries/[id]/route';
import { POST as exportCsv } from '../src/app/api/inquiries/export/route';
import { GET as followUps } from '../src/app/api/inquiries/[id]/follow-ups/route';
import { POST as retry } from '../src/app/api/notifications/[id]/retry/route';
import { GET as mediaUsage } from '../src/app/api/media/[id]/usage/route';

const origin = 'http://127.0.0.1:3392', password = 'Synthetic-member-operation-password-123';
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (path: string, cookie: string, body: unknown, method = 'POST') => new Request(`${origin}${path}`, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** hwm=0禁止构造时预读；只有真实生产路由通过鉴权并开始读取请求体，才触发撤权屏障。 */
function heldBody(path: string, cookie: string, body: unknown, method = 'POST') {
  let reached!: () => void, finish!: () => void, pulled = false;
  const reading = new Promise<void>(done => { reached = done; }), gate = new Promise<void>(done => { finish = done; });
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) { if (pulled) return; pulled = true; reached(); await gate; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } }, { highWaterMark: 0 });
  return { reading, finish, request: new Request(`${origin}${path}`, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit) };
}
/** await Promise子类真实进入params等待时记录屏障，避免靠时间猜测鉴权已完成。 */
function heldParams(id: string) {
  let reached!: () => void, finish!: () => void;
  const reading = new Promise<void>(done => { reached = done; });
  class PendingParams extends Promise<{ id: string }> {}
  const params = new PendingParams(done => { finish = () => done({ id }); }), then = params.then.bind(params);
  Object.defineProperty(params, 'then', { value: (...args: Parameters<typeof then>) => { reached(); return then(...args); } });
  return { reading, finish, context: { params } };
}
async function reached(reading: Promise<void>, pending: Promise<Response>) {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([reading, pending.then(response => { throw Error(`路由在撤权屏障前意外返回${response.status}`); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('真实路由未到达异步屏障')), 10000); })]); }
  finally { clearTimeout(timer); }
}

test('成员、询盘与通知在真实鉴权后的异步窗口重新核对当前会话与角色', { timeout: 60000 }, async t => {
  const previous = { ...process.env }, directory = mkdtempSync(join(tmpdir(), 'studio-member-operation-revocation-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-member-operation-secret-'.repeat(3); process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock';
  for (const key of Object.keys(process.env)) if (key.startsWith('FORM_STUDIO_SMTP_') || key === 'FORM_STUDIO_NOTIFY_TO') delete process.env[key];
  const db = getDatabase();
  try {
    getStudioEnvelope(); const auth = getAuth(); await (await getMigrations(auth.options)).runMigrations();
    const operator = (await auth.api.createUser({ body: { name: 'Pending administrator', email: 'pending-member@example.invalid', password, role: 'admin' } })).user;
    const controller = (await auth.api.createUser({ body: { name: 'Controller administrator', email: 'controller-member@example.invalid', password, role: 'admin' } })).user;
    const target = (await auth.api.createUser({ body: { name: 'Target member', email: 'target-member@example.invalid', password, role: 'editor' } })).user;
    const login = async (email: string) => { const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true }); assert.equal(response.status, 200); return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); };
    const controllerCookie = await login(controller.email), changeOperator = (body: unknown) => member(request(`/api/members/${operator.id}`, controllerCookie, body, 'PATCH'), context(operator.id));
    const renew = async () => { assert.equal((await changeOperator({ role: 'admin', disabled: false })).status, 200); return login(operator.email); };
    const revoke = async () => { assert.equal((await changeOperator({ role: 'viewer' })).status, 200); };
    const targetRow = () => db.prepare('SELECT name,role,banned FROM auth_user WHERE id=?').get(target.id);
    const auditCount = () => db.prepare("SELECT count(*) n FROM cms_audit WHERE action='member.update' AND result='success'").get() as { n: number };
    const inquiry = createInquiry({ name: 'Synthetic buyer', email: 'buyer@example.invalid', message: 'Supplied inquiry information.' }).item;
    type InquiryRow = { id: string; revision: number; payload_json: string; created_at: string; updated_at: string };
    const inquiryRow = () => db.prepare('SELECT * FROM cms_inquiry WHERE id=?').get(inquiry.id) as InquiryRow;
    const restoreInquiry = (row: InquiryRow) => { db.prepare('INSERT OR REPLACE INTO cms_inquiry(id,revision,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)').run(row.id, row.revision, row.payload_json, row.created_at, row.updated_at); };

    await t.test('挂起管理员自提权：另一管理员已降为只读并撤会话后，旧body不能恢复admin', async () => {
      const cookie = await renew(), held = heldBody(`/api/members/${operator.id}`, cookie, { role: 'admin' }, 'PATCH'), pending = member(held.request, context(operator.id));
      try { await reached(held.reading, pending); await revoke(); const audit = auditCount(); held.finish(); assert.equal((await pending).status, 401); assert.equal((db.prepare('SELECT role FROM auth_user WHERE id=?').get(operator.id) as { role: string }).role, 'viewer'); assert.deepEqual(auditCount(), audit); }
      finally { held.finish(); }
    });
    await t.test('成员body期间仅角色变为viewer但会话保留，也不能使用旧admin DTO修改他人', async () => {
      const cookie = await renew(), before = targetRow(), held = heldBody(`/api/members/${target.id}`, cookie, { name: 'Forbidden rename' }, 'PATCH'), pending = member(held.request, context(target.id));
      try { await reached(held.reading, pending); db.prepare("UPDATE auth_user SET role='viewer' WHERE id=?").run(operator.id); held.finish(); assert.equal((await pending).status, 403); assert.deepEqual(targetRow(), before); }
      finally { held.finish(); }
    });
    await t.test('成员params等待期间撤会话，随后body也不能重新提权', async () => {
      const cookie = await renew(), held = heldParams(operator.id), pending = member(request(`/api/members/${operator.id}`, cookie, { role: 'admin' }, 'PATCH'), held.context);
      try { await reached(held.reading, pending); await revoke(); held.finish(); assert.equal((await pending).status, 401); assert.equal((db.prepare('SELECT role FROM auth_user WHERE id=?').get(operator.id) as { role: string }).role, 'viewer'); }
      finally { held.finish(); }
    });
    await t.test('body期间停用管理员不能改成员；正常管理员修改保留原角色与姓名流程', async () => {
      const cookie = await renew(), before = targetRow(), held = heldBody(`/api/members/${target.id}`, cookie, { role: 'admin' }, 'PATCH'), pending = member(held.request, context(target.id));
      try { await reached(held.reading, pending); assert.equal((await changeOperator({ disabled: true })).status, 200); held.finish(); assert.equal((await pending).status, 401); assert.deepEqual(targetRow(), before); }
      finally { held.finish(); }
      assert.equal((await member(request(`/api/members/${target.id}`, controllerCookie, { name: 'Reviewed member', role: 'editor' }, 'PATCH'), context(target.id))).status, 200); assert.equal((targetRow() as { name: string }).name, 'Reviewed member');
    });
    await t.test('询盘保留策略body期间撤权，不保存配置', async () => {
      const cookie = await renew(), before = getInquiryPolicy(), held = heldBody('/api/inquiries/policy', cookie, { expectedRevision: before.revision, retentionDays: 30 }, 'PATCH'), pending = policy(held.request);
      try { await reached(held.reading, pending); await revoke(); held.finish(); assert.equal((await pending).status, 401); assert.deepEqual(getInquiryPolicy(), before); }
      finally { held.finish(); }
    });
    await t.test('询盘清理body期间撤权，原有运行数据不删除', async () => {
      saveInquiryPolicy({ expectedRevision: getInquiryPolicy().revision, retentionDays: 1 }); db.prepare("UPDATE cms_inquiry SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(inquiry.id);
      const cookie = await renew(), before = inquiryRow(), held = heldBody('/api/inquiries/cleanup', cookie, previewInquiryCleanup()), pending = cleanup(held.request);
      try { await reached(held.reading, pending); await revoke(); held.finish(); assert.equal((await pending).status, 401); assert.deepEqual(inquiryRow(), before); }
      finally { held.finish(); restoreInquiry(before); }
    });
    await t.test('后台新建询盘body期间降权不能插入，编辑员正常录入保持可用', async () => {
      const cookie = await renew(), before = db.prepare('SELECT count(*) n FROM cms_inquiry').get(), body = { name: 'Pending buyer', email: 'pending-buyer@example.invalid', message: 'Pending supplied inquiry.' }, held = heldBody('/api/inquiries', cookie, body), pending = create(held.request);
      try { await reached(held.reading, pending); db.prepare("UPDATE auth_user SET role='viewer' WHERE id=?").run(operator.id); held.finish(); assert.equal((await pending).status, 403); assert.deepEqual(db.prepare('SELECT count(*) n FROM cms_inquiry').get(), before); }
      finally { held.finish(); }
      db.prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(operator.id); assert.equal((await create(request('/api/inquiries', cookie, body))).status, 201);
    });
    await t.test('询盘更新body期间仅撤会话，仍是admin也不能写内部备注', async () => {
      const cookie = await renew(), before = inquiryRow(), held = heldBody(`/api/inquiries/${inquiry.id}`, cookie, { expectedRevision: 0, notes: 'Forbidden note' }, 'PATCH'), pending = update(held.request, context(inquiry.id));
      try { await reached(held.reading, pending); db.prepare('DELETE FROM auth_session WHERE userId=?').run(operator.id); held.finish(); assert.equal((await pending).status, 401); assert.deepEqual(inquiryRow(), before); }
      finally { held.finish(); restoreInquiry(before); }
    });
    await t.test('删除询盘body期间撤权，不删除原询盘', async () => {
      const cookie = await renew(), before = inquiryRow(), held = heldBody(`/api/inquiries/${inquiry.id}`, cookie, { expectedRevision: 0 }, 'DELETE'), pending = remove(held.request, context(inquiry.id));
      try { await reached(held.reading, pending); await revoke(); held.finish(); assert.equal((await pending).status, 401); assert.deepEqual(inquiryRow(), before); }
      finally { held.finish(); restoreInquiry(before); }
    });
    await t.test('CSV导出body期间撤会话，不返回客户明细', async () => {
      const cookie = await renew(), held = heldBody('/api/inquiries/export', cookie, {}), pending = exportCsv(held.request);
      try { await reached(held.reading, pending); db.prepare('DELETE FROM auth_session WHERE userId=?').run(operator.id); held.finish(); const response = await pending; assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), /buyer@example.invalid|Supplied inquiry/); }
      finally { held.finish(); }
    });
    await t.test('内部跟进读取params期间撤会话，不返回内部资料', async () => {
      const cookie = await renew(), held = heldParams(inquiry.id), pending = followUps(new Request(`${origin}/api/inquiries/${inquiry.id}/follow-ups`, { headers: { Cookie: cookie } }), held.context);
      try { await reached(held.reading, pending); db.prepare('DELETE FROM auth_session WHERE userId=?').run(operator.id); held.finish(); assert.equal((await pending).status, 401); }
      finally { held.finish(); }
    });
    await t.test('素材引用读取params期间撤会话拒绝，正常只读成员仍可查看引用', async () => {
      const mediaId = 'revocation-media', draft = getDraftRecord(); draft.content.media.push({ id: mediaId, name: 'Synthetic image', url: `/api/media/${mediaId}`, kind: 'image', folder: 'Synthetic', size: '1 KB', alt: 'Synthetic image' });
      const home = draft.content.editorData.home as { content: { type: string; props: Record<string, unknown> }[] }; home.content.push({ type: 'Image', props: { id: 'revocation-image-reference', src: `/api/media/${mediaId}`, alt: 'Synthetic image' } });
      db.prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(draft.content));
      const cookie = await renew(), held = heldParams(mediaId), pending = mediaUsage(new Request(`${origin}/api/media/${mediaId}/usage`, { headers: { Cookie: cookie } }), held.context), before = getDraftRecord();
      try { await reached(held.reading, pending); db.prepare('DELETE FROM auth_session WHERE userId=?').run(operator.id); held.finish(); assert.equal((await pending).status, 401); assert.deepEqual(getDraftRecord(), before); }
      finally { held.finish(); }
      await revoke(); const viewerCookie = await login(operator.email), response = await mediaUsage(new Request(`${origin}/api/media/${mediaId}/usage`, { headers: { Cookie: viewerCookie } }), context(mediaId)); assert.equal(response.status, 200); const value = await response.json(); assert.ok(value.draft.some((entry: { id: string }) => entry.id === 'home')); assert.deepEqual(getDraftRecord(), before);
    });
    await t.test('通知重试params期间撤权，不重新排队或重置尝试计数', async () => {
      const jobId = enqueueNotification(inquiry.id); db.prepare("UPDATE cms_notification_job SET status='failed',attempts=4,error_code='SYNTHETIC_FAILURE' WHERE id=?").run(jobId);
      const cookie = await renew(), before = db.prepare('SELECT * FROM cms_notification_job WHERE id=?').get(jobId), held = heldParams(jobId), pending = retry(request(`/api/notifications/${jobId}/retry`, cookie, {}), held.context);
      try { await reached(held.reading, pending); await revoke(); held.finish(); assert.equal((await pending).status, 401); assert.deepEqual(db.prepare('SELECT * FROM cms_notification_job WHERE id=?').get(jobId), before); }
      finally { held.finish(); }
      assert.equal((await retry(request(`/api/notifications/${jobId}/retry`, controllerCookie, {}), context(jobId))).status, 200); assert.deepEqual(db.prepare('SELECT status,attempts FROM cms_notification_job WHERE id=?').get(jobId), { status: 'pending', attempts: 0 });
    });
  } finally {
    if (db.open) db.close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-member-operation-revocation-`)); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
