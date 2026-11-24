import { runAccountRecoveryHttp } from './account-recovery-http';
import { runAiDesignGuidanceHttp } from './ai-design-guidance-http';
import { runLaunchCheckHttp } from './launch-check-http';
import { runMailSettingsHttp } from './mail-settings-http';
import { runAiDetailDesignHttp } from './ai-detail-design-http';
import {runExternalAiHttp} from './external-ai-http';
import {runAiSiteDesignSelectionHttp} from './ai-site-design-selection-http';
import {runExternalAiContentHttp} from './external-ai-content-http';
import {runLeadHttp} from './lead-http';
import {runAiBuilderHttp} from './ai-builder-http';
import {runAiSourceHttp} from './ai-source-http';
import {runAiPageEditHttp} from './ai-page-edit-http';
import {runAiSiteDesignHttp} from './ai-site-design-http';
import {runSeoSourcesHttp,startSeoSourcesHttpMock,type SeoSourcesHttpMock} from './seo-sources-http';
import {runSeoProposalsHttp} from './seo-proposals-http';
import {runAiBuildResumeHttp} from './ai-build-resume-http';
import {runAiWritingHttp} from './ai-writing-http';
import {runDiscoveryHttp} from './discovery-http';
import protocol from '../src/lib/protocol.json';
import {runS13Http} from './s13-http';
import {runS12Http} from './s12-http';
import {runS11Http} from './s11-http';
import type { SiteSnapshot } from '../src/server/types';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { StudioState } from '../src/lib/types';
import { STARTER_KITS } from '../src/lib/starter-kits';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null; releaseId?: string };
const root = process.cwd();
const port = Number(process.env.HTTP_TEST_PORT || 3201);
const origin = `http://127.0.0.1:${port}`;
let directory = ''; let server: ChildProcess | undefined; let serverLog = '';
let seoSourcesMock: SeoSourcesHttpMock | undefined;
const milestones: string[] = [];
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const signInQuietWindow = 61_000;
let syntheticSignIns = 0, lastSyntheticSignIn = -Infinity;

// Node22在tsx压缩源码的无消息assert.ok失败时会反复定位列号；明确消息保留断言语义并避免测试假性卡死。
function expectTrue(value:unknown,message='HTTP集成条件未满足，请按源代码位置检查'):asserts value {assert.ok(value,message);}

class Client {
  cookies = new Map<string, string>();
  async fetch(path: string, options: RequestInit = {}) {
    const signIn = path === '/api/auth/sign-in/email' && options.method === 'POST';
    if (signIn) {
      // 本机合成角色共用同一个滑动窗口，密码错误的尝试也由认证库计数。
      const remaining = signInQuietWindow - (performance.now() - lastSyntheticSignIn);
      if (remaining <= 0) syntheticSignIns = 0;
      else if (syntheticSignIns >= 8) { await delay(remaining); syntheticSignIns = 0; }
    }
    const request = () => fetch(`${origin}${path}`, { ...options, redirect: 'manual', headers: { Origin: origin, Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers } });
    let response = await request();
    if (signIn && response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? response.headers.get('x-retry-after'));
      assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60, '合成登录限流须提供有效的重试窗口');
      // 边界时钟由服务端控制，给隔离合成登录一个完整静默窗口，只重试一次。
      console.error(`Synthetic sign-in rate limited (${seconds}s). Waiting for one full login window.`);
      await response.body?.cancel();
      await delay(signInQuietWindow);
      syntheticSignIns = 0;
      response = await request();
    }
    if (signIn) { syntheticSignIns++; lastSyntheticSignIn = performance.now(); }
    for (const line of response.headers.getSetCookie()) {
      const part = line.split(';', 1)[0]; const index = part.indexOf('=');
      if (index > 0) { const key = part.slice(0, index), value = part.slice(index + 1); if (value) this.cookies.set(key, value); else this.cookies.delete(key); }
    }
    return response;
  }
  async api<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> {
    const options = { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) };
    const response = await this.fetch(path, options);
    const data = await response.json() as T & { error?: unknown };
    assert.equal(response.status, expected, `${method} ${path} 状态不符合预期${data.error ? `：${String(data.error)}` : ''}`);
    if (path.startsWith('/api/')) assert.match(response.headers.get('cache-control') || '', /no-store/);
    return data;
  }
}

async function requireFreePort() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3200) throw new Error('HTTP_TEST_PORT 必须为独立测试端口，禁止使用真实工作区 3200');
  await new Promise<void>((done, reject) => {
    const probe = createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close((error) => error ? reject(error) : done()));
  });
}
async function runSetup(env: NodeJS.ProcessEnv) {
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/setup.ts', '--demo-draft', '--setup-env-file', join(directory, '.env.test')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout?.on('data', (chunk) => { output += String(chunk); }); child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? done() : reject(new Error(`独立测试实例初始化失败：${output}`)));
  });
}
async function startServer(env: NodeJS.ProcessEnv) {
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout?.on('data', (chunk) => { serverLog = (serverLog + String(chunk)).slice(-6000); });
  server.stderr?.on('data', (chunk) => { serverLog = (serverLog + String(chunk)).slice(-6000); });
  server.once('error', (error) => { serverLog += error.message; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`独立测试服务启动失败：${serverLog}`);
    try { const response = await fetch(`${origin}/api/auth/get-session`, { signal: AbortSignal.timeout(1000) }); if (response.status === 200) return; } catch { /* 等待当前测试进程就绪。 */ }
    await delay(250);
  }
  throw new Error(`独立测试服务未就绪：${serverLog}`);
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  await new Promise<void>((done) => {
    child.once('exit', () => done()); child.kill('SIGTERM');
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000); timer.unref();
  });
  server = undefined;
}
function firstText(state: StudioState, id: string, value: string) {
  const editorData = structuredClone(state.editorData);
  const page = editorData[id] as { content: unknown[] };
  page.content.unshift({ type: 'Text', props: { id: `http-marker-${id}`, text: value, size: 16, color: '#222222', align: 'left', maxWidth: 1000 } });
  return editorData;
}

