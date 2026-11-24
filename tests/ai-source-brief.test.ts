import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { ApiError } from '../src/server/http';
import { saveAiProvider } from '../src/server/ai-provider';
import { normalizeAiSourceBrief, organizeAiSourceBrief } from '../src/server/ai-source-brief';
import type { AiExtractedSource, AiSourcePdfPage } from '../src/lib/ai-source-types';
import type { Actor } from '../src/server/permissions';

const admin: Actor = { id: 'brief-admin', name: '资料管理员', email: 'admin@example.invalid', role: 'admin' };
const other: Actor = { id: 'brief-other', name: '其他管理员', email: 'other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'brief-editor', name: '编辑员', email: 'editor@example.invalid', role: 'editor' };
const pages: AiSourcePdfPage[] = [{ pageNumber: 1, text: 'North Test Factory produces wooden furniture. Width tolerance <0.1 mm. Count 0; enabled false.', needsOcr: false }, { pageNumber: 2, text: 'PRIVATE_UNSELECTED_PAGE_DO_NOT_SEND', needsOcr: false }];
const modelResult = () => ({ brief: { companyName: 'North Test Factory', description: 'Wooden furniture manufacturer.' }, facts: [{ field: 'companyName', pageNumbers: [1], evidence: [{ pageNumber: 1, quote: 'North Test Factory' }] }, { field: 'description', pageNumbers: [1], evidence: [{ pageNumber: 1, quote: 'produces wooden furniture' }] }], warnings: [] });
let directory = '', previous: NodeJS.ProcessEnv, server: Server | undefined;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-ai-source-brief-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'source-brief-test-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3295';
  getDraftRecord(); const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(createEmptyDraft()));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(async () => {
  if (server) { const active = server; server = undefined; active.closeAllConnections(); await new Promise<void>(done => active.close(() => done())); }
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-ai-source-brief-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
function store(selected = pages) {
  const source: AiExtractedSource = { kind: 'pdf', fileName: 'private-synthetic-company.pdf', mime: 'application/pdf', bytes: 500, sha256: '1'.repeat(64), textChars: selected.reduce((sum, page) => sum + page.text.length, 0), warnings: [], pages: selected };
  const id = `ais-${randomUUID()}`; getDatabase().prepare('INSERT INTO cms_ai_source(id,actor_id,kind,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id, admin.id, 'source', -1, JSON.stringify(source), new Date().toISOString(), new Date(Date.now() + 7200000).toISOString()); return id;
}
async function mock(handler: (body: Record<string, unknown>) => unknown) {
  const requests: Record<string, unknown>[] = [];
  server = createServer((request, response) => { let raw = ''; request.on('data', chunk => raw += chunk); request.on('end', () => { const body = JSON.parse(raw); requests.push(body); const value = handler(body); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })); }); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  saveAiProvider({ expectedRevision: 0, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-source-model', apiKey: 'synthetic-private-key-for-tests', allowLocal: true }, admin); return requests;
}

test('资料建议每项需要真实选中页引文，数学符号/0/false作为纯文本保留', () => {
  const value = modelResult(), normalized = normalizeAiSourceBrief(value, [pages[0]]); assert.equal(normalized.brief.companyName, 'North Test Factory'); assert.ok(normalized.warnings.length);
  value.facts[1].evidence[0].quote = 'Width tolerance <0.1 mm. Count 0; enabled false.'; assert.match(normalizeAiSourceBrief(value, [pages[0]]).facts[1].evidence[0].quote, /<0.1 mm/);
  value.facts[1].evidence[0].quote = 'Fabricated certification'; assert.throws(() => normalizeAiSourceBrief(value, [pages[0]]), status(422));
});
test('无出处/重复字段/额外脚本/未选页/建议值不一致均拒绝', () => {
  const cases = [
    { ...modelResult(), facts: [] }, { ...modelResult(), script: 'alert(1)' },
    { ...modelResult(), facts: [...modelResult().facts, modelResult().facts[0]] },
    { ...modelResult(), facts: [{ ...modelResult().facts[0], pageNumbers: [2] }, modelResult().facts[1]] },
    { ...modelResult(), facts: [{ ...modelResult().facts[0], value: 'Changed name' }, modelResult().facts[1]] },
  ];
  for (const value of cases) assert.throws(() => normalizeAiSourceBrief(value, [pages[0]]), status(422));
});
test('未配置AI、扫描页/超长/错误页/越权拒绝且不改变网站或遗留计费占位', async () => {
  const id = store(), before = getStudioEnvelope();
  await assert.rejects(organizeAiSourceBrief({ sourceId: id, pageNumbers: [1] }, admin), status(422));
  await assert.rejects(organizeAiSourceBrief({ sourceId: id, pageNumbers: [1] }, other), status(404));
  await assert.rejects(organizeAiSourceBrief({ sourceId: id, pageNumbers: [1] }, editor), status(403));
  await assert.rejects(organizeAiSourceBrief({ sourceId: id, pageNumbers: [99] }, admin), status(422));
  const scan = store([{ pageNumber: 1, text: '', needsOcr: true }]); await assert.rejects(organizeAiSourceBrief({ sourceId: scan, pageNumbers: [1] }, admin), status(422));
  const long = store([{ pageNumber: 1, text: 'A'.repeat(24001), needsOcr: false }]); await assert.rejects(organizeAiSourceBrief({ sourceId: long, pageNumbers: [1] }, admin), status(413));
  assert.deepEqual(getStudioEnvelope(), before); assert.equal((getDatabase().prepare("SELECT count(*) n FROM cms_ai_source WHERE kind='brief'").get() as { n: number }).n, 0);
});
test('仅显式发送选中页给用户配置AI，建议私有暂存并不写CMS/发布', async () => {
  const id = store(), requests = await mock(() => modelResult()), before = getStudioEnvelope(); const result = await organizeAiSourceBrief({ sourceId: id, pageNumbers: [1] }, admin);
  assert.equal(requests.length, 1); const encoded = JSON.stringify(requests); assert.match(encoded, /North Test Factory/); assert.doesNotMatch(encoded, /PRIVATE_UNSELECTED|private-synthetic-company|synthetic-private-key/);
  assert.equal(result.brief.companyName, 'North Test Factory'); assert.deepEqual(result.sources, [{ pageNumber: 1 }]); assert.deepEqual(getStudioEnvelope(), before); assert.doesNotMatch(JSON.stringify(before), /private-synthetic-company|North Test Factory/);
  const saved = getDatabase().prepare('SELECT source_id,payload_json FROM cms_ai_source WHERE id=?').get(result.briefId) as { source_id: string; payload_json: string }; assert.equal(saved.source_id, id); assert.deepEqual(JSON.parse(saved.payload_json), result);
});
test('错误模型输出释放预留，满30条在请求前拒绝', async () => {
  const id = store(), requests = await mock(() => ({ ...modelResult(), facts: [] })); await assert.rejects(organizeAiSourceBrief({ sourceId: id, pageNumbers: [1] }, admin), status(422));
  assert.equal((getDatabase().prepare("SELECT count(*) n FROM cms_ai_source WHERE kind='brief'").get() as { n: number }).n, 0);
  for (let index = 0; index < 29; index++) store(); await assert.rejects(organizeAiSourceBrief({ sourceId: id, pageNumbers: [1] }, admin), status(429)); assert.equal(requests.length, 1);
});
test('模型响应期间删除来源或降权，不保存建议或更改网站', async () => {
  const id = store(); await mock(() => { getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); return modelResult(); });
  await assert.rejects(organizeAiSourceBrief({ sourceId: id, pageNumbers: [1] }, admin), status(403)); assert.equal(getDraftRecord().revision, 0); assert.equal((getDatabase().prepare("SELECT count(*) n FROM cms_ai_source WHERE kind='brief'").get() as { n: number }).n, 0);
});
