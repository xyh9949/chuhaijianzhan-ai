import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { getAuth } from '../src/server/auth';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { publishSite } from '../src/server/publication';
import { createExternalAiToken, requireExternalAiGrant } from '../src/server/external-ai-tokens';
import { externalAiWritingContext, submitExternalAiWriting } from '../src/server/external-ai-writing';
import type { Actor } from '../src/server/permissions';
import { POST as mintToken } from '../src/app/api/external-ai/tokens/route';
import { DELETE as revokeToken } from '../src/app/api/external-ai/tokens/[id]/route';
import { GET as reviewContent } from '../src/app/api/external-ai/content/[id]/route';
import { POST as applyContent } from '../src/app/api/external-ai/content/[id]/apply/route';
import { POST as undoContent } from '../src/app/api/external-ai/content/[id]/undo/route';
import { POST as exportPackage } from '../src/app/api/site-packages/export/route';
import { POST as captureVisual } from '../src/app/api/ai/visual/captures/route';
import { POST as reviewVisual } from '../src/app/api/ai/visual/reviews/route';
import { POST as generateTranslation } from '../src/app/api/ai/translations/route';
import { POST as applyTranslation } from '../src/app/api/ai/translations/[id]/apply/route';
import { POST as undoTranslation } from '../src/app/api/ai/translations/[id]/undo/route';