async function main() {
  if (!existsSync(join(root, '.next', 'BUILD_ID'))) throw new Error('请先由主任务完成生产构建；此测试不执行 build');
  await requireFreePort();
  directory = mkdtempSync(join(tmpdir(), 'form-studio-http-'));
  seoSourcesMock = await startSeoSourcesHttpMock();
  const password = randomBytes(24).toString('base64url');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', FORM_STUDIO_DATA_DIR: join(directory, 'data'), BETTER_AUTH_URL: origin, FORM_STUDIO_NOTIFY_TRANSPORT: 'mock', FORM_STUDIO_SEO_MOCK: 'true', FORM_STUDIO_SEO_MOCK_ORIGIN: seoSourcesMock.origin, BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), AUTH_SETUP_EMAIL: 'http-admin@example.com', AUTH_SETUP_NAME: 'HTTP 测试管理员', AUTH_SETUP_PASSWORD: password };
  await runSetup(env); delete env.AUTH_SETUP_PASSWORD;
  await startServer(env);
  const anonymous = new Client(), admin = new Client(), editor = new Client(), viewer = new Client();
  assert.deepEqual(await anonymous.api('/api/health'),{status:'ready'});
  await anonymous.api('/api/studio', 'GET', undefined, 401);
  await admin.api('/api/auth/sign-in/email', 'POST', { email: 'http-admin@example.com', password });
  await admin.api('/api/members', 'POST', { name: 'HTTP 编辑员', email: 'http-editor@example.com', password, role: 'editor' }, 201);
  await admin.api('/api/members', 'POST', { name: 'HTTP 只读员', email: 'http-viewer@example.com', password, role: 'viewer' }, 201);
  await editor.api('/api/auth/sign-in/email', 'POST', { email: 'http-editor@example.com', password });
  await viewer.api('/api/auth/sign-in/email', 'POST', { email: 'http-viewer@example.com', password });
  await viewer.api('/api/operations/status','GET',undefined,403);
  await anonymous.api('/api/operations/status','GET',undefined,401);
  assert.deepEqual(await admin.api('/api/operations/status'),{automatic:false,intervalHours:null,latest:null});
  let state = await admin.api<Envelope>('/api/studio');
  assert.equal(state.activeReleaseId, null); assert.equal(state.state.releases.length, 0); assert.equal(state.state.inquiries.length, 0);
  await viewer.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { theme: state.state.theme } }, 403);
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { settings: state.state.settings } }, 403);
  await editor.api('/api/releases', 'POST', {}, 403);
  const wrongOrigin = await admin.fetch('/api/studio', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://invalid.example' }, body: '{}' }); assert.equal(wrongOrigin.status, 403);
  milestones.push('未登录、只读、编辑员设置与发布权限，以及来源校验通过');
  // 首次发布前正式地址为空，真实走未部署分支；不能向后续合成示例域名发出探测。
  state=await runLaunchCheckHttp({admin,editor,viewer,anonymous},state);
  milestones.push('上线检查当前资料/正式指针绑定/配置与验证分开/本机不冒充公网/权限及检查不改网站通过');

  const homeMarker = `HTTP-HOME-${randomBytes(5).toString('hex')}`, aboutMarker = `HTTP-ABOUT-${randomBytes(5).toString('hex')}`;
  let editorData = firstText(state.state, 'home', homeMarker);
  editorData = firstText({ ...state.state, editorData }, 'about', aboutMarker);
  const stale = state.revision;
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { editorData } });
  await editor.api('/api/studio', 'PATCH', { expectedRevision: stale, patch: { theme: state.state.theme } }, 409);
  const previewBefore = await admin.fetch('/preview'); assert.equal(previewBefore.status, 200); expectTrue((await previewBefore.text()).includes(homeMarker));
  const anonPreview = await anonymous.fetch('/preview'); assert.notEqual(anonPreview.status, 200);
  const unpublished = await anonymous.fetch('/'); assert.equal((await unpublished.text()).includes(homeMarker), false);
  milestones.push('草稿真实持久化、409 冲突、登录预览与公开隔离通过');

  const pixels = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#345678' } }).png().toBuffer();
  const form = new FormData(); form.set('file', new File([new Uint8Array(pixels)], 'http-test.png', { type: 'image/png' })); form.set('expectedRevision', String(state.revision));
  const uploadedResponse = await editor.fetch('/api/media', { method: 'POST', body: form }); assert.equal(uploadedResponse.status, 201);
  const upload = await uploadedResponse.json() as Envelope & { media: { id: string; url: string } }; state = upload;
  const privateMedia = await anonymous.fetch(upload.media.url); assert.equal(privateMedia.status, 401);
  const authorizedMedia = await viewer.fetch(upload.media.url); assert.equal(authorizedMedia.status, 200); assert.equal(authorizedMedia.headers.get('content-type'), 'image/webp');
  editorData = structuredClone(state.state.editorData);
  (editorData.home as { content: unknown[] }).content.push({ type: 'Image', props: { id: 'http-uploaded-image', src: upload.media.url, alt: 'HTTP 上传测试', height: 160, fit: 'cover', radius: 0 } });
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { editorData } });
  await editor.api(`/api/media/${upload.media.id}`, 'DELETE', { expectedRevision: state.revision }, 422);

  const publication = (extra: Record<string, unknown> = {}) => ({ expectedRevision: state.revision, baseReleaseId: state.activeReleaseId, title: 'HTTP 完整发布', pageIds: ['home', 'about', 'product-detail'], productIds: ['p1'], includeTheme: true, includeSettings: true, ...extra });
  const check = await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', publication()); assert.deepEqual(check.errors, []);
  state = await admin.api<Envelope>('/api/releases', 'POST', publication(), 201); const firstRelease = state.releaseId!;
  const publicHome = await anonymous.fetch('/'); assert.equal(publicHome.status, 200); expectTrue((await publicHome.text()).includes(homeMarker)); assert.match(publicHome.headers.get('cache-control') || '', /no-store/);
  const publicProduct = await anonymous.fetch('/products/p1'); assert.equal(publicProduct.status, 200); expectTrue((await publicProduct.text()).includes('MR-CH-001'));
  const publicMedia = await anonymous.fetch(upload.media.url); assert.equal(publicMedia.status, 200); assert.match(publicMedia.headers.get('cache-control') || '', /immutable/);
  const snapshot = state.state.releases.find((release) => release.id === firstRelease)!.snapshot!;
  assert.equal('domain' in (snapshot.settings as object), false); assert.equal('inquiries' in snapshot, false);
  milestones.push('图片真实解码、草稿鉴权、引用删除保护、完整公开发布通过');

  const unpublishedAbout = `UNSELECTED-ABOUT-${randomBytes(5).toString('hex')}`, unpublishedProduct = `UNSELECTED-PRODUCT-${randomBytes(5).toString('hex')}`;
  editorData = structuredClone(state.state.editorData);
  ((editorData.about as { content: { props: { text: string } }[] }).content[0]).props.text = unpublishedAbout;
  ((editorData.home as { content: { props: { text: string } }[] }).content[0]).props.text = `${homeMarker}-V2`;
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { editorData, products: state.state.products.map((product) => product.id === 'p1' ? { ...product, name: unpublishedProduct } : product), theme: { ...state.state.theme, primary: '#123456' }, settings: { ...state.state.settings, email: 'unpublished@example.com' } } });
  state = await admin.api<Envelope>('/api/releases', 'POST', publication({ title: 'HTTP 仅首页', pageIds: ['home'], productIds: [], includeTheme: false, includeSettings: false }), 201); const secondRelease = state.releaseId!;
  const currentSnapshot = state.state.releases.find((release) => release.id === secondRelease)!.snapshot!;
  assert.deepEqual(currentSnapshot.products, snapshot.products); assert.deepEqual(currentSnapshot.theme, snapshot.theme); assert.deepEqual(currentSnapshot.settings, snapshot.settings);
  assert.equal(Object.hasOwn(state.state.releases.find(release => release.id === firstRelease)!, 'snapshot'), false);
  await anonymous.api(`/api/releases/${firstRelease}`, 'GET', undefined, 401);
  const selectedHistory = await viewer.fetch(`/api/releases/${firstRelease}`);
  assert.equal(selectedHistory.status, 200); assert.equal(selectedHistory.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await selectedHistory.json(), { snapshot });
  await viewer.api('/api/releases/missing-release', 'GET', undefined, 404);
  const publicAbout = await anonymous.fetch('/about'); const aboutHtml = await publicAbout.text(); expectTrue(aboutHtml.includes(aboutMarker)); assert.equal(aboutHtml.includes(unpublishedAbout), false);
  const productAfter = await anonymous.fetch('/products/p1'); assert.equal((await productAfter.text()).includes(unpublishedProduct), false);
  await admin.api('/api/releases', 'POST', publication({ baseReleaseId: firstRelease }), 409);
  milestones.push('部分发布保留未选页面、产品、主题与公开设置，过期线上指针拒绝通过');

  const inquiry = await editor.api<{ item: { id: string; revision: number } }>('/api/inquiries', 'POST', { name: 'HTTP 测试客户', email: 'buyer@example.com', message: '真实存储测试，不发送邮件' }, 201);
  await viewer.api(`/api/inquiries/${inquiry.item.id}`, 'PATCH', { expectedRevision: 0, status: 'contacted' }, 403);
  await editor.api(`/api/inquiries/${inquiry.item.id}`, 'PATCH', { expectedRevision: 0, status: 'contacted' });
  await editor.api(`/api/inquiries/${inquiry.item.id}`, 'PATCH', { expectedRevision: 0, status: 'archived' }, 409);
  const beforeRestore = structuredClone(state.state.editorData); const revisionBefore = state.revision;
  state = await admin.api<Envelope>(`/api/releases/${firstRelease}/activate`, 'POST', { expectedActiveReleaseId: secondRelease });
  assert.equal(state.revision, revisionBefore); assert.deepEqual(state.state.editorData, beforeRestore);
  const rolledBack = await anonymous.fetch('/'); const html = await rolledBack.text(); expectTrue(html.includes(homeMarker)); assert.equal(html.includes(`${homeMarker}-V2`), false);
  await editor.api(`/api/releases/${firstRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [], includeSettings: true }, 403);
  state = await editor.api<Envelope>(`/api/releases/${firstRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: ['home'], productIds: [], includeTheme: false, includeSettings: false });
  assert.equal(state.activeReleaseId, firstRelease); assert.deepEqual(state.state.editorData.about, beforeRestore.about);
  assert.equal(state.state.inquiries.find((item) => item.id === inquiry.item.id)?.status, 'contacted');
  milestones.push('线上回滚与草稿恢复互不覆盖，询盘独立版本和运行数据保留通过');

  // 同步资产、页眉页脚和代码在同一不可变版本中发布；以下写入仅发生在隔离实例。
  const emptyCode = { css: '', js: '', cssEnabled: false, jsEnabled: false };
  const code = { global: { ...emptyCode, css: '.http-code { color: rgb(12, 34, 56); }', js: 'document.documentElement.dataset.httpGlobal = "v1";', cssEnabled: true, jsEnabled: true }, pages: { home: { ...emptyCode, js: 'document.documentElement.dataset.httpPage = "home";', jsEnabled: true } } };
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { customCode: code } }, 403);
  await viewer.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { sharedBlocks: [] } }, 403);
  await admin.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { customCode: { ...code, global: { ...code.global, js: 'const broken = ;' } } } }, 422);
  const block = { id: 'http-shared', name: 'HTTP 同步页眉', updated: '', data: { root: { props: { showChrome: 'no' } }, content: [{ type: 'Text', props: { id: 'http-shared-text', text: 'HTTP-SHARED-V1', size: 20, color: '#112233', align: 'left', maxWidth: 1000 } }] } };
  const layout = { header: { mode: 'block', blockId: block.id }, footer: { mode: 'block', blockId: block.id } };
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { sharedBlocks: [block], siteLayout: layout } });
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { sharedBlocks: [] } }, 422);
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { customCode: code } });
  const globalSelection = (extra: Record<string, unknown> = {}) => publication({ pageIds: [], productIds: [], includeTheme: false, includeSettings: false, sharedBlockIds: [block.id], includeLayout: true, includeCode: true, ...extra });
  const globalCheck = await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', globalSelection()); assert.deepEqual(globalCheck.errors, []);
  state = await admin.api<Envelope>('/api/releases', 'POST', globalSelection({ title: 'HTTP 全站同步 V1' }), 201); const globalRelease = state.releaseId!;
  const globalHome = await (await anonymous.fetch('/')).text(), globalAbout = await (await anonymous.fetch('/about')).text();
  expectTrue(globalHome.includes('HTTP-SHARED-V1')); expectTrue(globalAbout.includes('HTTP-SHARED-V1'));
  expectTrue(globalHome.includes(`/api/site-code/${globalRelease}/global/js`)); expectTrue(globalHome.includes(`/api/site-code/${globalRelease}/home/js`));
  assert.equal(globalAbout.includes(`/api/site-code/${globalRelease}/home/js`), false);
  const codeAsset = await anonymous.fetch(`/api/site-code/${globalRelease}/global/js`); assert.equal(codeAsset.status, 200); assert.match(codeAsset.headers.get('cache-control') || '', /immutable/); expectTrue((await codeAsset.text()).includes('httpGlobal'));
  const cssAsset = await anonymous.fetch(`/api/site-code/${globalRelease}/global/css`); assert.match(cssAsset.headers.get('content-type') || '', /text\/css/); assert.equal(await cssAsset.text(), code.global.css);
  assert.equal((await anonymous.fetch('/api/site-code/not-published/global/js')).status, 404);
  const previewWithCode = await (await admin.fetch('/preview')).text(); expectTrue(previewWithCode.includes('data-preview-source="true"')); assert.equal(previewWithCode.includes(`src="/api/site-code/${globalRelease}`), false);
  const changedBlock = { ...block, data: { ...block.data, content: [{ ...block.data.content[0], props: { ...block.data.content[0].props, text: 'HTTP-SHARED-V2' } }] } };
  const draftOnlyCode = { ...code, global: { ...code.global, js: 'document.documentElement.dataset.httpGlobal = "unpublished";' } };
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { sharedBlocks: [changedBlock], customCode: draftOnlyCode } });
  state = await admin.api<Envelope>('/api/releases', 'POST', globalSelection({ title: 'HTTP 仅同步区块', includeCode: false, includeLayout: false }), 201); const sharedOnlyRelease = state.releaseId!;
  expectTrue((await (await anonymous.fetch('/about')).text()).includes('HTTP-SHARED-V2'));
  const preservedCode = await (await anonymous.fetch(`/api/site-code/${sharedOnlyRelease}/global/js`)).text(); expectTrue(preservedCode.includes('"v1"')); assert.equal(preservedCode.includes('unpublished'), false);
  await editor.api(`/api/releases/${globalRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [], includeCode: true }, 403);
  state = await admin.api<Envelope>(`/api/releases/${globalRelease}/activate`, 'POST', { expectedActiveReleaseId: sharedOnlyRelease });
  expectTrue((await (await anonymous.fetch('/about')).text()).includes('HTTP-SHARED-V1'));
  assert.equal(state.state.sharedBlocks?.[0].data.content[0].props.text, 'HTTP-SHARED-V2');
  state = await admin.api<Envelope>(`/api/releases/${globalRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [], sharedBlockIds: [block.id], includeLayout: true, includeCode: true });
  assert.equal(state.state.sharedBlocks?.[0].data.content[0].props.text, 'HTTP-SHARED-V1'); assert.deepEqual(state.state.customCode, code);
  milestones.push('同步区块与全站头尾跨页生效；代码权限、语法校验、不可变资源、单页作用域、显式部分发布及整套恢复通过');

  // 模型和扩展值作为独立发布资产；真实生产请求验证渲染不会偷读当前草稿。
  const productModel = { id: 'http-product-model', name: 'HTTP 产品参数', description: '独立测试', target: 'product', updated: '', fields: [
    { id: 'field-weight', key: 'weight', label: '重量', type: 'number', required: true, min: 0, max: 1000, unit: 'kg' },
    { id: 'field-ready', key: 'ready', label: '现货', type: 'boolean', required: true },
    { id: 'field-photo', key: 'photo', label: '图片集', type: 'gallery', required: false },
    { id: 'field-url', key: 'url', label: '资料链接', type: 'url', required: false },
  ] };
  const entryModel = { id: 'http-case-model', name: 'HTTP 项目案例', description: '', target: 'content', updated: '', fields: [
    { id: 'field-summary', key: 'summary', label: '摘要', type: 'textarea', required: true },
    { id: 'field-cover', key: 'cover', label: '封面', type: 'image', required: false },
    { id: 'field-case-link', key: 'case_link', label: '详情链接', type: 'url', required: false },
  ] };
  const models = [productModel, entryModel];
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { contentModels: models } }, 403);
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { contentModels: models } });
  const entry = { id: 'http-entry-one', modelId: entryModel.id, title: 'HTTP-CASE-ALPHA', status: 'draft', updated: '', customFields: { 'field-summary': 'HTTP-CASE-SUMMARY', 'field-cover': upload.media.url, 'field-case-link': '/about' } };
  const expandedProducts = state.state.products.map(product => product.id === 'p1' ? { ...product, modelId: productModel.id, customFields: { 'field-weight': 0, 'field-ready': false, 'field-photo': [upload.media.url], 'field-url': '/about' } } : product);
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { products: expandedProducts, contentEntries: [entry] } });
  await viewer.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { contentEntries: [entry] } }, 403);
  await admin.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { contentModels: [{ ...productModel, fields: productModel.fields.slice(1) }, entryModel] } }, 422);
  const fixed = (field: string) => ({ source: 'product', mode: 'fixed', modelId: productModel.id, recordId: 'p1', field });
  editorData = structuredClone(state.state.editorData);
  const homeData = editorData.home as { root: { props: Record<string, unknown> }; content: unknown[] };
  homeData.root.props.bindingContext = { source: 'entry', modelId: entryModel.id, recordId: entry.id };
  homeData.content.unshift(
    { type: 'Heading', props: { id: 'http-bound-weight', text: 'FALLBACK-WEIGHT', size: 24, mobileSize: 20, color: '#112233', align: 'left', style: 'sans', spacing: 0, bindings: { text: fixed('field:field-weight') } } },
    { type: 'Text', props: { id: 'http-bound-false', text: 'FALLBACK-BOOLEAN', size: 16, color: '#112233', align: 'left', maxWidth: 1000, bindings: { text: fixed('field:field-ready') } } },
    { type: 'Image', props: { id: 'http-bound-gallery', src: '', alt: 'HTTP-BOUND-IMAGE', height: 80, fit: 'cover', radius: 0, bindings: { src: fixed('field:field-photo') } } },
    { type: 'Text', props: { id: 'http-bound-current-entry', text: 'FALLBACK-ENTRY', size: 16, color: '#112233', align: 'left', maxWidth: 1000, bindings: { text: { source: 'entry', mode: 'current', modelId: entryModel.id, field: 'field:field-summary' } } } },
    { type: 'ContentList', props: { id: 'http-dynamic-list', source: 'entry', modelId: entryModel.id, count: 3, columns: 3, mobileColumns: 1, titleField: 'builtin:title', descriptionField: 'field:field-summary', imageField: 'field:field-cover', linkField: 'field:field-case-link', emptyText: 'No cases' } },
  );
  (editorData['product-detail'] as { content: unknown[] }).content.unshift({ type: 'Heading', props: { id: 'http-current-product', text: 'FALLBACK-DETAIL', size: 24, mobileSize: 20, color: '#112233', align: 'left', style: 'sans', spacing: 0, bindings: { text: { source: 'product', mode: 'current', modelId: productModel.id, field: 'field:field-weight' } } } });
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { editorData } });
  const modelSelection = (extra: Record<string, unknown> = {}) => publication({ pageIds: ['home', 'product-detail'], productIds: ['p1'], includeTheme: false, includeSettings: false, contentModelIds: models.map(model => model.id), contentEntryIds: [entry.id], ...extra });
  const dependencyCheck = await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', modelSelection({ contentModelIds: [] })); expectTrue(dependencyCheck.errors.length > 0, '新模型依赖必须显式勾选');
  const modelCheck = await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', modelSelection()); assert.deepEqual(modelCheck.errors, []);
  state = await admin.api<Envelope>('/api/releases', 'POST', modelSelection({ title: 'HTTP 内容模型 V1' }), 201); const modelRelease = state.releaseId!;
  const boundHome = await (await anonymous.fetch('/')).text(), boundProduct = await (await anonymous.fetch('/products/p1')).text();
  expectTrue(boundHome.includes('>0 kg<')); expectTrue(boundHome.includes('>No<')); expectTrue(boundHome.includes('HTTP-CASE-ALPHA')); expectTrue(boundHome.includes('HTTP-CASE-SUMMARY')); expectTrue(boundProduct.includes('>0 kg<'));
  const publishedModel = state.state.releases.find(release => release.id === modelRelease)!.snapshot!; assert.equal(publishedModel.schemaVersion, protocol.snapshot);
  const editedEntries = state.state.contentEntries!.map(item => ({ ...item, title: 'HTTP-CASE-UNPUBLISHED' }));
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { contentEntries: editedEntries, products: state.state.products.map(product => product.id === 'p1' ? { ...product, customFields: { ...product.customFields, 'field-weight': 12.5 } } : product) } });
  state = await admin.api<Envelope>('/api/releases', 'POST', modelSelection({ title: 'HTTP 仅产品值', pageIds: [], contentModelIds: [], contentEntryIds: [] }), 201); const valuesRelease = state.releaseId!;
  const afterValuePublish = await (await anonymous.fetch('/')).text(); expectTrue(afterValuePublish.includes('>12.5 kg<')); expectTrue(afterValuePublish.includes('HTTP-CASE-ALPHA')); assert.equal(afterValuePublish.includes('HTTP-CASE-UNPUBLISHED'), false);
  await editor.api(`/api/releases/${modelRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [], contentModelIds: [productModel.id] }, 403);
  state = await admin.api<Envelope>(`/api/releases/${globalRelease}/activate`, 'POST', { expectedActiveReleaseId: valuesRelease });
  assert.equal((await (await anonymous.fetch('/')).text()).includes('HTTP-CASE-ALPHA'), false, '未包含模型的历史版本仍可正常回滚');
  state = await admin.api<Envelope>(`/api/releases/${modelRelease}/activate`, 'POST', { expectedActiveReleaseId: globalRelease });
  state = await admin.api<Envelope>(`/api/releases/${modelRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [], productIds: ['p1'], contentModelIds: models.map(model => model.id), contentEntryIds: [entry.id] });
  assert.equal(state.state.products.find(product => product.id === 'p1')?.customFields?.['field-weight'], 0); assert.equal(state.state.contentEntries?.[0].title, 'HTTP-CASE-ALPHA');
  milestones.push('模型权限、字段删除保护、显式依赖发布、0/false/图片与当前产品动态绑定、内容列表、部分发布隔离及有无模型的历史版本回滚恢复通过');

  // 独立详情页与循环卡片共享不可变快照；真实路由、SEO和嵌套卡片不能串到其他记录。
  const currentEntry = (field: string) => ({ source: 'entry', mode: 'current', modelId: entryModel.id, field });
  const detailPage = { id: 'http-case-detail', title: '案例详情模板', slug: '/cases/:slug', contentModelId: entryModel.id, status: 'draft', type: '动态模板', updated: '' };
  const listingPage = { id: 'http-case-listing', title: '案例循环列表', slug: '/case-list', status: 'draft', type: '普通页面', updated: '' };
  const cases = [
    { ...state.state.contentEntries![0], slug: 'alpha', seoTitle: 'HTTP CASE SEO ALPHA', seoDescription: 'HTTP CASE DESCRIPTION ALPHA' },
    { ...state.state.contentEntries![0], id: 'http-entry-two', slug: 'beta', title: 'HTTP-CASE-BETA', seoTitle: 'HTTP CASE SEO BETA', seoDescription: 'HTTP CASE DESCRIPTION BETA', customFields: { ...state.state.contentEntries![0].customFields, 'field-summary': 'HTTP-CASE-SUMMARY-BETA' } },
  ];
  const caseHeading = (id: string) => ({ type: 'Heading', props: { id, text: 'STATIC CASE', size: 28, mobileSize: 22, color: '#123456', align: 'left', style: 'sans', spacing: 0, bindings: { text: currentEntry('builtin:title') } } });
  const caseLink = (id: string) => ({ type: 'ActionButton', props: { id, text: 'Read case', href: '', kind: 'theme', align: 'left', bindings: { href: currentEntry('builtin:url') } } });
  const cardMeta = { id: 'http-card-meta', name: '案例卡片说明', updated: '', data: { root: { props: { showChrome: 'no' } }, content: [{ type: 'Text', props: { id: 'http-card-summary', text: '', size: 15, color: '#123456', align: 'left', maxWidth: 900, bindings: { text: currentEntry('field:field-summary') } } }] } };
  const cardTemplate = { id: 'http-case-card', name: '案例自由卡片', updated: '', data: { root: { props: { showChrome: 'no', bindingContext: { source: 'entry', modelId: entryModel.id, recordId: cases[0].id } } }, content: [{ type: 'Container', props: { id: 'http-case-card-layout', layout: 'column', columns: 1, mobileColumns: 1, gap: 12, padding: 18, inset: 18, background: '#f7f8fa', image: '', minHeight: 120, align: 'start', content: [caseHeading('http-card-title'), { type: 'SharedBlock', props: { id: 'http-card-meta-ref', blockId: cardMeta.id } }, caseLink('http-card-link')] } }] } };
  const loopNode = { type: 'ContentLoop', props: { id: 'http-case-loop', source: 'entry', modelId: entryModel.id, itemBlockId: cardTemplate.id, count: 12, columns: 3, mobileColumns: 1, gap: 24, padding: 32, title: 'HTTP CASES', emptyText: 'No cases' } };
  editorData = { ...state.state.editorData, [detailPage.id]: { root: { props: { showChrome: 'no', bindingContext: { source: 'entry', modelId: entryModel.id, recordId: cases[0].id } } }, content: [caseHeading('http-detail-case-title'), { type: 'SharedBlock', props: { id: 'http-detail-summary-ref', blockId: cardMeta.id } }, caseLink('http-detail-self-link')] }, [listingPage.id]: { root: { props: { showChrome: 'no' } }, content: [loopNode] } };
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: [...state.state.pages, detailPage, listingPage], editorData, contentEntries: cases, sharedBlocks: [...(state.state.sharedBlocks || []), cardMeta, cardTemplate] } });
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { contentEntries: cases.map(item => ({ ...item, slug: 'alpha' })) } }, 422);
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: [...state.state.pages, { ...listingPage, id: 'http-route-collision', slug: '/cases/alpha' }], editorData: { ...state.state.editorData, 'http-route-collision': editorData[listingPage.id] } } }, 422);
  const loopSelection = (extra: Record<string, unknown> = {}) => publication({ pageIds: [detailPage.id, listingPage.id], productIds: [], contentModelIds: [], contentEntryIds: cases.map(item => item.id), sharedBlockIds: [cardMeta.id, cardTemplate.id], includeTheme: false, includeSettings: false, ...extra });
  expectTrue((await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', loopSelection({ sharedBlockIds: [] }))).errors.length, '循环卡片依赖不可自动携带草稿');
  expectTrue((await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', loopSelection({ pageIds: [listingPage.id] }))).errors.length, '内置详情链接需要显式发布详情模板');
  assert.deepEqual((await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', loopSelection())).errors, []);
  state = await admin.api<Envelope>('/api/releases', 'POST', loopSelection({ title: 'HTTP 内容详情与循环 V1' }), 201); const loopRelease = state.releaseId!;
  const alpha = await anonymous.fetch('/cases/alpha'), beta = await anonymous.fetch('/cases/beta'); assert.equal(alpha.status, 200); assert.equal(beta.status, 200);
  const alphaHtml = await alpha.text(), betaHtml = await beta.text(); expectTrue(alphaHtml.includes('HTTP CASE SEO ALPHA')); expectTrue(betaHtml.includes('HTTP CASE SEO BETA')); expectTrue(betaHtml.includes('HTTP-CASE-BETA')); expectTrue(betaHtml.includes('HTTP-CASE-SUMMARY-BETA')); assert.equal(betaHtml.includes('>HTTP-CASE-ALPHA<'), false, '模板编辑样本不能固定真实记录');
  assert.equal((await anonymous.fetch('/cases/missing')).status, 404); assert.equal((await anonymous.fetch('/cases/:slug')).status, 404);
  const loopHtml = await (await anonymous.fetch('/case-list')).text(); assert.equal((loopHtml.match(/data-loop-record=/g) || []).length, 2); expectTrue(loopHtml.includes('href="/cases/alpha"')); expectTrue(loopHtml.includes('href="/cases/beta"')); expectTrue(loopHtml.includes('HTTP-CASE-SUMMARY-BETA'));
  const previewCase = await admin.fetch('/preview/cases/beta'); assert.equal(previewCase.status, 200); expectTrue((await previewCase.text()).includes('noindex'));
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { contentEntries: state.state.contentEntries!.map(item => item.id === cases[1].id ? { ...item, slug: 'gamma', title: 'HTTP-CASE-GAMMA-DRAFT' } : item) } });
  assert.equal((await anonymous.fetch('/cases/gamma')).status, 404); expectTrue((await (await anonymous.fetch('/cases/beta')).text()).includes('HTTP-CASE-BETA'));
  state = await admin.api<Envelope>('/api/releases', 'POST', loopSelection({ title: 'HTTP 只发布案例地址', pageIds: [], sharedBlockIds: [], contentEntryIds: [cases[1].id] }), 201);
  assert.equal((await anonymous.fetch('/cases/beta')).status, 404); assert.equal((await anonymous.fetch('/cases/gamma')).status, 200); expectTrue((await (await anonymous.fetch('/case-list')).text()).includes('href="/cases/gamma"'));
  const updatedCard = structuredClone(cardTemplate); updatedCard.data.content[0].props.content.push({ type: 'Text', props: { id: 'http-card-new-copy', text: 'HTTP-CARD-V2', size: 15, color: '#123456', align: 'left', maxWidth: 900 } } as unknown as typeof updatedCard.data.content[0]['props']['content'][number]);
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { sharedBlocks: state.state.sharedBlocks!.map(item => item.id === cardTemplate.id ? updatedCard : item) } });
  state = await admin.api<Envelope>('/api/releases', 'POST', loopSelection({ title: 'HTTP 只发布循环卡片', pageIds: [], contentEntryIds: [], sharedBlockIds: [cardTemplate.id] }), 201);
  assert.equal(((await (await anonymous.fetch('/case-list')).text()).match(/>HTTP-CARD-V2</g) || []).length, 2);
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/activate`, 'POST', { expectedActiveReleaseId: state.releaseId });
  assert.equal((await anonymous.fetch('/cases/beta')).status, 200); assert.equal((await anonymous.fetch('/cases/gamma')).status, 404); assert.equal((await (await anonymous.fetch('/case-list')).text()).includes('HTTP-CARD-V2'), false);
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [detailPage.id, listingPage.id], contentEntryIds: cases.map(item => item.id), sharedBlockIds: [cardMeta.id, cardTemplate.id] });
  assert.equal(state.state.contentEntries?.find(item => item.id === cases[1].id)?.slug, 'beta');
  milestones.push('独立内容详情路由/SEO、地址冲突、嵌套自由卡片、当前项隔离、详情链接、显式依赖、仅记录/仅卡片发布、回滚恢复通过');

  // S01：稳定目标从实际API保存并发布，产品短路径只在选择发布后改变公开网址。
  const stableProduct = state.state.products[0];
  const stablePage = { id: 'http-stable-links', title: 'Stable links', slug: '/stable-links', type: '普通页面', status: 'draft', updated: '' };
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: [...state.state.pages, stablePage], editorData: { ...state.state.editorData, [stablePage.id]: { root: { props: { showChrome: 'no' } }, content: [{ type: 'ActionButton', props: { id: 'http-stable-button', text: 'Stable product target', href: '', kind: 'theme', align: 'left', linkTarget: { kind: 'product', id: stableProduct.id } } }] } } } });
  const stableSelection = (pageIds: string[], productIds: string[]) => ({ expectedRevision: state.revision, baseReleaseId: state.activeReleaseId, pageIds, productIds, includeTheme: false, includeSettings: false });
  state = await admin.api<Envelope>('/api/releases', 'POST', stableSelection([stablePage.id], []), 201);
  const stableRelease = state.releaseId!;
  expectTrue((await (await anonymous.fetch('/stable-links')).text()).includes(`href="/products/${stableProduct.id}"`));
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { products: state.state.products.map(item => item.id === stableProduct.id ? { ...item, slug: 'stable-short-path' } : item) } });
  assert.equal((await anonymous.fetch('/products/stable-short-path')).status, 404);
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { products: state.state.products.filter(item => item.id !== stableProduct.id) } }, 422);
  state = await admin.api<Envelope>('/api/releases', 'POST', stableSelection([], [stableProduct.id]), 201);
  assert.equal((await anonymous.fetch('/products/stable-short-path')).status, 200);
  assert.equal((await anonymous.fetch(`/products/${stableProduct.id}`)).status, 404);
  expectTrue((await (await anonymous.fetch('/stable-links')).text()).includes('href="/products/stable-short-path"'));
  state = await admin.api<Envelope>(`/api/releases/${stableRelease}/activate`, 'POST', { expectedActiveReleaseId: state.releaseId });
  assert.equal((await anonymous.fetch(`/products/${stableProduct.id}`)).status, 200);
  // 恢复本脚本原来的活动版本，下面继续验证重启持久化。
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/activate`, 'POST', { expectedActiveReleaseId: state.activeReleaseId });
  milestones.push('稳定ID按钮、产品短路径草稿隔离、只发布产品联动链接、目标删除保护与回滚通过');
  const menuLayout = { header: { mode: 'default', blockId: '', menuId: 'http-menu' }, footer: { mode: 'default', blockId: '' }, menus: [{ id: 'http-menu', name: 'HTTP Menu', items: [{ id: 'http-home', label: 'HTTP Navigation Home', target: { kind: 'page', id: 'home' } }, { id: 'http-mail', label: 'HTTP Email', href: 'mailto:example@example.com' }] }] };
  const navData = { root: { props: { showChrome: 'yes' } }, content: [{ type: 'Navigation', props: { id: 'http-navigation-node', menuId: 'http-menu', label: 'HTTP Navigation' } }, { type: 'Breadcrumb', props: { id: 'http-breadcrumb', homeLabel: 'Home' } }] };
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { siteLayout: menuLayout, editorData: { ...state.state.editorData, [stablePage.id]: navData } } });
  const invalidMenu = await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', stableSelection([stablePage.id], []));
  expectTrue(invalidMenu.errors.some(value => value.includes('菜单')));
  state = await admin.api<Envelope>('/api/releases', 'POST', { ...stableSelection([stablePage.id], []), includeLayout: true }, 201);
  const navHtml = await (await anonymous.fetch('/stable-links')).text();
  expectTrue(navHtml.includes('HTTP Navigation Home')); expectTrue(navHtml.includes('mailto:example@example.com')); expectTrue(navHtml.includes('Breadcrumb'));
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/activate`, 'POST', { expectedActiveReleaseId: state.activeReleaseId });
  milestones.push('菜单显式布局发布、缺依赖预检、导航与面包屑真实SSR、历史菜单隔离通过');
  const taxonomy = { id: 'http-catalog', name: 'HTTP Catalog', source: 'product', terms: [{ id: 'http-term', label: 'Selected', slug: 'selected' }] };
  const queryProducts = Array.from({ length: 31 }, (_, index) => ({ id: `http-query-product-${index}`, name: `HTTP-PAGE-${index}`, sku: `HTTP-Q-${index}`, category: 'Legacy', status: 'draft', image: '', description: 'Query demonstration', material: '', sortOrder: index, termIds: index % 2 ? ['http-term'] : [] }));
  const queryPage = { id: 'http-query-page', title: 'Query page', slug: '/query-list', type: '普通页面', status: 'draft', updated: '' };
  const queryCard = { id: 'http-query-card', name: 'Query card', updated: '', data: { root: { props: {} }, content: [{ type: 'Heading', props: { id: 'http-query-title', text: '', bindings: { text: { source: 'product', mode: 'current', field: 'builtin:name' } } } }] } };
  const queryLoop = (id: string) => ({ type: 'ContentLoop', props: { id, source: 'product', itemBlockId: queryCard.id, count: 12, title: id, query: { paginate: true, controls: true, pageSize: 12, sort: 'builtin:sortOrder', filters: [{ field: 'builtin:name', op: 'contains', value: 'HTTP-PAGE-' }] } } });
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { taxonomies: [taxonomy] } }, 403);
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { settings: { ...state.state.settings, publicUrl: origin }, taxonomies: [taxonomy], products: [...state.state.products, ...queryProducts], pages: [...state.state.pages, queryPage], sharedBlocks: [...(state.state.sharedBlocks || []), queryCard], editorData: { ...state.state.editorData, [queryPage.id]: { root: { props: { showChrome: 'no' } }, content: [queryLoop('query-alpha'), queryLoop('query-beta')] } } } });
  const querySelection = (includeCatalog: boolean) => ({ ...stableSelection([queryPage.id], queryProducts.map(item => item.id)), sharedBlockIds: [queryCard.id], includeCatalog, includeSettings: true });
  expectTrue((await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', querySelection(false))).errors.some(error => error.includes('分类')));
  state = await admin.api<Envelope>('/api/releases', 'POST', querySelection(true), 201);
  const queryRelease = state.releaseId!;
  const queryHtml = await (await anonymous.fetch('/query-list?page_query-alpha=3&page_query-beta=2&page_unknown=777&search_unknown=ignored')).text();
  assert.equal((queryHtml.match(/data-loop-record=/g) || []).length, 19);
  expectTrue(queryHtml.includes('page_query-beta=2')); expectTrue(queryHtml.includes('HTTP-PAGE-30'));
  expectTrue(queryHtml.includes(`rel="canonical" href="${origin}/query-list?page_query-alpha=3&amp;page_query-beta=2"`));
  assert.doesNotMatch(queryHtml, /<meta name="robots" content="noindex[^"]*"/);
  const invalidQuery = await anonymous.fetch('/query-list?page_query-alpha=4');
  assert.equal(invalidQuery.status, 404);
  assert.doesNotMatch(await invalidQuery.text(), /rel="canonical"/);
  assert.equal((await anonymous.fetch('/query-list?search_query-alpha=no-match')).status, 200);
  const filtered = await (await anonymous.fetch('/query-list?term_query-alpha=http-term&page_query-alpha=2')).text();
  expectTrue(filtered.replace(/<!--.*?-->/g, '').includes('15 results'));
  expectTrue(filtered.includes(`rel="canonical" href="${origin}/query-list"`));
  assert.match(filtered, /<meta name="robots" content="noindex[^"]*"/);
  const previewQuery = await admin.fetch('/preview/query-list?page_query-alpha=2'); assert.equal(previewQuery.status, 200); expectTrue((await previewQuery.text()).includes('page_query-alpha'));
  await editor.api(`/api/releases/${queryRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [], includeCatalog: true }, 403);
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/activate`, 'POST', { expectedActiveReleaseId: state.activeReleaseId });
  milestones.push('分类权限与显式发布、31条SSR分页、双循环参数隔离、搜索/分类筛选、超页404与预览查询通过');
  const seoPage = { id: 'http-seo-page', title: 'SEO page', slug: '/seo-before', type: '普通页面', status: 'draft', updated: '', seoTitle: 'HTTP SEO TITLE', seoDescription: 'HTTP SEO DESCRIPTION', seoImage: upload.media.url };
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { settings: { ...state.state.settings, publicUrl: origin }, pages: [...state.state.pages, seoPage], editorData: { ...state.state.editorData, [seoPage.id]: { root: { props: { showChrome: 'no' } }, content: [{ type: 'Text', props: { id: 'http-seo-copy', text: 'SEO demonstration' } }] } } } });
  const seoSelection = (extra = {}) => ({ ...stableSelection([seoPage.id], []), includeSettings: true, ...extra });
  state = await admin.api<Envelope>('/api/releases', 'POST', seoSelection(), 201);
  const seoRelease = state.releaseId!;
  const seoHtml = await (await anonymous.fetch('/seo-before')).text();
  expectTrue(seoHtml.includes('HTTP SEO TITLE')); expectTrue(seoHtml.includes(`href="${origin}/seo-before"`)); expectTrue(seoHtml.includes('application/ld+json'));
  expectTrue((await (await anonymous.fetch('/sitemap.xml')).text()).includes(`${origin}/seo-before`));
  expectTrue((await (await anonymous.fetch('/robots.txt')).text()).includes('Disallow: /admin'));
  const nonLoopQuery = await (await anonymous.fetch('/seo-before?page_alpha=999&search_alpha=ignored&term_alpha=ignored')).text();
  expectTrue(nonLoopQuery.includes(`rel="canonical" href="${origin}/seo-before"`));
  assert.doesNotMatch(nonLoopQuery, /<meta name="robots" content="noindex[^"]*"/);
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: state.state.pages.map(page => page.id === seoPage.id ? { ...page, slug: '/seo-after', noindex: true } : page) } });
  const redirectCheck = await admin.api<{ errors: string[]; suggestedRedirects: { id: string; from: string; target: { kind: string; id: string }; status: number }[] }>('/api/releases/preview', 'POST', seoSelection());
  const suggestion = redirectCheck.suggestedRedirects.find(item => item.from === '/seo-before')!; expectTrue(suggestion);
  const redirects = [suggestion, { id: 'http-temporary', from: '/seo-temp', target: { kind: 'page', id: seoPage.id }, status: 302 }];
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { redirects } }, 403);
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { redirects } });
  assert.equal((await anonymous.fetch('/seo-before')).status, 200); assert.equal((await anonymous.fetch('/seo-after')).status, 404);
  state = await admin.api<Envelope>('/api/releases', 'POST', seoSelection({ includeRedirects: true }), 201);
  const redirectResponse = await anonymous.fetch('/seo-before?campaign=test'); assert.equal(redirectResponse.status, 301); assert.equal(new URL(redirectResponse.headers.get('location') || '', origin).href, `${origin}/seo-after?campaign=test`);
  assert.equal((await anonymous.fetch('/seo-temp')).status, 302); expectTrue(redirectResponse.headers.get('cache-control')?.includes('no-store'));
  const noindexHtml = await (await anonymous.fetch('/seo-after')).text(); expectTrue(noindexHtml.includes('noindex'));
  assert.equal((await (await anonymous.fetch('/sitemap.xml')).text()).includes('/seo-after'), false);
  state = await admin.api<Envelope>(`/api/releases/${seoRelease}/activate`, 'POST', { expectedActiveReleaseId: state.activeReleaseId });
  assert.equal((await anonymous.fetch('/seo-before')).status, 200); assert.equal((await anonymous.fetch('/seo-temp')).status, 404);
  state = await admin.api<Envelope>(`/api/releases/${seoRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [seoPage.id], includeRedirects: true });
  assert.equal(state.state.redirects?.length, 0);
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/activate`, 'POST', { expectedActiveReleaseId: state.activeReleaseId });
  milestones.push('普通页面SEO/canonical/分享图、sitemap/robots/noindex、显式跳转建议、真实301/302与立即回滚通过');




  // 新组件通过真实匿名站点验证；本地MP4为FFmpeg生成的一秒纯色测试素材。
  const videoBytes = readFileSync(join(root, 'tests/fixtures/short-video.mp4'));
  const videoForm = new FormData(); videoForm.set('file', new File([videoBytes], 'factory-demo.mp4', { type: 'video/mp4' })); videoForm.set('expectedRevision', String(state.revision));
  const videoUploadResponse = await editor.fetch('/api/media', { method: 'POST', body: videoForm }); assert.equal(videoUploadResponse.status, 201);
  const videoUpload = await videoUploadResponse.json() as Envelope & { media: { id: string; url: string; kind: string } }; state = videoUpload; assert.equal(videoUpload.media.kind, 'video');
  assert.equal((await anonymous.fetch(videoUpload.media.url, { headers: { Range: 'bytes=0-19' } })).status, 401);
  const presentationPage = { id: 'component-lab', title: '展示组件验收', slug: '/component-lab', status: 'draft' as const, type: '自定义页面', updated: '' };
  const visualNode = (type: string, props: Record<string, unknown>) => ({ type, props: { id: `visual-${type}`, ...props } });
  const presentationData = { root: { props: { title: 'Components', showChrome: 'no' } }, content: [
    visualNode('RichText', { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Structured document <script>alert(1)</script>' }] }] } }),
    visualNode('Gallery', { images: [{ id: 'photo', src: '/images/studio.jpg', alt: 'Demo studio' }], lightbox: true }),
    visualNode('Accordion', { items: [{ id: 'faq', title: 'Keyboard question', body: 'Readable answer' }] }),
    visualNode('Tabs', { items: [{ id: 'a', title: 'Overview', body: 'First panel' }, { id: 'b', title: 'Details', body: 'Second panel' }] }),
    visualNode('Video', { videoUrl: videoUpload.media.url, title: 'Local demo video', poster: '/images/studio.jpg' }),
    visualNode('Carousel', { images: [{ id: 'slide-a', src: '/images/interior.jpg', alt: 'Demo interior' }, { id: 'slide-b', src: '/images/chair.jpg', alt: 'Demo chair' }] }),
    visualNode('Icon', { icon: 'globe', label: 'Global' }), visualNode('Divider', { text: 'Details' }),
  ] };
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: [...state.state.pages, presentationPage], editorData: { ...state.state.editorData, [presentationPage.id]: presentationData } } });
  const presentationCheck = await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', publication({ pageIds: [presentationPage.id], productIds: [], includeTheme: false, includeSettings: false })); assert.deepEqual(presentationCheck.errors, []);
  state = await admin.api<Envelope>('/api/releases', 'POST', publication({ pageIds: [presentationPage.id], productIds: [], includeTheme: false, includeSettings: false }), 201);
  const presentationHtml = await (await anonymous.fetch('/component-lab')).text();
  assert.match(presentationHtml, /Structured document &lt;script&gt;/); assert.match(presentationHtml, /<details><summary>Keyboard question/); assert.match(presentationHtml, /popover="auto"/); assert.match(presentationHtml, /name="visual-Tabs-tabs"/); assert.match(presentationHtml, /Local demo video/);
  const publicVideoRange = await anonymous.fetch(videoUpload.media.url, { headers: { Range: 'bytes=0-19' } }); assert.equal(publicVideoRange.status, 206); assert.equal(publicVideoRange.headers.get('content-type'), 'video/mp4'); assert.equal(publicVideoRange.headers.get('content-range'), `bytes 0-19/${videoBytes.length}`); assert.deepEqual(Buffer.from(await publicVideoRange.arrayBuffer()), videoBytes.subarray(0, 20));
  assert.equal((await anonymous.fetch(videoUpload.media.url, { headers: { Range: 'bytes=99999999-' } })).status, 416);
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/activate`, 'POST', { expectedActiveReleaseId: state.activeReleaseId }); assert.equal((await anonymous.fetch('/component-lab')).status, 404);
  milestones.push('八展示组件生产SSR、富文本转义、本地视频鉴权/发布/206Range/416及版本回滚通过');

  // S06：只向隔离实例提交合成资料，通知固定为mock，验证实际生产worker而不外发邮件。
  const publicForm = { id: 'http-contact', name: 'HTTP contact', enabled: true, submitLabel: 'Send inquiry', successMessage: 'Your inquiry has been received.', fields: [
    { id: 'name', label: 'Visitor name', type: 'text', required: true, mapTo: 'name', maxLength: 100 },
    { id: 'email', label: 'Email address', type: 'email', required: true, mapTo: 'email' },
    { id: 'message', label: 'Requirements', type: 'textarea', required: true, mapTo: 'message', maxLength: 2000 },
    { id: 'confirm', label: 'Confirmation', type: 'checkbox', required: false },
  ] };
  const formPage = { id: 'http-inquiry-lab', title: 'Inquiry lab', slug: '/inquiry-lab', status: 'draft', type: '普通页面', updated: '' };
  await editor.api('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { forms: [publicForm] } }, 403);
  state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { forms: [publicForm], pages: [...state.state.pages, formPage], editorData: { ...state.state.editorData, [formPage.id]: { root: { props: { showChrome: 'no' } }, content: [{ type: 'Form', props: { id: 'http-form-node', formId: publicForm.id } }] } } } });
  const formSelection = publication({ pageIds: [formPage.id], productIds: [], includeTheme: false, includeSettings: false });
  expectTrue((await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', formSelection)).errors.some(error => error.includes('表单')));
  state = await admin.api<Envelope>('/api/releases', 'POST', { ...formSelection, includeForms: true }, 201);
  await viewer.api(`/api/releases/${state.releaseId}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [], includeForms: true }, 403);
  const formPath = `/api/public/forms/${publicForm.id}`;
  const wrongFormOrigin = await anonymous.fetch(`${formPath}/session`, { method: 'POST', headers: { Origin: 'https://invalid.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ sourcePath: formPage.slug }) }); assert.equal(wrongFormOrigin.status, 403);
  await anonymous.api(`${formPath}/session`, 'POST', { sourcePath: '/not-a-form' }, 404);
  const formSession = await anonymous.api<{ token: string; minDelayMs: number }>(`${formPath}/session`, 'POST', { sourcePath: formPage.slug });
  const submission = { token: formSession.token, answers: { name: 'HTTP anonymous visitor', email: 'http-visitor@example.invalid', message: '=synthetic test, no external mail', confirm: false }, honeypot: '' };
  const early = await anonymous.fetch(formPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission) }); assert.equal(early.status, 429); expectTrue(Number(early.headers.get('retry-after')) >= 1);
  await delay(formSession.minDelayMs);
  await anonymous.api(formPath, 'POST', { ...submission, honeypot: 'spam' }, 422);
  await anonymous.api(formPath, 'POST', { ...submission, recipient: 'attacker@example.invalid' }, 422);
  await anonymous.api(formPath, 'POST', { ...submission, answers: { ...submission.answers, email: 'bad-email' } }, 422);
  const receipt = await anonymous.api<{ received: boolean; message: string }>(formPath, 'POST', submission); assert.equal(receipt.received, true); assert.deepEqual(Object.keys(receipt).sort(), ['message', 'received']);
  assert.deepEqual(await anonymous.api(formPath, 'POST', submission), receipt);
  await anonymous.api(formPath, 'POST', { ...submission, answers: { ...submission.answers, message: 'changed' } }, 409);
  const receivedItems = await admin.api<{ items: (StudioState['inquiries'][number] & { revision: number })[] }>('/api/inquiries');
  const publicInquiries = receivedItems.items.filter(item => item.formId === publicForm.id); assert.equal(publicInquiries.length, 1);
  const publicInquiry = publicInquiries[0]; assert.equal(publicInquiry.sourcePath, formPage.slug); assert.equal(publicInquiry.answers?.find(answer => answer.id === 'confirm')?.value, false);
  type Jobs = { jobs: { id: string; status: string; attempts: number }[]; configuration: { mode: string } };
  let notification = await viewer.api<Jobs>(`/api/notifications?inquiryId=${publicInquiry.id}`); assert.equal(notification.jobs.length, 1); assert.equal(notification.configuration.mode, 'mock');
  await viewer.api(`/api/notifications/${notification.jobs[0].id}/retry`, 'POST', {}, 403);
  for (let attempt = 0; attempt < 30 && notification.jobs[0].status !== 'mock_sent'; attempt++) { await delay(250); notification = await admin.api<Jobs>(`/api/notifications?inquiryId=${publicInquiry.id}`); }
  assert.equal(notification.jobs[0].status, 'mock_sent', '真实生产instrumentation应运行mock通知worker'); assert.equal(notification.jobs[0].attempts, 1);
  await viewer.api('/api/inquiries/export', 'POST', {}, 403);
  const csv = await editor.fetch('/api/inquiries/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type') || '', /text\/csv/); expectTrue((await csv.text()).includes("'=synthetic test"));
  await editor.api(`/api/inquiries/${publicInquiry.id}`, 'PATCH', { expectedRevision: publicInquiry.revision, notes: 'HTTP verification note' });
  await editor.api(`/api/inquiries/${publicInquiry.id}`, 'PATCH', { expectedRevision: publicInquiry.revision, notes: 'stale note' }, 409);
  await viewer.api('/api/inquiries/policy', 'GET', undefined, 403); assert.equal((await admin.api<{ retentionDays: number }>('/api/inquiries/policy')).retentionDays, 0);
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/activate`, 'POST', { expectedActiveReleaseId: state.activeReleaseId });
  await anonymous.api(`${formPath}/session`, 'POST', { sourcePath: formPage.slug }, 404);
  assert.deepEqual(await anonymous.api(formPath, 'POST', submission), receipt);
  assert.equal(state.state.inquiries.find(item => item.id === publicInquiry.id)?.notes, 'HTTP verification note');
  milestones.push('公开表单显式发布、来源/时间/蜜罐/字段校验、幂等收件、mock生产worker、导出权限/CSV、备注冲突及回滚保留通过');

  // S07：PDF解析worker、图片实际尺寸/衍生流、只读容量与原子内容导入走真实HTTP。
  const largeImage = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#456789' } }).png().toBuffer();
  const uploadImageForm = new FormData(); uploadImageForm.set('file', new File([largeImage], 'responsive.png', { type: 'image/png' })); uploadImageForm.set('expectedRevision', String(state.revision));
  const largeUploaded = await editor.fetch('/api/media', { method: 'POST', body: uploadImageForm }); assert.equal(largeUploaded.status, 201);
  const largeResult = await largeUploaded.json() as Envelope & { media: { id: string; url: string; width: number; height: number; variants: unknown[] } }; state = largeResult; assert.equal(largeResult.media.width, 1280); assert.equal(largeResult.media.height, 720); assert.equal(largeResult.media.variants.length, 2);
  assert.equal((await anonymous.fetch(`${largeResult.media.url}?width=768`)).status, 401);
  const pdf = await PDFDocument.create(); pdf.addPage([300, 200]); const pdfBytes = await pdf.save();
  const uploadPdfForm = new FormData(); uploadPdfForm.set('file', new File([new Uint8Array(pdfBytes)], 'catalog.pdf', { type: 'application/pdf' })); uploadPdfForm.set('expectedRevision', String(state.revision));
  const pdfUploaded = await editor.fetch('/api/media', { method: 'POST', body: uploadPdfForm }); assert.equal(pdfUploaded.status, 201, '生产PDF worker应能解析真实文件');
  const pdfResult = await pdfUploaded.json() as Envelope & { media: { id: string; url: string; pages: number; kind: string } }; state = pdfResult; assert.equal(pdfResult.media.pages, 1); assert.equal(pdfResult.media.kind, 'document');
  const invalidPdf = new FormData(); invalidPdf.set('file', new File(['<script>invalid</script>'], 'bad.pdf', { type: 'application/pdf' })); invalidPdf.set('expectedRevision', String(state.revision)); assert.equal((await editor.fetch('/api/media', { method: 'POST', body: invalidPdf })).status, 422);
  const mediaPage = { id: 'http-media-lab', title: 'Media lab', slug: '/media-lab', status: 'draft', type: '普通页面', updated: '' };
  state = await editor.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: [...state.state.pages, mediaPage], editorData: { ...state.state.editorData, [mediaPage.id]: { root: { props: { showChrome: 'no' } }, content: [{ type: 'Image', props: { id: 'responsive-image', src: largeResult.media.url, alt: 'Responsive sample', height: 360, fit: 'cover', radius: 0 } }, { type: 'Download', props: { id: 'download-catalog', fileUrl: pdfResult.media.url, text: 'Download test catalog' } }] } } } });
  state = await admin.api<Envelope>('/api/releases', 'POST', publication({ pageIds: [mediaPage.id], productIds: [], includeTheme: false, includeSettings: false }), 201); const mediaRelease = state.releaseId!;
  const mediaHtml = await (await anonymous.fetch('/media-lab')).text(); expectTrue(mediaHtml.includes(`${largeResult.media.url}?width=320 320w`)); assert.match(mediaHtml, /width="1280" height="720"/); expectTrue(mediaHtml.includes(pdfResult.media.url));
  const derivative = await anonymous.fetch(`${largeResult.media.url}?width=768`); assert.equal(derivative.status, 200); assert.match(derivative.headers.get('cache-control') || '', /immutable/); assert.equal((await sharp(Buffer.from(await derivative.arrayBuffer())).metadata()).width, 768);
  assert.equal((await anonymous.fetch(`${largeResult.media.url}?width=999`)).status, 422);
  const catalogDownload = await anonymous.fetch(pdfResult.media.url); assert.equal(catalogDownload.status, 200); assert.equal(catalogDownload.headers.get('content-type'), 'application/pdf'); assert.match(catalogDownload.headers.get('content-disposition') || '', /^attachment;/); expectTrue(catalogDownload.headers.get('content-security-policy')?.includes('sandbox'));
  expectTrue((await viewer.api<{ draft: unknown[]; historical: unknown[] }>(`/api/media/${pdfResult.media.id}/usage`)).historical.length);
  const inventory = await viewer.api<{ physicalBytes: number; derivativeBytes: number }>('/api/media'); expectTrue(inventory.physicalBytes > inventory.derivativeBytes && inventory.derivativeBytes > 0);
  await viewer.api('/api/media/cleanup-plan', 'GET', undefined, 403); assert.equal((await admin.api<{ readOnly: boolean }>('/api/media/cleanup-plan')).readOnly, true);
  await viewer.api('/api/media/batch', 'POST', { expectedRevision: state.revision, ids: [largeResult.media.id], action: 'move', folder: 'Forbidden' }, 403);
  await editor.api('/api/media/batch', 'POST', { expectedRevision: state.revision, ids: [largeResult.media.id, pdfResult.media.id], action: 'remove' }, 422);
  let importSpec = { expectedRevision: state.revision, format: 'csv', target: 'product', content: 'name,sku\nHTTP imported item,HTTP-IMPORT-1\nHTTP second item,HTTP-IMPORT-2\n', mapping: { name: 'builtin:name', sku: 'builtin:sku' } };
  await viewer.api('/api/content-import/preview', 'POST', importSpec, 403);
  const importPreview = await editor.api<{ errors: unknown[]; confirmation: string }>('/api/content-import/preview', 'POST', importSpec); assert.deepEqual(importPreview.errors, []); assert.equal((await admin.api<Envelope>('/api/studio')).revision, state.revision);
  state = await editor.api<Envelope>('/api/media/batch', 'POST', { expectedRevision: state.revision, ids: [largeResult.media.id, pdfResult.media.id], action: 'move', folder: 'HTTP Catalog' });
  await editor.api('/api/content-import/commit', 'POST', { ...importSpec, confirmation: importPreview.confirmation }, 409);
  importSpec = { ...importSpec, expectedRevision: state.revision }; const importChecked = await editor.api<{ errors: unknown[]; confirmation: string }>('/api/content-import/preview', 'POST', importSpec);
  state = await editor.api<Envelope>('/api/content-import/commit', 'POST', { ...importSpec, confirmation: importChecked.confirmation }); assert.equal(state.state.products.filter(p => p.sku.startsWith('HTTP-IMPORT-') && p.status === 'draft').length, 2);
  const duplicateImport = await editor.api<{ errors: unknown[] }>('/api/content-import/preview', 'POST', { ...importSpec, expectedRevision: state.revision }); expectTrue(duplicateImport.errors.length);
  const importedItem = state.state.products.find(p => p.sku === 'HTTP-IMPORT-1')!; assert.equal((await anonymous.fetch(`/products/${importedItem.id}`)).status, 404);
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/activate`, 'POST', { expectedActiveReleaseId: state.activeReleaseId });
  assert.equal((await anonymous.fetch(pdfResult.media.url)).status, 200); assert.equal((await anonymous.fetch(`${largeResult.media.url}?width=320`)).status, 200);
  state = await admin.api<Envelope>(`/api/releases/${mediaRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [mediaPage.id] }); expectTrue(state.state.media.some(m => m.id === pdfResult.media.id));
  milestones.push('PDF生产解析worker/附件下载、图片固有尺寸/多尺寸/历史访问、素材批量引用与只读容量、导入映射/权限/409/原子新增/重复拒绝/不自动发布通过');

  // S08页面模板子批：真实角色保护、独立布局副本与专用私有预览；整站包另行验收。
  const aboutBeforeTemplate = structuredClone(state.state.editorData.about);
  const templateInput = { expectedRevision: state.revision, pageId: 'about', templateId: 'http-page-template', name: 'HTTP reusable page', description: 'Synthetic page layout' };
  await editor.api('/api/page-templates/from-page', 'POST', templateInput, 403);
  state = await admin.api<Envelope>('/api/page-templates/from-page', 'POST', templateInput, 201);
  assert.equal(state.state.pageTemplates?.length, 1); assert.deepEqual(state.state.editorData.about, aboutBeforeTemplate);
  await viewer.api('/api/page-templates/apply', 'POST', { expectedRevision: state.revision, templateId: templateInput.templateId, newPageId: 'http-template-copy', title: 'Copy', slug: '/template-copy' }, 403);
  state = await editor.api<Envelope>('/api/page-templates/apply', 'POST', { expectedRevision: state.revision, templateId: templateInput.templateId, newPageId: 'http-template-copy', title: 'Independent template copy', slug: '/template-copy' });
  assert.deepEqual(state.state.editorData.about, aboutBeforeTemplate); expectTrue(state.state.pages.some(p => p.id === 'http-template-copy' && p.status === 'draft')); assert.equal((await anonymous.fetch('/template-copy')).status, 404);
  await editor.api('/api/page-templates/apply', 'POST', { expectedRevision: state.revision, templateId: templateInput.templateId, newPageId: 'http-forbidden-code-copy', title: 'Forbidden code copy', slug: '/forbidden-code-copy', includeCode: true }, 403);
  state = await admin.api<Envelope>('/api/page-templates/from-page', 'POST', { expectedRevision: state.revision, pageId: 'home', templateId: 'http-code-template', name: 'HTTP code template' }, 201);
  state = await admin.api<Envelope>('/api/page-templates/apply', 'POST', { expectedRevision: state.revision, templateId: 'http-code-template', newPageId: 'http-code-copy', title: 'Code copy', slug: '/code-copy', includeCode: true });
  assert.equal(state.state.customCode!.pages['http-code-copy'].jsEnabled, false); assert.deepEqual(state.state.customCode!.global, code.global); assert.deepEqual(state.state.customCode!.pages.home, code.pages.home);
  const assetPreview = await viewer.fetch(`/preview/~template/${templateInput.templateId}`); assert.equal(assetPreview.status, 200); assert.match(assetPreview.headers.get('x-robots-tag') || '', /noindex/);
  assert.notEqual((await anonymous.fetch(`/preview/~template/${templateInput.templateId}`)).status, 200);
  await editor.api(`/api/releases/${loopRelease}/restore-draft`, 'POST', { expectedRevision: state.revision, pageIds: [], includeTemplates: true }, 403);
  const librarySelection = publication({ pageIds: [], productIds: [], includeTheme: false, includeSettings: false, includeTemplates: true });
  const libraryCheck = await admin.api<{ errors: string[] }>('/api/releases/preview', 'POST', librarySelection); assert.deepEqual(libraryCheck.errors, []);
  state = await admin.api<Envelope>('/api/releases', 'POST', librarySelection, 201); assert.equal(state.state.releases.find(r => r.id === state.releaseId)!.snapshot!.pageTemplates instanceof Array, true);
  assert.equal((await anonymous.fetch(`/api/site-code/${state.releaseId}/http-code-template/js`)).status, 404);
  state = await admin.api<Envelope>(`/api/releases/${loopRelease}/activate`, 'POST', { expectedActiveReleaseId: state.activeReleaseId });
  milestones.push('页面模板管理员捕获/编辑员复制/只读拒写、源页面独立、专用预览鉴权与noindex、模板资源独立发布/回退通过');

  // 整站分发只能由管理员操作；从真实生产API导出/预检/导入，未选私有草稿不进入包。
  const exportSpec = { name: 'HTTP public package', description: 'Synthetic export', license: 'QA only. No redistribution rights asserted for demonstration photography.' };
  await editor.api('/api/site-packages/export', 'POST', exportSpec, 403); await viewer.api('/api/site-packages/export', 'POST', exportSpec, 403);
  const exported = await admin.api<{format:string;snapshot:SiteSnapshot;files:{path:string}[]}>('/api/site-packages/export', 'POST', exportSpec);
  assert.equal(exported.format,'form-studio-site');assert.equal(exported.snapshot.pages.some(p=>p.id==='http-template-copy'),false);assert.equal('releaseId' in exported.snapshot,false);assert.equal('inquiries' in exported.snapshot,false);
  await viewer.api('/api/site-packages/starters/services','GET',undefined,403);
  const starter = await admin.api('/api/site-packages/starters/services');
  assert.equal((await viewer.fetch('/preview/~starter/services')).status,200);assert.notEqual((await anonymous.fetch('/preview/~starter/services')).status,200);
  // 案例子页与详情同样鉴权，链接不能误跳到当前客户草稿；陌生路径保持404。
  for(const path of ['/preview/~starter/services/about','/preview/~starter/services/services/example-1','/preview/~starter/manufacturing/products/sample-1']){
    const response=await viewer.fetch(path);assert.equal(response.status,200);const html=await response.text();assert.match(html,/noindex/);assert.match(html,/href="\/preview\/~starter\/(?:services|manufacturing)\/contact"/);assert.notEqual((await anonymous.fetch(path)).status,200);
  }
  assert.equal((await viewer.fetch('/preview/~starter/services/customer-only-page')).status,404);assert.equal((await viewer.fetch('/preview/~starter/unknown')).status,404);
  const packageInput = {package:starter,options:{mode:'merge',prefix:'http-services',skuPrefix:'',enableJs:false},expectedRevision:state.revision};
  await editor.api('/api/site-packages/preview','POST',packageInput,403);await viewer.api('/api/site-packages/commit','POST',packageInput,403);
  const packageCheck = await admin.api<{confirmation:string;counts:{pages:number}}>('/api/site-packages/preview','POST',packageInput);assert.equal(packageCheck.counts.pages,STARTER_KITS.find(kit=>kit.id==='services')!.pageCount);
  await admin.api('/api/site-packages/commit','POST',{...packageInput,options:{...packageInput.options,prefix:'tampered'},confirmation:packageCheck.confirmation},409);
  await admin.api('/api/site-packages/preview','POST',{...packageInput,options:{...packageInput.options,mode:'fresh'}},422);
  const countBeforeImport=state.state.inquiries.length;
  state=await admin.api<Envelope>('/api/site-packages/commit','POST',{...packageInput,confirmation:packageCheck.confirmation});assert.equal(state.activeReleaseId,loopRelease);assert.equal(state.state.inquiries.length,countBeforeImport);expectTrue(state.state.pages.some(p=>p.slug==='/http-services'));assert.equal((await anonymous.fetch('/http-services')).status,404);assert.equal((await admin.fetch('/preview/http-services')).status,200);
  milestones.push('整站公开包导出权限/排除私有草稿与运行数据、真实starter预检/来源选项签名/合并草稿/私有预览/公开隔离通过');

  // 审计是管理员运行数据；预检不产生修改事件，失败状态不记录私人正文。
  await editor.api('/api/audit','GET',undefined,403);await viewer.api('/api/audit','GET',undefined,403);await anonymous.api('/api/audit','GET',undefined,401);
  type AuditEnvelope={items:{id:number;action:string;result:string;details:Record<string,unknown>}[];nextCursor:number|null};
  const auditMembers=await admin.api<{members:{id:string;role:string}[]}>('/api/members'),auditMember=auditMembers.members.find(m=>m.role==='viewer')!;
  await admin.api(`/api/members/${auditMember.id}`,'PATCH',{role:'editor'});await viewer.api('/api/studio','GET',undefined,401);await admin.api(`/api/members/${auditMember.id}`,'PATCH',{role:'viewer'});await viewer.api('/api/auth/sign-in/email','POST',{email:'http-viewer@example.com',password});
  const audit=await admin.api<AuditEnvelope>('/api/audit?limit=100');expectTrue(audit.items.some(i=>i.action==='package.import'));expectTrue(audit.items.some(i=>i.action==='release.publish'));expectTrue((await admin.api<AuditEnvelope>('/api/audit?action=member.update&limit=5')).items.length);expectTrue(audit.items.some(i=>i.result==='failure'));expectTrue(audit.items.every(i=>!['password','notes','answers','customCode'].some(key=>Object.hasOwn(i.details,key))));
  const auditFirst=await admin.api<AuditEnvelope>('/api/audit?limit=2');if(auditFirst.nextCursor){const auditNext=await admin.api<AuditEnvelope>(`/api/audit?limit=2&before=${auditFirst.nextCursor}`);expectTrue(auditNext.items.every(i=>i.id<auditFirst.nextCursor!));}
  const restorePreviewInput={expectedRevision:state.revision,pageIds:['about'],includeTemplates:true};
  await editor.api(`/api/releases/${loopRelease}/restore-preview`,'POST',restorePreviewInput,403);
  const restorePlan=await admin.api<{expectedRevision:number;errors:string[]}>(`/api/releases/${loopRelease}/restore-preview`,'POST',restorePreviewInput);assert.deepEqual(restorePlan.errors,[]);assert.equal(restorePlan.expectedRevision,state.revision);assert.equal((await admin.api<Envelope>('/api/studio')).revision,state.revision);
  const publicationPlan=await admin.api<{expectedRevision:number;baseReleaseId:string|null;diagnostics:{changes:unknown[];pendingDraftCount:number}}>('/api/releases/preview','POST',publication({pageIds:[],productIds:[],includeTemplates:true,includeTheme:false,includeSettings:false}));assert.equal(publicationPlan.expectedRevision,state.revision);assert.equal(publicationPlan.baseReleaseId,loopRelease);expectTrue(Array.isArray(publicationPlan.diagnostics.changes));expectTrue(publicationPlan.diagnostics.pendingDraftCount>0);
  const auditCountBefore=(await admin.api<AuditEnvelope>('/api/audit?limit=1')).items[0].id;await admin.api(`/api/releases/${loopRelease}/restore-preview`,'POST',restorePreviewInput);assert.equal((await admin.api<AuditEnvelope>('/api/audit?limit=1')).items[0].id,auditCountBefore);
  milestones.push('发布分组差异与精确预检版本、恢复预检无写入、审计管理员权限/失败记录/游标分页/运行隔离通过');

  state=await runS11Http({admin,editor,viewer,anonymous},state);
  milestones.push('S11关系权限/预览/强引用/分页404/显式条件资源与关系发布隔离/回退/恢复通过');
  state=await runS12Http({admin,editor,viewer,anonymous},state);
  milestones.push('S12两语言关系/双条件布局/草稿隔离/SEO与分页/实际条件表单/语言询盘/多语言包与回退恢复通过');
  state=await runS13Http({admin,editor,viewer,anonymous},state);
  milestones.push('S13扩展权限/页面与循环卡片/v1兼容/模板预览/受控定位/引用清单/未知类型与版本保护通过');
  state=await runDiscoveryHttp({admin,editor,viewer,anonymous},state);
  milestones.push('AI可见性权限/robots公开资源/SSR企业事实与H1/草稿隔离/目录/观测排除/资料预设通过');
  await runLeadHttp({admin,editor,viewer,anonymous});
  state=await admin.api<Envelope>('/api/studio');
  milestones.push('询盘来源扩展兼容、轻量负责人权限、原子跟进/历史按需加载/过期冲突/不外发/导出与公开隔离通过');
  state=await runAiBuilderHttp({admin,editor,viewer,anonymous},state,{dataDirectory:env.FORM_STUDIO_DATA_DIR!,password});
  milestones.push('用户自配AI/密钥加密与角色来源保护、本机模型规划/三方向只读预览/创建者隔离/草稿幂等应用/普通可拖拽节点/原资料保留/发布检查与到期冲突通过');
  state=await runAiSourceHttp({admin,editor,viewer,anonymous},state,{dataDirectory:env.FORM_STUDIO_DATA_DIR!,password});
  milestones.push('真实PDF/XLSX私有上传/隐藏资料排除/源页与产品审核/创建者权限/草稿原子导入与稳定回执/所选产品优先建站/本机AI整理引用/删除级联与分发隔离通过');
  state=await runAiPageEditHttp({admin,editor,viewer,anonymous},state,{dataDirectory:env.FORM_STUDIO_DATA_DIR!,password});
  state=await runAiSiteDesignHttp({admin,editor,viewer,anonymous},state);
  state=await runAiDetailDesignHttp({admin,editor,viewer,anonymous},state);
  milestones.push('产品与案例详情模板原生AI/样本真实匹配/冻结HTML预览/本人确认采用与安全撤销/权限来源隔离通过');
  state=await runExternalAiHttp({admin,editor,viewer,origin,milestones});
  state=await runAiSiteDesignSelectionHttp({admin,editor,viewer,anonymous,origin,milestones},state);
  state=await runExternalAiContentHttp({admin,editor,viewer,origin,milestones,dataDirectory:env.FORM_STUDIO_DATA_DIR!,password});
  milestones.push('整站AI设计实际路由/跨页候选与续调/私有真实预览/原子采用撤销/角色来源及自配模型通过');
  milestones.push('AI局部修改/锁定与范围白名单/真实前后私有预览/确认草稿/事务幂等/七天安全撤销/人工修改409保护/角色与owner/分发隔离通过');
  state=await runSeoSourcesHttp({admin,editor,viewer,anonymous},state,{dataDirectory:env.FORM_STUDIO_DATA_DIR!,password,mock:seoSourcesMock});
  milestones.push('用户自配Google只读OAuth/PKCE/单次state/搜索数据PT与覆盖标识、DataForSEO费用确认/真实口径及CSV/owner与加密分发隔离通过');
  state=await runSeoProposalsHttp({admin,editor,viewer,anonymous},state,{dataDirectory:env.FORM_STUDIO_DATA_DIR!,password});
  milestones.push('SEO确定性诊断/标题描述人工或用户AI建议/真实来源行证据/前后HTML与搜索示意/确认事务/安全撤销与人工冲突保护通过');
  state=await runAiBuildResumeHttp({admin,editor,viewer,anonymous},state,{dataDirectory:env.FORM_STUDIO_DATA_DIR!,password});
  milestones.push('本人AI建站记录摘要/只读恢复/未过期父方案/真实revision/角色与owner隔离/恢复不重放付费和网站写入通过');
  state=await runAiWritingHttp({admin,editor,viewer,anonymous},state,{dataDirectory:env.FORM_STUDIO_DATA_DIR!});
  milestones.push('用户自配AI写作资料/未保存产品与结构化文章建议/原生保存字段回执/后改保护和撤销/真实角色来源/私有只读与失败不重试通过');
  state=await runAccountRecoveryHttp({
    admin,anonymous,origin,dataDirectory:env.FORM_STUDIO_DATA_DIR!,
    signIn: (email, password) => new Client().fetch('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    }),
  },state);
  milestones.push('恢复统一回执/真实after与原生token一次消费/旧密码及会话失效/同源与私有保护通过');
  state=await runMailSettingsHttp({admin,editor,viewer,anonymous},state);
  milestones.push('后台邮件私有配置/加密口令留空保留与换源保护/原生权限来源/合成测试与限流/即时禁用/草稿发布隔离通过');
  state=await runAiDesignGuidanceHttp({admin,editor,viewer,anonymous,origin},state);
  milestones.push('私有AI设计约定明确保存/版本冲突/旧连接不扩权/显式MCP读取及原生候选/无模型调用与草稿公开隔离通过');
  await stopServer(); await startServer(env);
  const reopened = await admin.api<Envelope>('/api/studio'); assert.equal(reopened.activeReleaseId, state.activeReleaseId); assert.equal(reopened.revision, state.revision);
  assert.deepEqual(reopened.state.products, state.state.products); assert.deepEqual(reopened.state.media, state.state.media); assert.deepEqual(reopened.state.forms, state.state.forms); assert.deepEqual(reopened.state.pageTemplates, state.state.pageTemplates); assert.deepEqual(reopened.state.redirects, state.state.redirects); assert.deepEqual(reopened.state.taxonomies, state.state.taxonomies); assert.deepEqual(reopened.state.editorData, state.state.editorData); assert.deepEqual(reopened.state.sharedBlocks, state.state.sharedBlocks); assert.deepEqual(reopened.state.customCode, state.state.customCode); assert.deepEqual(reopened.state.contentModels, state.state.contentModels); assert.deepEqual(reopened.state.contentEntries, state.state.contentEntries);
  const afterRestartMedia = await anonymous.fetch(upload.media.url); assert.equal(afterRestartMedia.status, 200);
  assert.equal(reopened.state.inquiries.filter(item => item.formId === publicForm.id).length, 1);
  assert.equal((await admin.api<Jobs>(`/api/notifications?inquiryId=${publicInquiry.id}`)).jobs[0].status, 'mock_sent');
  milestones.push('独立生产进程重启后，登录会话、草稿、发布指针与媒体均保留');
  console.log(JSON.stringify({ passed: true, checks: milestones, isolated: true, origin }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : 'HTTP 集成测试失败'); process.exitCode = 1; }).finally(async () => {
  await stopServer();
  if (seoSourcesMock) await seoSourcesMock.close();
  // 默认真实 data 目录绝不参与测试；清理仅允许本脚本创建的独立临时目录。
  if (directory && resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-http-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
