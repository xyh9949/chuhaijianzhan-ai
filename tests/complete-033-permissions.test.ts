import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer, type Server } from 'node:http';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { getMigrations } from 'better-auth/db/migration';
import { getAuth } from '../src/server/auth';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { requireActor, revalidateActor, type Actor } from '../src/server/permissions';
import { ApiError } from '../src/server/http';
import { deleteMedia } from '../src/server/media';
import { getAiProviderSummary, saveAiProvider } from '../src/server/ai-provider';
import { enhanceAiSource, adoptAiSourceImage } from '../src/server/ai-source-enhance';
import { POST as siteGenerate } from '../src/app/api/ai/site-translations/route';
import { GET as siteRead, DELETE as siteDelete } from '../src/app/api/ai/site-translations/[id]/route';
import { POST as siteSelect } from '../src/app/api/ai/site-translations/[id]/select/route';
import { POST as siteApply } from '../src/app/api/ai/site-translations/[id]/apply/route';
import { POST as siteUndo } from '../src/app/api/ai/site-translations/[id]/undo/route';
import { PATCH as glossary } from '../src/app/api/ai/site-translations/glossary/route';
import { POST as seoGenerate } from '../src/app/api/seo/content/route';
import { GET as seoRead, DELETE as seoDelete } from '../src/app/api/seo/content/[id]/route';
import { POST as seoApply } from '../src/app/api/seo/content/[id]/apply/route';
import { POST as seoUndo } from '../src/app/api/seo/content/[id]/undo/route';
import { POST as sourceUpload, GET as sourceList } from '../src/app/api/ai/sources/route';
import { GET as sourceRead, DELETE as sourceDelete } from '../src/app/api/ai/sources/[id]/route';
import { GET as sourceFile } from '../src/app/api/ai/sources/[id]/file/route';
import { GET as sourceImage } from '../src/app/api/ai/sources/[id]/images/[imageId]/route';
import { POST as sourceEnhance } from '../src/app/api/ai/sources/[id]/enhance/route';
import { POST as sourceAdopt } from '../src/app/api/ai/sources/[id]/images/adopt/route';
import { POST as mergePrepare } from '../src/app/api/ai/sources/merge/prepare/route';
import { POST as mergePreview } from '../src/app/api/ai/sources/merge/preview/route';
import { POST as mergeConfirm } from '../src/app/api/ai/sources/merge/confirm/route';
import { POST as mergeUndo } from '../src/app/api/ai/sources/merge/undo/route';
import { GET as mergeRead } from '../src/app/api/ai/sources/merge/[id]/route';
import { POST as batchCreate } from '../src/app/api/ai/batches/route';
import { GET as batchRead, PATCH as batchControl, DELETE as batchDelete } from '../src/app/api/ai/batches/[id]/route';
import { POST as batchAction } from '../src/app/api/ai/batches/[id]/items/[position]/[action]/route';
import { PATCH as pricing } from '../src/app/api/ai/usage/pricing/route';
import { GET as usage } from '../src/app/api/ai/usage/route';
import { POST as detailSelect } from '../src/app/api/ai/detail-designs/select/route';

