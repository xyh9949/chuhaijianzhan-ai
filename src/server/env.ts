/** 运行时只读取持久配置；密钥必须由 setup 写入，禁止重启时静默换密钥。 */
export function getAuthEnvironment() {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("缺少有效 BETTER_AUTH_SECRET，请先运行 setup");
  const rawUrl = process.env.BETTER_AUTH_URL?.trim();
  if (!rawUrl) throw new Error("缺少 BETTER_AUTH_URL，请先运行 setup");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("BETTER_AUTH_URL 必须是有效网站地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("BETTER_AUTH_URL 只允许 http/https 网站来源，不包含账号、路径或查询参数");
  }
  return { secret, baseURL: url.origin, secureCookies: url.protocol === "https:" };
}
