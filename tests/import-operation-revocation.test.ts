import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { Metadata, Sharp } from 'sharp';
import { getMigrations } from 'better-auth/db/migration';
import { getAuth } from '../src/server/auth';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { buildSitePackage, previewSitePackage } from '../src/server/site-package';
import { previewContentImport } from '../src/server/content-import';
import { previewDefaultLocaleMigration } from '../src/server/localization';
import protocol from '../src/lib/protocol.json';
import { POST as packageCommit } from '../src/app/api/site-packages/commit/route';
import { POST as contentCommit } from '../src/app/api/content-import/commit/route';
import { POST as templateSave } from '../src/app/api/page-templates/from-page/route';
import { POST as templateApply } from '../src/app/api/page-templates/apply/route';
import { POST as localeCommit } from '../src/app/api/localization/default-commit/route';
import { POST as localeCopy } from '../src/app/api/localization/copy/route';
import { POST as observations } from '../src/app/api/discovery/route';
import { POST as preset } from '../src/app/api/discovery/presets/route';

const origin = 'http://127.0.0.1:3286', password = 'Synthetic-import-role-password-123';
let directory = '', previous: NodeJS.ProcessEnv, user: { id: string; email: string }, headers: Headers, sequence = 0;
type Handler = (request: Request) => Promise<Response>;
before(async () => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-import-revocation-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-import-revocation-secret-'.repeat(3);
  getDraftRecord(); await (await getMigrations(getAuth().options)).runMigrations();
});
beforeEach(async () => {
  const auth = getAuth(); user = (await auth.api.createUser({ body: { name: 'Synthetic route administrator', email: `import-role-${++sequence}@example.invalid`, password, role: 'admin' } })).user;
  const login = await auth.api.signInEmail({ body: { email: user.email, password }, asResponse: true }); assert.equal(login.status, 200);
  headers = new Headers({ Origin: origin, 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }); resetDraft();
});
afterEach(() => mock.restoreAll());
after(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-import-revocation-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function resetDraft() {
  const draft = createEmptyDraft(); draft.settings.locales = [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }, { code: 'fr', label: 'Français' }]; draft.pages[0] = { ...draft.pages[0], locale: 'en', translationGroupId: 'home-translations' };
  draft.pages.push({ ...draft.pages[0], id: 'de-home', title: 'Startseite', slug: '/de', locale: 'de' });
  const data = { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Text', props: { id: 'source-copy', text: 'Supplied company content' } }] };
  draft.editorData = { home: data, 'de-home': structuredClone(data) }; draft.pageTemplates = [{ id: 'supplied-template', kind: 'page', name: 'Supplied template', description: '', sourcePath: '/', updated: '', data: structuredClone(data), code: { css: '#source-copy{color:#123456}', js: 'document.documentElement.dataset.demo = "true";', cssEnabled: true, jsEnabled: true } }];
  getDatabase().prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft)); getDatabase().prepare('DELETE FROM cms_discovery_observation').run();
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function delayedBody(path: string, body: unknown) {
  const entered = deferred<void>(), gate = deferred<void>(); let pulled = false;
  // highWaterMark=0确保只有生产handler鉴权完开始read()后才进入pull，不用构造期预读伪造等待窗口。
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) { if (pulled) return; pulled = true; entered.resolve(); await gate.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } }, { highWaterMark: 0 });
  return { request: new Request(`${origin}${path}`, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' }), entered: entered.promise, release: () => gate.resolve() };
}
async function atGate<T>(gate: Promise<void>, outcome: Promise<T>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([gate, outcome.then(() => { throw Error('生产route在到达请求体等待点前已返回'); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('没有到达真实异步等待点')), 10000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function held(path: string, handler: Handler, body: unknown, change: () => void, expected: number) {
  const before = getDraftRecord(), active = getStudioEnvelope().activeReleaseId, request = delayedBody(path, body), response = handler(request.request);
  try { await atGate(request.entered, response); change(); }
  finally { request.release(); }
  const result = await response; assert.equal(result.status, expected, path); assert.deepEqual(getDraftRecord(), before, `${path}不得写草稿`); assert.equal(getStudioEnvelope().activeReleaseId, active); return result;
}
function contentInput() { const input = { expectedRevision: 0, format: 'json', target: 'product', content: JSON.stringify({ schemaVersion: 1, kind: 'product', rows: [{ name: 'Supplied imported chair', sku: 'IMPORT-01' }] }), mapping: { name: 'builtin:name', sku: 'builtin:sku' } }; const preview = previewContentImport(input); assert.deepEqual(preview.errors, []); return { ...input, confirmation: preview.confirmation }; }
async function packageInput(withImage = false) {
  const draft = createEmptyDraft(); draft.editorData.home = { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Text', props: { id: 'pack-copy', text: 'Supplied packaged page' } }] };
  if (withImage) { draft.media = [{ id: 'source-photo', name: 'Supplied bundled chair', url: '/images/chair.jpg', kind: 'image', alt: '', folder: '', size: '1KB' }]; (draft.editorData.home as { content: unknown[] }).content.push({ type: 'Image', props: { id: 'pack-photo', src: '/images/chair.jpg', alt: 'Supplied chair' } }); }
  const pkg = buildSitePackage({ ...draft, schemaVersion: protocol.snapshot }, { name: 'Synthetic route fixture', description: '', license: 'Synthetic local regression fixture.' });
  const input = { package: pkg, expectedRevision: 0, options: { mode: 'merge', prefix: 'copied', skuPrefix: '', enableJs: false } }, preview = await previewSitePackage(input); return { ...input, confirmation: preview.confirmation };
}
const downgrade = () => { getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('viewer', user.id); };
const revoke = () => { getDatabase().prepare('DELETE FROM auth_session WHERE userId=?').run(user.id); };

test('真实cookie和延迟请求体下，导入/模板/语言/观测写route均拒绝等待期间降权', async () => {
  const migration = { expectedRevision: 0, baseReleaseId: null, language: 'de', includeRedirects: false }, plan = previewDefaultLocaleMigration(migration); assert.deepEqual(plan.errors, []);
  const cases: [string, Handler, unknown][] = [
    ['/api/content-import/commit', contentCommit, contentInput()],
    ['/api/page-templates/from-page', templateSave, { expectedRevision: 0, pageId: 'home', templateId: 'copied-template', name: 'Copied template' }],
    ['/api/page-templates/apply', templateApply, { expectedRevision: 0, templateId: 'supplied-template', newPageId: 'copied-page', title: 'Copied page', slug: '/copied-page' }],
    ['/api/localization/default-commit', localeCommit, { ...migration, expectedChangeHash: plan.changeHash, acknowledgeUnavailableRedirects: true }],
    ['/api/localization/copy', localeCopy, { expectedRevision: 0, kind: 'page', sourceId: 'home', locale: 'fr' }],
    ['/api/discovery', observations, { action: 'record', rows: [{ kind: 'manual-answer', platform: 'Synthetic test', date: '2026-11-14', timezone: 'UTC', count: 0, url: '', source: 'Synthetic observation', notes: '' }] }],
    ['/api/discovery/presets', preset, { expectedRevision: 0, kind: 'capability' }],
    ['/api/site-packages/commit', packageCommit, await packageInput()],
  ];
  for (const [path, handler, body] of cases) { await held(path, handler, body, downgrade, 403); getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('admin', user.id); }
  assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_discovery_observation').get() as { n: number }).n, 0);
});

test('内容导入等待期间仅撤销会话也拒绝，保留合法产品预检但不写任何新产品', async () => {
  await held('/api/content-import/commit', contentCommit, contentInput(), revoke, 401); assert.deepEqual(getDraftRecord().content.products, []);
});

test('模板复制代码使用读体后的角色，管理员降为编辑员不能沿用旧canCode', async () => {
  await held('/api/page-templates/apply', templateApply, { expectedRevision: 0, templateId: 'supplied-template', newPageId: 'copied-page', title: 'Copied page', slug: '/copied-page', includeCode: true, enableJs: true }, () => { getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('editor', user.id); }, 403);
  assert.equal(getDraftRecord().content.customCode, undefined);
});

test('合法编辑权限与管理员模板代码复制仍经真实route成功', async () => {
  getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('editor', user.id);
  const imported = await contentCommit(new Request(`${origin}/api/content-import/commit`, { method: 'POST', headers, body: JSON.stringify(contentInput()) })); assert.equal(imported.status, 200); assert.equal(getDraftRecord().content.products[0].sku, 'IMPORT-01');
  getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('admin', user.id); const applied = await templateApply(new Request(`${origin}/api/page-templates/apply`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: getDraftRecord().revision, templateId: 'supplied-template', newPageId: 'copied-page', title: 'Copied page', slug: '/copied-page', includeCode: true, enableJs: true }) })); assert.equal(applied.status, 200); assert.equal(getDraftRecord().content.customCode?.pages['copied-page'].jsEnabled, true);
});

test('分发包真正异步图片解码期间撤会话，最终事务不写媒体文件索引或草稿', async () => {
  const input = await packageInput(true), before = getDraftRecord(), active = getStudioEnvelope().activeReleaseId, entered = deferred<void>(), gate = deferred<void>(), prototype = Object.getPrototypeOf(sharp()) as Sharp, nativeMetadata = prototype.metadata as () => Promise<Metadata>;
  // 只暂停真实Sharp解码边界；生产route、认证、包校验、提交事务及授权回调全部照常执行。
  mock.method(prototype, 'metadata', async function(this: Sharp) { entered.resolve(); await gate.promise; return nativeMetadata.call(this); });
  const result = packageCommit(new Request(`${origin}/api/site-packages/commit`, { method: 'POST', headers, body: JSON.stringify(input) }));
  try { await atGate(entered.promise, result); revoke(); }
  finally { gate.resolve(); }
  const response = await result; assert.equal(response.status, 401); assert.deepEqual(getDraftRecord(), before); assert.equal(getStudioEnvelope().activeReleaseId, active); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_media_file').get() as { n: number }).n, 0);
  const mediaPath = join(directory, 'data', 'media'); assert.deepEqual(existsSync(mediaPath) ? readdirSync(mediaPath) : [], []);
});