const origin = 'http://127.0.0.1:3285', password = 'Synthetic-request-session-password-123';
let directory = '', previous: NodeJS.ProcessEnv, actor: Actor, headers: Headers, sequence = 0;
type Handler = (request: Request) => Promise<Response>;
before(async () => { previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-request-session-')); process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-request-session-secret-'.repeat(3); getDraftRecord(); await (await getMigrations(getAuth().options)).runMigrations(); });
beforeEach(async () => {
  const auth = getAuth(), user = (await auth.api.createUser({ body: { name: 'Synthetic session administrator', email: `request-session-${++sequence}@example.invalid`, password, role: 'admin' } })).user; actor = { id: user.id, name: user.name, email: user.email, role: 'admin' };
  const login = await auth.api.signInEmail({ body: { email: actor.email, password }, asResponse: true }); assert.equal(login.status, 200); headers = new Headers({ Origin: origin, 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') });
  const draft = createEmptyDraft(); draft.editorData.home = { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Text', props: { id: 'source-copy', text: 'Supplied company information' } }] }; draft.products = [{ id: 'supplied-product', name: 'Supplied chair', sku: 'CHAIR-01', category: 'Seating', material: 'Wood', description: 'Original product introduction', image: '', status: 'draft' }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft)); db.prepare('UPDATE cms_runtime SET active_release_id=NULL WHERE id=1').run();
});
after(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-request-session-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function held(path: string, handler: Handler, body: unknown, change: () => void) {
  const entered = deferred<void>(), gate = deferred<void>(); let pulled = false, timer: ReturnType<typeof setTimeout> | undefined, gateError: unknown;
  // 真正鉴权后读body才会pull；不伪造Actor，也不让构造期预读取代生产等待窗口。
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) { if (pulled) return; pulled = true; entered.resolve(); await gate.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } }, { highWaterMark: 0 });
  const response = handler(new Request(`${origin}${path}`, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' }));
  try { await Promise.race([entered.promise, response.then(() => { throw Error('未到达真实body等待点就已返回'); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('等待body读取超时')), 10000); })]); change(); }
  catch (error) { gateError = error; }
  finally { if (timer) clearTimeout(timer); gate.resolve(); }
  const result = await response; if (gateError) throw gateError; return result;
}
const revokeSession = () => { getDatabase().prepare('DELETE FROM auth_session WHERE userId=?').run(actor.id); };
function writingCandidate() {
  const issued = createExternalAiToken({ name: 'Synthetic writing connection', scopes: ['read', 'content:read', 'content:propose'], recordIds: { productIds: ['supplied-product'], entryIds: [] } }, actor), grant = requireExternalAiGrant(new Request(`${origin}/api/mcp`, { headers: { Authorization: `Bearer ${issued.token}` } }));
  const context = externalAiWritingContext(grant, { target: { kind: 'product', id: 'supplied-product' }, task: 'product', fieldKeys: ['description'], instruction: 'Clarify the supplied product introduction.', factIds: [] });
  return submitExternalAiWriting(grant, { requestId: 'session-writing', request: context.request, proposal: { fields: [{ key: 'description', after: 'Clear supplied product introduction' }], warnings: [], missingFacts: [], evidenceIds: [] } });
}
function publish() { const current = getDraftRecord(); return publishSite({ expectedRevision: current.revision, baseReleaseId: getStudioEnvelope().activeReleaseId, pageIds: ['home'], productIds: [], includeTheme: true, includeSettings: true }, actor); }

test('外部AI凭据POST等待body期间仅撤会话，不降角色也不能造新持久凭据', async () => {
  const before = (getDatabase().prepare('SELECT count(*) n FROM cms_external_ai_token').get() as { n: number }).n;
  const result = await held('/api/external-ai/tokens', mintToken, { name: 'Must not mint', scopes: ['read', 'propose'], pageIds: ['home'] }, revokeSession);
  assert.equal(result.status, 401); assert.equal((getDatabase().prepare('SELECT role FROM auth_user WHERE id=?').get(actor.id) as { role: string }).role, 'admin'); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_external_ai_token').get() as { n: number }).n, before);
});

test('外部内容采用等待body时仅撤会话，候选和产品草稿均保持', async () => {
  const candidate = writingCandidate(), before = getDraftRecord();
  const result = await held(`/api/external-ai/content/${candidate.id}/apply`, request => applyContent(request, { params: Promise.resolve({ id: candidate.id }) }), { expectedRevision: before.revision, selectedKeys: ['description'] }, revokeSession);
  assert.equal(result.status, 401); assert.deepEqual(getDraftRecord(), before); assert.equal((getDatabase().prepare('SELECT applied_revision FROM cms_external_ai_writing WHERE id=?').get(candidate.id) as { applied_revision: number | null }).applied_revision, null);
});

test('站点导出等待body时停用管理员，不返回原先已有发布包', async () => {
  publish(); const before = getDraftRecord(), active = getStudioEnvelope().activeReleaseId;
  const result = await held('/api/site-packages/export', exportPackage, { name: 'Synthetic export', license: 'Synthetic local fixture.' }, () => { getDatabase().prepare('UPDATE auth_user SET banned=1 WHERE id=?').run(actor.id); });
  assert.equal(result.status, 401); assert.deepEqual(getDraftRecord(), before); assert.equal(getStudioEnvelope().activeReleaseId, active);
});

test('合法会话仍可造凭据、查看并采用撤销内容、导出发布包及撤销连接', async () => {
  const minted = await mintToken(new Request(`${origin}/api/external-ai/tokens`, { method: 'POST', headers, body: JSON.stringify({ name: 'Synthetic valid connection', scopes: ['read'], pageIds: ['home'] }) })); assert.equal(minted.status, 201); const issued = await minted.json(); assert.equal(typeof issued.token, 'string');
  const candidate = writingCandidate(), context = { params: Promise.resolve({ id: candidate.id }) }, before = getDraftRecord(); assert.equal((await reviewContent(new Request(`${origin}/api/external-ai/content/${candidate.id}`, { headers }), context)).status, 200);
  const applied = await applyContent(new Request(`${origin}/api/external-ai/content/${candidate.id}/apply`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: before.revision, selectedKeys: ['description'] }) }), context); assert.equal(applied.status, 200); assert.equal(getDraftRecord().content.products[0].description, 'Clear supplied product introduction');
  const undone = await undoContent(new Request(`${origin}/api/external-ai/content/${candidate.id}/undo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: getDraftRecord().revision }) }), context); assert.equal(undone.status, 200); assert.equal(getDraftRecord().content.products[0].description, 'Original product introduction');
  publish(); const exported = await exportPackage(new Request(`${origin}/api/site-packages/export`, { method: 'POST', headers, body: JSON.stringify({ name: 'Synthetic export', license: 'Synthetic local fixture.' }) })); assert.equal(exported.status, 200); assert.equal((await exported.json()).format, 'form-studio-site');
  const revoked = await revokeToken(new Request(`${origin}/api/external-ai/tokens/${issued.credential.id}`, { method: 'DELETE', headers }), { params: Promise.resolve({ id: issued.credential.id }) }); assert.equal(revoked.status, 200); assert.ok((await revoked.json()).credential.revokedAt);
});

// 必须先在生产鉴权后真实等待body；撤会话应在浏览器、模型、候选查找或业务写入之前拒绝。
for (const [label, path, handler, body] of [
  ['视觉截图', '/api/ai/visual/captures', captureVisual, { target: { kind: 'site-design', id: 'not-started' }, devices: ['mobile'] }],
  ['视觉模型检查', '/api/ai/visual/reviews', reviewVisual, { captureId: 'not-started', imageIds: ['mobile'], instruction: '' }],
  ['生成翻译', '/api/ai/translations', generateTranslation, { kind: 'product', sourceId: 'supplied-product', targetLocale: 'de', expectedRevision: 0, fieldKeys: ['description'], terms: [] }],
  ['采用翻译', '/api/ai/translations/not-started/apply', (request: Request) => applyTranslation(request, { params: Promise.resolve({ id: 'not-started' }) }), { expectedRevision: 0, selectedKeys: ['description'] }],
  ['撤销翻译', '/api/ai/translations/not-started/undo', (request: Request) => undoTranslation(request, { params: Promise.resolve({ id: 'not-started' }) }), { expectedRevision: 0 }],
] as const) {
  test(`${label}在完整读体前撤会话：401且无私有任务或草稿写入`, async () => {
    const before = getStudioEnvelope(), db = getDatabase(), tables = ['cms_ai_visual_capture', 'cms_ai_visual_review', 'cms_ai_translation'];
    const counts = () => tables.map(name => (db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n), original = counts();
    assert.equal((await held(path, handler, body, revokeSession)).status, 401); assert.deepEqual(counts(), original); assert.deepEqual(getStudioEnvelope(), before);
  });
}
