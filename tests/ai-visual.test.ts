import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { createExternalSiteDesignCandidate, resolveAiSiteDesignPreview } from '../src/server/ai-site-design';
import { aiVisualStatus, planVisualSections, visualOrigin, visualRequestAllowed } from '../src/server/ai-visual-browser';
import { createAiVisualCapture, createAiVisualReview, deleteAiVisualCapture, listAiVisualCaptures, listAiVisualReviews, normalizeAiVisualReview, readAiVisualCapture, readAiVisualImage, visualCaptureOptions } from '../src/server/ai-visual';
import { getAiProviderSummary, requestAiJson, requestAiVisionJson, saveAiProvider } from '../src/server/ai-provider';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';
import type { AiVisualTarget } from '../src/lib/ai-visual-types';

const admin: Actor = { id: 'visual-admin', name: '视觉管理员', email: 'visual@example.invalid', role: 'admin' };
const other: Actor = { id: 'visual-other', name: '其他管理员', email: 'other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'visual-editor', name: '编辑员', email: 'editor@example.invalid', role: 'editor' };
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
let directory = '', previous: NodeJS.ProcessEnv, server: Server | undefined;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-visual-review-'));
  process.env.FORM_STUDIO_DATA_DIR = directory; process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3295'; process.env.BETTER_AUTH_SECRET = 'visual-review-synthetic-secret-'.repeat(3); process.env.FORM_STUDIO_VISUAL_DISABLED = '1';
  getDraftRecord(); const content = createEmptyDraft(); content.editorData.home = { root: { props: { title: 'Preview', showChrome: 'no' } }, content: [{ type: 'Heading', props: { id: 'visual-heading', text: 'Original heading', level: 'h1' } }] };
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(async () => {
  if (server) { const active = server; server = undefined; active.closeAllConnections(); await new Promise<void>(done => active.close(() => done())); }
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-visual-review-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});
const node = { id: 'visual-heading', tag: 'DIV', x: 0, y: 0, width: 390, height: 44 };
function candidate(actor: Actor = admin) {
  const view = createExternalSiteDesignCandidate({ expectedRevision: getDraftRecord().revision, instruction: '调整已有首页标题用于隔离测试', targets: { pageIds: ['home'], header: false, footer: false, navigation: false, style: false }, preserveText: false }, { summary: 'Visual candidate', operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'text', id: 'visual-heading', text: 'Candidate heading' }] }], warnings: [] }, actor, () => {});
  return { view, target: { kind: 'site-design', id: view.designId, pageId: 'home' } as AiVisualTarget };
}
async function storedCapture(owner: Actor = admin) {
  // 单测只植入合成图片到私表，真实浏览器采图由独立UI用例验证，不能把此fixture称作截图验收。
  const { view, target } = candidate(owner), source = resolveAiSiteDesignPreview(view.designId, 'after', owner)!, bytes = await sharp({ create: { width: 390, height: 500, channels: 3, background: '#eff4fa' } }).jpeg().toBuffer();
  const id = `avc-${randomUUID()}`, now = new Date().toISOString(), expires = new Date(Date.now() + 600_000).toISOString(), sourceHash = createHash('sha256').update(JSON.stringify({ snapshot: source.snapshot, resolved: source.resolved })).digest('hex');
  getDatabase().prepare('INSERT INTO cms_ai_visual_capture VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, owner.id, target.kind, target.id, target.pageId, view.baseRevision, sourceHash, JSON.stringify({ target, images: [{ device: 'mobile', width: 390, height: 500, bytes: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), nodes: [node], warnings: ['仅合成首屏fixture'] }], warnings: [] }), now, expires);
  return { id, target, bytes };
}
async function mock(handler: (body: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  server = createServer((incoming, outgoing) => { let raw = ''; incoming.on('data', chunk => raw += chunk); incoming.on('end', () => { const body = JSON.parse(raw); calls.push(body); outgoing.setHeader('Content-Type', 'application/json'); outgoing.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(handler(body)) } }] })); }); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  saveAiProvider({ expectedRevision: 0, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'text-model', visionModel: 'vision-model', allowLocal: true, apiKey: 'synthetic-visual-private-key' }, admin);
  return calls;
}
const result = () => ({ summary: '核对手机首屏层级', issues: [{ device: 'mobile', severity: 'suggestion', title: '标题留白', description: '首屏可收紧标题上方空隙', nodeId: node.id, suggestion: '仅调整手机标题上方留白' }], suggestedInstruction: '收紧手机标题上方留白，保留文字图片和电脑布局。', warnings: [] });

