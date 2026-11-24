import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { getDatabase, getDataDirectory } from './database';
import { getAuthEnvironment } from './env';
import { ApiError } from './http';
import { isMemberDisabled, type Actor, type MemberRow } from './permissions';
import { object, revision, text } from './validation';
import { recordAudit } from './audit';
import { startAiUsage, observeAiUsage, finishAiUsage, type AiUsageTicket } from './ai-usage';

export interface AiProviderSummary { revision: number; enabled: boolean; baseUrl: string; model: string; visionModel?: string; hasApiKey: boolean; allowLocal: boolean; }
interface ProviderRow { revision: number; enabled: number; base_url: string; model: string; vision_model: string; allow_local: number; secret_cipher: string; }
interface ProviderConfig extends AiProviderSummary { apiKey: string; }
type AddressClass = 'public' | 'local' | 'blocked';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PROMPT_CHARS = 180_000;
const REQUEST_TIMEOUT_MS = 90_000;
const AAD = Buffer.from('form-studio/ai-provider/v1');
const processState = globalThis as typeof globalThis & { formStudioAiBusy?: Set<string> };

function readRow(): ProviderRow {
  return getDatabase().prepare('SELECT revision,enabled,base_url,model,vision_model,allow_local,secret_cipher FROM cms_ai_provider WHERE id=1').get() as ProviderRow;
}
/** 密钥仅在实例运行表加密保存；发布、模板包与前端DTO均没有密钥字段。 */
export function getAiProviderSummary(): AiProviderSummary {
  const row = readRow();
  return { revision: row.revision, enabled: Boolean(row.enabled), baseUrl: row.base_url, model: row.model, ...(row.vision_model ? { visionModel: row.vision_model } : {}), hasApiKey: Boolean(row.secret_cipher), allowLocal: Boolean(row.allow_local) };
}
function encryptionKey() { return createHash('sha256').update('form-studio-ai-key:v1\0').update(getAuthEnvironment().secret).digest(); }
function encryptSecret(secret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv); cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
function decryptSecret(encoded: string): string {
  if (!encoded) return '';
  try {
    const [version, iv, tag, ciphertext, extra] = encoded.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext || extra !== undefined) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url')); decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw new ApiError(422, 'AI密钥无法解密，请重新填写密钥并保存；恢复实例时需保留原固定密钥'); }
}
function ipv4Class(address: string): AddressClass {
  const [a, b, c] = address.split('.').map(Number);
  if (a === 0 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127 || a >= 224 || a === 192 && b === 0 || a === 198 && [18, 19].includes(b) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) return 'blocked';
  if (a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return 'local';
  return 'public';
}
/** 只允许明确公网或用户主动允许的本地地址；链路本地、元数据及保留网段始终拒绝。 */
export function classifyAiAddress(raw: string): AddressClass {
  let address = raw.replace(/^\[|\]$/g, '').toLowerCase(); const family = isIP(address);
  if (family === 4) return ipv4Class(address);
  if (family !== 6 || address.includes('%')) return 'blocked';
  address = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  if (address.startsWith('fd00:ec2:')) return 'blocked';
  if (address.startsWith('::ffff:')) {
    const tail = address.slice(7);
    if (isIP(tail) === 4) return ipv4Class(tail);
    if (/^[a-f\d]{1,4}:[a-f\d]{1,4}$/.test(tail)) {
      const [high, low] = tail.split(':').map(part => parseInt(part, 16));
      return ipv4Class(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return 'blocked';
  }
  if (address === '::1' || address === '0:0:0:0:0:0:0:1' || /^(fc|fd)/.test(address)) return 'local';
  // 仅接受全球单播范围，排除文档、Teredo/6to4等可能转译到受限目标的地址。
  if (!/^[23]/.test(address) || address.startsWith('2001:db8:') || /^2001:(?:0:|:)/.test(address) || address.startsWith('2002:')) return 'blocked';
  return 'public';
}
export function validateAiProviderUrl(value: string, allowLocal: boolean): URL {
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new ApiError(422, 'AI服务地址格式无效');
  let url: URL; try { url = new URL(value); } catch { throw new ApiError(422, '请填写完整的AI服务地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ApiError(422, 'AI服务地址仅支持HTTP/HTTPS，不能包含账号、查询参数或片段');
  if (url.protocol !== 'https:' && !allowLocal) throw new ApiError(422, '公网AI服务必须使用HTTPS；本地模型需明确开启本地服务');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    const kind = classifyAiAddress(hostname);
    if (kind === 'blocked' || kind === 'local' && !allowLocal || url.protocol === 'http:' && kind !== 'local') throw new ApiError(422, 'AI服务地址不在允许的网络范围内');
  }
  if (!allowLocal && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) throw new ApiError(422, '本地模型需明确开启本地服务');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}
function assertCurrentAdmin(actor: Actor) {
  const member = getDatabase().prepare('SELECT role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as Pick<MemberRow, 'role' | 'banned' | 'banExpires'> | undefined;
  if (!member || member.role !== 'admin' || isMemberDisabled(member)) throw new ApiError(403, '当前账号没有配置AI服务的权限');
}
/** 清空输入表示保留已有密钥；只有明确clearApiKey才删除，避免掩码被保存成真实密钥。 */
export function saveAiProvider(value: unknown, actor: Actor): AiProviderSummary {
  const input = object(value, 'AI服务配置'), expected = revision(input.expectedRevision);
  const allowed = ['expectedRevision', 'enabled', 'baseUrl', 'model', 'visionModel', 'apiKey', 'clearApiKey', 'allowLocal'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.enabled !== 'boolean' || input.allowLocal !== undefined && typeof input.allowLocal !== 'boolean' || input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new ApiError(422, 'AI服务配置字段无效');
  const allowLocal = input.allowLocal === undefined ? Boolean(readRow().allow_local) : input.allowLocal;
  const baseUrl = text(input.baseUrl, 'AI服务地址', 2048).trim(), model = text(input.model, '模型名称', 150).trim();
  // 视觉模型可选并复用同一连接；旧表单不传时保留，显式空值才恢复使用默认模型。
  const visionModel = input.visionModel === undefined ? readRow().vision_model : text(input.visionModel, '视觉模型名称', 150).trim();
  if (/[\u0000-\u001f\u007f]/.test(visionModel)) throw new ApiError(422, '视觉模型名称包含无效字符');
  if (/[\u0000-\u001f\u007f]/.test(model)) throw new ApiError(422, '模型名称包含无效字符');
  if (baseUrl) validateAiProviderUrl(baseUrl, allowLocal);
  if (input.enabled && (!baseUrl || !model)) throw new ApiError(422, '启用AI前请填写服务地址和模型名称');
  const apiKey = input.apiKey === undefined ? '' : text(input.apiKey, 'API密钥', 4096).trim();
  if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey) || apiKey && input.clearApiKey) throw new ApiError(422, 'API密钥格式或清除操作无效');
  getDatabase().transaction(() => {
    assertCurrentAdmin(actor);
    const current = readRow(); if (current.revision !== expected) throw new ApiError(409, 'AI配置已被其他窗口修改，请刷新后重试');
    // 服务来源变化时必须重新给密钥或明确清除，避免留空保留机制把旧服务凭据发往新域名。
    if (baseUrl && current.secret_cipher && !apiKey && !input.clearApiKey && new URL(baseUrl).origin !== (current.base_url ? new URL(current.base_url).origin : '')) throw new ApiError(422, 'AI服务来源已变化，请重新填写新服务的API密钥，或明确清除原密钥后保存');
    const cipher = input.clearApiKey ? '' : apiKey ? encryptSecret(apiKey) : current.secret_cipher;
    if (input.enabled && !cipher && !allowLocal) throw new ApiError(422, '公网AI服务需要配置API密钥');
    const result = getDatabase().prepare('UPDATE cms_ai_provider SET revision=revision+1,enabled=?,base_url=?,model=?,vision_model=?,allow_local=?,secret_cipher=?,updated_at=? WHERE id=1 AND revision=?').run(Number(input.enabled), baseUrl, model, visionModel, Number(allowLocal), cipher, new Date().toISOString(), expected);
    if (result.changes !== 1) throw new ApiError(409, 'AI配置已被其他窗口修改，请刷新后重试');
    recordAudit(actor, 'ai.provider', 'success', { fields: ['enabled', 'baseUrl', 'model', 'allowLocal', ...(input.visionModel === undefined ? [] : ['visionModel']), ...(apiKey || input.clearApiKey ? ['apiKey'] : [])], revision: expected + 1 });
  }).immediate();
  return getAiProviderSummary();
}
function loadConfig(requireEnabled: boolean): ProviderConfig {
  const row = readRow(), summary = getAiProviderSummary();
  if (requireEnabled && !summary.enabled) throw new ApiError(422, '请先在AI服务配置中启用自己的模型服务');
  if (!summary.baseUrl || !summary.model) throw new ApiError(422, '请先保存AI服务地址和模型名称');
  return { ...summary, apiKey: decryptSecret(row.secret_cipher) };
}
async function resolveTarget(url: URL, allowLocal: boolean, signal: AbortSignal): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    try {
      addresses = await new Promise((resolve, reject) => {
        const cancel = () => reject(new ApiError(499, 'AI请求已取消或超时'));
        if (signal.aborted) { cancel(); return; }
        signal.addEventListener('abort', cancel, { once: true });
        lookup(hostname, { all: true, verbatim: true }).then(resolve, () => reject(new ApiError(502, '无法解析AI服务地址，请检查配置'))).finally(() => signal.removeEventListener('abort', cancel));
      });
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(502, '无法解析AI服务地址，请检查配置'); }
  }
  if (!addresses.length || addresses.some(item => { const kind = classifyAiAddress(item.address); return kind === 'blocked' || kind === 'local' && !allowLocal || url.protocol === 'http:' && kind !== 'local'; })) throw new ApiError(422, 'AI服务解析到不允许的网络地址，请检查公网或本地服务设置');
  const chosen = addresses.find(item => item.family === 4) || addresses[0];
  return { address: chosen.address, family: chosen.family as 4 | 6 };
}
export interface AiVisionImage { bytes: Uint8Array; mime: 'image/jpeg'; }
async function sendRequest(config: ProviderConfig, system: string, prompt: string, externalSignal?: AbortSignal, testing = false, images?: readonly AiVisionImage[]): Promise<unknown> {
  const key = getDataDirectory(), busy = processState.formStudioAiBusy ??= new Set();
  if (busy.has(key)) throw new ApiError(429, '当前已有AI请求正在处理，请等待完成后再试');
  busy.add(key);
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout.signal]) : timeout.signal;
  let usage: AiUsageTicket | undefined;
  try {
    usage = startAiUsage(config.model, system.length + prompt.length, images?.length || 0);
    const url = validateAiProviderUrl(config.baseUrl, config.allowLocal);
    if (!url.pathname.endsWith('/chat/completions')) url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;
    const target = await resolveTarget(url, config.allowLocal, signal);
    if (!config.apiKey && classifyAiAddress(target.address) !== 'local') throw new ApiError(422, '公网AI服务需要配置API密钥');
    if (signal.aborted) throw new ApiError(499, 'AI请求已取消或超时');
    // 只发送本地已核对的图片字节，不给供应商可访问的私有预览网址、Cookie或任意远程图片URL。
    const userContent = images ? [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`, detail: 'high' } }))] : prompt;
    const payload = Buffer.from(JSON.stringify({ model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }], max_tokens: testing ? 32 : 8192, stream: false }));
    // DNS检查后将本次连接锁定到同一个IP，禁止重定向和连接复用，防止重绑定绕过地址约束。
    const raw = await new Promise<string>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({ protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined, path: url.pathname, method: 'POST', agent: false, family: target.family, lookup: (_hostname, options, callback) => options.all ? callback(null, [target]) : callback(null, target.address, target.family), headers: { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength, Accept: 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, signal }, response => {
        const status = response.statusCode || 0;
        if (status !== 200) {
          response.resume();
          reject(new ApiError(status === 401 || status === 403 ? 422 : status === 429 ? 429 : 502, status === 401 || status === 403 ? 'AI服务拒绝访问，请检查密钥与模型权限' : status === 429 ? 'AI服务额度或请求频率受限，请检查服务商账户' : status >= 300 && status < 400 ? 'AI服务返回重定向，请直接填写最终服务地址' : 'AI服务未完成请求，请检查接口兼容性、模型名称和服务商状态'));
          request.destroy(); return;
        }
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > MAX_RESPONSE_BYTES) { reject(new ApiError(502, 'AI回复超过允许大小，请缩小生成范围')); request.destroy(); } else chunks.push(chunk); });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', () => reject(new ApiError(502, '读取AI回复失败，请稍后重试')));
      });
      request.on('error', () => reject(new ApiError(signal.aborted ? timeout.signal.aborted ? 504 : 499 : 502, signal.aborted ? timeout.signal.aborted ? 'AI服务回复超时，请缩小生成范围后重试' : 'AI请求已取消' : '无法连接AI服务，请检查地址、证书和网络')));
      request.end(payload);
    });
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ApiError(502, 'AI接口没有返回有效JSON响应，请检查Chat Completions兼容性'); }
    observeAiUsage(usage, parsed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { choices?: unknown }).choices)) throw new ApiError(502, 'AI接口响应格式不兼容，请检查Chat Completions地址与模型配置');
    const envelope = parsed as { choices: { message?: { content?: unknown }; finish_reason?: string }[] };
    if (envelope.choices?.[0]?.finish_reason === 'length') throw new ApiError(502, 'AI回复达到长度上限，请缩小生成范围后重试');
    const content = envelope.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new ApiError(502, 'AI没有返回可用文本，请检查模型与接口兼容性');
    const cleaned = content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
    try { const result = JSON.parse(cleaned); finishAiUsage(usage); return result; } catch { throw new ApiError(502, 'AI回复不是有效JSON，请使用能按指令生成JSON的模型后重试'); }
  } catch (error) { finishAiUsage(usage,error); throw error; } finally { clearTimeout(timer); busy.delete(key); }
}
/** 一次操作只请求一次用户模型；失败不自动重试，避免重复扣费及不可见的多次生成。 */
export async function requestAiJson(system: string, prompt: string, signal?: AbortSignal): Promise<unknown> {
  if (typeof system !== 'string' || typeof prompt !== 'string' || system.length + prompt.length > MAX_PROMPT_CHARS) throw new ApiError(413, '发送给AI的资料过多，请缩小资料范围');
  return sendRequest(loadConfig(true), system, prompt, signal);
}
/** 用户明确选择截图后才调用一次视觉模型；与文字请求共用限流、地址锁定、超时及密钥保护。 */
export async function requestAiVisionJson(system: string, prompt: string, images: readonly AiVisionImage[], signal?: AbortSignal): Promise<unknown> {
  if (typeof system !== 'string' || typeof prompt !== 'string' || system.length + prompt.length > MAX_PROMPT_CHARS) throw new ApiError(413, '发送给AI的检查要求过长');
  if (!Array.isArray(images) || images.length < 1 || images.length > 3 || images.some(image => image?.mime !== 'image/jpeg' || !(image.bytes instanceof Uint8Array) || image.bytes.length < 4 || image.bytes.length > 1024 * 1024 || image.bytes[0] !== 0xff || image.bytes[1] !== 0xd8 || image.bytes[2] !== 0xff) || images.reduce((sum, image) => sum + image.bytes.length, 0) > 3 * 1024 * 1024) throw new ApiError(422, '请选择1至3张本站生成的有效截图');
  const config = loadConfig(true);
  return sendRequest({ ...config, model: config.visionModel || config.model }, system, prompt, signal, false, images);
}
export async function testAiProviderConnection(signal?: AbortSignal): Promise<{ ok: true; model: string }> {
  const config = loadConfig(false);
  const result = await sendRequest(config, 'Return exactly this JSON object: {"ok":true}. Do not add any other text.', 'Connection test. Reply with {"ok":true}.', signal, true);
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true) throw new ApiError(502, 'AI服务已回复，但未按要求返回JSON，请检查模型兼容性');
  return { ok: true, model: config.model };
}
