/** 来源只描述询盘携带的线索；没有访客分母，也不能验证访客填写的活动参数。 */
export type InquiryAttributionChannel = 'campaign' | 'referral' | 'unknown';
export interface InquiryAttributionInput {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  referrerHost?: string;
  landingPath?: string;
}
export interface InquiryAttribution extends InquiryAttributionInput {
  channel: InquiryAttributionChannel;
  capturedAt: string;
  source: 'visitor';
  verification: 'unverified';
}
export const ATTRIBUTION_UNVERIFIED_LABEL = '访客携带信息，未经验证';
export const SITE_ATTRIBUTION_STORAGE_KEY = 'form-studio:inquiry-attribution:v1';
export const SITE_ATTRIBUTION_TTL_MS = 30 * 60 * 1000;
const fields = ['utmSource', 'utmMedium', 'utmCampaign', 'referrerHost', 'landingPath'] as const;
const campaignFields = ['utmSource', 'utmMedium', 'utmCampaign'] as const;
const campaignLimits = { utmSource: 120, utmMedium: 120, utmCampaign: 200 };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export class AttributionValidationError extends Error {}
function invalid(): never { throw new AttributionValidationError('The inquiry source is invalid.'); }
function campaignText(value: unknown, field: typeof campaignFields[number]) {
  if (typeof value !== 'string' || value.length > campaignLimits[field] || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  const text = value.trim(); if (/(?:[a-z][a-z0-9+.-]*:\/\/|^\/\/)/i.test(text)) invalid();
  return text;
}
function pathText(value: unknown) {
  if (typeof value !== 'string' || value.length > 400 || !/^\/[a-zA-Z0-9/_-]*$/.test(value) || value.includes('//')) invalid();
  return value;
}
/** 只接受域名；URL、端口、凭据、IP及其数字变体均不能进入引荐字段。 */
function hostText(value: unknown) {
  if (typeof value !== 'string' || value.length > 253 || /[\u0000-\u0020\u007f/:@?#\\\[\]]/.test(value)) invalid();
  const host = value.toLowerCase().replace(/\.$/, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) invalid();
  try { if (new URL(`https://${host}`).hostname !== host) invalid(); } catch { invalid(); }
  return host;
}
function sameHost(a: string, b: string) { return a.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') === b.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
export function parseInquiryAttributionInput(value: unknown, ownHostname = ''): InquiryAttributionInput {
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key as typeof fields[number]))) invalid();
  const result: InquiryAttributionInput = {};
  for (const field of campaignFields) if (Object.hasOwn(value, field)) { const text = campaignText(value[field], field); if (text) result[field] = text; }
  if (Object.hasOwn(value, 'referrerHost')) { const host = hostText(value.referrerHost); if (!sameHost(host, ownHostname)) result.referrerHost = host; }
  if (Object.hasOwn(value, 'landingPath')) result.landingPath = pathText(value.landingPath);
  return result;
}
/** channel和采集时间由服务器补写；客户端不能将携带信息升级为已验证事实。 */
export function createInquiryAttribution(value: unknown, ownHostname: string, now = Date.now()): InquiryAttribution {
  const input = parseInquiryAttributionInput(value, ownHostname);
  return { ...input, channel: campaignFields.some(field => !!input[field]) ? 'campaign' : input.referrerHost ? 'referral' : 'unknown', capturedAt: new Date(now).toISOString(), source: 'visitor', verification: 'unverified' };
}
export function attributionChannelLabel(channel: InquiryAttributionChannel) {
  return ({ campaign: '链接活动参数', referral: '外部网站引荐', unknown: '来源未提供' })[channel];
}
export function inquirySourceLabel(inquiry: { attribution?: InquiryAttribution; sourcePath?: string; formId?: string; origin?: 'manual' | 'website' }): string {
  const attribution = inquiry.attribution;
  return attribution ? attribution.utmSource || attribution.referrerHost || attributionChannelLabel(attribution.channel) : inquiry.origin === 'manual' ? '后台人工录入' : inquiry.sourcePath || inquiry.formId ? '历史未采集' : '来源未记录';
}

type AttributionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type StoredAttribution = { version: 1; expiresAt: number; attribution: InquiryAttributionInput };
export function isPrivateAttributionPath(path: string) { return /^\/(?:admin|preview|api)(?:\/|$)/.test(path); }
function readStored(storage: AttributionStorage | undefined, ownHostname: string, now: number): StoredAttribution | undefined {
  if (!storage) return;
  try {
    const raw = storage.getItem(SITE_ATTRIBUTION_STORAGE_KEY); if (!raw) return;
    const saved: unknown = raw.length <= 2048 ? JSON.parse(raw) : undefined;
    if (!record(saved) || Object.keys(saved).some(key => !['version', 'expiresAt', 'attribution'].includes(key)) || saved.version !== 1 || typeof saved.expiresAt !== 'number' || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt <= now || saved.expiresAt > now + SITE_ATTRIBUTION_TTL_MS) throw new Error();
    const attribution = parseInquiryAttributionInput(saved.attribution, ownHostname);
    if (!campaignFields.some(field => !!attribution[field]) && !attribution.referrerHost) throw new Error();
    return { version: 1, expiresAt: saved.expiresAt, attribution };
  } catch { try { storage.removeItem(SITE_ATTRIBUTION_STORAGE_KEY); } catch { /* 禁用存储时仍可使用当前链接。 */ } }
}
/** 仅保存有限来源线索；普通站内导航沿用原期限，不记录页面序列或产生网络请求。 */
export function capturePageAttribution({ href, referrer = '', storage, now = Date.now() }: { href: string; referrer?: string; storage?: AttributionStorage; now?: number }): InquiryAttributionInput {
  let url: URL; try { url = new URL(href); } catch { return {}; }
  if (isPrivateAttributionPath(url.pathname)) return {};
  let landingPath: string | undefined; try { landingPath = pathText(url.pathname); } catch { /* 不保存不受支持的页面路径。 */ }
  const current: InquiryAttributionInput = {};
  for (const field of campaignFields) {
    const param = { utmSource: 'utm_source', utmMedium: 'utm_medium', utmCampaign: 'utm_campaign' }[field];
    const raw = url.searchParams.get(param); if (raw === null) continue;
    try { const value = campaignText(raw, field); if (value) current[field] = value; } catch { /* 丢弃不合规格的参数，不阻止询盘。 */ }
  }
  if (referrer) try { const from = new URL(referrer); if (['http:', 'https:'].includes(from.protocol) && !sameHost(from.hostname, url.hostname)) current.referrerHost = hostText(from.hostname); } catch { /* 不保存完整引荐网址或IP。 */ }
  const saved = readStored(storage, url.hostname, now);
  const explicit = campaignFields.some(field => !!current[field]);
  if (explicit || current.referrerHost) {
    if (landingPath) current.landingPath = landingPath;
    if (explicit && !current.referrerHost && saved?.attribution.referrerHost && current.landingPath === saved.attribution.landingPath && campaignFields.every(field => current[field] === saved.attribution[field])) current.referrerHost = saved.attribution.referrerHost;
    // 同一页重复采集不延长有效期；新显式活动或新外部引荐可替换先前线索。
    if (saved && fields.every(field => saved.attribution[field] === current[field])) return saved.attribution;
    try { storage?.setItem(SITE_ATTRIBUTION_STORAGE_KEY, JSON.stringify({ version: 1, expiresAt: now + SITE_ATTRIBUTION_TTL_MS, attribution: current } satisfies StoredAttribution)); } catch { /* 存储被禁用不影响当前来源。 */ }
    return current;
  }
  return saved?.attribution || {};
}

let memorySnapshot: string | null = null, documentReferrerObserved = false;
/** 只在公开组件中调用；浏览器禁用sessionStorage时同一文档退回内存，提交仍读取当前URL。 */
export function captureBrowserAttribution(): InquiryAttributionInput {
  if (typeof window === 'undefined') return {};
  try {
    if (isPrivateAttributionPath(window.location.pathname)) return {};
    const storage: AttributionStorage = {
      getItem(key) { try { return window.sessionStorage.getItem(key); } catch { return memorySnapshot; } },
      setItem(key, value) { memorySnapshot = value; try { window.sessionStorage.setItem(key, value); } catch { /* 同一文档可使用内存。 */ } },
      removeItem(key) { memorySnapshot = null; try { window.sessionStorage.removeItem(key); } catch { /* 无持久存储可清理。 */ } },
    };
    // SPA导航不会更新document.referrer；一个文档只消费一次，避免站内跳转重写落地页和期限。
    const referrer = documentReferrerObserved ? '' : document.referrer; documentReferrerObserved = true;
    return capturePageAttribution({ href: window.location.href, referrer, storage });
  } catch { return {}; } // 浏览器环境异常只损失来源，不能阻止正常询盘。
}