test('截图能力未安装/显式关闭时明确降级，不改草稿、不伪造图片或调用模型', async () => {
  const before = getStudioEnvelope(), { target } = candidate(); assert.equal(aiVisualStatus().available, false); assert.equal(aiVisualStatus().providerReady, false);
  await assert.rejects(createAiVisualCapture({ target, devices: ['mobile'] }, admin, 'synthetic-cookie'), status(422));
  assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_visual_capture').get() as { n: number }).n, 0); assert.deepEqual(getStudioEnvelope(), before);
});
test('截图只接受固定候选/设备，外域/后台/写入及配置地址绕过拒绝', async () => {
  const origin = 'http://127.0.0.1:3295', path = '/preview/~edit/aie-123/after';
  assert.equal(visualRequestAllowed(`${origin}${path}`, 'GET', origin, path), true);
  const permittedQueries = new Set([`${path}?filter=chairs`]);
  assert.equal(visualRequestAllowed(`${origin}${path}?filter=chairs`, 'GET', origin, path), false);
  assert.equal(visualRequestAllowed(`${origin}${path}?filter=chairs`, 'GET', origin, path, permittedQueries), true);
  assert.equal(visualRequestAllowed(`${origin}${path}?filter=tables`, 'GET', origin, path, permittedQueries), false);
  for (const [url, method] of [[`${origin}/api/studio`, 'GET'], [`${origin}${path}`, 'POST'], ['https://elsewhere.example/track', 'GET'], [`${origin}/preview/~edit/other/after`, 'GET'], [`${origin}/_next/image?url=http://private`, 'GET']]) assert.equal(visualRequestAllowed(url, method, origin, path), false);
  assert.equal(visualRequestAllowed(`${origin}/api/media/media-one?width=320`, 'GET', origin, path), true);
  process.env.FORM_STUDIO_VISUAL_ORIGIN = 'http://169.254.169.254'; assert.throws(visualOrigin, status(422));
  const { target } = candidate(); await assert.rejects(createAiVisualCapture({ target: { ...target, url: 'http://private' }, devices: ['mobile'] }, admin, 'cookie'), status(422));
  await assert.rejects(createAiVisualCapture({ target, devices: ['mobile', 'mobile'] }, admin, 'cookie'), status(422));
});
test('私有截图/图像只限当前本人管理员，过期、候选移除和撤权均保护', async () => {
  const fixture = await storedCapture(), view = readAiVisualCapture(fixture.id, admin); assert.equal(view.images[0].coverage, 'viewport'); assert.doesNotMatch(JSON.stringify(view), /base64|synthetic-cookie/); assert.deepEqual(readAiVisualImage(fixture.id, 'mobile', admin).bytes, fixture.bytes);
  assert.throws(() => readAiVisualCapture(fixture.id, other), status(404)); assert.throws(() => readAiVisualImage(fixture.id, 'mobile', editor), status(403));
  getDatabase().prepare('UPDATE cms_ai_visual_capture SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', fixture.id); assert.throws(() => readAiVisualCapture(fixture.id, admin), status(410));
  const removed = await storedCapture(); getDatabase().prepare('DELETE FROM cms_ai_site_design WHERE id=?').run(removed.target.id); assert.throws(() => readAiVisualCapture(removed.id, admin), status(404));
  const revoked = await storedCapture(); getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); assert.throws(() => readAiVisualImage(revoked.id, 'mobile', admin), status(403));
});
test('视觉结果仅保留真实截图设备/节点，不能注入HTML或伪造通过证明', () => {
  const images = [{ device: 'mobile' as const, nodes: [node] }]; assert.equal(normalizeAiVisualReview(result(), images).issues[0].nodeId, node.id);
  const unknown = result(); unknown.issues[0].nodeId = 'not-visible'; assert.equal(normalizeAiVisualReview(unknown, images).issues[0].nodeId, undefined);
  assert.throws(() => normalizeAiVisualReview({ ...result(), score: 100 }, images), status(422));
  assert.throws(() => normalizeAiVisualReview({ ...result(), summary: '<script>bad()</script>' }, images), status(422));
  assert.throws(() => normalizeAiVisualReview({ ...result(), issues: [{ ...result().issues[0], device: 'desktop' }] }, images), status(422));
});
test('视觉真实协议共用用户连接但选择视觉模型，只有明确请求才发图，不发送私有URL或Cookie', async () => {
  const fixture = await storedCapture(), before = getStudioEnvelope(), calls = await mock(() => result());
  assert.equal(calls.length, 0); const review = await createAiVisualReview({ captureId: fixture.id, imageIds: ['mobile'], instruction: '检查首屏阅读层级' }, admin);
  assert.equal(calls.length, 1); assert.equal(calls[0].model, 'vision-model'); const messages = calls[0].messages as { content: unknown }[], content = messages[1].content as { type: string; image_url?: { url: string } }[];
  assert.equal(content[1].type, 'image_url'); assert.equal(content[1].image_url!.url, `data:image/jpeg;base64,${fixture.bytes.toString('base64')}`); assert.doesNotMatch(JSON.stringify(calls[0]), /\/preview\/~|Cookie|synthetic-visual-private-key/);
  assert.equal(review.issues[0].nodeId, node.id); assert.equal(listAiVisualReviews(admin, { targetKind: fixture.target.kind, targetId: fixture.target.id, pageId: 'home' }).items[0].id, review.id); assert.deepEqual(getStudioEnvelope(), before);
  deleteAiVisualCapture(fixture.id, admin); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_visual_review').get() as { n: number }).n, 0); assert.deepEqual(getStudioEnvelope(), before);
});
test('视觉可选模型旧表单保留、明确清空回默认；文字协议不受图像支持影响', async () => {
  const calls = await mock(() => ({ ok: true })), config = getAiProviderSummary(); assert.equal(config.visionModel, 'vision-model');
  saveAiProvider({ expectedRevision: config.revision, enabled: true, baseUrl: config.baseUrl, model: config.model, allowLocal: true }, admin); assert.equal(getAiProviderSummary().visionModel, 'vision-model');
  await requestAiJson('Return JSON', '{}'); assert.equal(calls[0].model, 'text-model'); assert.equal(typeof (calls[0].messages as { content: unknown }[])[1].content, 'string');
  saveAiProvider({ expectedRevision: getAiProviderSummary().revision, enabled: true, baseUrl: config.baseUrl, model: config.model, visionModel: '', allowLocal: true }, admin);
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).jpeg().toBuffer(); await requestAiVisionJson('Return JSON', '{}', [{ bytes, mime: 'image/jpeg' }]); assert.equal(calls[1].model, 'text-model');
  await assert.rejects(requestAiVisionJson('Return JSON', '{}', [{ bytes: Buffer.from('not image'), mime: 'image/jpeg' }]), status(422)); assert.equal(calls.length, 2);
});
test('模型处理中降权不会留下成功记录或修改站点，失败不自动重试', async () => {
  const fixture = await storedCapture(), before = getStudioEnvelope(), calls = await mock(() => { getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); return result(); });
  await assert.rejects(createAiVisualReview({ captureId: fixture.id, imageIds: ['mobile'], instruction: '' }, admin), status(403)); assert.equal(calls.length, 1); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_visual_review').get() as { n: number }).n, 0); assert.deepEqual(getStudioEnvelope(), before);
});
test('无效视觉结果不留成功记录、不改草稿或自动重试', async () => {
  const fixture = await storedCapture(), before = getStudioEnvelope(), calls = await mock(() => ({ ...result(), issues: [{ ...result().issues[0], device: 'desktop' }] }));
  await assert.rejects(createAiVisualReview({ captureId: fixture.id, imageIds: ['mobile'], instruction: '' }, admin), status(422)); assert.equal(calls.length, 1); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_visual_review').get() as { n: number }).n, 0); assert.deepEqual(getStudioEnvelope(), before);
});
test('已合法接受的模型任务登出后保留私有结果，重新读取仍须会话鉴权', async () => {
  const fixture = await storedCapture(), before = getStudioEnvelope(); let signedOut = false, checks = 0;
  const calls = await mock(() => { signedOut = true; return result(); });
  const review = await createAiVisualReview({ captureId: fixture.id, imageIds: ['mobile'], instruction: '' }, admin, undefined, () => { checks++; if (signedOut) throw new ApiError(401, '会话已失效'); });
  assert.equal(checks, 1); assert.equal(calls.length, 1); assert.equal(review.captureId, fixture.id); assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_ai_visual_review').get() as { n: number }).n, 1); assert.deepEqual(getStudioEnvelope(), before);
});

