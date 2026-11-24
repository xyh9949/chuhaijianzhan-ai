const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const APPLICATION = require('../package.json').version;
const protocol = require('../src/lib/protocol.json');
const SUPPORTED_RENDERER = protocol.renderer, SUPPORTED_MIGRATION = protocol.database;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (a, b) => { if(process.platform==='win32'){a=a.toLowerCase();b=b.toLowerCase();}return a === b || a.startsWith(b + path.sep); };
function distinct(a, b) { if (inside(a, b) || inside(b, a))
    throw Error('操作目录不能相同或互相包含'); }
function noSymlink(file) { let current = path.resolve(file); while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw Error('操作路径不能经过符号链接');
    const parent = path.dirname(current);
    if (parent === current)
        break;
    current = parent;
} }
function hashFile(file) { const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024); let count; try {
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, count));
}
finally {
    fs.closeSync(fd);
} return hash.digest('hex'); }
function filesUnder(directory, prefix = '') { if (!fs.existsSync(directory))
    return []; return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => { const relative = prefix ? `${prefix}/${entry.name}` : entry.name, full = path.join(directory, entry.name); if (entry.isSymbolicLink())
    throw Error('备份源不能包含符号链接'); if (entry.isDirectory())
    return filesUnder(full, relative); if (!entry.isFile())
    throw Error('备份源包含非常规文件'); return [{ path: relative, bytes: fs.statSync(full).size, sha256: hashFile(full) }]; }).sort((a, b) => a.path.localeCompare(b.path)); }
