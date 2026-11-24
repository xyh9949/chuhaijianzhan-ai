const path = require('node:path');
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const ops = require('./operations.cjs');
async function main() {
    const args = process.argv.slice(2), command = args.shift();
    const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
    const envFile = value('--env-file');
    if (envFile) {
        for (const [key, v] of Object.entries(parseEnv(fs.readFileSync(envFile, 'utf8'))))
            if (process.env[key] === undefined)
                process.env[key] = v;
    }
    else
        require('@next/env').loadEnvConfig(process.cwd());
    const source = path.resolve(process.env.FORM_STUDIO_DATA_DIR || 'data'), root = path.resolve(process.env.FORM_STUDIO_BACKUP_DIR || 'backups');
    let result;
    if (command === 'backup') {
        const target = value('--target');
        result = target ? await ops.backup(source, target) : await ops.scheduledBackup(source, root, Number(process.env.FORM_STUDIO_BACKUP_KEEP || 7));
    }
    else if (command === 'verify') {
        if (!value('--backup'))
            throw Error('verify需要 --backup 目录');
        result = ops.verify(value('--backup'), { allowLegacy: args.includes('--allow-legacy') });
    }
    else if (command === 'restore') {
        if (!value('--backup') || !value('--target'))
            throw Error('restore需要 --backup 与全新 --target 目录');
        result = ops.restore(value('--backup'), value('--target'), { allowLegacy: args.includes('--allow-legacy') });
    }
    else if (command === 'preflight') {
        const secret = process.env.BETTER_AUTH_SECRET, url = new URL(process.env.BETTER_AUTH_URL);
        if (!secret || secret.length < 32 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
            throw Error('实例来源或固定密钥无效');
        result = { status: 'ready', ...ops.preflight(source, root) };
    }
    else
        throw Error('用法：ops.cjs preflight | backup [--target 新目录] | verify --backup 目录 | restore --backup 目录 --target 新目录；可指定 --env-file');
    console.log(JSON.stringify({ operation: command, ...result }));
}
main().catch(error => {
    // 只输出固定错误类别，保留可行动原因而不泄露系统路径或数据库正文。
    const known={EACCES:['permission_denied','目录不可写，请核对运行用户与恢复父目录的所有权'],EPERM:['permission_denied','目录权限不足，请核对运行用户'],ENOENT:['path_missing','指定目录或文件不存在，请核对参数'],ENOSPC:['disk_full','磁盘空间不足，请核对数据与备份卷容量']};
    const [code,hint]=known[error?.code]||['operation_failed','核对参数、备份完整性与版本；完整规则见docs/OPERATIONS.md'];
    console.error(JSON.stringify({status:'failed',code,hint}));process.exitCode=1;
});