test('全页分段计划保持重叠和真实边界，起点/段数有界且旧首屏输入兼容', () => {
  assert.deepEqual(visualCaptureOptions({}), { mode: 'viewport', startSection: 1, maxSections: 4, inspectInteractions: false });
  assert.deepEqual(visualCaptureOptions({ mode: 'page', startSection: 3, maxSections: 2, inspectInteractions: true }), { mode: 'page', startSection: 3, maxSections: 2, inspectInteractions: true });
  for (const input of [{ mode: 'anything' }, { mode: 'page', startSection: 201 }, { maxSections: 7 }, { inspectInteractions: 'true' }, { startSection: 2 }]) assert.throws(() => visualCaptureOptions(input), status(422));
  const plan = planVisualSections(3300, 640, 1, 6); assert.equal(plan.totalSections, 6); assert.equal(plan.sections[0].from, 0); assert.equal(plan.sections.at(-1)!.to, 3300);
  for (let i = 1; i < plan.sections.length; i++) assert.ok(plan.sections[i].from < plan.sections[i - 1].to, '相邻截图必须重叠，不能漏掉中间区域');
  assert.deepEqual(planVisualSections(3300, 640, 3, 2).sections.map(item => item.number), [3, 4]); assert.deepEqual(planVisualSections(3300, 640, 7, 2).sections, []);
  assert.throws(() => planVisualSections(100001, 640), status(422));
});

