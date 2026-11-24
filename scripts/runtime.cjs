const { spawn } = require('node:child_process');
const { scheduledBackup, preflight } = require('./operations.cjs');
const data = process.env.FORM_STUDIO_DATA_DIR || '/data', backups = process.env.FORM_STUDIO_BACKUP_DIR || '/backups';
const hours = Number(process.env.FORM_STUDIO_BACKUP_INTERVAL_HOURS || 24), keep = Number(process.env.FORM_STUDIO_BACKUP_KEEP || 7);
/** 单Node生产入口：先检查实例，应用退出时停止；备份不阻塞服务，失败只记固定类别。 */
async function main() {
    if (!Number.isInteger(hours) || hours < 1 || hours > 8760 || !Number.isInteger(keep) || keep < 1 || keep > 365)
        throw Error('backup_configuration_invalid');
    if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32)
        throw Error('instance_not_initialized');
    preflight(data, backups);
    const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '0.0.0.0', '--port', process.env.PORT || '3200'], { stdio: 'inherit', env: { ...process.env, FORM_STUDIO_AUTOMATIC_BACKUP: '1' } });
    let active = false, stopping = false;
    const runBackup = async () => { if (active || stopping)
        return; active = true; try {
        const result = await scheduledBackup(data, backups, keep);
        console.log(JSON.stringify({ event: 'backup_completed', ...result }));
    }
    catch {
        console.error(JSON.stringify({ event: 'backup_failed' }));
    }
    finally {
        active = false;
    } };
    const timer = setInterval(runBackup, hours * 3600000);
    timer.unref();
    // 启动即验证备份链；停止期间不再启动新任务，已有快照可能留下无完成标记目录。
    void runBackup();
    for (const signal of ['SIGTERM', 'SIGINT'])
        process.on(signal, () => { stopping = true; clearInterval(timer); child.kill(signal); });
    child.on('error', () => { clearInterval(timer); console.error('application_start_failed'); process.exitCode = 1; });
    child.on('exit', code => { stopping = true; clearInterval(timer); process.exitCode = code ?? 1; });
}
main().catch(() => { console.error('instance_preflight_failed'); process.exitCode = 1; });
