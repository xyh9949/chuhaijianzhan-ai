import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { getMigrations } from 'better-auth/db/migration';
import { getAuth } from '../src/server/auth';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getStudioEnvelope } from '../src/server/studio';
import { uploadMedia } from '../src/server/media';
import { requireActor, revalidateActor } from '../src/server/permissions';
import { ApiError } from '../src/server/http';
import { POST as publish } from '../src/app/api/releases/route';
import { POST as preview } from '../src/app/api/releases/preview/route';
import { POST as activate } from '../src/app/api/releases/[id]/activate/route';
import { POST as restore } from '../src/app/api/releases/[id]/restore-draft/route';
import { PATCH as studio } from '../src/app/api/studio/route';
import { POST as upload } from '../src/app/api/media/route';
import { POST as mediaBatch } from '../src/app/api/media/batch/route';
import { DELETE as mediaDelete } from '../src/app/api/media/[id]/route';
import { POST as codeCheck } from '../src/app/api/studio/code-check/route';
import { PATCH as member } from '../src/app/api/members/[id]/route';
import { POST as password } from '../src/app/api/members/[id]/password/route';
import { PATCH as aiProvider } from '../src/app/api/ai/provider/route';
import { PATCH as mailSettings } from '../src/app/api/notifications/settings/route';
import { getAiProviderSummary } from '../src/server/ai-provider';
import { getMailSettingsSummary, saveMailSettings } from '../src/server/mail-settings';

const origin = 'http://127.0.0.1:3299';
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonRequest = (path: string, cookie: string, body: unknown, method = 'POST') => new Request(`${origin}${path}`, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** 仅在真实路由开始读body时发信号；不替换鉴权、服务或事务，模拟慢速上传在撤权后才完成。 */
function delayed(path: string, cookie: string, method = 'POST', contentType = 'application/json') {
  let controller!: ReadableStreamDefaultController<Uint8Array>, reached!: () => void;
  const reading = new Promise<void>(done => { reached = done; });
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const request = new Request(`${origin}${path}`, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': contentType }, body: stream, duplex: 'half' } as RequestInit);
  const original = request.body!.getReader.bind(request.body);
  Object.defineProperty(request.body, 'getReader', { value: (...args: unknown[]) => { reached(); return (original as (...args: unknown[]) => unknown)(...args); } });
  return { request, wait: async () => { let timer: NodeJS.Timeout | undefined; try { await Promise.race([reading, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('真实路由未开始读取body')), 10000); })]); } finally { clearTimeout(timer); } }, finish: (bytes: Uint8Array) => { controller.enqueue(bytes); controller.close(); } };
}