test('同设备多张页段严格按图片绑定建议，不能用另一段的节点定位或无ID猜图', () => {
  const secondNode = { ...node, id: 'visual-bottom' }, images = [{ id: 'mobile-section-1', device: 'mobile' as const, nodes: [node] }, { id: 'mobile-section-2', device: 'mobile' as const, nodes: [secondNode] }];
  assert.throws(() => normalizeAiVisualReview(result(), images), status(422));
  const explicit = { ...result(), issues: [{ ...result().issues[0], imageId: 'mobile-section-2', nodeId: secondNode.id }] };
  const correct = normalizeAiVisualReview(explicit, images); assert.equal(correct.issues[0].imageId, 'mobile-section-2'); assert.equal(correct.issues[0].nodeId, secondNode.id);
  const wrongNode = normalizeAiVisualReview({ ...explicit, issues: [{ ...explicit.issues[0], nodeId: node.id }] }, images); assert.equal(wrongNode.issues[0].nodeId, undefined);
  assert.throws(() => normalizeAiVisualReview({ ...explicit, issues: [{ ...explicit.issues[0], imageId: 'mobile-section-3' }] }, images), status(422));
});

test('本人可重开分段截图组并只发送明确选择图片，旧设备图片仍可读且GET不改草稿或审计', async () => {
  const fixture = await storedCapture(), db = getDatabase(), row = db.prepare('SELECT payload_json FROM cms_ai_visual_capture WHERE id=?').get(fixture.id) as { payload_json: string }, payload = JSON.parse(row.payload_json);
  const first = payload.images[0]; payload.images = [first, { ...first, id: 'mobile-section-2', coverage: 'page-segment', section: { number: 2, from: 500, to: 1000, pageHeight: 2200 }, nodes: [{ ...node, id: 'visual-bottom' }] }];
  payload.pageCoverage = [{ device: 'mobile', mode: 'page', viewportHeight: 500, pageHeight: 2200, startSection: 1, endSection: 2, totalSections: 5, complete: false, intervals: [{ from: 0, to: 500 }, { from: 500, to: 1000 }], nextStartSection: 3 }];
  db.prepare('UPDATE cms_ai_visual_capture SET payload_json=? WHERE id=?').run(JSON.stringify(payload), fixture.id);
  const before = getStudioEnvelope(), audits = db.prepare('SELECT count(*) n FROM cms_audit').get(), listed = listAiVisualCaptures(admin, { targetKind: fixture.target.kind, targetId: fixture.target.id, pageId: 'home' });
  assert.equal(listed.items.length, 1); assert.deepEqual(listed.items[0].images.map(item => item.id), ['mobile', 'mobile-section-2']); assert.equal(listed.items[0].pageCoverage![0].complete, false);
  assert.doesNotMatch(JSON.stringify(listed), /base64|synthetic-cookie/); assert.deepEqual(readAiVisualImage(fixture.id, 'mobile-section-2', admin).bytes, fixture.bytes); assert.deepEqual(readAiVisualImage(fixture.id, 'mobile', admin).bytes, fixture.bytes);
  assert.deepEqual(db.prepare('SELECT count(*) n FROM cms_audit').get(), audits); assert.deepEqual(getStudioEnvelope(), before);
  const calls = await mock(() => ({ ...result(), issues: [{ ...result().issues[0], imageId: 'mobile-section-2', nodeId: 'visual-bottom' }] }));
  const review = await createAiVisualReview({ captureId: fixture.id, imageIds: ['mobile-section-2'], instruction: '只看第二段' }, admin); assert.deepEqual(review.imageIds, ['mobile-section-2']); assert.equal(review.issues[0].nodeId, 'visual-bottom'); assert.equal(calls.length, 1);
  const sent = JSON.parse(((calls[0].messages as { content: { text?: string }[] }[])[1].content)[0].text!); assert.equal(sent.screenshots.length, 1); assert.equal(sent.screenshots[0].coverage, 'page-segment'); assert.equal(sent.screenshots[0].imageId, 'mobile-section-2'); assert.equal(sent.nativeNodes[0].id, 'visual-bottom');
  await assert.rejects(createAiVisualReview({ captureId: fixture.id, imageIds: ['mobile-section-3'], instruction: '' }, admin), status(422)); await assert.rejects(createAiVisualReview({ captureId: fixture.id, imageIds: ['mobile', 'mobile-section-2', 'tablet', 'desktop'], instruction: '' }, admin), status(422)); assert.equal(calls.length, 1);
  assert.throws(() => listAiVisualCaptures(other, { targetKind: fixture.target.kind, targetId: fixture.target.id, pageId: 'home' }), status(404));
  db.prepare('UPDATE cms_ai_visual_capture SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', fixture.id); assert.deepEqual(listAiVisualCaptures(admin, { targetKind: fixture.target.kind, targetId: fixture.target.id, pageId: 'home' }).items, []);
});


