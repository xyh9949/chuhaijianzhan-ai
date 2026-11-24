// 只创建带随机前缀的本地测试容器/卷；凭据仅在内存和私有容器配置卷，绝不展开docker inspect。
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {createServer: createPortProbe} = require('node:net');
const protocol = require('../src/lib/protocol.json');
const image = process.env.DEPLOY_TEST_IMAGE || 'form-studio:s10-qa';
const prefix = `studio-delivery-${randomBytes(4).toString('hex')}`;
const resources = { containers: [], volumes: [] }, milestones = [];
// 与本轮案例目录一致的验收夹具；制造业含产品和工程案例两套模型，另两套各八页。
const showcaseCases = [{ kind: 'manufacturing', pages: 10 }, { kind: 'services', pages: 8 }, { kind: 'portfolio', pages: 8 }];
let completed=false;
let operationCount=0;
const delay = ms => new Promise(r => setTimeout(r, ms));
/** 只选当前可用的随机本机端口，不能与正式3200或别的项目的固定端口混用。 */
async function freePort(){for(let attempt=0;attempt<8;attempt++){const probe=createPortProbe();await new Promise((done,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',done);});const port=probe.address().port;await new Promise(done=>probe.close(done));if(port!==3200&&port>=1024)return port;}throw Error('未能分配隔离部署端口');}
function milestone(message){milestones.push(message);console.log(JSON.stringify({step:milestones.length,completed:message}));}
function docker(args, env = {}) {
    // 冷启动原生依赖可能较慢；所有短命容器也要可追踪，超时后能精确清理。
    if(args[0]==='run'&&!args.includes('--name')){const name=`${prefix}-operation-${++operationCount}`;resources.containers.push(name);args=[args[0],'--name',name,'--label','form-studio-test=delivery',...args.slice(1)];}
    const r = spawnSync('docker', args, { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
    if (r.status !== 0)throw Error(`Docker操作失败：${args[0]}（${r.error?.code||r.status}）`);
    return r.stdout.trim();
}
function volume(suffix) { const name = `${prefix}-${suffix}`; docker(['volume', 'create', '--label', 'form-studio-test=delivery', name]); resources.volumes.push(name); return name; }
const mount = (source, target, readOnly = false, subdir) => ['--mount', `type=volume,source=${source},target=${target}${readOnly ? ',readonly' : ''}${subdir ? `,volume-subpath=${subdir}` : ''}`];
function instance(kind, port) { return { kind, port, origin: `http://127.0.0.1:${port}`, name: `${prefix}-${kind}`, data: volume(`${kind}-data`), config: volume(`${kind}-config`), backups: volume(`${kind}-backups`), email: `${kind}@delivery.example.invalid`, password: randomBytes(24).toString('base64url') }; }
function mounts(i, readOnly = false) { return [...mount(i.data, '/data', false, i.subdir), ...mount(i.config, '/config', readOnly), ...mount(i.backups, '/backups')]; }
function initialize(i, selectedImage = image, migrateOnly = false) { return docker(['run', '--rm', ...mounts(i), '--env', 'BETTER_AUTH_URL', '--env', 'AUTH_SETUP_EMAIL', '--env', 'AUTH_SETUP_PASSWORD', selectedImage, 'flock', '--nonblock', '/data/.instance.lock', 'node', '--import', 'tsx', 'scripts/setup.ts', '--setup-env-file', '/config/instance.env', ...(migrateOnly ? ['--migrate-only'] : [])], { BETTER_AUTH_URL: i.origin, AUTH_SETUP_EMAIL: i.email, AUTH_SETUP_PASSWORD: i.password }); }
async function start(i, selectedImage = image, old = false) { resources.containers.push(i.name); docker(['run', '--detach', '--name', i.name, '--label', 'form-studio-test=delivery', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--tmpfs', '/tmp:size=128m,mode=1777', '--publish', `127.0.0.1:${i.port}:3200`, ...mounts(i, true), '--env', 'FORM_STUDIO_NOTIFY_TRANSPORT=mock', selectedImage, ...(old ? ['node', '--env-file=/config/instance.env', 'node_modules/next/dist/bin/next', 'start', '--hostname', '0.0.0.0', '--port', '3200'] : [])]); for (let n = 0; n < 120; n++) {
    try {
        const response = await fetch(i.origin + (old ? '/api/auth/get-session' : '/api/health'), { signal: AbortSignal.timeout(1000) });
        if (response.ok)
            return;
    }
    catch { }
    await delay(500);
} throw Error(`实例未就绪：${i.kind}`); }
function stop(i) { docker(['stop', '--time', '15', i.name]); docker(['rm', i.name]); resources.containers = resources.containers.filter(n => n !== i.name); }
class Client {
    constructor(i, headers = {}) { this.i = i; this.headers = headers; this.cookie = ''; }
    async request(url, options = {}) {
        const r = await fetch(this.i.origin + url, { ...options, redirect: 'manual', headers: { ...this.headers, Origin: this.i.origin, Cookie: this.cookie, ...options.headers } });
        // 表单防重cookie与登录cookie并存，新增一枚不能覆盖整份cookie jar。
        const jar=new Map(this.cookie.split('; ').filter(Boolean).map(pair=>{const index=pair.indexOf('=');return [pair.slice(0,index),pair.slice(index+1)];}));
        for(const header of r.headers.getSetCookie()){const pair=header.split(';',1)[0],index=pair.indexOf('='),name=pair.slice(0,index),value=pair.slice(index+1);if(value)jar.set(name,value);else jar.delete(name);}
        this.cookie=[...jar].map(([name,value])=>`${name}=${value}`).join('; ');
        return r;
    }
    async api(url, method = 'GET', body, status = 200) { const response = await this.request(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); assert.equal(response.status, status, `${method} ${url}`); return response.json(); }
    async login() { await this.api('/api/auth/sign-in/email', 'POST', { email: this.i.email, password: this.i.password }); }
}
async function starter(client, kind) { const pkg = await client.api(`/api/site-packages/starters/${kind}`), env = await client.api('/api/studio'), options = { mode: 'fresh', prefix: kind, skuPrefix: '', enableJs: false }, input = { package: pkg, options, expectedRevision: env.revision }; const preview = await client.api('/api/site-packages/preview', 'POST', input); return client.api('/api/site-packages/commit', 'POST', { ...input, confirmation: preview.confirmation }); }
const selection = env => ({ expectedRevision: env.revision, baseReleaseId: env.activeReleaseId, title: 'Delivery integration QA', pageIds: env.state.pages.map(p => p.id), productIds: env.state.products.map(p => p.id), contentModelIds: (env.state.contentModels || []).map(p => p.id), contentEntryIds: (env.state.contentEntries || []).map(p => p.id), sharedBlockIds: (env.state.sharedBlocks || []).map(p => p.id), includeTheme: true, includeSettings: true, includeLayout: true, includeCode: true, includeForms: true, includeTemplates: true, includeCatalog: true, includeRedirects: true });
async function publish(client, env) { const input = selection(env), check = await client.api('/api/releases/preview', 'POST', input); assert.deepEqual(check.errors, []); return client.api('/api/releases', 'POST', input, 201); }
async function verifyCustomer(client, env, mediaUrl) { const home = await client.request('/'); assert.equal(home.status, 200); const text = await home.text(); assert.match(env.state.settings.description,/\bfictional\b/i); assert.match(text,/\bfictional\b/i); if (mediaUrl) {
    const response = await client.request(mediaUrl);
    assert.equal(response.status, 200);
} const members = await client.api('/api/members'); assert.equal(members.members?.length || members.items?.length, 1); assert.equal((await client.api('/api/studio')).activeReleaseId, env.activeReleaseId); }
async function upgradeRoundtrip() {
    const oldImage = process.env.DEPLOY_TEST_OLD_IMAGE;
    if (!oldImage)
        return;
    const i = instance('upgrade', await freePort()), originalData = i.data;
    initialize(i, oldImage);
    await start(i, oldImage, true);
    const c = new Client(i);
    await c.login();
    let env = await c.api('/api/studio');
    assert.equal(env.state.products.length, 4);
    env = await publish(c, env);
    const before = await c.api('/api/studio');
    docker(['exec', i.name, 'node', '--env-file=/config/instance.env', 'scripts/backup.cjs', '/backups/pre-upgrade']);
    stop(i);
    const upgraded = volume('upgrade-copy');
    docker(['run', '--rm', ...mount(i.backups, '/backups', true), ...mount(upgraded, '/data'), image, 'node', 'scripts/ops.cjs', 'restore', '--allow-legacy', '--backup', '/backups/pre-upgrade', '--target', '/data/instance']);
    i.data = upgraded;
    i.subdir = 'instance';
    i.name = `${prefix}-upgraded`;
    initialize(i, image, true);
    await start(i);
    await c.login();
    assert.deepEqual(await c.api('/api/studio'), before);
    const rows = JSON.parse(docker(['exec', i.name, 'node', '-e', "const Database=require('better-sqlite3');const db=new Database('/data/studio.sqlite',{readonly:true});console.log(JSON.stringify(db.prepare('SELECT version FROM cms_schema_migration ORDER BY version').all()))"]));
    assert.deepEqual(rows.map(r => r.version), Array.from({length:protocol.database},(_,index)=>index+1));
    await c.api('/api/studio', 'PATCH', { expectedRevision: before.revision, patch: { settings: { ...before.state.settings, name: 'Upgrade-only synthetic marker' } } });
    stop(i);
    i.data = originalData;
    i.subdir = undefined;
    i.name = `${prefix}-rollback`;
    await start(i, oldImage, true);
    await c.login();
    assert.deepEqual(await c.api('/api/studio'), before);
    assert.equal((await c.request('/')).status, 200);
    milestone(`真实旧镜像备份→隔离恢复→当前SQL${protocol.database}迁移且草稿/会话/指针不变→原镜像+原目录回滚通过`);
}
/** 同一份交付配置服务两个客户，真实验证重建、备份和停机不会命中另一家。 */
async function composeRoundtrip() {
    docker(['image', 'inspect', image]);
    const directory = mkdtempSync(join(tmpdir(), `${prefix}-compose-`));
    const files = [], projects = [];
    let phase = '解析交付配置';
    const composeFile = resolve(__dirname, '../deploy/compose.yaml');
    const override = join(directory, 'volumes.yaml');
    const composeEnv = { COMPOSE_PROJECT_NAME: undefined, INSTANCE_ROOT: undefined, LOCAL_PORT: undefined, FORM_STUDIO_IMAGE: undefined };
    const composeArgs = (envFile, withVolumes, command) => [
        'compose', '-f', composeFile, ...(withVolumes ? ['-f', override] : []), '--env-file', envFile, ...command,
    ];
    function runCompose(envFile, command, withVolumes = true) {
        const result = spawnSync('docker', composeArgs(envFile, withVolumes, command), {
            env: { ...process.env, ...composeEnv }, encoding: 'utf8', windowsHide: true, timeout: 120000,
        });
        // Compose 仅处理本函数创建的合成配置，保留命令阶段与诊断便于定位回归。
        assert.equal(result.status, 0, `Compose ${command[0]} 失败：${result.stderr?.trim() || result.error?.code || '无错误输出'}`);
        return result.stdout.trim();
    }
    const projectContainers = project => docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]);
    const projectNetworks = project => docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
    function writeFixture(name, content) {
        const file = join(directory, name);
        writeFileSync(file, content, { flag: 'wx' });
        files.push(file);
        return file;
    }
    try {
        const a = instance('compose-a', await freePort());
        let otherPort = await freePort();
        while (otherPort === a.port) otherPort = await freePort();
        const b = instance('compose-b', otherPort);
        // 先用交付 YAML 核对实际绑定的目录；运行阶段只换挂载后端，用临时卷兼容 Windows 主机权限。
        writeFixture('volumes.yaml', JSON.stringify({
            services: { app: { volumes: ['test-data:/data', 'test-backups:/backups', 'test-config:/config:ro'] } },
            volumes: Object.fromEntries(['data', 'backups', 'config'].map(key => [
                `test-${key}`, { external: true, name: '${TEST_' + key.toUpperCase() + '_VOLUME}' },
            ])),
        }));
        const configCommand = ['config', '--format', 'json'];
        const base = `INSTANCE_ROOT=${JSON.stringify(directory.replaceAll('\\', '/'))}`;
        const missing = writeFixture('missing.env', base + '\n');
        const omitted = spawnSync('docker', composeArgs(missing, false, configCommand), {
            env: { ...process.env, ...composeEnv }, encoding: 'utf8', windowsHide: true, timeout: 30000,
        });
        assert.notEqual(omitted.status, 0);
        assert.match(omitted.stderr || '', /required variable COMPOSE_PROJECT_NAME/);
        for (const i of [a, b]) {
            const root = join(directory, i.kind).replaceAll('\\', '/');
            i.envFile = writeFixture(`${i.kind}.env`, [
                `COMPOSE_PROJECT_NAME=${i.name}`, `INSTANCE_ROOT=${JSON.stringify(root)}`, `LOCAL_PORT=${i.port}`, `FORM_STUDIO_IMAGE=${image}`,
                ...['data', 'backups', 'config'].map(key => `TEST_${key.toUpperCase()}_VOLUME=${i[key]}`), '',
            ].join('\n'));
            const config = JSON.parse(runCompose(i.envFile, configCommand, false));
            assert.equal(config.name, i.name);
            assert.deepEqual(config.services.app.ports.map(port => [port.host_ip, Number(port.published)]), [['127.0.0.1', i.port]]);
            assert.deepEqual(config.services.app.volumes.map(mount => [mount.type, mount.source.replaceAll('\\', '/'), mount.target]), [
                ['bind', `${root}/data`, '/data'], ['bind', `${root}/backups`, '/backups'], ['bind', `${root}/config`, '/config'],
            ]);
            const runnable = JSON.parse(runCompose(i.envFile, configCommand));
            assert.equal(runnable.name, i.name);
            assert.equal(projectContainers(i.name), '');
            assert.equal(projectNetworks(i.name), '');
            projects.push(i);
            phase = `初始化与启动 ${i.kind}`;
            initialize(i);
            runCompose(i.envFile, ['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90']);
            phase = `登录 ${i.kind}`;
            // Compose 重建会断开原服务的套接字。每次请求新建连接，验证实际接管端口的新服务。
            i.client = new Client(i, { Connection: 'close' });
            await i.client.login();
        }
        phase = '验证项目登录和草稿相互隔离';
        const unrelated = new Client(b);
        unrelated.cookie = a.client.cookie;
        assert.equal((await unrelated.request('/api/studio')).status, 401);
        const activeId = i => runCompose(i.envFile, ['ps', '-q', 'app']);
        const aId = activeId(a), bId = activeId(b);
        assert.ok(aId && bId && aId !== bId);
        const beforeA = await a.client.api('/api/studio'), beforeB = await b.client.api('/api/studio');
        const marker = 'Compose A synthetic settings';
        await a.client.api('/api/studio', 'PATCH', {
            expectedRevision: beforeA.revision, patch: { settings: { ...beforeA.state.settings, name: marker } },
        });
        assert.deepEqual(await b.client.api('/api/studio'), beforeB);
        const backup = '/backups/manual-compose';
        phase = '验证两个项目的备份与校验';
        for (const i of [a, b]) {
            const path = runCompose(i.envFile, ['exec', '-T', 'app', 'node', '-e', `console.log(require('node:fs').existsSync('${backup}'))`]);
            assert.equal(path, 'false');
            const result = JSON.parse(runCompose(i.envFile, ['exec', '-T', 'app', 'node', '--env-file=/config/instance.env', 'scripts/ops.cjs', 'backup', '--target', backup]));
            assert.equal(result.operation, 'backup');
            assert.equal(JSON.parse(runCompose(i.envFile, ['exec', '-T', 'app', 'node', 'scripts/ops.cjs', 'verify', '--backup', backup])).legacy, false);
        }
        // 用同一交付镜像重建A，验证升级命令只重建目标项目，无需拉取镜像。
        phase = '重建 A 后读取两套站点';
        runCompose(a.envFile, ['up', '-d', '--force-recreate', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90']);
        assert.notEqual(activeId(a), aId);
        assert.equal(activeId(b), bId);
        assert.equal((await a.client.api('/api/studio')).state.settings.name, marker);
        phase = '停止 A 后读取 B';
        runCompose(a.envFile, ['stop', 'app']);
        assert.equal(activeId(a), '');
        assert.equal(activeId(b), bId);
        assert.deepEqual(await b.client.api('/api/studio'), beforeB);
        milestone('共享交付 YAML 的两个 Compose 项目：单独挂载、端口、登录、备份、重建与停机通过');
    } catch (error) {
        throw Error(`${phase}失败：${error.message}${error.cause?.code ? `（${error.cause.code}）` : ''}`, { cause: error });
    } finally {
        const failedCleanup = [];
        for (const project of projects) try {
            runCompose(project.envFile, ['down', '--timeout', '15']);
            assert.equal(projectContainers(project.name), '');
            assert.equal(projectNetworks(project.name), '');
        } catch { failedCleanup.push(project.name); }
        assert.deepEqual(failedCleanup, [], '仅本轮生成项目的清理未完成，保留临时配置用于核对');
        for (const file of files) unlinkSync(file);
        rmdirSync(directory);
    }
}
async function main() {
    console.log(JSON.stringify({operation:'start',prefix,image}));
    await composeRoundtrip();
    if (process.argv.includes('--compose-only')) {
        completed = true;
        return;
    }
    const ports=[];while(ports.length<3){const port=await freePort();if(!ports.includes(port))ports.push(port);}
    const sites = [instance('factory', ports[0]), instance('services', ports[1]), instance('portfolio', ports[2])];
    for (const i of sites) {
        initialize(i);
        await start(i);
        const client = new Client(i);
        await client.login();
        i.client = client;
        const env = await client.api('/api/studio');
        assert.equal((await client.request('/admin')).status,200);
        assert.deepEqual(await(await client.request('/api/health')).json(),{status:'ready'});
        assert.equal(env.activeReleaseId, null);
        assert.equal(env.state.pages.length, 1);
        assert.equal(env.state.products.length, 0);
        assert.equal(JSON.stringify(env.state).includes('Morrow'), false);
        assert.equal((await (await client.request('/')).text()).includes('网站尚未发布'), true);
    }
    const foreign = new Client(sites[1]);
    foreign.cookie = sites[0].client.cookie;
    assert.equal((await foreign.request('/api/studio')).status, 401);
    const fingerprints = sites.map(i => docker(['exec', i.name, 'node', '-e', "const fs=require('node:fs'),{parseEnv}=require('node:util'),c=require('node:crypto');console.log(c.createHash('sha256').update(parseEnv(fs.readFileSync('/config/instance.env','utf8')).BETTER_AUTH_SECRET).digest('hex'))"]));
    assert.equal(new Set(fingerprints).size, 3);
    milestone('三个Linux空实例：独立密钥/账号/Cookie/数据卷，无演示发布');
    for (let index = 0; index < sites.length; index++) {
        const i = sites[index], c = i.client;
        const showcase = showcaseCases[index];
        let env = await starter(c, showcase.kind);
        assert.equal(env.state.pages.length, showcase.pages);
        assert.equal(env.state.contentModels.length, showcase.kind === 'manufacturing' ? 2 : 1);
        env = await publish(c, env);
        i.env = env;
        await verifyCustomer(c, env);
    }
    milestone('同一镜像导入制造业10页、空间设计8页、创意工作室8页案例，显式依赖检查/发布/SSR通过');
    const i = sites[0], c = i.client;
    let env = await c.api('/api/studio');
    const png = await sharp({ create: { width: 1700, height: 900, channels: 3, background: '#234a69' } }).png().toBuffer(), form = new FormData();
    form.set('file', new Blob([png], { type: 'image/png' }), 'delivery-test.png');
    form.set('expectedRevision', String(env.revision));
    form.set('folder', 'Delivery QA');
    const upload = await c.request('/api/media', { method: 'POST', body: form });
    assert.equal(upload.status, 201);
    env = await upload.json();
    const media = env.media;
    // 更换封面同时更新有序相册首图，保留其余照片；遵循产品真实的封面一致性规则。
    env = await c.api('/api/studio', 'PATCH', { expectedRevision: env.revision, patch: { products: env.state.products.map((p, index) => index === 0 ? { ...p, image: media.url, images: [media.url, ...(p.images || []).filter(url => url !== media.url)] } : p) } });
    env = await publish(c, env);
    i.env = env;
    i.media = media;
    const mediaBytes = Buffer.from(await (await c.request(media.url)).arrayBuffer());
    const contact = env.state.pages.find(p => p.slug === '/contact'), definition = env.state.forms[0], session = await c.api(`/api/public/forms/${definition.id}/session`, 'POST', { sourcePath: contact.slug });
    await delay(session.minDelayMs + 30);
    // 国家填写明确名称；产品字段引用已发布记录，不能把任意文案当作产品 ID。
    const answers = Object.fromEntries(definition.fields.map(f => [f.id, f.type === 'email' ? 'delivery-visitor@example.invalid' : f.mapTo === 'name' ? 'Delivery visitor' : f.type === 'country' ? 'United States' : f.type === 'product' ? env.state.products[0].id : f.type === 'checkbox' ? false : 'Synthetic deployment verification']));
    await c.api(`/api/public/forms/${definition.id}`, 'POST', { token: session.token, answers, honeypot: '' });
    const inquiry = (await c.api('/api/inquiries')).items[0];
    assert.equal(inquiry.sourcePath, '/contact');
    const second = new Client(sites[1]);
    second.cookie = c.cookie;
    assert.equal((await second.request(media.url)).status, 401);
    assert.equal((await sites[1].client.api('/api/inquiries')).items.length, 0);
    milestone('独立媒体/三尺寸图片/匿名收件/持久通知，第二客户无共享询盘或私有媒体');
    const lockName=`${prefix}-lock-probe`;
    resources.containers.push(lockName);
    const lockAttempt = spawnSync('docker', ['run','--name',lockName,'--label','form-studio-test=delivery', '--rm', ...mounts(i, true), image], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(lockAttempt.status, 75);
    milestone('同数据卷第二写服务被内核锁拒绝');
    const liveBackup = JSON.parse(docker(['exec', i.name, 'node', '--env-file=/config/instance.env', 'scripts/ops.cjs', 'backup', '--target', '/backups/manual-delivery']));
    assert.equal(liveBackup.operation, 'backup');
    const verified = JSON.parse(docker(['exec', i.name, 'node', 'scripts/ops.cjs', 'verify', '--backup', '/backups/manual-delivery']));
    assert.equal(verified.legacy, false);
    const restored = volume('restored-data');
    // /data在镜像中由运行UID持有；全新任意挂载点的卷默认root所有，不能充当可写恢复父目录。
    docker(['run', '--rm', ...mount(i.backups, '/backups', true), ...mount(restored, '/data'), image, 'node', 'scripts/ops.cjs', 'restore', '--backup', '/backups/manual-delivery', '--target', '/data/instance']);
    stop(i);
    i.data = restored;
    i.subdir = 'instance';
    i.name = `${prefix}-restored`;
    await start(i);
    await c.login();
    const restoredEnv = await c.api('/api/studio');
    assert.equal(restoredEnv.activeReleaseId, env.activeReleaseId);
    assert.equal(restoredEnv.revision, env.revision);
    assert.deepEqual(Buffer.from(await (await c.request(media.url)).arrayBuffer()), mediaBytes);
    assert.equal((await c.api('/api/inquiries')).items[0].id, inquiry.id);
    assert.equal(restoredEnv.state.releases.length, 2);
    for (let n = 0; n < 30; n++) {
        const jobs = (await c.api('/api/notifications')).jobs;
        if (jobs[0]?.status === 'mock_sent')
            break;
        await delay(300);
    }
    assert.equal((await c.api('/api/notifications')).jobs[0].status, 'mock_sent');
    const opsStatus = await c.api('/api/operations/status');
    assert.equal(opsStatus.automatic, true);
    milestone('在线备份→新卷恢复→同密钥登录/历史媒体/两版本/公开页/询盘/通知任务均持久');
    await upgradeRoundtrip();
    const timing = [];
    for (let index = 0; index < sites.length; index++) {
        const site = sites[index], samples = [];
        for (let n = 0; n < 10; n++) {
            const begin = performance.now(), response = await site.client.request('/');
            await response.arrayBuffer();
            assert.equal(response.status, 200);
            samples.push(performance.now() - begin);
        }
        samples.sort((a, b) => a - b);
        timing.push({ site: site.kind, pages: site.env.state.pages.length, requests: 10, medianMs: Math.round(samples[5] * 10) / 10, p90Ms: Math.round(samples[8] * 10) / 10 });
    }
    console.log(JSON.stringify({ image, prefix, milestones, timing, environment: { platform: process.platform, arch: process.arch, node: process.version }, isolated: true }, null, 2));
    completed=true;
}
/** 清理也是验收结果；自动--rm的操作容器可已不存在，真实删除失败不能被exit0掩盖。 */
function cleanupResources(){const remaining=[];for(const [kind,names] of [['container',resources.containers],['volume',resources.volumes]])for(const name of names){assert(name.startsWith(prefix+'-'),'仅允许清理本次登记的资源');const result=spawnSync('docker',kind==='container'?['rm','--force',name]:['volume','rm',name],{encoding:'utf8',windowsHide:true,timeout:30000});if(result.status!==0&&!/no such (?:container|volume)/i.test(result.stderr||''))remaining.push({kind,name});}const cleanupCompleted=remaining.length===0;console.log(JSON.stringify({operation:'cleanup',prefix,cleanupCompleted,remaining}));return cleanupCompleted;}
module.exports={image,prefix,resources,docker,instance,initialize,start,stop,Client,starter,selection,publish,milestone,delay,cleanupResources};
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({status:'failed',step:milestones.length,error:error.message,prefix}));process.exitCode=1;}).finally(()=>{if(completed&&process.env.DEPLOY_TEST_KEEP_RUNNING==='1')return;if(process.env.DEPLOY_TEST_KEEP==='1'){for(const name of resources.containers)spawnSync('docker',['rm','--force',name],{stdio:'ignore',windowsHide:true,timeout:30000});}else if(!cleanupResources())process.exitCode=1;});
