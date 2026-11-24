import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";
import { ApiError, apiError, readBodyBytes } from "@/server/http";
import { assertSameOrigin } from "@/server/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allowed = {
  GET: new Set(["/get-session", "/list-sessions"]),
  POST: new Set(["/sign-in/email", "/sign-out", "/change-password", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions"]),
};

async function dispatch(request: Request, method: "GET" | "POST") {
  try {
    const path = new URL(request.url).pathname.slice("/api/auth".length);
    // 管理插件只能经受保护的 members API 调用，避免绕过最后管理员保护。
    if (!allowed[method].has(path)) throw new ApiError(404, "认证接口不存在");
    let boundedRequest = request;
    if (method === "POST") {
      assertSameOrigin(request);
      const bytes = await readBodyBytes(request, 64 * 1024);
      // 保留 URL、方法与全部请求头（含 Cookie），只替换为已验证大小的请求体。
      boundedRequest = new Request(request, { body: bytes });
    }
    const response = await toNextJsHandler(getAuth())[method](boundedRequest);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) { return apiError(error); }
}
export async function GET(request: Request) { return dispatch(request, "GET"); }
export async function POST(request: Request) { return dispatch(request, "POST"); }
