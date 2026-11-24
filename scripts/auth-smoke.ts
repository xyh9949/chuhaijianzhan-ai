import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

async function main() {
  // 测试只使用随机临时目录与凭据，不加载或改动默认 data/.env.local。
  const work = resolve(process.cwd(), "../work");
  mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(join(work, "auth-smoke-"));
  const envFile = join(directory, ".env.local");
  const baseURL = "http://127.0.0.1:3299";
  const adminPassword = randomBytes(20).toString("base64url");
  const memberPassword = randomBytes(20).toString("base64url");
  const replacementPassword = randomBytes(20).toString("base64url");
  Object.assign(process.env, { FORM_STUDIO_DATA_DIR: join(directory, "data"), BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"), AUTH_SETUP_EMAIL: "admin@example.test", AUTH_SETUP_PASSWORD: adminPassword, AUTH_SETUP_NAME: "Auth test admin" });
  const setup = () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/setup.ts", "--setup-env-file", envFile], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 60_000 });
    // 失败信息也不展开子进程输出；单独验证初始化日志没有包含随机密码或持久密钥。
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    for (const secret of [adminPassword, process.env.BETTER_AUTH_SECRET]) {
      assert.ok(secret && !output.includes(secret), "setup logs must not contain credentials or auth secrets");
    }
    return result;
  };
  let initialized = setup();
  assert.equal(initialized.status, 0, "first setup process failed");
  assert.equal(readFileSync(envFile, "utf8").includes(adminPassword), false, "setup must never persist account passwords");
  initialized = setup();
  assert.equal(initialized.status, 0, "idempotent setup process failed");
  delete process.env.AUTH_SETUP_PASSWORD;

  const auth = await import("../src/app/api/auth/[...all]/route");
  const members = await import("../src/app/api/members/route");
  const member = await import("../src/app/api/members/[id]/route");
  const reset = await import("../src/app/api/members/[id]/password/route");
  const me = await import("../src/app/api/members/me/route");
  const permissions = await import("../src/server/permissions");
  const { getDatabase } = await import("../src/server/database");
  const { readJsonObject } = await import("../src/server/http");
  const db = getDatabase();
  const request = (path: string, method = "GET", body?: unknown, cookie = "", origin = baseURL) => new Request(`${baseURL}${path}`, { method, headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, "User-Agent": "FormStudioAuthSmoke" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const cookieOf = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const context = (id: string) => ({ params: Promise.resolve({ id }) });
  const signIn = (email: string, password: string) => auth.POST(request("/api/auth/sign-in/email", "POST", { email, password }));
  const results: string[] = [];

  try {
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM auth_user").get() as { count: number }).count, 1);
    const stored = db.prepare("SELECT password FROM auth_account LIMIT 1").get() as { password: string };
    assert.ok(stored.password && stored.password !== adminPassword);
    results.push("setup migration, persistent secret, idempotent first admin, library password hash, credential-free setup logs");

    assert.equal((await members.GET(request("/api/members"))).status, 401);
    assert.equal((await auth.POST(request("/api/auth/sign-up/email", "POST", { email: "rogue@example.test", password: memberPassword, name: "rogue" }))).status, 404);
    assert.equal((await auth.POST(request("/api/auth/admin/create-user", "POST", {}))).status, 404);
    assert.equal((await auth.POST(request("/api/auth/sign-in/email", "POST", {}, "", "http://evil.example"))).status, 403);
    assert.equal((await signIn("admin@example.test", "wrong-password-000")).status, 401);
    const signedIn = await signIn("admin@example.test", adminPassword);
    assert.equal(signedIn.status, 200, "admin sign-in failed");
    const adminCookie = cookieOf(signedIn);
    assert.ok(adminCookie);
    assert.match(signedIn.headers.get("set-cookie") ?? "", /HttpOnly/i);
    assert.match(signedIn.headers.get("set-cookie") ?? "", /Max-Age/i);
    const actor = (await (await me.GET(request("/api/members/me", "GET", undefined, adminCookie))).json()).actor;
    assert.equal(actor.role, "admin");
    const restarted = spawnSync(process.execPath, ["--import", "tsx", "scripts/auth-session-check.ts"], { cwd: process.cwd(), env: { ...process.env, AUTH_TEST_COOKIE: adminCookie }, encoding: "utf8", timeout: 30_000 });
    assert.equal(restarted.status, 0, "fresh-process session lookup failed");
    assert.equal(JSON.parse(restarted.stdout).authenticated, true);
    assert.equal((await members.GET(request("/api/members", "GET", undefined, adminCookie))).headers.get("cache-control"), "no-store");
    results.push("login, HttpOnly persistent cookie, fresh-process session lookup, anonymous/origin/signup/admin-route rejection");

    const create = await members.POST(request("/api/members", "POST", { name: "Editor", email: "editor@example.test", role: "editor", password: memberPassword }, adminCookie));
    assert.equal(create.status, 201, "member creation failed");
    const editor = (await create.json()).member;
    let editorCookie = cookieOf(await signIn(editor.email, memberPassword));
    const editorActor = await permissions.requireActor(request("/", "GET", undefined, editorCookie));
    permissions.requirePermission(editorActor, "edit");
    assert.throws(() => permissions.requirePermission(editorActor, "publish"));
    assert.equal((await members.GET(request("/api/members", "GET", undefined, editorCookie))).status, 403);
    assert.equal((await member.PATCH(request(`/api/members/${actor.id}`, "PATCH", { disabled: true }, adminCookie), context(actor.id))).status, 409);
    assert.equal((await member.PATCH(request(`/api/members/${actor.id}`, "PATCH", { role: "viewer" }, adminCookie), context(actor.id))).status, 409);
    assert.equal((await member.PATCH(request(`/api/members/${editor.id}`, "PATCH", { role: "viewer" }, adminCookie), context(editor.id))).status, 200);
    assert.equal((await me.GET(request("/api/members/me", "GET", undefined, editorCookie))).status, 401);
    editorCookie = cookieOf(await signIn(editor.email, memberPassword));
    assert.throws(() => permissions.requirePermission({ ...editorActor, role: "viewer" }, "edit"));
    assert.equal((await member.PATCH(request(`/api/members/${editor.id}`, "PATCH", { disabled: true }, adminCookie), context(editor.id))).status, 200);
    assert.equal((await me.GET(request("/api/members/me", "GET", undefined, editorCookie))).status, 401);
    assert.equal((await signIn(editor.email, memberPassword)).status, 403);
    assert.equal((await member.PATCH(request(`/api/members/${editor.id}`, "PATCH", { disabled: false }, adminCookie), context(editor.id))).status, 200);
    results.push("editor/viewer permissions, atomic last-admin protection, role/disable immediate session revocation");

    assert.equal((await reset.POST(request(`/api/members/${editor.id}/password`, "POST", { password: replacementPassword }, adminCookie), context(editor.id))).status, 200);
    assert.equal((await signIn(editor.email, memberPassword)).status, 401);
    const changedSignIn = await signIn(editor.email, replacementPassword);
    assert.equal(changedSignIn.status, 200);
    const newCookie = cookieOf(changedSignIn);
    const selfChange = await auth.POST(request("/api/auth/change-password", "POST", { currentPassword: replacementPassword, newPassword: memberPassword, revokeOtherSessions: true }, newCookie));
    assert.equal(selfChange.status, 200, "self password change failed");
    const signedOut = await auth.POST(request("/api/auth/sign-out", "POST", {}, cookieOf(selfChange) || newCookie));
    assert.equal(signedOut.status, 200);
    assert.equal((await me.GET(request("/api/members/me", "GET", undefined, cookieOf(selfChange) || newCookie))).status, 401);
    results.push("admin reset, self change with current password, logout invalidation");

    assert.equal((await members.POST(request("/api/members", "POST", { payload: "x".repeat(33 * 1024) }, adminCookie))).status, 413);
    assert.equal((await auth.POST(request("/api/auth/sign-in/email", "POST", { payload: "x".repeat(65 * 1024) }))).status, 413);
    const streamed = new Request(`${baseURL}/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33 * 1024)); controller.close(); } }), duplex: "half" } as RequestInit);
    await assert.rejects(readJsonObject(streamed), (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === 413));
    results.push("32 KiB JSON / 64 KiB auth limits including streamed body without Content-Length");
    const secondAdmin = await members.POST(request("/api/members", "POST", { name: "Second admin", email: "second-admin@example.test", role: "admin", password: memberPassword }, adminCookie));
    assert.equal(secondAdmin.status, 201);
    const secondId = (await secondAdmin.json()).member.id;
    const secondCookie = cookieOf(await signIn("second-admin@example.test", memberPassword));
    assert.ok(secondCookie);
    const concurrent = await Promise.all([
      member.PATCH(request(`/api/members/${actor.id}`, "PATCH", { disabled: true }, adminCookie), context(actor.id)),
      member.PATCH(request(`/api/members/${secondId}`, "PATCH", { disabled: true }, secondCookie), context(secondId)),
    ]);
    assert.equal(concurrent.filter((response) => response.status === 200).length, 1);
    assert.ok(concurrent.some((response) => response.status === 409));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM auth_user WHERE role = 'admin' AND COALESCE(banned, 0) = 0").get() as { count: number }).count, 1);
    results.push("concurrent admin disabling leaves exactly one active admin");
    console.log(JSON.stringify({ passed: results, testDirectory: directory }, null, 2));
  } finally { db.close(); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Auth smoke failed"); process.exitCode = 1; });