test('新建截图仅清理本人已删除或过期来源的孤儿组，异常来源与其他人记录保持', async () => {
  const deleted = await storedCapture(), expired = await storedCapture(), broken = await storedCapture(), foreign = await storedCapture(other), valid = await storedCapture(), db = getDatabase(), before = getStudioEnvelope();
  db.prepare('DELETE FROM cms_ai_site_design WHERE id=?').run(deleted.target.id); db.prepare('UPDATE cms_ai_site_design SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', expired.target.id);
  db.prepare('UPDATE cms_ai_site_design SET payload_json=? WHERE id=?').run('{}', broken.target.id);
  const reviewId = `avr-${randomUUID()}`, now = new Date().toISOString(); db.prepare('INSERT INTO cms_ai_visual_review VALUES(?,?,?,?,?,?)').run(reviewId, admin.id, deleted.id, '{"summary":"orphan fixture"}', now, new Date(Date.now() + 600_000).toISOString());
  await assert.rejects(createAiVisualCapture({ target: valid.target, devices: ['mobile'] }, admin, 'synthetic-cookie'), status(422));
  const exists = (id: string) => !!db.prepare('SELECT id FROM cms_ai_visual_capture WHERE id=?').get(id);
  assert.equal(exists(deleted.id), false); assert.equal(exists(expired.id), false); assert.equal(exists(broken.id), true); assert.equal(exists(foreign.id), true); assert.equal(exists(valid.id), true);
  assert.equal(db.prepare('SELECT id FROM cms_ai_visual_review WHERE id=?').get(reviewId), undefined); assert.deepEqual(getStudioEnvelope(), before);
});
