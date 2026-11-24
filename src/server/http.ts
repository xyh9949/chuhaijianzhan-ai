export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}

/** 后台响应不进入浏览器或中间缓存，避免退出后暴露上一账号的数据。 */
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function apiError(error: unknown): Response {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  const authError = error as { statusCode?: number; body?: { message?: string; code?: string } } | null;
  if (authError?.statusCode && authError.statusCode >= 400 && authError.statusCode < 500) {
    return json({ error: authError.body?.message ?? "请求未完成", code: authError.body?.code }, authError.statusCode);
  }
  // 第三方异常可能含SQL、文件路径或用户输入；服务日志只记录固定错误类别。
  console.error("Server request failed: internal_error");
  return json({ error: "服务器暂时无法完成请求，请稍后重试" }, 500);
}

export async function readBodyBytes(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new ApiError(400, "请求长度无效");
  if (declared !== null && Number(declared) > limit) throw new ApiError(413, "请求内容过大");
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    // 不信任 Content-Length；流式累计，达到上限即取消读取，避免先整读巨大请求。
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new ApiError(413, "请求内容过大"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readJsonObject(request: Request, limit = 32 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "请使用 JSON 请求");
  const bytes = await readBodyBytes(request, limit);
  try {
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new ApiError(400, "请求内容不是有效 JSON 对象"); }
}
