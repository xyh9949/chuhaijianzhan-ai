import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ApiError } from './http';
import { classifyAiAddress } from './ai-provider';

export interface LaunchPageResponse { status: number; body: string; contentType: string; robots: string; }
export type LaunchPageReader = (url: URL, signal: AbortSignal) => Promise<LaunchPageResponse>;
const MAX_RESPONSE_BYTES = 128 * 1024;

/** 正式探测只接受已配置的HTTPS源；请求调用者不能指定用户名、查询、路径或内网目标。 */
export function validateLaunchOrigin(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new ApiError(422, '请先填写有效的正式网址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ApiError(422, '正式连接检查需要不带路径和参数的HTTPS网址');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || isIP(hostname) && classifyAiAddress(hostname) !== 'public') throw new ApiError(422, '当前是本机或内网演示，尚未验证公网；请在部署后检查正式域名');
  return url;
}

async function publicAddress(hostname: string, signal: AbortSignal) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: { address: string; family: number }[]) => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); if (error) reject(error); else resolve(value || []); };
    const cancel = () => finish(new ApiError(504, '正式网站地址解析已取消或超时'));
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) { cancel(); return; }
    if (isIP(host)) { finish(undefined, [{ address: host, family: isIP(host) }]); return; }
    void lookup(host, { all: true, verbatim: true }).then(value => finish(undefined, value), () => finish(new ApiError(502, '无法解析正式网站域名，请核对DNS记录')));
  });
  // 同时验证全部解析结果，不能从混入的公网地址中挑一个后把内网地址当作合法备用。
  if (!addresses.length || addresses.some(item => classifyAiAddress(item.address) !== 'public')) throw new ApiError(422, '正式域名解析到了非公网或保留地址，本次没有连接');
  const chosen = addresses.find(item => item.family === 4) || addresses[0]; return { address: chosen.address, family: chosen.family as 4 | 6 };
}

/** 只读当前正式源的固定页面，DNS固定IP、保留原Host/SNI、不跟随任何重定向、不自动重试。 */
export const readLaunchPage: LaunchPageReader = async (url, signal) => {
  validateLaunchOrigin(url.origin);
  if (url.username || url.password || !['/', '/robots.txt', '/sitemap.xml'].includes(url.pathname) || url.search || url.hash) throw new ApiError(422, '上线检查只读取无凭据和参数的首页、robots.txt和sitemap.xml');
  const target = await publicAddress(url.hostname, signal); if (signal.aborted) throw new ApiError(499, '正式网站检查已取消');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<LaunchPageResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: LaunchPageResponse) => { if (settled) return; settled = true; if (error) reject(error); else resolve(value!); };
    const pinnedLookup: NonNullable<import('node:http').RequestOptions['lookup']> = (_host, options, done) => options.all ? done(null, [target]) : done(null, target.address, target.family);
    const request = httpsRequest(url, { method: 'GET', agent: false, signal, family: target.family, lookup: pinnedLookup, rejectUnauthorized: true, servername: isIP(hostname) ? '' : hostname, headers: { Accept: url.pathname === '/' ? 'text/html' : url.pathname.endsWith('.xml') ? 'application/xml,text/xml' : 'text/plain', 'User-Agent': 'Form-Studio-Launch-Check/1.0', 'Accept-Encoding': 'identity' } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (part: Buffer) => { bytes += part.length; if (bytes > MAX_RESPONSE_BYTES) { response.destroy(); request.destroy(); finish(new ApiError(413, '正式页面超过本次128KiB检查容量，未完成读取')); } else chunks.push(part); });
      response.on('end', () => finish(undefined, { status: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8'), contentType: String(response.headers['content-type'] || '').slice(0, 150), robots: String(response.headers['x-robots-tag'] || '').slice(0, 1000) }));
      response.on('error', () => finish(new ApiError(502, '正式页面响应中断，请稍后重新检查')));
    });
    request.once('error', () => finish(new ApiError(signal.aborted ? 504 : 502, signal.aborted ? '正式网站检查已取消或超时' : '正式网站HTTPS连接未成功，请核对证书、域名和服务器')));
    request.end();
  });
};