const origin = 'http://127.0.0.1:3283', password = 'Synthetic-complete-033-password-123';
let directory = '', previous: NodeJS.ProcessEnv, actor: Actor, headers: Headers, sequence = 0;
type Params = { id: string; imageId: string; position: string; action: string };
const params: Params = { id: 'ais-00000000-0000-4000-8000-000000000000', imageId: 'img-000000000000000000000000', position: '0', action: 'generate' };
type Handler = (request: Request) => Promise<Response>;
type ParamHandler = (request: Request, params: Promise<Params>) => Promise<Response>;
const context = (value: Params = params) => ({ params: Promise.resolve(value) });
before(async () => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-complete-033-permissions-')); process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-complete-033-secret-'.repeat(3);
  getDraftRecord(); await (await getMigrations(getAuth().options)).runMigrations();
});
async function login() {
  const auth = getAuth(), user = (await auth.api.createUser({ body: { name: 'Synthetic 033 administrator', email: `complete-033-${++sequence}@example.invalid`, password, role: 'admin' } })).user;
  const response = await auth.api.signInEmail({ body: { email: user.email, password }, asResponse: true }); assert.equal(response.status, 200);
  const requestHeaders = new Headers({ Origin: origin, 'Content-Type': 'application/json', Cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') });
  return { actor: await requireActor(new Request(`${origin}/api/studio`, { headers: requestHeaders })), headers: requestHeaders };
}
beforeEach(async () => {
  ({ actor, headers } = await login()); const draft = createEmptyDraft(); draft.settings.language = 'en'; draft.settings.locales = [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }];
  draft.products = [{ id: 'complete-product', name: 'Supplied private product', sku: '033-SUPPLIED', category: 'Samples', description: 'Supplied original introduction', material: 'Steel', image: '', status: 'draft' }];
  draft.editorData.home = { root: { props: { title: 'Home', brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Text', props: { id: 'private-033-copy', text: 'Supplied private 033 company text' } }] };
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft)); db.prepare('UPDATE cms_runtime SET active_release_id=NULL WHERE id=1').run();
});
after(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  const path = resolve(directory), root = resolve(tmpdir()); if (path.startsWith(root + sep + 'studio-complete-033-permissions-')) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const revoke = () => { getDatabase().prepare('DELETE FROM auth_session WHERE userId=?').run(actor.id); };
const privateCounts = () => ['cms_ai_source', 'cms_ai_site_translation', 'cms_seo_content_proposal', 'cms_ai_batch_job', 'cms_ai_batch_item', 'cms_ai_usage', 'cms_ai_pricing', 'cms_ai_translation_glossary', 'cms_ai_template_design'].map(table => (getDatabase().prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n);
/** 使用真实登录会话；只有生产路由已鉴权并开始读取body才放开撤会话窗口。 */
async function heldBody(path: string, method: string, handler: Handler, body: unknown, change = revoke) {
  const reached = deferred<void>(), gate = deferred<void>(); let pulled = false, timer: NodeJS.Timeout | undefined;
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) { if (pulled) return; pulled = true; reached.resolve(); await gate.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } }, { highWaterMark: 0 });
  const pending = handler(new Request(`${origin}${path}`, { method, headers, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' }));
  try { await Promise.race([reached.promise, pending.then(() => { throw Error('生产路由未进入body等待点'); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('body等待超时')), 10000); })]); change(); }
  finally { clearTimeout(timer); gate.resolve(); }
  return pending;
}
const bodyCases: [string, string, string, Handler, unknown][] = [
  ['整站翻译生成', '/api/ai/site-translations', 'POST', siteGenerate, {}],
  ['整站翻译选择', '/api/ai/site-translations/id/select', 'POST', req => siteSelect(req, context()), {}],
  ['整站翻译采用', '/api/ai/site-translations/id/apply', 'POST', req => siteApply(req, context()), {}],
  ['整站翻译撤销', '/api/ai/site-translations/id/undo', 'POST', req => siteUndo(req, context()), {}],
  ['翻译术语保存', '/api/ai/site-translations/glossary', 'PATCH', glossary, { expectedRevision: 0, entries: [] }],
  ['正文SEO生成', '/api/seo/content', 'POST', seoGenerate, {}],
  ['正文SEO采用', '/api/seo/content/id/apply', 'POST', req => seoApply(req, context()), {}],
  ['正文SEO撤销', '/api/seo/content/id/undo', 'POST', req => seoUndo(req, context()), {}],
  ['离线OCR抽图', '/api/ai/sources/id/enhance', 'POST', req => sourceEnhance(req, context()), {}],
  ['来源图片采用', '/api/ai/sources/id/images/adopt', 'POST', req => sourceAdopt(req, context()), {}],
  ['多来源准备', '/api/ai/sources/merge/prepare', 'POST', mergePrepare, {}],
  ['多来源预览', '/api/ai/sources/merge/preview', 'POST', mergePreview, {}],
  ['多来源确认', '/api/ai/sources/merge/confirm', 'POST', mergeConfirm, {}],
  ['多来源撤销', '/api/ai/sources/merge/undo', 'POST', mergeUndo, {}],
  ['批量任务创建', '/api/ai/batches', 'POST', batchCreate, {}],
  ['批量任务控制', '/api/ai/batches/id', 'PATCH', req => batchControl(req, context()), {}],
  ['批量任务生成', '/api/ai/batches/id/items/0/generate', 'POST', req => batchAction(req, context()), {}],
  ['批量任务采用', '/api/ai/batches/id/items/0/apply', 'POST', req => batchAction(req, context({ ...params, action: 'apply' })), {}],
  ['批量任务撤销', '/api/ai/batches/id/items/0/undo', 'POST', req => batchAction(req, context({ ...params, action: 'undo' })), {}],
  ['AI用量价格保存', '/api/ai/usage/pricing', 'PATCH', pricing, { expectedRevision: 0, rates: [] }],
  ['详情范围选择', '/api/ai/detail-designs/select', 'POST', detailSelect, {}],
];
for (const [label, path, method, handler, body] of bodyCases) test(`${label}：鉴权后慢body期间仅撤会话，401且不写私有任务或草稿`, async () => {
  const before = getStudioEnvelope(), counts = privateCounts(); const response = await heldBody(path, method, handler, body);
  assert.equal(response.status, 401); assert.deepEqual(Object.keys(await response.json()), ['error']); assert.deepEqual(getStudioEnvelope(), before); assert.deepEqual(privateCounts(), counts);
  assert.equal((getDatabase().prepare('SELECT role FROM auth_user WHERE id=?').get(actor.id) as { role: string }).role, 'admin');
});
function heldParams(value: Params = params) {
  const reached = deferred<void>(); let release!: () => void;
  class Held extends Promise<Params> { static get [Symbol.species]() { return Promise; } then<T = Params, E = never>(ok?: ((value: Params) => T | PromiseLike<T>) | null, fail?: ((error: unknown) => E | PromiseLike<E>) | null): Promise<T | E> { reached.resolve(); return super.then(ok, fail); } }
  return { params: new Held(done => { release = () => done(value); }), release: () => release(), reached: reached.promise };
}
const paramCases: [string, string, string, ParamHandler][] = [
  ['整站翻译读取', '/api/ai/site-translations/id', 'GET', (req, params) => siteRead(req, { params })],
  ['整站翻译删除', '/api/ai/site-translations/id', 'DELETE', (req, params) => siteDelete(req, { params })],
  ['正文SEO读取', '/api/seo/content/id', 'GET', (req, params) => seoRead(req, { params })],
  ['正文SEO删除', '/api/seo/content/id', 'DELETE', (req, params) => seoDelete(req, { params })],
  ['私有来源读取', '/api/ai/sources/id', 'GET', (req, params) => sourceRead(req, { params })],
  ['私有来源删除', '/api/ai/sources/id', 'DELETE', (req, params) => sourceDelete(req, { params })],
  ['私有原件下载', '/api/ai/sources/id/file', 'GET', (req, params) => sourceFile(req, { params })],
  ['私有来源图片', '/api/ai/sources/id/images/image', 'GET', (req, params) => sourceImage(req, { params })],
  ['合并记录读取', '/api/ai/sources/merge/id', 'GET', (req, params) => mergeRead(req, { params })],
  ['批量任务读取', '/api/ai/batches/id', 'GET', (req, params) => batchRead(req, { params })],
  ['批量任务删除', '/api/ai/batches/id', 'DELETE', (req, params) => batchDelete(req, { params })],
];
for (const [label, path, method, handler] of paramCases) test(`${label}：真实会话鉴权后慢params再signOut，私有数据不外返`, async () => {
  const held = heldParams(), before = getStudioEnvelope(), counts = privateCounts(), pending = handler(new Request(`${origin}${path}`, { method, headers }), held.params); let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([held.reached, pending.then(() => { throw Error('生产路由未进入params等待点'); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('params等待超时')), 10000); })]); await getAuth().api.signOut({ headers }); }
  finally { clearTimeout(timer); held.release(); }
  const response = await pending; assert.equal(response.status, 401); assert.deepEqual(Object.keys(await response.json()), ['error']); assert.deepEqual(getStudioEnvelope(), before); assert.deepEqual(privateCounts(), counts);
});
test('慢body后的管理员降权与仅登出区别：返回403，仍不写全站配置', async () => {
  const counts = privateCounts(), response = await heldBody('/api/ai/usage/pricing', 'PATCH', pricing, { expectedRevision: 0, rates: [] }, () => { getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(actor.id); });
  assert.equal(response.status, 403); assert.deepEqual(privateCounts(), counts);
});
test('真实multipart完整到达前登出：上传不启动解析、不保存私有原件或资料记录', async () => {
  const book = new ExcelJS.Workbook(); book.addWorksheet('Products').addRow(['Supplied product']); const form = new FormData(); form.set('file', new File([new Uint8Array(await book.xlsx.writeBuffer())], 'held-private.xlsx'));
  const encoded = new Response(form), bytes = new Uint8Array(await encoded.arrayBuffer()), requestHeaders = new Headers(headers); requestHeaders.set('Content-Type', encoded.headers.get('Content-Type')!);
  const reached = deferred<void>(), gate = deferred<void>(); let pulled = false, timer: NodeJS.Timeout | undefined;
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) { if (pulled) return; pulled = true; reached.resolve(); await gate.promise; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
  const counts = privateCounts(), before = getStudioEnvelope(), pending = sourceUpload(new Request(`${origin}/api/ai/sources`, { method: 'POST', headers: requestHeaders, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' }));
  try { await Promise.race([reached.promise, pending.then(() => { throw Error('上传未进入真实multipart读取窗口'); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('multipart等待超时')), 10000); })]); await getAuth().api.signOut({ headers }); }
  finally { clearTimeout(timer); gate.resolve(); }
  const response = await pending; assert.equal(response.status, 401); assert.deepEqual(privateCounts(), counts); assert.deepEqual(getStudioEnvelope(), before);
});
async function uploadedImages(enhance = true) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Products'); sheet.addRow(['Name', 'SKU']); sheet.addRow(['Supplied private product', '033-0001']);
  const picture = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#335577' } }).png().toBuffer(), imageId = book.addImage({ buffer: picture as never, extension: 'png' }); sheet.addImage(imageId, { tl: { col: 2, row: 1 }, ext: { width: 80, height: 60 } });
  const form = new FormData(); form.set('file', new File([new Uint8Array(await book.xlsx.writeBuffer())], 'private-033.xlsx'));
  const requestHeaders = new Headers(headers); requestHeaders.delete('Content-Type'); const response = await sourceUpload(new Request(`${origin}/api/ai/sources`, { method: 'POST', headers: requestHeaders, body: form })); assert.equal(response.status, 201);
  const record = await response.json(); return enhance ? enhanceAiSource(record.id, { images: true, ocr: false, language: 'eng' }, actor, undefined, () => revalidateActor(actor, 'manage')) : record as Awaited<ReturnType<typeof enhanceAiSource>>;
}
test('离线worker处理完成后、私有写入前撤真实会话，原件保留且不提交抽图结果', async () => {
  const record = await uploadedImages(false), original = getDatabase().prepare('SELECT payload_json FROM cms_ai_source WHERE id=?').get(record.id), before = getStudioEnvelope(); let checks = 0;
  await assert.rejects(enhanceAiSource(record.id, { images: true, ocr: false, language: 'eng' }, actor, undefined, () => { if (++checks === 1) revoke(); revalidateActor(actor, 'manage'); }), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(checks, 1); assert.deepEqual(getDatabase().prepare('SELECT payload_json FROM cms_ai_source WHERE id=?').get(record.id), original); assert.deepEqual(getStudioEnvelope(), before);
});
test('真实本人会话可读来源与原件、另一管理员不能靠UUID下载正文或提取图片', async () => {
  const record = await uploadedImages(), actual = { ...params, id: record.id, imageId: record.source.images![0].id }, foreign = await login(), own = new Request(`${origin}/api/ai/sources/${record.id}`, { headers });
  assert.equal((await sourceRead(own, context(actual))).status, 200); assert.equal((await sourceFile(own, context(actual))).status, 200); assert.equal((await sourceImage(own, context(actual))).status, 200);
  const request = new Request(`${origin}/api/ai/sources/${record.id}`, { headers: foreign.headers }); for (const handler of [sourceRead, sourceFile, sourceImage]) assert.equal((await handler(request, context(actual))).status, 404);
  const foreignList = await sourceList(request); assert.equal(foreignList.status, 200); assert.equal(JSON.stringify(await foreignList.json()).includes('private-033.xlsx'), false);
  const prepared = await mergePrepare(new Request(`${origin}/api/ai/sources/merge/prepare`, { method: 'POST', headers, body: JSON.stringify({ baseBrief: { companyName: 'Supplied company', description: '', industry: '', audience: '', market: '', styleNotes: '', language: 'en' }, selections: [{ sourceId: record.id, sheetIndex: 1, rowNumbers: [2] }] }) })); assert.equal(prepared.status, 200); const evidence = await prepared.json();
  assert.equal((await mergeRead(request, context({ ...params, id: evidence.evidenceSetId }))).status, 404);
  const ownUsage = await usage(new Request(`${origin}/api/ai/usage`, { headers })); assert.equal(ownUsage.status, 200); assert.equal((await ownUsage.json()).total, 0);
});
test('来源图片恢复采用最终事务必须重查素材仍在库，不能返回已被并发删除的成功回执', async () => {
  const record = await uploadedImages(), image = record.source.images![0], adopted = await adoptAiSourceImage(record.id, { imageId: image.id, expectedRevision: getDraftRecord().revision }, actor, () => revalidateActor(actor, 'manage'));
  let checks = 0;
  await assert.rejects(adoptAiSourceImage(record.id, { imageId: image.id, expectedRevision: adopted.revision }, actor, () => {
    // 图片读取后、恢复事务开始前提交另一窗口的真实删除，不能把删除放进待测事务随异常一并回滚。
    revalidateActor(actor, 'manage'); if (++checks === 1) deleteMedia(adopted.media.id, { expectedRevision: getDraftRecord().revision });
  }), (error: unknown) => error instanceof ApiError && error.status === 409);
  assert.equal(getDraftRecord().content.media.some(media => media.id === adopted.media.id), false);
});

/** 只监听loopback合成模型；精确停在模型已受理窗口，不模拟Actor或生产鉴权。 */
async function acceptedTranslation() {
  const reached = deferred<void>(), gate = deferred<void>(); let calls = 0;
  const server: Server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const envelope = JSON.parse(raw), task = JSON.parse(envelope.messages.at(-1).content) as { slots: { id: string; text: string }[] }; calls++; reached.resolve(); await gate.promise;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: task.slots.map(slot => ({ id: slot.id, text: `DE ${slot.text}` })) }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  saveAiProvider({ expectedRevision: getAiProviderSummary().revision, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, allowLocal: true, model: 'synthetic-033-permissions', apiKey: 'synthetic-local-only-key' }, actor);
  const body = { expectedRevision: getDraftRecord().revision, sourceLocale: 'en', targetLocale: 'de', pageIds: ['home'], includeChrome: false, terms: [], useGlossary: false };
  const pending = siteGenerate(new Request(`${origin}/api/ai/site-translations`, { method: 'POST', headers, body: JSON.stringify(body) }));
  return { pending, reached: reached.promise, release: () => gate.resolve(), calls: () => calls, close: async () => { gate.resolve(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}
test('模型已受理后仅登出保留本人私有结果；旧会话不能再读，新登录可恢复，网站始终未采用', async () => {
  const before = getStudioEnvelope(), task = await acceptedTranslation();
  try {
    await task.reached; await getAuth().api.signOut({ headers }); task.release(); const response = await task.pending; assert.equal(response.status, 201); const proposal = await response.json(); assert.equal(task.calls(), 1); assert.deepEqual(getStudioEnvelope(), before);
    const ctx = context({ ...params, id: proposal.id }); assert.equal((await siteRead(new Request(`${origin}/api/ai/site-translations/${proposal.id}`, { headers }), ctx)).status, 401);
    const loginResponse = await getAuth().api.signInEmail({ body: { email: actor.email, password }, asResponse: true }); assert.equal(loginResponse.status, 200); const newHeaders = new Headers({ Origin: origin, Cookie: loginResponse.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') });
    const restored = await siteRead(new Request(`${origin}/api/ai/site-translations/${proposal.id}`, { headers: newHeaders }), ctx); assert.equal(restored.status, 200); assert.equal((await restored.json()).id, proposal.id);
    const batch = await batchCreate(new Request(`${origin}/api/ai/batches`, { method: 'POST', headers: new Headers({ ...Object.fromEntries(newHeaders), 'Content-Type': 'application/json' }), body: JSON.stringify({ kind: 'writing', instruction: 'Clarify supplied facts', items: [{ kind: 'product', id: 'complete-product', fieldKeys: ['description'] }] }) })); assert.equal(batch.status, 201); const job = await batch.json(), foreign = await login();
    assert.equal((await siteRead(new Request(`${origin}/api/ai/site-translations/${proposal.id}`, { headers: foreign.headers }), ctx)).status, 404);
    assert.equal((await batchRead(new Request(`${origin}/api/ai/batches/${job.id}`, { headers: foreign.headers }), context({ ...params, id: job.id }))).status, 404);
    const foreignUsage = await usage(new Request(`${origin}/api/ai/usage`, { headers: foreign.headers })); assert.equal(foreignUsage.status, 200); assert.equal((await foreignUsage.json()).total, 0);
    const ownerUsage = await usage(new Request(`${origin}/api/ai/usage`, { headers: newHeaders })); assert.equal(ownerUsage.status, 200); assert.equal((await ownerUsage.json()).items[0].totalTokens, 15);
  } finally { await task.close(); }
});
test('模型已受理后的管理员降权仍阻止最终私有写入与返回正文，与单纯登出分开处理', async () => {
  const before = getStudioEnvelope(), task = await acceptedTranslation();
  try {
    await task.reached; getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(actor.id); task.release(); const response = await task.pending; assert.equal(response.status, 403); assert.deepEqual(Object.keys(await response.json()), ['error']); assert.deepEqual(getStudioEnvelope(), before); assert.equal(task.calls(), 1);
    assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_site_translation WHERE actor_id=?').get(actor.id) as { n: number }).n, 0);
    // 模型已消费的用量仍按真实供应商数值记账，不伪造未请求或零费用。
    assert.equal((getDatabase().prepare('SELECT total_tokens FROM cms_ai_usage WHERE actor_id=?').get(actor.id) as { total_tokens: number }).total_tokens, 15);
  } finally { await task.close(); }
});
