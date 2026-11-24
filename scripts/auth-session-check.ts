import { requireActor } from "../src/server/permissions";
import { getDatabase } from "../src/server/database";

// 仅供隔离烟测的新进程验证，不接收或输出真实用户凭据。
async function main() {
  if (!process.env.AUTH_TEST_COOKIE || !process.env.FORM_STUDIO_DATA_DIR?.includes("auth-smoke-")) throw new Error("此检查仅允许隔离认证测试目录");
  try {
    const actor = await requireActor(new Request(`${process.env.BETTER_AUTH_URL}/api/members/me`, { headers: { Cookie: process.env.AUTH_TEST_COOKIE } }));
    console.log(JSON.stringify({ authenticated: true, role: actor.role }));
  } finally { getDatabase().close(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Session check failed"); process.exitCode = 1; });