function databaseInfo(file) { const db = new Database(file, { readonly: true, fileMustExist: true }); try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok')
        throw Error('数据库完整性检查失败');
    const has = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!has('cms_draft') || !has('cms_release') || !has('auth_user'))
        throw Error('数据库缺少已初始化实例表');
    const migration = has('cms_schema_migration') ? db.prepare('SELECT COALESCE(MAX(version),0) version FROM cms_schema_migration').get().version : 0;
    const renderer = db.prepare('SELECT COALESCE(MAX(renderer_version),0) version FROM cms_release').get().version, draft = db.prepare('SELECT schema_version version FROM cms_draft WHERE id=1').get()?.version || 0;
    if (migration > SUPPORTED_MIGRATION || renderer > SUPPORTED_RENDERER || draft > SUPPORTED_RENDERER)
        throw Error('备份比本程序更新，请使用匹配应用');
    return { migration, renderer, draft };
}
finally {
    db.close();
} }
/** 历史索引也必须有原文件；防止产出“清单完整但历史媒体已缺失”的可疑备份。 */
function verifyMedia(directory, databaseFile = path.join(directory, 'studio.sqlite')) { const db = new Database(databaseFile, { readonly: true, fileMustExist: true }); try {
    const rows = db.prepare('SELECT filename,bytes,sha256 FROM cms_media_file').all();
    for (const row of rows) {
        if (!/^[a-f0-9]{64}\.(webp|jpg|png|mp4|webm|pdf)$/.test(row.filename))
            throw Error('媒体索引文件名无效');
        const file = path.join(directory, 'media', row.filename);
        if (!fs.existsSync(file) || fs.statSync(file).size !== row.bytes || hashFile(file) !== row.sha256)
            throw Error('备份历史媒体缺失或内容不符');
    }
}
finally {
    db.close();
} }
// 旧快照可能仍标记WAL；只在私有临时副本检查，不向原备份写入SHM/WAL。
function legacyInfo(directory) { const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'studio-backup-check-')); try {
    const file = path.join(temporary, 'studio.sqlite');
    fs.copyFileSync(path.join(directory, 'studio.sqlite'), file);
    const db = new Database(file);
    try {
        db.pragma('journal_mode = DELETE');
    }
    finally {
        db.close();
    }
    verifyMedia(directory, file);
    return databaseInfo(file);
}
finally {
    fs.rmSync(temporary, { recursive: true, force: true });
} }
function atomicJson(file, value) { const temporary = `${file}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
function availableSpace(directory, required = 0) { let parent = path.resolve(directory); while (!fs.existsSync(parent))
    parent = path.dirname(parent); const stats = fs.statfsSync(parent), available = Number(stats.bavail) * Number(stats.bsize); if (available < required + 32 * 1024 * 1024)
    throw Error('可用磁盘空间不足'); return available; }
/** 在线快照先包含所有已提交WAL，再复制只增不改的媒体；manifest最后落盘才算完成。 */
async function backup(source, destination) { source = path.resolve(source); destination = path.resolve(destination); distinct(source, destination); noSymlink(source); noSymlink(destination); if (fs.existsSync(destination))
    throw Error('备份目标已存在'); const sourceDb = path.join(source, 'studio.sqlite'); if (!fs.existsSync(sourceDb))
    throw Error('实例数据库不存在'); const media = filesUnder(path.join(source, 'media'), 'media'), needed = fs.statSync(sourceDb).size + media.reduce((sum, f) => sum + f.bytes, 0); availableSpace(destination, needed * 2); fs.mkdirSync(destination, { recursive: true, mode: 0o700 }); try {
    const db = new Database(sourceDb, { readonly: true, fileMustExist: true });
    try {
        await db.backup(path.join(destination, 'studio.sqlite'));
    }
    finally {
        db.close();
    }
    if (fs.existsSync(path.join(source, 'media')))
        fs.cpSync(path.join(source, 'media'), path.join(destination, 'media'), { recursive: true, errorOnExist: true, force: false, filter: entry => { if (fs.lstatSync(entry).isSymbolicLink())
                throw Error('媒体目录包含符号链接'); return true; } });
    const snapshotDb = new Database(path.join(destination, 'studio.sqlite'));
    try {
        snapshotDb.pragma('journal_mode = DELETE');
    }
    finally {
        snapshotDb.close();
    }
    const info = databaseInfo(path.join(destination, 'studio.sqlite'));
    verifyMedia(destination);
    const files = filesUnder(destination);
    for (const f of files)
        fs.chmodSync(path.join(destination, f.path), 0o600);
    const lock = path.join(__dirname, '../package-lock.json');
    const manifest = { format: 'form-studio-backup', version: 2, createdAt: new Date().toISOString(), applicationVersion: APPLICATION, supportedRenderer: SUPPORTED_RENDERER, database: info, lockSha256: fs.existsSync(lock) ? hashFile(lock) : null, files, includes: ['database', 'media'], excludes: ['environment', 'auth-secret', 'application-code'] };
    atomicJson(path.join(destination, 'BACKUP.json'), manifest);
    return { createdAt: manifest.createdAt, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}
catch (error) {
    atomicJson(path.join(destination, 'FAILED.json'), { status: 'failed', at: new Date().toISOString(), code: 'backup_incomplete' });
    throw error;
} }
/** 只接受数据库和media清单，校验原始字节及实际额外文件；从不按清单路径解压或执行内容。 */
function verify(directory, { allowLegacy = false } = {}) { directory = path.resolve(directory); noSymlink(directory); const manifestFile = path.join(directory, 'BACKUP.json'); if (fs.statSync(manifestFile).size > 16 * 1024 * 1024)
    throw Error('备份清单过大'); const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); if (manifest.format !== 'form-studio-backup' || ![1, 2].includes(manifest.version))
    throw Error('备份格式不支持'); if (manifest.version === 1) {
    if (!allowLegacy)
        throw Error('旧备份没有逐文件哈希；核实来源后可明确 --allow-legacy');
    const files = filesUnder(directory).filter(f => f.path !== 'BACKUP.json');
    if (files.some(f => f.path !== 'studio.sqlite' && !/^media\/[A-Za-z0-9._/-]+$/.test(f.path)))
        throw Error('旧备份包含额外文件');
    return { legacy: true, ...legacyInfo(directory), bytes: files.reduce((n, f) => n + f.bytes, 0) };
} if (!Array.isArray(manifest.files) || manifest.files.length > 100000 || !manifest.files.length)
    throw Error('备份文件清单无效'); const seen = new Set(); for (const f of manifest.files) {
    if (!f || typeof f.path !== 'string' || f.path.includes('..') || f.path.includes('\\') || f.path !== 'studio.sqlite' && !/^media\/[A-Za-z0-9._/-]+$/.test(f.path) || seen.has(f.path) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || !/^[a-f0-9]{64}$/.test(f.sha256))
        throw Error('备份文件清单无效');
    seen.add(f.path);
} if (!seen.has('studio.sqlite'))
    throw Error('备份缺少数据库'); const actual = filesUnder(directory).filter(f => f.path !== 'BACKUP.json'); if (actual.length !== manifest.files.length)
    throw Error('备份实际文件与清单不符'); const expected = new Map(manifest.files.map(f => [f.path, f])); for (const f of actual) {
    const match = expected.get(f.path);
    if (!match || f.bytes !== match.bytes || f.sha256 !== match.sha256)
        throw Error('备份文件缺失、被修改或哈希不符');
} verifyMedia(directory); return { legacy: false, ...databaseInfo(path.join(directory, 'studio.sqlite')), bytes: actual.reduce((n, f) => n + f.bytes, 0) }; }
/** 恢复只写全新目录，先校验再复制到同级暂存目录；旧实例与备份都保留供回退。 */
function restore(source, target, options = {}) { source = path.resolve(source); target = path.resolve(target); distinct(source, target); noSymlink(target); if (fs.existsSync(target))
    throw Error('恢复目标必须是尚不存在的新目录；禁止覆盖运行实例'); const info = verify(source, options); availableSpace(target, info.bytes * 2); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); const stage = `${target}.restore-${crypto.randomUUID()}`; fs.mkdirSync(stage, { mode: 0o700 }); fs.copyFileSync(path.join(source, 'studio.sqlite'), path.join(stage, 'studio.sqlite'), fs.constants.COPYFILE_EXCL); if (fs.existsSync(path.join(source, 'media')))
    fs.cpSync(path.join(source, 'media'), path.join(stage, 'media'), { recursive: true, errorOnExist: true, force: false }); databaseInfo(path.join(stage, 'studio.sqlite')); fs.renameSync(stage, target); return { status: 'restored', legacy: info.legacy }; }
/** 自动保留策略仅清理本工具生成且已校验的备份，不删除手工命名目录和失败/损坏副本。 */
async function scheduledBackup(source, root, keep = 7) { root = path.resolve(root); noSymlink(root); distinct(path.resolve(source), root); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); try {
    if (!Number.isInteger(keep) || keep < 1 || keep > 365)
        throw Error('备份保留份数需1至365');
    const name = `auto-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`, result = await backup(source, path.join(root, name));
    atomicJson(path.join(root, 'STATUS.json'), { status: 'success', ...result, backup: name, keep });
    const directories = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^auto-\d{4}-\d{2}-\d{2}T[0-9TZ-]+-[a-f0-9]{6}$/.test(d.name)).sort((a, b) => b.name.localeCompare(a.name));
    for (const d of directories.slice(keep)) {
        const full = path.join(root, d.name);
        try {
            verify(full);
            fs.rmSync(full, { recursive: true });
        }
        catch { }
    }
    return result;
}
catch (error) {
    atomicJson(path.join(root, 'STATUS.json'), { status: 'failure', at: new Date().toISOString(), code: 'backup_failed', keep });
    throw error;
} }
function preflight(source, backupRoot) { source = path.resolve(source); backupRoot = path.resolve(backupRoot); distinct(source, backupRoot); for (const directory of [source, backupRoot]) {
    noSymlink(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    availableSpace(directory);
    const probe = path.join(directory, `.preflight-${crypto.randomUUID()}`);
    fs.writeFileSync(probe, 'ok', { flag: 'wx', mode: 0o600 });
    fs.unlinkSync(probe);
} return databaseInfo(path.join(source, 'studio.sqlite')); }
module.exports = { backup, verify, restore, scheduledBackup, preflight, filesUnder, availableSpace, databaseInfo, digest };
