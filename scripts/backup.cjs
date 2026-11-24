const { join, resolve } = require('node:path');
const {backup}=require('./operations.cjs');
require('@next/env').loadEnvConfig(process.cwd());

// SQLite 在线备份包含已提交的 WAL；媒体不可覆盖、不可物理删除，因此随后复制可保持引用完整。
async function main() {
  const source = resolve(process.env.FORM_STUDIO_DATA_DIR || 'data');
  const destination = resolve(process.argv[2] || join('backups', new Date().toISOString().replace(/[:.]/g, '-')));
  await backup(source,destination);
  console.log(`备份已写入 ${destination}；请另行安全保管 .env.local 与对应源码版本。`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
