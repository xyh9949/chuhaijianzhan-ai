#!/usr/bin/env node
// UI回归始终创建自己的临时实例，不接受已有站点地址、数据库、账号或环境文件。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync, realpathSync, lstatSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve, dirname, basename, sep } = require('node:path');
const { startUiAiModel } = require('../tests/ui/ai-model.cjs');

const root = resolve(__dirname, '..');
const reportRoot = join(root, 'output', 'ui-regression');
const cli = require.resolve('@playwright/test/cli');
const args = process.argv.slice(2);
let directory, application, runner, model, interrupted = false, appLog = '';
const delay = ms => new Promise(done => setTimeout(done, ms));

function parseArguments(values) {
  // 采用白名单，连写的-cfile、--config=file等形式也不能覆盖隔离配置或报告目录。
  const normalized = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (['--list', '--headed'].includes(value)) normalized.push(value);
    else if (value === '--grep') { const pattern = values[++index]; assert(typeof pattern === 'string' && pattern.length > 0, '--grep需要非空匹配表达式'); normalized.push(`--grep=${pattern}`); }
    else if (value.startsWith('--grep=') && value.length > 7) normalized.push(value);
    else throw Error('UI回归仅支持 --list、--grep 和 --headed；不得覆盖配置、来源、报告、重试或trace');
  }
  return normalized;
}
function resultStatus({ code, removed, closed, interrupted, buildUnchanged, listOnly, stats }) {
  if (code !== 0 || !removed || !closed || interrupted || !buildUnchanged) return 'failed';
  if (listOnly) return 'listed';
  // CLI退出0不等于真正跑过用例，空选择/全skip/波动都必须写成failed。
  const valid = stats && ['expected', 'unexpected', 'skipped', 'flaky'].every(key => Number.isInteger(stats[key]) && stats[key] >= 0) && stats.expected > 0 && stats.unexpected === 0 && stats.skipped === 0 && stats.flaky === 0;
  return valid ? 'passed' : 'failed';
}
function removeTemporaryDirectory() {
  if (!directory || !existsSync(directory)) return true;
  const tempRoot = realpathSync(tmpdir());
  assert(dirname(realpathSync(directory)) === tempRoot && basename(directory).startsWith('form-studio-ui-') && !lstatSync(directory).isSymbolicLink(), '临时清理路径核验失败，未删除');
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return !existsSync(directory);
}

function systemEnvironment() {
  // 不继承SMTP、Google、模型及FORM_STUDIO配置；Windows/浏览器所需系统路径单独白名单保留。
  // 带浏览器Linux镜像将锁定Chromium放在只读/opt；只转交已安装路径，不启用运行期下载。
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'LD_LIBRARY_PATH', 'LANG', 'LC_ALL', 'CI', 'NO_COLOR', 'FORCE_COLOR', 'PLAYWRIGHT_BROWSERS_PATH'];
  return Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}
function child(command, argv, options = {}) {
  return spawn(command, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
async function exitCode(processRef) {
  if (processRef.exitCode !== null) return processRef.exitCode;
  return new Promise((done, reject) => { processRef.once('error', reject); processRef.once('exit', (code, signal) => done(signal ? 1 : code ?? 1)); });
}
async function stopOwned(processRef) {
  if (!processRef || processRef.exitCode !== null || processRef.signalCode !== null) return;
  // 只处理本包装器直接创建且仍未退出的子进程；Windows同时终止它的浏览器/worker子树。
  if (process.platform === 'win32') {
    const stop = child('taskkill', ['/PID', String(processRef.pid), '/T', '/F']);
    stop.stdout.resume(); stop.stderr.resume(); await exitCode(stop);
  } else processRef.kill('SIGTERM');
  await Promise.race([exitCode(processRef), delay(5000).then(() => { if (processRef.exitCode === null && processRef.signalCode === null) processRef.kill('SIGKILL'); })]);
}
async function freePort() {
  return new Promise((done, reject) => { const probe = createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const address = probe.address(); assert(address && typeof address !== 'string'); const port = address.port; probe.close(error => error ? reject(error) : done(port)); }); });
}
async function portClosed(port) {
  return new Promise(done => { const probe = createServer(); probe.once('error', () => done(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => done(true))); });
}
function writePrivate(file, value) { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }

class LocalClient {
  constructor(origin) { this.origin = origin; this.cookies = new Map(); }
  async api(path, method = 'GET', body, expected = 200) {
    assert(path.startsWith('/api/') && !path.startsWith('//'));
    const response = await fetch(this.origin + path, { method, redirect: 'error', headers: { Origin: this.origin, Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    for (const header of response.headers.getSetCookie()) { const pair = header.split(';', 1)[0], index = pair.indexOf('='); if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
    const value = await response.json();
    assert.equal(response.status, expected, `合成实例 ${method} ${path} 应返回 ${expected}${value.error ? `：${value.error}` : ''}`);
    return value;
  }
  storage() { return { cookies: [...this.cookies].map(([name, value]) => ({ name, value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' })), origins: [] }; }
}

async function seed(admin) {
  let env = await admin.api('/api/studio');
  const now = new Date().toISOString();
  const longName = 'UI_LONG_PRODUCT_' + 'ContinuousName'.repeat(6);
  const longSku = 'UI-SKU-' + 'S'.repeat(55);
  const productModel = { id: 'ui-product-model', name: '回归产品参数', description: '仅用于自动回归的合成字段', target: 'product', updated: now, fields: [{ id: 'ui-zero', key: 'zero', label: '零值参数', type: 'number', required: false }, { id: 'ui-false', key: 'enabled', label: '布尔参数', type: 'boolean', required: false }, { id: 'ui-long', key: 'long_value', label: 'L'.repeat(80), type: 'text', required: false }] };
  const entryModel = { id: 'ui-story-model', name: '回归案例', description: '仅用于自动回归的合成内容', target: 'content', updated: now, fields: [{ id: 'ui-body', key: 'body', label: '案例说明', type: 'textarea', required: false }] };
  const products = Array.from({ length: 20 }, (_, index) => ({ id: `p${index + 1}`, name: index === 0 ? longName : `UI Product ${String(index + 1).padStart(2, '0')}`, sku: index === 0 ? longSku : `UI-SKU-${index + 1}`, slug: `ui-product-${index + 1}`, category: index === 0 ? 'C'.repeat(80) : index % 2 ? '分类 Beta' : '分类 Alpha', status: 'draft', image: '/images/chair.jpg', description: 'UI regression synthetic product. No real product claims.', material: '合成测试资料', locale: index % 3 === 2 ? 'de' : 'en', modelId: productModel.id, customFields: { 'ui-zero': 0, 'ui-false': false, 'ui-long': 'DescriptiveValue'.repeat(16) }, termIds: index === 0 ? ['ui-selected-tag'] : [], updated: now }));
  const extraPages = Array.from({ length: 12 }, (_, index) => ({ id: `ui-page-${index + 1}`, title: index === 0 ? 'UI_LONG_PAGE_' + 'LongTitle'.repeat(8) : `UI Page ${index + 1}`, slug: `/ui/${'very-long-address-'.repeat(index === 0 ? 7 : 1)}${index + 1}`, status: 'draft', type: '普通页面', updated: now }));
  const entries = Array.from({ length: 10 }, (_, index) => ({ id: `ui-entry-${index + 1}`, modelId: entryModel.id, title: index === 0 ? 'UI_LONG_ENTRY_' + 'ContinuousTitle'.repeat(5) : `UI Story ${index + 1}`, status: 'draft', slug: `story-${'long-address-'.repeat(4)}${index + 1}`, customFields: { 'ui-body': `Synthetic case ${index + 1}; local UI regression only.` }, updated: now }));
  const detail = { id: 'ui-story-detail', title: '回归案例详情', slug: '/stories/:slug', status: 'draft', type: '内容详情', contentModelId: entryModel.id, updated: now };
  const pages = [...env.state.pages, ...extraPages, detail], editorData = { ...env.state.editorData };
  for (const page of [...extraPages, detail]) editorData[page.id] = { root: { props: { brand: 'UI regression', showChrome: 'no' } }, content: [] };
  const settings = { ...env.state.settings, name: 'UI 回归测试站', domain: 'ui-regression.example.invalid', publicUrl: 'https://ui-regression.example.invalid', email: 'ui@example.invalid', locales: [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }] };
  env = await admin.api('/api/studio', 'PATCH', { expectedRevision: env.revision, patch: { products, pages, settings, editorData, contentModels: [productModel, entryModel], contentEntries: entries, taxonomies: [{ id: 'ui-tags', name: '测试标签', source: 'product', terms: [{ id: 'ui-selected-tag', label: '专项测试标签', slug: 'selected' }] }] } });
  // 只在本次随机临时实例生成一个版本，供历史表格读取；不是正式网站发布。
  const selection = { expectedRevision: env.revision, baseReleaseId: env.activeReleaseId, title: 'UI regression synthetic snapshot', pageIds: pages.map(page => page.id), productIds: products.map(product => product.id), contentModelIds: [productModel.id, entryModel.id], contentEntryIds: entries.map(entry => entry.id), includeTheme: true, includeSettings: true, includeCatalog: true };
  const check = await admin.api('/api/releases/preview', 'POST', selection);
  assert.deepEqual(check.errors, [], '合成版本预检必须真实通过');
  env = await admin.api('/api/releases', 'POST', selection, 201);
  return { longName, longSku, productCount: products.length, releaseId: env.releaseId, entryCount: entries.length, longPageId: extraPages[0].id, mediaId: env.state.media[0].id, mediaName: env.state.media[0].name, longPagePath: extraPages[0].slug };
}

async function main() {
  if (args[0] === '--report') {
    assert(args.length === 1, '报告查看命令不接受其他参数');
    const latest = JSON.parse(readFileSync(join(reportRoot, 'latest.json'), 'utf8'));
    const reports = latest.tracePrivate ? join(root, 'output', 'ui-regression-private') : reportRoot;
    const folder = resolve(reports, latest.run, 'report');
    assert(folder.startsWith(reports + sep) && existsSync(join(folder, 'index.html')));
    const viewer = child(process.execPath, [cli, 'show-report', folder], { cwd: root, env: systemEnvironment(), stdio: 'inherit' });
    process.exitCode = await exitCode(viewer); return;
  }
  const testArguments = parseArguments(args);
  assert(existsSync(join(root, '.next', 'BUILD_ID')), '缺少生产构建，请先运行 npm run build');
  const buildId = readFileSync(join(root, '.next', 'BUILD_ID'), 'utf8').trim();
  const channel = process.env.UI_TEST_CHANNEL || '';
  assert(['', 'chrome', 'msedge'].includes(channel), 'UI_TEST_CHANNEL 只支持 chrome 或 msedge；留空使用 Playwright Chromium');
  const run = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8), runFolder = join(reportRoot, run);
  mkdirSync(runFolder, { recursive: true });
  directory = mkdtempSync(join(realpathSync(tmpdir()), 'form-studio-ui-'));
  const runtime = join(directory, 'runtime'); mkdirSync(runtime);
  // runtime自身是真实临时目录，只有三个公开/编译目录链接；其中没有源码根的.env文件。
  for (const name of ['.next', 'node_modules', 'public', 'docs']) symlinkSync(join(root, name), join(runtime, name), process.platform === 'win32' ? 'junction' : 'dir');
  copyFileSync(join(root, 'next.config.ts'), join(runtime, 'next.config.ts'));
  writePrivate(join(runtime, 'package.json'), { name: 'form-studio-ui-runtime', private: true });
  const port = await freePort(); assert(port !== 3200 && port >= 1024);
  const origin = `http://127.0.0.1:${port}`, password = randomBytes(30).toString('base64url');
  // 邮件始终使用进程内JSON模拟，允许验证测试按钮而不会连接SMTP或发送真实邮件。
  const env = { ...systemEnvironment(), NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), BETTER_AUTH_URL: origin, FORM_STUDIO_DATA_DIR: join(directory, 'data'), FORM_STUDIO_BACKUP_DIR: join(directory, 'backups'), FORM_STUDIO_NOTIFY_TRANSPORT: 'mock', FORM_STUDIO_INDEXNOW_ENABLED: 'false', FORM_STUDIO_CRAWL_LOG: 'false', FORM_STUDIO_SEO_MOCK: 'false', FORM_STUDIO_TRUST_PROXY: 'false', AUTH_SETUP_EMAIL: 'ui-admin@example.invalid', AUTH_SETUP_NAME: 'UI 自动回归管理员', AUTH_SETUP_PASSWORD: password, UI_TEST_ORIGIN: origin, FORM_STUDIO_VISUAL_BROWSER_CHANNEL: channel || 'chromium', FORM_STUDIO_VISUAL_DISABLED: '0', FORM_STUDIO_VISUAL_ORIGIN: origin };
  let code = 1, removed = false, closed = false, resultDir = runFolder;
  try {
    model = await startUiAiModel(); env.UI_TEST_MODEL_ORIGIN = model.origin;
    const setup = child(process.execPath, ['--import', 'tsx', 'scripts/setup.ts', '--demo-draft', '--setup-env-file', join(directory, 'setup.env')], { cwd: root, env });
    let setupLog = ''; setup.stdout.on('data', chunk => { setupLog += chunk; }); setup.stderr.on('data', chunk => { setupLog += chunk; });
    assert.equal(await exitCode(setup), 0, `临时实例初始化失败：${setupLog}`);
    delete env.AUTH_SETUP_PASSWORD;
    application = child(process.execPath, ['--require', join(root, 'tests/ui/deny-external.cjs'), join(root, 'node_modules/next/dist/bin/next'), 'start', runtime, '--hostname', '127.0.0.1', '--port', String(port)], { cwd: runtime, env });
    application.stdout.on('data', chunk => { appLog = (appLog + chunk).slice(-6000); }); application.stderr.on('data', chunk => { appLog = (appLog + chunk).slice(-6000); });
    const deadline = Date.now() + 45000; let ready = false;
    while (Date.now() < deadline) { if (application.exitCode !== null) throw Error('临时服务提前退出，详情保存在本轮私有服务日志'); try { const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1500) }); if (response.status === 200) { ready = true; break; } } catch {} await delay(150); }
    assert(ready, '临时服务未就绪，详情保存在本轮私有服务日志');
    const admin = new LocalClient(origin), viewer = new LocalClient(origin);
    await admin.api('/api/auth/sign-in/email', 'POST', { email: 'ui-admin@example.invalid', password });
    await admin.api('/api/members', 'POST', { name: 'UI 只读成员', email: 'ui-viewer@example.invalid', password, role: 'viewer' }, 201);
    await viewer.api('/api/auth/sign-in/email', 'POST', { email: 'ui-viewer@example.invalid', password });
    assert.equal((await viewer.api('/api/auth/get-session')).user.role, 'viewer');
    const fixture = await seed(admin), adminAuth = join(directory, 'admin.auth.json'), viewerAuth = join(directory, 'viewer.auth.json');
    writePrivate(adminAuth, admin.storage()); writePrivate(viewerAuth, viewer.storage());
    const config = join(directory, 'run.json'); writePrivate(config, { origin, modelOrigin: model.origin, adminAuth, viewerAuth, fixture, dataDirectory: join(directory, 'data') });
    const trace = process.env.UI_TEST_TRACE === '1';
    resultDir = trace ? join(root, 'output', 'ui-regression-private', run) : runFolder;
    mkdirSync(resultDir, { recursive: true });
    const runnerEnv = { ...systemEnvironment(), UI_TEST_RUN_CONFIG: config, UI_TEST_RUN_DIR: resultDir, UI_TEST_CHANNEL: channel, UI_TEST_TRACE: trace ? '1' : '0' };
    console.log(`UI regression: isolated temporary instance; reports: output/${trace ? 'ui-regression-private' : 'ui-regression'}/${run}`);
    runner = child(process.execPath, [cli, 'test', '--config', join(root, 'tests/ui/playwright.config.ts'), ...testArguments], { cwd: root, env: runnerEnv, stdio: 'inherit' });
    code = await exitCode(runner);
  } finally {
    await stopOwned(runner); await stopOwned(application); if (model) { await model.close(); model = undefined; } closed = await portClosed(port);
    // 删除前确认最终绝对路径仍是本次mkdtemp生成的普通目录；rm不跟随内部junction。
    removed = removeTemporaryDirectory();
    const listOnly = args.includes('--list'), report = join(resultDir, 'results.json');
    const stats = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')).stats : undefined;
    const buildUnchanged = readFileSync(join(root, '.next', 'BUILD_ID'), 'utf8').trim() === buildId;
    const summary = { status: resultStatus({ code, removed, closed, interrupted, buildUnchanged, listOnly, stats }), mode: listOnly ? 'discovery' : 'execution', run, buildId, buildUnchanged, browser: channel || 'chromium', testExitCode: code, temporaryInstanceRemoved: removed, testPortClosed: closed, formalInstanceUsed: false, tracePrivate: process.env.UI_TEST_TRACE === '1', fullSuite: !listOnly && !testArguments.some(value => value.startsWith('--grep=')), ...(stats ? { tests: { passed: stats.expected, failed: stats.unexpected, skipped: stats.skipped, flaky: stats.flaky, durationMs: stats.duration } } : {}) };
    // 原始服务错误可能含临时请求信息，失败时只在排除分发的私有目录留证，不拼入公开日志。
    if (summary.status === 'failed' && appLog) { const privateDir = join(root, 'output', 'ui-regression-private', run); mkdirSync(privateDir, { recursive: true }); writeFileSync(join(privateDir, 'next-server.log'), appLog, { mode: 0o600 }); summary.privateServerLogSaved = true; }
    writeFileSync(join(runFolder, 'summary.json'), JSON.stringify(summary, null, 2));
    writeFileSync(join(reportRoot, 'latest.json'), JSON.stringify(summary, null, 2));
    assert(removed && closed, '临时实例或端口清理失败，结果不能视为通过');
    assert(buildUnchanged, '回归期间构建被替换，结果不能代表同一构建');
    if (summary.status === 'failed') process.exitCode = code || 1;
    console.log(JSON.stringify(summary));
  }
}
module.exports = { parseArguments, resultStatus };
if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; void stopOwned(runner).then(() => stopOwned(application)); });
  main().catch(async error => {
    // 初始化阶段发生在服务启动前，也要清理已创建的runtime，不遗留junction或临时配置。
    try { await stopOwned(runner); await stopOwned(application); if (model) { await model.close(); model = undefined; } removeTemporaryDirectory(); } catch { console.error('UI regression cleanup failed; inspect the latest local run before retrying.'); }
    console.error(error instanceof Error ? error.message : 'UI regression failed'); process.exitCode = 1;
  });
}
