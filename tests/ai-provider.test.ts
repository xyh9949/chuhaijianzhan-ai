import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { getDatabase } from '../src/server/database';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';
import { classifyAiAddress, getAiProviderSummary, requestAiJson, saveAiProvider, testAiProviderConnection, validateAiProviderUrl } from '../src/server/ai-provider';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { buildSitePackage } from '../src/server/site-package';
import { createEmptyDraft } from '../src/server/seed';

const admin: Actor = { id: 'ai-admin', name: 'AI配置管理员', email: 'admin@example.invalid', role: 'admin' };
const ops = createRequire(import.meta.url)('../scripts/operations.cjs');
let directory: string, previous: NodeJS.ProcessEnv, servers: Server[];
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-ai-provider-')); servers = [];
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'private-ai-provider-test-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3299';
  getDraftRecord();
  getDatabase().exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  getDatabase().prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(admin.id, admin.name, admin.email, admin.role);
});
afterEach(async () => {
  for (const server of servers) { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); }
  getDatabase().close();
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-ai-provider-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
function configure(overrides: Record<string, unknown> = {}) { return saveAiProvider({ expectedRevision: getAiProviderSummary().revision, enabled: true, baseUrl: 'https://models.example.invalid/v1', model: 'customer-model', apiKey: 'synthetic-private-token', allowLocal: false, ...overrides }, admin); }
async function localServer(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}/v1`;
}
function reply(response: import('node:http').ServerResponse, value: unknown, finish = 'stop') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: finish }] })); }

test('AI配置默认关闭，密钥加密保存且空白保留、明确清除、版本冲突均可靠', () => {
  assert.deepEqual(getAiProviderSummary(), { revision: 0, enabled: false, baseUrl: '', model: '', hasApiKey: false, allowLocal: false });
  const first = configure(), db = getDatabase(), stored = db.prepare('SELECT * FROM cms_ai_provider').get() as { secret_cipher: string };
  assert.equal(first.hasApiKey, true); assert.equal(Object.hasOwn(first, 'apiKey'), false); assert.equal(JSON.stringify(stored).includes('synthetic-private-token'), false); assert.match(stored.secret_cipher, /^v1\./);
  configure({ apiKey: '' }); assert.equal((db.prepare('SELECT secret_cipher FROM cms_ai_provider').get() as { secret_cipher: string }).secret_cipher, stored.secret_cipher);
  assert.throws(() => configure({ expectedRevision: 0 }), status(409));
  configure({ enabled: false, apiKey: '', clearApiKey: true }); assert.equal(getAiProviderSummary().hasApiKey, false);
  assert.throws(() => configure({ apiKey: '' }), status(422));
  assert.equal(JSON.stringify(db.prepare('SELECT details_json FROM cms_audit').all()).includes('synthetic-private-token'), false);
});

test('配置只接受白名单，写事务重核管理员的当前权限与停用状态', () => {
  assert.throws(() => configure({ publicKey: 'not-supported' }), status(422)); assert.throws(() => configure({ apiKey: 'has space' }), status(422)); assert.throws(() => configure({ apiKey: '非HTTP头字符' }), status(422)); assert.throws(() => configure({ apiKey: 'token', clearApiKey: true }), status(422));
  getDatabase().prepare('UPDATE auth_user SET role=? WHERE id=?').run('editor', admin.id); assert.throws(() => configure(), status(403));
  getDatabase().prepare('UPDATE auth_user SET role=?,banned=1 WHERE id=?').run('admin', admin.id); assert.throws(() => configure(), status(403)); assert.equal(getAiProviderSummary().revision, 0);
});

test('更换服务来源不能默默沿用旧密钥，同来源路径或模型更改可保留', () => {
  configure(); const row = () => getDatabase().prepare('SELECT secret_cipher FROM cms_ai_provider').get() as { secret_cipher: string }, before = row();
  assert.throws(() => configure({ baseUrl: 'https://another.example.invalid/v1', apiKey: '' }), error => error instanceof ApiError && error.status === 422 && /来源已变化/.test(error.message));
  assert.equal(getAiProviderSummary().baseUrl, 'https://models.example.invalid/v1'); assert.deepEqual(row(), before);
  configure({ baseUrl: 'https://models.example.invalid/another-path', model: 'new-model', apiKey: '' }); assert.deepEqual(row(), before);
  configure({ baseUrl: 'http://127.0.0.1:11434/v1', allowLocal: true, apiKey: '', clearApiKey: true }); assert.equal(getAiProviderSummary().hasApiKey, false);
});

test('公网HTTPS默认约束与本地显式开关不会放开元数据、链路本地和保留地址', () => {
  for (const address of ['0.0.0.0', '169.254.169.254', '100.100.100.200', '192.0.2.1', '198.51.100.8', '203.0.113.9', '224.1.2.3', '::', 'fe80::1', 'fd00:ec2::254', 'fd00:ec2::23', '2001:db8::1', '2001:0db8:0:0::1', '2002:7f00:1::', '::ffff:a9fe:a9fe']) assert.equal(classifyAiAddress(address), 'blocked', address);
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.2', '192.168.1.1', '::1', 'fd00::1', '::ffff:7f00:1']) assert.equal(classifyAiAddress(address), 'local', address);
  assert.equal(classifyAiAddress('8.8.8.8'), 'public'); assert.equal(classifyAiAddress('2606:4700:4700::1111'), 'public');
  for (const address of ['http://example.com/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?token=secret', 'https://example.com/v1#secret', 'file:///tmp/key', 'https://127.0.0.1/v1']) assert.throws(() => validateAiProviderUrl(address, false), status(422));
  for (const address of ['http://169.254.169.254/v1', 'https://100.100.100.200/v1', 'http://8.8.8.8/v1', 'http://[fe80::1]/v1']) assert.throws(() => validateAiProviderUrl(address, true), status(422));
  assert.equal(validateAiProviderUrl('http://127.0.0.1:11434/v1/', true).pathname, '/v1');
});

test('本地mock能真实完成JSON调用；只有服务端向指定接口发送密钥及最小请求', async () => {
  let seen: { path?: string; authorization?: string; body?: Record<string, unknown> } = {};
  const baseUrl = await localServer((request, response) => { let raw = ''; request.on('data', chunk => raw += chunk); request.on('end', () => { seen = { path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) }; reply(response, { company: '客户确认的名称', pages: [] }); }); });
  configure({ baseUrl, allowLocal: true });
  assert.deepEqual(await requestAiJson('JSON only. Preserve facts.', 'Synthetic company description.'), { company: '客户确认的名称', pages: [] });
  assert.equal(seen.path, '/v1/chat/completions'); assert.equal(seen.authorization, 'Bearer synthetic-private-token'); assert.equal(seen.body?.max_tokens, 8192); assert.equal(seen.body?.stream, false); assert.equal(seen.body?.model, 'customer-model');
  assert.deepEqual(seen.body?.messages, [{ role: 'system', content: 'JSON only. Preserve facts.' }, { role: 'user', content: 'Synthetic company description.' }]);
});

test('保存后可先测试连接再启用；显式本地服务支持不配置密钥', async () => {
  let calls = 0;
  const baseUrl = await localServer((request, response) => { calls++; assert.equal(request.headers.authorization, undefined); reply(response, { ok: true }); });
  configure({ baseUrl, allowLocal: true, enabled: false, apiKey: '' });
  await assert.rejects(() => requestAiJson('JSON only', 'test'), status(422)); assert.equal(calls, 0);
  assert.deepEqual(await testAiProviderConnection(), { ok: true, model: 'customer-model' }); assert.equal(calls, 1);
  configure({ baseUrl, allowLocal: true, apiKey: '' }); assert.deepEqual(await requestAiJson('JSON only', 'test'), { ok: true }); assert.equal(calls, 2);
});

test('域名解析检查后实际连接使用同一已允许IP，兼容Node自动选择地址族', async () => {
  let calls = 0; const baseUrl = (await localServer((_request, response) => { calls++; reply(response, { ok: true }); })).replace('127.0.0.1', 'localhost');
  configure({ baseUrl, allowLocal: true });
  assert.deepEqual(await requestAiJson('JSON only', 'Synthetic DNS test.'), { ok: true }); assert.equal(calls, 1);
});

test('单实例并发限制拒绝重复调用，失败或取消后允许新的显式操作', async () => {
  let release!: () => void, received!: () => void, count = 0;
  const started = new Promise<void>(resolveStart => received = resolveStart);
  const baseUrl = await localServer((_request, response) => { count++; if (count === 1) { release = () => reply(response, { ok: true }); received(); } else reply(response, { ok: true }); });
  configure({ baseUrl, allowLocal: true }); const first = requestAiJson('JSON only', 'test'); await started;
  await assert.rejects(() => requestAiJson('JSON only', 'duplicate'), status(429)); assert.equal(count, 1); release(); await first;
  await requestAiJson('JSON only', 'explicit new request'); assert.equal(count, 2);
});

test('服务商错误正文与重定向不会泄漏密钥或触发第二个地址', async () => {
  let hits = 0, mode = 'error';
  const baseUrl = await localServer((_request, response) => { hits++; if (mode === 'error') { response.statusCode = 500; response.end('synthetic-private-token private model details'); } else { response.statusCode = 302; response.setHeader('Location', 'http://169.254.169.254/latest/meta-data'); response.end(); } });
  configure({ baseUrl, allowLocal: true });
  await assert.rejects(() => requestAiJson('JSON only', 'test'), error => error instanceof ApiError && error.status === 502 && !error.message.includes('synthetic-private-token') && !error.message.includes('private model'));
  mode = 'redirect'; await assert.rejects(() => requestAiJson('JSON only', 'test'), error => error instanceof ApiError && error.status === 502 && /重定向/.test(error.message)); assert.equal(hits, 2);
});

test('过大、不完整、错误格式与非文本回复明确失败，不自动再次请求', async () => {
  let mode = 'oversized', calls = 0;
  const baseUrl = await localServer((_request, response) => { calls++; if (mode === 'oversized') response.end('x'.repeat(513 * 1024)); else if (mode === 'length') reply(response, { pages: [] }, 'length'); else if (mode === 'bad-json') response.end('{broken'); else if (mode === 'null') response.end('null'); else if (mode === 'primitive') response.end('42'); else if (mode === 'nontext') response.end(JSON.stringify({ choices: [{ message: { content: [{ text: 'something' }] } }] })); else response.end(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] })); });
  configure({ baseUrl, allowLocal: true });
  for (const sample of ['oversized', 'length', 'bad-json', 'null', 'primitive', 'nontext', 'bad-content']) { mode = sample; await assert.rejects(() => requestAiJson('JSON only', 'test'), status(502)); }
  assert.equal(calls, 7);
});

test('中途取消终止等待并释放并发位，预先取消及超长资料不会产生网络请求', async () => {
  let hits = 0, received!: () => void;
  const started = new Promise<void>(resolveStart => received = resolveStart);
  const baseUrl = await localServer((_request, response) => { hits++; if (hits === 1) received(); else reply(response, { ok: true }); });
  configure({ baseUrl, allowLocal: true });
  const abort = new AbortController(), pending = requestAiJson('JSON only', 'test', abort.signal); await started; abort.abort(); await assert.rejects(() => pending, status(499));
  await assert.rejects(() => requestAiJson('JSON only', 'test', AbortSignal.abort()), status(499)); await assert.rejects(() => requestAiJson('x'.repeat(180_001), ''), status(413)); assert.equal(hits, 1);
  assert.deepEqual(await requestAiJson('JSON only', 'explicit next request'), { ok: true }); assert.equal(hits, 2);
});

test('密钥解密依赖原固定实例密钥，异常不会外发或返回密文', async () => {
  let hits = 0; const baseUrl = await localServer((_request, response) => { hits++; reply(response, { ok: true }); }); configure({ baseUrl, allowLocal: true });
  process.env.BETTER_AUTH_SECRET = 'replacement-auth-secret-'.repeat(4);
  await assert.rejects(() => requestAiJson('JSON only', 'test'), error => error instanceof ApiError && /重新填写密钥/.test(error.message) && !error.message.includes('synthetic-private-token'));
  assert.equal(hits, 0); assert.equal(getAiProviderSummary().hasApiKey, true);
});

test('完整备份保留AI私有运行数据，公开工作区及整站分发不携带配置与密钥', async () => {
  configure(); const db = getDatabase(); db.prepare('INSERT INTO cms_ai_build VALUES(?,?,?,?,?,?,?,?,?)').run('test-ai-build', admin.id, 'plan', 0, '{"privateBrief":"synthetic-private-brief"}', '2026-11-10T00:00:00Z', '2026-11-11T00:00:00Z', null, null);
  const serialized = JSON.stringify(getStudioEnvelope()); assert.equal(serialized.includes('synthetic-private-token'), false); assert.equal(serialized.includes('models.example.invalid'), false); assert.equal(serialized.includes('synthetic-private-brief'), false);
  const draft = createEmptyDraft(); const pkg = buildSitePackage({ ...draft, schemaVersion: 19 }, { name: '合成测试', description: '', license: 'private' });
  assert.equal(JSON.stringify(pkg).includes('synthetic-private-token'), false); assert.equal(JSON.stringify(pkg).includes('models.example.invalid'), false);
  const backup = join(directory, 'backup'); await ops.backup(process.env.FORM_STUDIO_DATA_DIR, backup); const restored = join(directory, 'restored'); ops.restore(backup, restored);
  const Database = (await import('better-sqlite3')).default, copy = new Database(join(restored, 'studio.sqlite'));
  try { assert.deepEqual(copy.prepare('SELECT * FROM cms_ai_provider').get(), db.prepare('SELECT * FROM cms_ai_provider').get()); assert.deepEqual(copy.prepare('SELECT * FROM cms_ai_build').all(), db.prepare('SELECT * FROM cms_ai_build').all()); } finally { copy.close(); }
});
