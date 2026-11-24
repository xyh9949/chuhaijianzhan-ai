import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { parseEnv } from 'node:util';
const userError = (message: string) => Object.assign(new Error(message), { safeRecovery: true });

async function question(label: string) { const reader = createInterface({ input: process.stdin, output: process.stdout }); try { return await reader.question(label); } finally { reader.close(); } }
function password(label: string): Promise<string> {
  return new Promise((done, reject) => { let value = ''; const previous = process.stdin.isRaw; process.stdout.write(label); emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    const finish = (error?: Error) => { process.stdin.off('keypress', key); process.stdin.setRawMode(Boolean(previous)); process.stdin.pause(); process.stdout.write('\n'); error ? reject(error) : done(value); };
    const key = (text: string, info: { name?: string; ctrl?: boolean; meta?: boolean }) => { if (info.ctrl && info.name === 'c') return finish(new Error('恢复已取消')); if (info.name === 'return' || info.name === 'enter') return finish(); if (info.name === 'backspace') value = value.slice(0, -1); else if (text && !info.ctrl && !info.meta) value += text; };
    process.stdin.on('keypress', key);
  });
}
async function main() {
  const args = process.argv.slice(2), allowed = new Set(['--email','--env-file','--port','--backup-dir','--acknowledge-stopped','--stdin']);
  for (let i = 0; i < args.length; i++) { if (!allowed.has(args[i])) throw userError('不支持该恢复参数；密码只能从隐式终端或标准输入读取'); if (!['--acknowledge-stopped','--stdin'].includes(args[i]) && !args[++i]) throw userError('恢复参数缺少值'); }
  if (!args.includes('--acknowledge-stopped')) throw userError('请先停止网站服务，并使用--acknowledge-stopped确认维护窗口');
  const argument = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const file = resolve(argument('--env-file') || '.env.local'); if (argument('--env-file') && !existsSync(file)) throw userError('指定环境文件不存在');
  if (existsSync(file)) { const values = parseEnv(readFileSync(file, 'utf8')); if (values.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_SECRET && values.BETTER_AUTH_SECRET !== process.env.BETTER_AUTH_SECRET) throw userError('环境密钥与现有实例不一致'); for (const [key, value] of Object.entries(values)) if (process.env[key] === undefined) process.env[key] = value; }
  let email = argument('--email') || '', confirmationEmail = '', newPassword = '', repeated = '';
  if (args.includes('--stdin')) {
    if (process.stdin.isTTY) throw userError('--stdin仅供受控管道输入使用'); let raw = '';
    for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 8192) throw userError('恢复输入过大'); }
    const input = JSON.parse(raw) as Record<string, unknown>; if (Object.keys(input).some(key => !['email','confirmationEmail','newPassword','confirmPassword'].includes(key))) throw userError('恢复标准输入字段无效');
    if ([input.email, input.confirmationEmail, input.newPassword, input.confirmPassword].some(value => typeof value !== 'string')) throw userError('恢复标准输入字段无效');
    if (email && email !== input.email) throw userError('命令邮箱与标准输入目标不一致'); email = input.email as string; confirmationEmail = input.confirmationEmail as string; newPassword = input.newPassword as string; repeated = input.confirmPassword as string;
  } else {
    if (!process.stdin.isTTY) throw userError('非交互恢复只接受--stdin结构化标准输入，不接受密码参数或环境变量');
    email ||= await question('要恢复的现有管理员邮箱：'); confirmationEmail = await question('请再次输入邮箱，确认仅恢复此管理员：'); newPassword = await password('新密码（12至128字符，输入不显示）：'); repeated = await password('再次输入新密码：');
  }
  if (newPassword !== repeated) throw userError('两次输入的新密码不一致');
  const { recoverLocalAdministrator } = await import('../src/server/local-account-recovery');
  const result = await recoverLocalAdministrator({ email, confirmationEmail, newPassword, acknowledgedStopped: args.includes('--acknowledge-stopped'), port: Number(argument('--port') || process.env.PORT || 3200), backupDirectory: resolve(argument('--backup-dir') || join('backups', `auth-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)) });
  newPassword = ''; repeated = '';
  console.log(JSON.stringify({ recovered: result.recovered, sessionsRevoked: result.sessionsRevoked, backupDirectory: result.backupDirectory, message: '现有管理员密码已恢复，旧会话已撤销。请重新启动网站并使用新密码登录。' }));
}
main().catch(error => { console.error(error?.safeRecovery === true ? error.message : '本机账号恢复未完成；请核对现有管理员、停服确认、端口、固定密钥及备份目录。未输出任何密码或恢复令牌。'); process.exitCode = 1; });
