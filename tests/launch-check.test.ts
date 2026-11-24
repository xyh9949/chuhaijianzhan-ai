import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope } from '../src/server/studio';
import { checkLaunchReadiness, readLaunchCheck, robotsHomeBlocked } from '../src/server/launch-check';
import { readLaunchPage, validateLaunchOrigin, type LaunchPageReader, type LaunchPageResponse } from '../src/server/launch-check-http';
import { saveAiProvider } from '../src/server/ai-provider';
import { saveMailSettings } from '../src/server/mail-settings';
import { captureServiceTestConfiguration, recordServiceTestEvidence } from '../src/server/service-test-evidence';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';
import type { LaunchCheckItem, LaunchCheckKind, LaunchCheckReport } from '../src/lib/launch-check-types';
import type { DraftContent } from '../src/server/types';

const admin: Actor = { id: 'launch-admin', name: 'Synthetic launch administrator', email: 'admin@example.invalid', role: 'admin' };
const editor: Actor = { id: 'launch-editor', name: 'Synthetic editor', email: 'editor@example.invalid', role: 'editor' };
const networkIds = ['public-home', 'public-robots', 'public-sitemap', 'public-indexing', 'public-canonical'];
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
const find = (report: LaunchCheckReport, id: string): LaunchCheckItem => { const value = report.items.find(item => item.id === id); assert.ok(value, id); return value; };
const count = () => (getDatabase().prepare('SELECT count(*) n FROM cms_launch_check').get() as { n: number }).n;
let directory = '', previous: NodeJS.ProcessEnv;

beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-launch-check-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.FORM_STUDIO_BACKUP_DIR = join(directory, 'backups');
  process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3299'; process.env.BETTER_AUTH_SECRET = 'synthetic-launch-secret-'.repeat(3);
  for (const key of Object.keys(process.env)) if (key.startsWith('FORM_STUDIO_SMTP_') || ['FORM_STUDIO_NOTIFY_TO', 'FORM_STUDIO_AUTOMATIC_BACKUP', 'FORM_STUDIO_BACKUP_INTERVAL_HOURS'].includes(key)) delete process.env[key];
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'none';
  getDraftRecord(); getDatabase().exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, editor]) getDatabase().prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  const target = resolve(directory); assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}studio-launch-check-`)); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function request(checks: LaunchCheckKind[] = ['local']) { const report = readLaunchCheck(admin); return { expectedRevision: report.revision, expectedReleaseId: report.releaseId, checks }; }
function draft(change: (value: DraftContent) => void, bump = true) { const current = getDraftRecord(); change(current.content); getDatabase().prepare('UPDATE cms_draft SET content_json=?,revision=revision+? WHERE id=1').run(JSON.stringify(current.content), Number(bump)); return current.content; }
/** 合成公开快照只存在本测试临时实例，不经过网络、不发布正式站点。 */
function publish(url = 'https://launch.example.invalid', id = 'synthetic-release') {
  const content = draft(value => { value.settings.publicUrl = url; });
  getDatabase().prepare('INSERT INTO cms_release(id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, 'Synthetic release', JSON.stringify({ ...content, schemaVersion: 20, releaseId: id }), 'synthetic-hash', 20, 20, admin.id, admin.name, new Date().toISOString(), '{}');
  getDatabase().prepare('UPDATE cms_runtime SET active_release_id=? WHERE id=1').run(id); return id;
}
function response(body: string, contentType = 'text/html', code = 200, robots = ''): LaunchPageResponse { return { status: code, body, contentType, robots }; }
function goodReader(releaseId = 'synthetic-release', seen: string[] = []): LaunchPageReader { return async url => {
  seen.push(url.href); return url.pathname === '/' ? response(`<html data-site-release="${releaseId}"><head><link rel="canonical" href="${url.origin}/"></head></html>`) : url.pathname === '/robots.txt' ? response('User-agent: *\nDisallow: /admin\nUser-agent: GPTBot\nDisallow: /', 'text/plain') : response(`<urlset><url><loc>${url.origin}/</loc></url></urlset>`, 'application/xml');
}; }
function ai() { saveAiProvider({ expectedRevision: 0, enabled: true, baseUrl: 'https://model.example.invalid/v1', model: 'synthetic-model', apiKey: 'SYNTHETIC_PRIVATE_MODEL_KEY', allowLocal: false }, admin); }
function mail() { saveMailSettings({ expectedRevision: 0, enabled: false, host: 'smtp.example.invalid', port: 587, security: 'starttls', username: 'synthetic-user', password: 'SYNTHETIC_PRIVATE_MAIL_PASSWORD', from: 'from@example.invalid', to: ['to@example.invalid'], allowLocal: false }, admin); }

test('GET不写检查、不调用网络或AI；配置、未验证和不适用分开，DTO不带秘密', () => {
  ai(); mail(); const before = getStudioEnvelope(), report = readLaunchCheck(admin); assert.deepEqual(getStudioEnvelope(), before); assert.equal(count(), 0);
  assert.equal(report.items.length, 21); assert.equal(report.summary.total, 21); assert.equal(report.lastCheck, null); assert.equal(find(report, 'ai-config').status, 'configured'); assert.equal(find(report, 'ai-connection').status, 'unverified'); assert.equal(find(report, 'ai-generation').status, 'unverified'); assert.equal(find(report, 'mail-config').status, 'configured'); assert.equal(find(report, 'mail-test').status, 'unverified');
  for (const id of networkIds) assert.equal(find(report, id).status, 'unverified'); assert.match(report.note, /不代表.*Google收录/);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_PRIVATE|secret_cipher|configuration_fingerprint|smtp\.example|model\.example|from@example|to@example/);
});

test('仅本地POST保存私有回执，网站草稿、公开版本和通知任务保持；GET不会续期', async () => {
  const before = getStudioEnvelope(), result = await checkLaunchReadiness(request(), admin); assert.equal(count(), 1); assert.deepEqual(getStudioEnvelope(), before); assert.deepEqual(result.lastCheck?.checks, ['local']);
  const again = readLaunchCheck(admin); assert.deepEqual(again.lastCheck, result.lastCheck); assert.equal(count(), 1);
  const stored = getDatabase().prepare('SELECT payload_json FROM cms_launch_check').get() as { payload_json: string }; assert.deepEqual(JSON.parse(stored.payload_json), { checks: ['local'], items: [] });
});

test('缓存角色、编辑者、停用和已删除管理员都不能读取或检查', async () => {
  assert.throws(() => readLaunchCheck(editor), status(403)); await assert.rejects(checkLaunchReadiness({}, editor), status(403));
  const input = request(); getDatabase().prepare("UPDATE auth_user SET role='viewer' WHERE id=?").run(admin.id); assert.throws(() => readLaunchCheck(admin), status(403)); await assert.rejects(checkLaunchReadiness(input, admin), status(403));
  getDatabase().prepare("UPDATE auth_user SET role='admin',banned=1 WHERE id=?").run(admin.id); assert.throws(() => readLaunchCheck(admin), status(401)); getDatabase().prepare('DELETE FROM auth_user WHERE id=?').run(admin.id); assert.throws(() => readLaunchCheck(admin), status(401)); assert.equal(count(), 0);
});

test('检查输入严格拒绝自选URL、传输器、重复检查和无效版本', async () => {
  const base = request(); for (const extra of [{ url: 'https://other.example.invalid' }, { readPage: 'bypass' }, { checks: [] }, { checks: ['local', 'local'] }, { checks: ['ai'] }, { expectedRevision: -1 }, { expectedReleaseId: '' }, { expectedReleaseId: 5 }]) await assert.rejects(checkLaunchReadiness({ ...base, ...extra }, admin), status(422)); assert.equal(count(), 0);
});

test('草稿版本与公开指针均须匹配，不以旧界面启动新检查', async () => {
  const base = request(); draft(value => { value.settings.name = 'Changed'; }); await assert.rejects(checkLaunchReadiness(base, admin), status(409)); const beforePublish = request(); publish(); await assert.rejects(checkLaunchReadiness(beforePublish, admin), status(409)); assert.equal(count(), 0);
});

test('没有公开版本或只有草稿网址时公网检查只返回未验证，零网络', async () => {
  draft(value => { value.settings.publicUrl = 'https://draft-only.example.invalid'; }); let reads = 0;
  const report = await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: async () => { reads++; throw new Error('must not execute'); } });
  assert.equal(reads, 0); assert.equal(report.publicUrl, null); assert.equal(find(report, 'public-url').status, 'configured'); for (const id of networkIds) assert.equal(find(report, id).status, 'unverified');
});

test('HTTP、本机和元数据正式网址都不进入传输器，不放宽测试环境网络策略', async () => {
  for (const [index, url] of ['http://launch.example.invalid', 'https://127.0.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://demo.local'].entries()) {
    publish(url, `invalid-release-${index}`); let reads = 0; const report = await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: async () => { reads++; throw new Error('must not execute'); } }); assert.equal(reads, 0); for (const id of networkIds) assert.equal(find(report, id).status, 'unverified');
  }
});

test('本机演示地址不变成要求购买证书的错误，不影响原本的预览和发布', () => {
  publish('http://127.0.0.1:3299'); const report = readLaunchCheck(admin); for (const id of ['public-url', 'https-config', 'admin-origin']) assert.equal(find(report, id).status, 'unverified'); assert.match(find(report, 'public-url').message, /继续预览和编辑/);
});

test('只探测公开网址的三条固定路径，草稿迁移地址不偷换检查对象', async () => {
  publish(); draft(value => { value.settings.publicUrl = 'https://next.example.invalid'; }); const seen: string[] = [];
  const report = await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: goodReader('synthetic-release', seen) });
  assert.deepEqual(seen.sort(), ['https://launch.example.invalid/', 'https://launch.example.invalid/robots.txt', 'https://launch.example.invalid/sitemap.xml']); assert.equal(report.publicUrl, 'https://launch.example.invalid'); assert.equal(find(report, 'draft-changes').status, 'attention'); assert.equal(find(report, 'public-url').status, 'attention');
  for (const id of networkIds) assert.equal(find(report, id).status, 'passed'); assert.match(find(report, 'public-home').message, /仅验证本次首页/); assert.match(find(report, 'public-sitemap').message, /不表示.*收录/);
});

test('首页可访问但发布标记不符、noindex和规范地址不同都保留问题，不自动修复', async () => {
  publish(); const before = getStudioEnvelope(), delegate = goodReader();
  const report = await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: async (url, signal) => url.pathname === '/' ? response('<html data-site-release="old-release"><meta name="robots" content="noindex"><link rel="canonical" href="https://elsewhere.example.invalid/"></html>') : delegate(url, signal) });
  for (const id of ['public-home', 'public-indexing', 'public-canonical']) assert.equal(find(report, id).status, 'attention'); assert.deepEqual(getStudioEnvelope(), before); assert.doesNotMatch(JSON.stringify(report), /elsewhere\.example/);
});

test('robots缺失、复杂规则和不可识别内容保留未验证，训练机器人禁令不误报搜索', async () => {
  publish(); const delegate = goodReader(); for (const robots of [response('', 'text/plain', 404), response('<html>Not a robots file</html>'), response('User-agent: *\nDisallow: /*search*', 'text/plain')]) {
    const report = await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: async (url, signal) => url.pathname === '/robots.txt' ? robots : delegate(url, signal) }); assert.equal(find(report, 'public-robots').status, 'unverified');
  }
  assert.equal(robotsHomeBlocked('User-agent: *\nDisallow: /admin\nUser-agent: GPTBot\nDisallow: /'), false); assert.equal(robotsHomeBlocked('User-agent: *\nDisallow: /\nUser-agent: Googlebot\nAllow: /'), false); assert.equal(robotsHomeBlocked('User-agent: Googlebot\nDisallow: /'), true); assert.equal(robotsHomeBlocked('User-agent: *\nDisallow: /\nAllow: /'), false);
});

test('正式服务重定向不跟随，首页未取得时不猜测索引或canonical', async () => {
  publish(); const seen: string[] = [], report = await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: async url => { seen.push(url.href); return response('', 'text/html', 302); } });
  assert.equal(seen.length, 3); for (const id of ['public-home', 'public-robots', 'public-sitemap']) assert.equal(find(report, id).status, 'attention'); for (const id of ['public-indexing', 'public-canonical']) assert.equal(find(report, id).status, 'unverified');
});

test('站点地图空内容或跨域地址需处理，不访问地图链接', async () => {
  publish(); const delegate = goodReader(); for (const body of ['<urlset></urlset>', '<urlset><url><loc>https://outside.example.invalid/secret</loc></url></urlset>']) { let reads = 0; const report = await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: async (url, signal) => { reads++; return url.pathname === '/sitemap.xml' ? response(body, 'application/xml') : delegate(url, signal); } }); assert.equal(reads, 3); assert.equal(find(report, 'public-sitemap').status, 'attention'); assert.doesNotMatch(JSON.stringify(report), /outside\.example/); }
});

test('传输异常只返回安全错误，不回显上游正文或凭据', async () => {
  publish(); const report = await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: async () => { throw new Error('password=DO_NOT_EXPOSE secret private upstream response'); } });
  for (const id of ['public-home', 'public-robots', 'public-sitemap']) assert.equal(find(report, id).status, 'failed'); assert.doesNotMatch(JSON.stringify(report), /DO_NOT_EXPOSE|password=|upstream response/);
});

test('异步探测中草稿变化、公开切换或权限撤销都不能保存过时回执', async () => {
  publish(); for (const change of ['draft', 'release', 'role'] as const) {
    const base = request(['public-website']); let changed = false; await assert.rejects(checkLaunchReadiness(base, admin, undefined, { readPage: async () => { if (!changed) { changed = true; if (change === 'draft') draft(value => { value.settings.description = 'Changed during check'; }); else if (change === 'release') getDatabase().prepare('UPDATE cms_runtime SET active_release_id=NULL WHERE id=1').run(); else getDatabase().prepare("UPDATE auth_user SET role='viewer' WHERE id=?").run(admin.id); } return response(''); } }), status(change === 'role' ? 403 : 409));
    assert.equal(count(), 0); if (change === 'release') getDatabase().prepare("UPDATE cms_runtime SET active_release_id='synthetic-release' WHERE id=1").run();
  }
});

test('显式取消不保存成功回执，不修改网站', async () => {
  const before = getStudioEnvelope(), controller = new AbortController(); controller.abort(); await assert.rejects(checkLaunchReadiness(request(), admin, controller.signal), status(499)); assert.equal(count(), 0); assert.deepEqual(getStudioEnvelope(), before);
});

test('回执仅十分钟且与修订/公开快照匹配，读取过期结果不会假绿或续期', async () => {
  publish(); const checked = await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: goodReader() }); assert.equal(find(readLaunchCheck(admin), 'public-home').status, 'passed');
  getDatabase().prepare('UPDATE cms_launch_check SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), checked.lastCheck!.id); const expired = readLaunchCheck(admin); assert.equal(expired.lastCheck, null); assert.equal(find(expired, 'public-home').status, 'unverified'); assert.equal(count(), 1);
  await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: goodReader() }); draft(value => { value.settings.name = 'New draft'; }); assert.equal(find(readLaunchCheck(admin), 'public-home').status, 'unverified');
});

test('本地检查不会伪造或抹去同版本仍新鲜的网络抽样证据', async () => {
  publish(); await checkLaunchReadiness(request(['public-website']), admin, undefined, { readPage: goodReader() }); const local = await checkLaunchReadiness(request(), admin); assert.deepEqual(local.lastCheck?.checks, ['local']); assert.equal(find(local, 'public-home').status, 'passed'); assert.equal(find(readLaunchCheck(admin), 'public-home').status, 'passed');
});

test('服务测试绑定完整当前配置；最近失败覆盖旧成功，改配置和过期都回未验证', () => {
  ai(); mail(); const aiConfig = captureServiceTestConfiguration('ai'), mailConfig = captureServiceTestConfiguration('mail'); recordServiceTestEvidence(aiConfig, admin, { mode: 'model', status: 'passed' }); recordServiceTestEvidence(mailConfig, admin, { mode: 'smtp', status: 'sent' }); let report = readLaunchCheck(admin); assert.equal(find(report, 'ai-connection').status, 'passed'); assert.equal(find(report, 'mail-test').status, 'passed'); assert.match(find(report, 'mail-test').message, /服务接受.*实际收到/);
  recordServiceTestEvidence(aiConfig, admin, { mode: 'model', status: 'failed' }); recordServiceTestEvidence(mailConfig, admin, { mode: 'smtp', status: 'failed' }); report = readLaunchCheck(admin); assert.equal(find(report, 'ai-connection').status, 'failed'); assert.equal(find(report, 'mail-test').status, 'failed');
  getDatabase().prepare('UPDATE cms_service_test_receipt SET created_at=?').run(new Date(Date.now() - 25 * 3600000).toISOString()); report = readLaunchCheck(admin); assert.equal(find(report, 'ai-connection').status, 'unverified'); assert.equal(find(report, 'mail-test').status, 'unverified');
  recordServiceTestEvidence(aiConfig, admin, { mode: 'model', status: 'passed' }); getDatabase().prepare("UPDATE cms_ai_provider SET model='different-model',revision=revision+1 WHERE id=1").run(); assert.equal(find(readLaunchCheck(admin), 'ai-connection').status, 'unverified');
});

test('模拟邮件、未来记录和未知服务结果不能当作真实检查通过', () => {
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock'; recordServiceTestEvidence(captureServiceTestConfiguration('mail'), admin, { mode: 'mock', status: 'mock_sent' }); assert.equal(find(readLaunchCheck(admin), 'mail-test').status, 'unverified');
  ai(); recordServiceTestEvidence(captureServiceTestConfiguration('ai'), admin, { mode: 'model', status: 'unknown' }); assert.equal(find(readLaunchCheck(admin), 'ai-connection').status, 'unverified');
  recordServiceTestEvidence(captureServiceTestConfiguration('ai'), admin, { mode: 'model', status: 'passed' }); getDatabase().prepare("UPDATE cms_service_test_receipt SET created_at=? WHERE service='ai'").run(new Date(Date.now() + 10 * 60000).toISOString()); assert.equal(find(readLaunchCheck(admin), 'ai-connection').status, 'unverified');
});

test('旧AI建站方案不冒充当前模型生成或用户满意证据', () => {
  ai(); getDatabase().prepare("INSERT INTO cms_ai_build(id,actor_id,kind,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").run('synthetic-plan', admin.id, 'plan', getDraftRecord().revision, '{}', new Date().toISOString(), new Date(Date.now() + 60000).toISOString()); const item = find(readLaunchCheck(admin), 'ai-generation'); assert.equal(item.status, 'unverified'); assert.ok(item.checkedAt); assert.match(item.message, /没有绑定当前AI配置/);
});

test('自动备份开关只算配置；新近成功、失败、陈旧与缺少恢复证据分别显示', () => {
  mkdirSync(process.env.FORM_STUDIO_BACKUP_DIR!, { recursive: true }); const file = join(process.env.FORM_STUDIO_BACKUP_DIR!, 'STATUS.json'), report = readLaunchCheck(admin); assert.equal(find(report, 'backup-schedule').status, 'attention'); assert.equal(find(report, 'backup-latest').status, 'unverified');
  process.env.FORM_STUDIO_AUTOMATIC_BACKUP = '1'; writeFileSync(file, JSON.stringify({ status: 'success', createdAt: new Date().toISOString(), privateFile: 'DO_NOT_EXPOSE_PATH' })); let result = readLaunchCheck(admin); assert.equal(find(result, 'backup-schedule').status, 'configured'); assert.equal(find(result, 'backup-latest').status, 'passed'); assert.equal(find(result, 'backup-recoverability').status, 'unverified'); assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE_PATH/);
  writeFileSync(file, JSON.stringify({ status: 'success', createdAt: new Date(Date.now() - 48 * 3600000).toISOString() })); assert.equal(find(readLaunchCheck(admin), 'backup-latest').status, 'attention'); writeFileSync(file, JSON.stringify({ status: 'failure', at: new Date().toISOString() })); assert.equal(find(readLaunchCheck(admin), 'backup-latest').status, 'failed');
});

test('受控网络层拒绝凭据、额外路径、非HTTPS、内网和元数据地址', async () => {
  for (const url of ['http://public.example.invalid', 'https://u:p@public.example.invalid', 'https://public.example.invalid/path', 'https://public.example.invalid/?q=x', 'https://public.example.invalid/#x', 'https://localhost', 'https://10.0.0.1', 'https://100.100.100.200', 'https://169.254.169.254', 'https://[fd00:ec2::254]', 'https://[::ffff:7f00:1]']) assert.throws(() => validateLaunchOrigin(url), status(422));
  await assert.rejects(readLaunchPage(new URL('https://public.example.invalid/arbitrary'), AbortSignal.timeout(1000)), status(422)); await assert.rejects(readLaunchPage(new URL('https://u:p@public.example.invalid/'), AbortSignal.timeout(1000)), status(422)); await assert.rejects(readLaunchPage(new URL('https://127.0.0.1/'), AbortSignal.timeout(1000)), status(422)); assert.equal(validateLaunchOrigin('https://public.example.invalid').origin, 'https://public.example.invalid');
});