test('写操作撤权保护使用真实会话、延迟请求体和生产提交路径', { timeout: 60000 }, async t => {
  const previous = { ...process.env }, directory = mkdtempSync(join(tmpdir(), 'studio-operation-revocation-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-operation-revocation-secret-'.repeat(3);
  const db = getDatabase();
  try {
    getStudioEnvelope(); const auth = getAuth(); await (await getMigrations(auth.options)).runMigrations();
    let operatorPassword = 'Synthetic-operation-password-123';
    const operator = (await auth.api.createUser({ body: { name: 'Pending operator', email: 'pending-operator@example.invalid', password: operatorPassword, role: 'admin' } })).user;
    await auth.api.createUser({ body: { name: 'Controller admin', email: 'operation-controller@example.invalid', password: operatorPassword, role: 'admin' } });
    const login = async (email: string, secret: string) => { const response = await auth.api.signInEmail({ body: { email, password: secret }, asResponse: true }); assert.equal(response.status, 200); return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); };
    const controllerCookie = await login('operation-controller@example.invalid', operatorPassword);
    const memberPatch = (body: unknown) => member(jsonRequest(`/api/members/${operator.id}`, controllerCookie, body, 'PATCH'), context(operator.id));
    const renew = async () => { assert.equal((await memberPatch({ role: 'admin', disabled: false })).status, 200); return login(operator.email, operatorPassword); };
    const revokeSessions = async () => { operatorPassword += '-x'; assert.equal((await password(jsonRequest(`/api/members/${operator.id}/password`, controllerCookie, { password: operatorPassword }), context(operator.id))).status, 200); };
    const draft = createEmptyDraft(); draft.settings.name = 'Synthetic company'; draft.settings.description = 'Supplied company information.';
    draft.editorData.home = { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Heading', props: { id: 'home-title', text: 'Supplied homepage', level: 'h1' } }] };
    db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
    const selection = () => { const state = getStudioEnvelope(); return { expectedRevision: state.revision, baseReleaseId: state.activeReleaseId, pageIds: ['home'], productIds: [], includeTheme: true, includeSettings: true }; };
    const first = await publish(jsonRequest('/api/releases', controllerCookie, selection())); assert.equal(first.status, 201); const firstId = (await first.json()).releaseId as string;
    assert.equal((await publish(jsonRequest('/api/releases', controllerCookie, selection()))).status, 201);
    const business = () => ({ studio: getStudioEnvelope(), successes: db.prepare("SELECT action,count(*) n FROM cms_audit WHERE result='success' AND action IN ('release.publish','release.activate','draft.restore','draft.update') GROUP BY action ORDER BY action").all(), media: db.prepare('SELECT count(*) n FROM cms_media_file').get() });
    const bytes = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));

    await t.test('发布读body期间降为只读：旧请求和旧会话均拒绝，公开指针/草稿/成功审计保持', async () => {
      const cookie = await renew(), before = business(), body = selection(), held = delayed('/api/releases', cookie), pending = publish(held.request); await held.wait();
      assert.equal((await memberPatch({ role: 'viewer' })).status, 200); held.finish(bytes(body)); assert.equal((await pending).status, 401);
      assert.equal((await publish(jsonRequest('/api/releases', cookie, body))).status, 401); assert.deepEqual(business(), before);
    });
    await t.test('回滚读body期间停用：不能切换公开版本或新增成功事件', async () => {
      const cookie = await renew(), before = business(), held = delayed(`/api/releases/${firstId}/activate`, cookie), pending = activate(held.request, context(firstId)); await held.wait();
      assert.equal((await memberPatch({ disabled: true })).status, 200); held.finish(bytes({ expectedActiveReleaseId: before.studio.activeReleaseId })); assert.equal((await pending).status, 401); assert.deepEqual(business(), before);
    });
    await t.test('恢复读body期间仅撤会话：账号仍管理员也不能提交旧请求', async () => {
      const cookie = await renew(), before = business(), held = delayed(`/api/releases/${firstId}/restore-draft`, cookie), pending = restore(held.request, context(firstId)); await held.wait();
      await revokeSessions(); held.finish(bytes({ expectedRevision: before.studio.revision, pageIds: ['home'] })); assert.equal((await pending).status, 401); assert.deepEqual(business(), before);
    });
    await t.test('发布预检读body期间撤权也不返回草稿诊断', async () => {
      const cookie = await renew(), before = business(), body = selection(), held = delayed('/api/releases/preview', cookie), pending = preview(held.request); await held.wait();
      assert.equal((await memberPatch({ role: 'viewer' })).status, 200); held.finish(bytes(body)); assert.equal((await pending).status, 401); assert.deepEqual(business(), before);
    });
    await t.test('草稿body期间管理员变编辑员：按当前角色拒绝网站设置，仍可正常编辑内容', async () => {
      const cookie = await renew(), before = business(), held = delayed('/api/studio', cookie, 'PATCH'), pending = studio(held.request); await held.wait();
      // 保留会话模拟仅角色变化，专门验证不能把旧admin DTO继续交给字段授权。
      db.prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(operator.id);
      held.finish(bytes({ expectedRevision: before.studio.revision, patch: { settings: { ...before.studio.state.settings, name: 'Must not save' } } })); assert.equal((await pending).status, 403); assert.deepEqual(business(), before);
      const next = structuredClone(before.studio.state.editorData); (next.home as { content: { props: { text: string } }[] }).content[0].props.text = 'Allowed current editor content';
      assert.equal((await studio(jsonRequest('/api/studio', cookie, { expectedRevision: before.studio.revision, patch: { editorData: next } }, 'PATCH'))).status, 200);
    });
    await t.test('媒体multipart读body期间撤会话：不新增素材索引或草稿', async () => {
      const cookie = await renew(), before = business(), form = new FormData(); form.set('expectedRevision', String(before.studio.revision)); form.set('file', new File([new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toBuffer())], 'synthetic.png', { type: 'image/png' }));
      const encoded = new Request(`${origin}/api/media`, { method: 'POST', body: form }), body = new Uint8Array(await encoded.arrayBuffer()), held = delayed('/api/media', cookie, 'POST', encoded.headers.get('content-type')!), pending = upload(held.request); await held.wait();
      await revokeSessions(); held.finish(body); assert.equal((await pending).status, 401); assert.deepEqual(business(), before);
    });
    await t.test('图片读取/解码异步后撤会话：最终同步校验拒绝且DTO不泄漏会话绑定', async () => {
      const cookie = await renew(), before = business(), actor = await requireActor(jsonRequest('/api/media', cookie, {})); assert.deepEqual(Object.keys(actor).sort(), ['email', 'id', 'name', 'role']);
      let release!: () => void, reached!: () => void; const gate = new Promise<void>(done => { release = done; }), reading = new Promise<void>(done => { reached = done; });
      const file = new File([new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#654321' } }).png().toBuffer())], 'synthetic-async.png', { type: 'image/png' }), originalRead = file.arrayBuffer.bind(file);
      Object.defineProperty(file, 'arrayBuffer', { value: async () => { reached(); await gate; return originalRead(); } });
      const form = new FormData(); form.set('expectedRevision', String(before.studio.revision)); form.set('file', file);
      const pending = uploadMedia(form, () => revalidateActor(actor, 'edit')); await reading; await revokeSessions(); release();
      await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.status === 401); assert.deepEqual(business(), before);
      assert.throws(() => revalidateActor({ ...actor }, 'edit'), (error: unknown) => error instanceof ApiError && error.status === 401);
    });
    await t.test('AI设置body期间仅撤会话：仍为管理员也不能保存，合法设置和成功审计保持', async () => {
      const cookie = await renew(), initial = getAiProviderSummary();
      const valid = { expectedRevision: initial.revision, enabled: false, baseUrl: 'https://model.example.invalid/v1', model: 'synthetic-review-model', allowLocal: false, clearApiKey: true };
      assert.equal((await aiProvider(jsonRequest('/api/ai/provider', cookie, valid, 'PATCH'))).status, 200);
      const before = business(), settings = getAiProviderSummary(), successes = db.prepare("SELECT count(*) n FROM cms_audit WHERE action='ai.provider' AND result='success'").get();
      const held = delayed('/api/ai/provider', cookie, 'PATCH'), pending = aiProvider(held.request); await held.wait(); await revokeSessions();
      assert.equal((db.prepare('SELECT role FROM auth_user WHERE id=?').get(operator.id) as { role: string }).role, 'admin');
      const body = { ...valid, expectedRevision: settings.revision, model: 'must-not-save' }; held.finish(bytes(body)); assert.equal((await pending).status, 401); assert.equal((await aiProvider(jsonRequest('/api/ai/provider', cookie, body, 'PATCH'))).status, 401);
      assert.deepEqual(getAiProviderSummary(), settings); assert.deepEqual(db.prepare("SELECT count(*) n FROM cms_audit WHERE action='ai.provider' AND result='success'").get(), successes); assert.deepEqual(business(), before);
    });
    await t.test('邮件设置body期间仅撤会话：不写私有配置、不新增成功回执且旧cookie拒绝', async () => {
      const cookie = await renew(), controllerActor = await requireActor(jsonRequest('/api/notifications/settings', controllerCookie, {})), initial = getMailSettingsSummary(controllerActor);
      const valid = { expectedRevision: initial.revision, enabled: false, host: 'smtp.example.invalid', port: 465, security: 'tls', username: '', from: 'sender@example.invalid', to: ['owner@example.invalid'], allowLocal: false, clearPassword: true };
      const settings = saveMailSettings(valid, controllerActor), before = business(), successes = db.prepare("SELECT count(*) n FROM cms_audit WHERE action='mail.settings' AND result='success'").get();
      const held = delayed('/api/notifications/settings', cookie, 'PATCH'), pending = mailSettings(held.request); await held.wait(); await revokeSessions();
      assert.equal((db.prepare('SELECT role FROM auth_user WHERE id=?').get(operator.id) as { role: string }).role, 'admin');
      const body = { ...valid, expectedRevision: settings.revision, from: 'must-not-save@example.invalid' }; held.finish(bytes(body)); assert.equal((await pending).status, 401); assert.equal((await mailSettings(jsonRequest('/api/notifications/settings', cookie, body, 'PATCH'))).status, 401);
      assert.deepEqual(getMailSettingsSummary(controllerActor), settings); assert.deepEqual(db.prepare("SELECT count(*) n FROM cms_audit WHERE action='mail.settings' AND result='success'").get(), successes); assert.deepEqual(business(), before);
    });
    await t.test('素材批处理与移除读体期间撤会话：不变更记录，正常移动与移除仍可用', async () => {
      const form = new FormData(); form.set('expectedRevision', String(getStudioEnvelope().revision)); form.set('file', new File([new Uint8Array(await sharp({ create: { width: 12, height: 12, channels: 3, background: '#546789' } }).png().toBuffer())], 'pending-media.png', { type: 'image/png' }));
      const media = (await uploadMedia(form)).media, cookie = await renew(), before = business();
      const held = delayed('/api/media/batch', cookie), pending = mediaBatch(held.request); await held.wait(); await revokeSessions();
      held.finish(bytes({ expectedRevision: before.studio.revision, ids: [media.id], action: 'move', folder: 'MUST_NOT_MOVE' })); assert.equal((await pending).status, 401); assert.deepEqual(business(), before);
      const valid = await renew(); assert.equal((await mediaBatch(jsonRequest('/api/media/batch', valid, { expectedRevision: getStudioEnvelope().revision, ids: [media.id], action: 'move', folder: 'Allowed folder' }))).status, 200);
      assert.equal(getStudioEnvelope().state.media.find(item => item.id === media.id)?.folder, 'Allowed folder');
      const beforeDelete = business(), deletion = delayed(`/api/media/${media.id}`, valid, 'DELETE'), deleting = mediaDelete(deletion.request, context(media.id)); await deletion.wait(); await revokeSessions();
      deletion.finish(bytes({ expectedRevision: beforeDelete.studio.revision })); assert.equal((await deleting).status, 401); assert.deepEqual(business(), beforeDelete);
      assert.equal((await mediaDelete(jsonRequest(`/api/media/${media.id}`, await renew(), { expectedRevision: getStudioEnvelope().revision }, 'DELETE'), context(media.id))).status, 200); assert.equal(getStudioEnvelope().state.media.length, 0);
    });
    await t.test('源码检查读体期间撤会话也拒绝，合法检查保持只读', async () => {
      const cookie = await renew(), before = business(), source = { css: '', js: '', cssEnabled: false, jsEnabled: false }, held = delayed('/api/studio/code-check', cookie), pending = codeCheck(held.request);
      await held.wait(); await revokeSessions(); held.finish(bytes(source)); assert.equal((await pending).status, 401); assert.deepEqual(business(), before);
      assert.equal((await codeCheck(jsonRequest('/api/studio/code-check', await renew(), source))).status, 200); assert.deepEqual(business(), before);
    });
    await t.test('同步helper返回当前角色且延续绑定，过期会话拒绝；正常发布/恢复/上传仍成功', async () => {
      const cookie = await renew(), actor = await requireActor(jsonRequest('/api/studio', cookie, {})); db.prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(operator.id);
      const fresh = revalidateActor(actor, 'edit'); assert.equal(fresh.role, 'editor'); assert.equal(revalidateActor(fresh, 'edit').role, 'editor'); assert.throws(() => revalidateActor(actor, 'manage'), (error: unknown) => error instanceof ApiError && error.status === 403);
      db.prepare('UPDATE auth_session SET expiresAt=? WHERE userId=?').run(Date.now() - 1, operator.id); assert.throws(() => revalidateActor(fresh, 'edit'), (error: unknown) => error instanceof ApiError && error.status === 401);
      const valid = await renew(); assert.equal((await publish(jsonRequest('/api/releases', valid, selection()))).status, 201);
      const state = getStudioEnvelope(); assert.equal((await restore(jsonRequest(`/api/releases/${firstId}/restore-draft`, valid, { expectedRevision: state.revision, pageIds: ['home'] }), context(firstId))).status, 200);
      const form = new FormData(); form.set('expectedRevision', String(getStudioEnvelope().revision)); form.set('file', new File([new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#abcdef' } }).png().toBuffer())], 'allowed.png', { type: 'image/png' }));
      const response = await upload(new Request(`${origin}/api/media`, { method: 'POST', headers: { Origin: origin, Cookie: valid }, body: form })); assert.equal(response.status, 201); assert.equal(getStudioEnvelope().state.media.length, 1);
    });
  } finally {
    db.close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
    const target = resolve(directory), parent = resolve(tmpdir()); if (target.startsWith(`${parent}${sep}studio-operation-revocation-`)) rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
