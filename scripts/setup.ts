import protocol from '../src/lib/protocol.json';
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";

async function ask(label: string) {
  if (!process.stdin.isTTY) throw new Error("非交互初始化必须提供 AUTH_SETUP_EMAIL 和 AUTH_SETUP_PASSWORD");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(label); } finally { rl.close(); }
}

function askPassword(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("非交互初始化必须提供 AUTH_SETUP_PASSWORD");
  return new Promise((resolvePassword, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    process.stdout.write("管理员密码（至少 12 个字符，输入不显示）：");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error?: Error) => {
      process.stdin.off("keypress", handleKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolvePassword(value);
    };
    const handleKey = (input: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === "c") { finish(new Error("初始化已取消")); return; }
      if (key.name === "return" || key.name === "enter") { finish(); return; }
      if (key.name === "backspace") { value = value.slice(0, -1); return; }
      if (input && !key.ctrl && !key.meta) value += input;
    };
    process.stdin.on("keypress", handleKey);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const fileFlag = args.indexOf("--setup-env-file");
  if (fileFlag >= 0 && !args[fileFlag + 1]) throw new Error("--setup-env-file 缺少路径");
  const envFile = resolve(fileFlag >= 0 ? args[fileFlag + 1] : ".env.local");
  const hadEnvFile = existsSync(envFile);
  const original = hadEnvFile ? readFileSync(envFile, "utf8") : "";
  const existing = parseEnv(original);
  if (existing.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_SECRET && existing.BETTER_AUTH_SECRET !== process.env.BETTER_AUTH_SECRET) {
    throw new Error("环境密钥与已有配置不一致，拒绝隐式替换持久密钥");
  }
  for (const [key, value] of Object.entries(existing)) if (process.env[key] === undefined) process.env[key] = value;
  process.env.BETTER_AUTH_SECRET ||= randomBytes(48).toString("base64url");
  process.env.BETTER_AUTH_URL ||= "http://127.0.0.1:3200";
  process.env.FORM_STUDIO_DATA_DIR ||= resolve("data");
  const { getAuthEnvironment } = await import("../src/server/env");
  getAuthEnvironment();

  // 配置只追加缺失项；密码从环境或隐式输入读取，绝不写入配置或日志。
  let contents = original;
  for (const key of ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "FORM_STUDIO_DATA_DIR"] as const) {
    if (existing[key]) continue;
    const line = `${key}=${JSON.stringify(process.env[key])}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    contents = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
  }
  if (contents !== original) {
    mkdirSync(dirname(envFile), { recursive: true });
    if (!hadEnvFile) {
      // 首次配置采用独占创建，两个并发 setup 不能互相覆盖各自生成的密钥。
      writeFileSync(envFile, contents.trimStart(), { mode: 0o600, flag: "wx" });
    } else {
      const temporary = `${envFile}.${process.pid}.tmp`;
      writeFileSync(temporary, contents.trimStart(), { mode: 0o600, flag: "wx" });
      renameSync(temporary, envFile);
    }
  }

  const { getDatabase, getDataDirectory } = await import("../src/server/database");
  const directory = getDataDirectory();
  mkdirSync(directory, { recursive: true });
  const lockPath = resolve(directory, ".auth-setup.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch { throw new Error("另一个初始化正在运行；若上次进程异常退出，请核实后移除 data 目录的 .auth-setup.lock"); }
  try {
    const { getAuth } = await import("../src/server/auth");
    const { getMigrations } = await import("better-auth/db/migration");
    const auth = getAuth();
    const migrations = await getMigrations(auth.options);
    await migrations.runMigrations();
    if (args.includes("--migrate-only")) { console.log("认证表迁移完成，未创建或修改账号。"); return; }
    const count = getDatabase().prepare("SELECT COUNT(*) AS count FROM auth_user").get() as { count: number };
    if (count.count > 0) { console.log("已有账号，初始化未创建或修改任何账号。"); return; }
    const email = (process.env.AUTH_SETUP_EMAIL ?? await ask("管理员邮箱：")).trim().toLowerCase();
    const name = (process.env.AUTH_SETUP_NAME ?? "管理员").trim();
    const password = process.env.AUTH_SETUP_PASSWORD ?? await askPassword();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("管理员邮箱格式无效");
    if (!name || name.length > 100) throw new Error("管理员姓名需为 1 至 100 个字符");
    if (password.length < 12 || password.length > 128) throw new Error("管理员密码需为 12 至 128 个字符");
    // 无请求 headers 的特权库 API 仅在此本机 CLI、空账号库且持有初始化锁时使用。
    // 先建立空站再创建账号；中断重试不会留下有账号却回退到演示seed的实例。
    // 测试/主动演示才使用 --demo-draft，不覆盖任何已有草稿。
    const {createEmptyDraft,createInitialDraft}=await import('../src/server/seed');
    getDatabase().prepare('INSERT OR IGNORE INTO cms_draft(id,revision,schema_version,content_json,updated_at) VALUES(1,0,?,?,?)')
      .run(protocol.snapshot,JSON.stringify(args.includes('--demo-draft')?createInitialDraft():createEmptyDraft()),new Date().toISOString());
    await auth.api.createUser({ body: { name, email, password, role: "admin" } });
    delete process.env.AUTH_SETUP_PASSWORD;
    console.log("首管理员已创建。请使用配置的站点地址登录；密码未写入任何文件。");
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
    getDatabase().close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "初始化失败");
  process.exitCode = 1;
});
