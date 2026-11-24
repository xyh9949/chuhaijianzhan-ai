import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { getAuth } from '../src/server/auth';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getStudioEnvelope } from '../src/server/studio';
import { requireActor } from '../src/server/permissions';
import { createExternalSiteDesignCandidate } from '../src/server/ai-site-design';
import { GET, DELETE } from '../src/app/api/ai/site-designs/[id]/route';
import { GET as readVisualCapture } from '../src/app/api/ai/visual/captures/[id]/route';
import { GET as readTranslation } from '../src/app/api/ai/translations/[id]/route';

const origin = 'http://127.0.0.1:3299';
/** Promise子类让await真实经过then，精确观测鉴权后等待params；不替换认证或候选服务。 */
function heldParams(id: string) {
  let release!: () => void, reached!: () => void;
  const observed = new Promise<void>(done => { reached = done; });
  class Params extends Promise<{ id: string }> {
    static get [Symbol.species]() { return Promise; }
    then<TResult1 = { id: string }, TResult2 = never>(onfulfilled?: ((value: { id: string }) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
      reached(); return super.then(onfulfilled, onrejected);
    }
  }
  const params = new Params(done => { release = () => done({ id }); });
  return { params, release, wait: async () => { let timer: NodeJS.Timeout | undefined; try { await Promise.race([observed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('生产路由未进入params等待')), 10000); })]); } finally { clearTimeout(timer); } } };
}

test('私有动态路由params等待后必须重验真实会话', { timeout: 30000 }, async t => {
  const previous = { ...process.env }, directory = mkdtempSync(join(tmpdir(), 'studio-params-revocation-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-params-revocation-secret-'.repeat(3);
  const db = getDatabase();
  try {
    getStudioEnvelope(); const auth = getAuth(); await (await getMigrations(auth.options)).runMigrations();
    const email = 'params-admin@example.invalid', password = 'Synthetic-params-password-123';
    await auth.api.createUser({ body: { name: 'Params administrator', email, password, role: 'admin' } });
    const login = async () => { const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true }); assert.equal(response.status, 200); return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); };
    const request = (cookie: string, method = 'GET') => new Request(`${origin}/api/ai/site-designs/candidate`, { method, headers: { Origin: origin, Cookie: cookie } });
    const firstCookie = await login(), actor = await requireActor(request(firstCookie)), draft = createEmptyDraft();
    draft.editorData.home = { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Heading', props: { id: 'headline', text: 'Supplied original title', level: 'h1' } }] };
    db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
    const candidate = createExternalSiteDesignCandidate({ expectedRevision: 0, instruction: '仅调整首页标题，保留其余真实资料。', targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false }, preserveText: false }, { summary: 'PRIVATE_PARAMS_CANDIDATE', warnings: [], operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'text', id: 'headline', text: 'PRIVATE_PARAMS_NEW_TITLE' }] }] }, actor, () => {});
    const stored = () => db.prepare('SELECT payload_json FROM cms_ai_site_design WHERE id=?').get(candidate.designId);
    const successDeletes = () => db.prepare("SELECT count(*) n FROM cms_audit WHERE action='ai.siteDesign.delete' AND result='success'").get();
    const signOut = async (cookie: string) => { await auth.api.signOut({ headers: request(cookie).headers }); assert.equal(await auth.api.getSession({ headers: request(cookie).headers, query: { disableCookieCache: true } }), null); assert.equal((db.prepare('SELECT role FROM auth_user WHERE id=?').get(actor.id) as { role: string }).role, 'admin'); };
    await t.test('DELETE鉴权后params悬挂再signOut：返回401且私有候选/草稿/成功删除审计保持', async () => {
      const before = getStudioEnvelope(), payload = stored(), audits = successDeletes(), held = heldParams(candidate.designId), pending = DELETE(request(firstCookie, 'DELETE'), { params: held.params });
      await held.wait(); await signOut(firstCookie); held.release(); const response = await pending; assert.equal(response.status, 401);
      assert.deepEqual(stored(), payload); assert.deepEqual(getStudioEnvelope(), before); assert.deepEqual(successDeletes(), audits);
    });
    await t.test('GET鉴权后params悬挂再signOut：不返回私有预览正文，候选仍保留', async () => {
      const cookie = await login(), payload = stored(), held = heldParams(candidate.designId), pending = GET(request(cookie), { params: held.params });
      await held.wait(); await signOut(cookie); held.release(); const response = await pending; assert.equal(response.status, 401);
      const body = await response.json(); assert.deepEqual(Object.keys(body), ['error']); assert.equal(JSON.stringify(body).includes('PRIVATE_PARAMS'), false); assert.deepEqual(stored(), payload);
    });
    for (const [name, handler, id] of [['视觉截图', readVisualCapture, 'avc-00000000-0000-4000-8000-000000000000'], ['翻译候选', readTranslation, 'ait-00000000-0000-4000-8000-000000000000']] as const) {
      await t.test(`${name}等候params时登出，先返回401而非读取私有任务`, async () => {
        const cookie = await login(), held = heldParams(id), before = getStudioEnvelope(), pending = handler(request(cookie), { params: held.params });
        await held.wait(); await signOut(cookie); held.release(); const response = await pending;
        assert.equal(response.status, 401); assert.deepEqual(Object.keys(await response.json()), ['error']); assert.deepEqual(getStudioEnvelope(), before);
      });
    }
    await t.test('有效会话正常读取和删除仍成功，撤会话后的新请求继续401', async () => {
      assert.equal((await GET(request(firstCookie), { params: Promise.resolve({ id: candidate.designId }) })).status, 401);
      const cookie = await login(), response = await GET(request(cookie), { params: Promise.resolve({ id: candidate.designId }) }); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.designId, candidate.designId); assert.equal(body.summary, 'PRIVATE_PARAMS_CANDIDATE');
      assert.equal((await DELETE(request(cookie, 'DELETE'), { params: Promise.resolve({ id: candidate.designId }) })).status, 200); assert.equal(stored(), undefined);
    });
  } finally {
    db.close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
    const target = resolve(directory), parent = resolve(tmpdir()); if (target.startsWith(`${parent}${sep}studio-params-revocation-`)) rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
