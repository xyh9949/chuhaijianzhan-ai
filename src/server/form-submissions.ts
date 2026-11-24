import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FormDefinition, Inquiry, InquiryItem } from '../lib/types';
import { publicSiteOrigin } from '../lib/site-seo';
import { formProductAvailable, resolvePublicForm } from '../lib/site-form-availability';
import { MAX_INQUIRY_ITEMS, MAX_INQUIRY_QUANTITY, MAX_INQUIRY_REQUIREMENTS, type InquiryItemInput } from '../lib/inquiry-items';
import { AttributionValidationError, createInquiryAttribution } from '../lib/inquiry-attribution';
import { getDatabase } from './database';
import { getAuthEnvironment } from './env';
import { ApiError } from './http';
import { getActiveSiteSnapshot } from './publication';
import type { SiteSnapshot } from './types';
import { enqueueNotification } from './notification-jobs';

type Token = { version: 1; formId: string; releaseId: string; sourcePath: string; visitId: string; issuedAt: number; nonce: string };
export class FormThrottleError extends ApiError { constructor(message: string, public readonly retryAfter: number) { super(429, message); } }
export class FormSubmissionError extends ApiError { constructor(status: number, message: string, public readonly code: 'FORM_VERSION_CHANGED' | 'SUBMISSION_CONFLICT') { super(status, message); } }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (purpose: string, value: string) => createHmac('sha256', getAuthEnvironment().secret).update(`${purpose}:${value}`).digest('base64url');
const validPath = (v: unknown): v is string => typeof v === 'string' && v.length <= 400 && /^\/[a-zA-Z0-9/_-]*$/.test(v) && !v.includes('//');
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function signToken(payload: Token) { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${encoded}.${hash('form-token', encoded)}`; }
function decodeToken(value: unknown, formId: string, now: number): Token {
  if (typeof value !== 'string' || value.length > 4096 || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(value)) throw new ApiError(403, 'Please refresh the form and try again.');
  const [encoded, signature] = value.split('.');
  if (!equal(signature, hash('form-token', encoded))) throw new ApiError(403, 'Please refresh the form and try again.');
  let token: Token;
  try { token = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new ApiError(403, 'The form session is invalid.'); }
  if (!record(token) || token.version !== 1 || token.formId !== formId || typeof token.releaseId !== 'string' || !validPath(token.sourcePath) || typeof token.visitId !== 'string' || !/^[a-f0-9-]{36}$/.test(token.visitId) || typeof token.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(token.nonce) || !Number.isSafeInteger(token.issuedAt) || token.issuedAt > now + 5000) throw new ApiError(403, 'The form session is invalid.');
  return token;
}
function publicOrigin(snapshot: SiteSnapshot) { return publicSiteOrigin(snapshot.settings.publicUrl) || getAuthEnvironment().baseURL; }
function assertPublicOrigin(request: Request, snapshot: SiteSnapshot) { if (request.headers.get('origin') !== publicOrigin(snapshot)) throw new ApiError(403, 'The request origin is not allowed.'); }
function visitIdentity(request: Request) {
  const cookie = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith('form_studio_visit='))?.slice('form_studio_visit='.length);
  if (cookie) { const [id, signature] = cookie.split('.'); if (/^[a-f0-9-]{36}$/.test(id) && signature && equal(signature, hash('form-visit', id))) return id; }
  return randomUUID();
}
function consumeRate(key: string, limit: number, duration: number, now: number) {
  const db = getDatabase(), window = Math.floor(now / duration), bucket = `${key}:${window}`;
  db.transaction(() => {
    db.prepare('DELETE FROM cms_public_rate WHERE expires_at<?').run(now);
    const current = db.prepare('SELECT count FROM cms_public_rate WHERE bucket=?').get(bucket) as { count: number } | undefined;
    if ((current?.count || 0) >= limit) throw new FormThrottleError('Too many requests. Please try again later.', Math.max(1, Math.ceil(((window + 1) * duration - now) / 1000)));
    db.prepare('INSERT INTO cms_public_rate(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1').run(bucket, (window + 2) * duration);
  }).immediate();
}
function clientRateKey(request: Request) {
  // 只有显式信任且由反向代理覆盖的IP头可用于额外限流，不把任意客户端Header当真实IP。
  if (process.env.FORM_STUDIO_TRUST_PROXY !== 'true') return;
  const address = request.headers.get('x-forwarded-for')?.split(',')[0].trim();
  return address && isIP(address) ? hash('form-ip', address) : undefined;
}
/** 只沿当前页面实际引用图查表单，包含全站头尾及循环卡片，不借用未引用的草稿资产。 */
export function formAvailableAt(snapshot: SiteSnapshot, formId: string, path: string): boolean {
  return !!resolvePublicForm(snapshot, formId, path);
}
export function createFormSession(formId: string, value: unknown, request: Request, now = Date.now()) {
  const snapshot = getActiveSiteSnapshot();
  if (!snapshot?.releaseId) throw new ApiError(404, 'The form is not available.');
  assertPublicOrigin(request, snapshot);
  if (!record(value) || Object.keys(value).some(k => k !== 'sourcePath') || !validPath(value.sourcePath)) throw new ApiError(422, 'The form source is invalid.');
  const source = resolvePublicForm(snapshot, formId, value.sourcePath);
  if (!source) throw new ApiError(404, 'The form is not available on this page.');
  const { form, locale } = source;
  const visitId = visitIdentity(request), client = clientRateKey(request);
  consumeRate('form-session-global', 1000, 600000, now); consumeRate(`form-session-${hash('visit', visitId)}`, 30, 600000, now);
  if (client) consumeRate(`form-session-ip-${client}`, 60, 600000, now);
  const token = signToken({ version: 1, formId, releaseId: snapshot.releaseId, sourcePath: value.sourcePath, visitId, issuedAt: now, nonce: randomUUID() });
  return { token, minDelayMs: 1100, form, products: snapshot.products.filter(p => formProductAvailable(snapshot.settings, p, locale)).map(p => ({ id: p.id, name: p.name, ...(form.multiProduct ? { sku: p.sku } : {}) })), cookie: `form_studio_visit=${visitId}.${hash('form-visit', visitId)}; Path=/api/public; HttpOnly; SameSite=Lax; Max-Age=3600${publicOrigin(snapshot).startsWith('https:') ? '; Secure' : ''}` };
}

/** 哈希只包含访客填入的清单，公开产品改名或回退时仍可找回原提交回执。 */
function parseInquiryItems(value: unknown): InquiryItemInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INQUIRY_ITEMS) throw new ApiError(422, `Choose between 1 and ${MAX_INQUIRY_ITEMS} products.`);
  const productIds = new Set<string>();
  return value.map(line => {
    if (!record(line) || Object.keys(line).some(key => !['productId', 'quantity', 'requirements'].includes(key))) throw new ApiError(422, 'Review the product selection and quantities.');
    const { productId, quantity, requirements } = line;
    if (typeof productId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(productId) || productIds.has(productId)) throw new ApiError(422, 'Choose each available product only once.');
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_INQUIRY_QUANTITY) throw new ApiError(422, `Enter a whole quantity between 1 and ${MAX_INQUIRY_QUANTITY}.`);
    if (requirements !== undefined && (typeof requirements !== 'string' || requirements.length > MAX_INQUIRY_REQUIREMENTS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(requirements))) throw new ApiError(422, `Review the requirements. Use up to ${MAX_INQUIRY_REQUIREMENTS} characters per product.`);
    const detail = requirements?.trim();
    productIds.add(productId);
    return { productId, quantity, ...(detail ? { requirements: detail } : {}) };
  });
}

function inquiryItemsFor(form: FormDefinition, input: InquiryItemInput[] | undefined, snapshot: SiteSnapshot, locale: string): InquiryItem[] | undefined {
  if (!form.multiProduct) {
    if (input) throw new ApiError(422, 'This form does not accept a list of products.');
    return undefined;
  }
  if (!input) throw new ApiError(422, 'Add at least one product to your inquiry.');
  // 只信本次签名所绑定的公开快照和页面语言，清单的型号及名称独立于日后改名和回退。
  return input.map(line => {
    const product = snapshot.products.find(item => item.id === line.productId && formProductAvailable(snapshot.settings, item, locale));
    if (!product) throw new ApiError(422, 'A selected product is no longer available. Review your product list.');
    return { ...line, sku: product.sku, name: product.name };
  });
}

function answersFor(form: FormDefinition, input: Record<string, unknown>, snapshot: SiteSnapshot, locale: string) {
  if (Object.keys(input).some(id => !form.fields.some(f => f.id === id))) throw new ApiError(422, 'The form contains an unknown field.');
  return form.fields.map(field => {
    const raw = input[field.id], present = Object.hasOwn(input, field.id);
    if (!present && field.required) throw new ApiError(422, `${field.label}: This field is required.`);
    if (!present) return { id: field.id, label: field.label, type: field.type, value: null };
    if (field.type === 'checkbox') { if (typeof raw !== 'boolean' || field.required && !raw) throw new ApiError(422, `${field.label}: Please confirm this field.`); return { id: field.id, label: field.label, type: field.type, value: raw }; }
    if (typeof raw !== 'string') throw new ApiError(422, `${field.label}: Invalid value.`);
    const value = raw.trim(), max = Math.min(field.maxLength || (field.type === 'textarea' ? 4000 : 2000), field.type === 'email' ? 254 : field.type === 'phone' ? 40 : field.type === 'country' ? 100 : 10000);
    if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || field.required && !value) throw new ApiError(422, `${field.label}: Please check the value or length.`);
    if (field.type !== 'textarea' && /[\r\n]/.test(value)) throw new ApiError(422, `${field.label}: Line breaks are not allowed.`);
    if (value && field.type === 'email' && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) throw new ApiError(422, `${field.label}: Please enter a valid email.`);
    if (value && field.type === 'phone' && !/^[+()0-9 .x#-]{5,40}$/.test(value)) throw new ApiError(422, `${field.label}: Please enter a phone number.`);
    if (value && field.type === 'select' && !field.options?.some(o => o.id === value)) throw new ApiError(422, `${field.label}: Please choose an available option.`);
    if (value && field.type === 'product' && !snapshot.products.some(p => p.id === value && formProductAvailable(snapshot.settings, p, locale))) throw new ApiError(422, `${field.label}: Please choose an available product.`);
    const displayValue = value && field.type === 'product' ? snapshot.products.find(p => p.id === value)?.name : value && field.type === 'select' ? field.options?.find(o => o.id === value)?.label : undefined;
    return { id: field.id, label: field.label, type: field.type, value, ...(displayValue ? { displayValue } : {}) };
  });
}
/** 先验证、再在同一事务写询盘/回执/通知任务；成功只表示已持久接收，不表示邮件已送达。 */
export function submitPublicForm(formId: string, value: unknown, request: Request, now = Date.now()) {
  if (!record(value) || Object.keys(value).some(k => !['token', 'answers', 'honeypot', 'attribution', 'items'].includes(k)) || !record(value.answers) || value.honeypot !== undefined && typeof value.honeypot !== 'string') throw new ApiError(422, 'Please review the form and try again.');
  const token = decodeToken(value.token, formId, now), snapshot = getActiveSiteSnapshot();
  if (!snapshot) throw new ApiError(404, 'The form is not available.');
  assertPublicOrigin(request, snapshot);
  if (value.honeypot) throw new ApiError(422, 'Please review the form and try again.');
  const requestedItems = parseInquiryItems(value.items);
  const sortedAnswers = Object.fromEntries(Object.entries(value.answers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  // 未启用清单的旧回执仍按原算法读取；附带清单后，修改任一行必须走新的提交。
  const payloadHash = hash('form-payload', JSON.stringify(requestedItems ? [sortedAnswers, requestedItems] : sortedAnswers));
  const db = getDatabase();
  const existing = db.prepare('SELECT payload_hash,response_json FROM cms_form_submission WHERE nonce=?').get(token.nonce) as { payload_hash: string; response_json: string } | undefined;
  if (existing) { if (!equal(existing.payload_hash, payloadHash)) throw new FormSubmissionError(409, 'An earlier version of this inquiry was already received. Changed answers were not sent.', 'SUBMISSION_CONFLICT'); return JSON.parse(existing.response_json); }
  // 过期令牌仍可核对已持久回执，但不能创建新提交；网络中断后延迟重试也不会丢失接收事实。
  if (now - token.issuedAt > 3600000) throw new ApiError(410, 'The form session expired. Your input is preserved; please try again.');
  if (now - token.issuedAt < 1000) throw new FormThrottleError('Please wait a moment before submitting.', 1);
  if (snapshot.releaseId !== token.releaseId) throw new FormSubmissionError(409, 'The website changed. Your input is preserved; please review the refreshed form.', 'FORM_VERSION_CHANGED');
  const source = resolvePublicForm(snapshot, formId, token.sourcePath);
  if (!source) throw new ApiError(404, 'The form is not available.');
  const { form, locale } = source;
  consumeRate('form-submit-global', 240, 600000, now); consumeRate(`form-submit-${hash('visit', token.visitId)}`, 5, 600000, now);
  const client = clientRateKey(request); if (client) consumeRate(`form-submit-ip-${client}`, 10, 600000, now);
  const items = inquiryItemsFor(form, requestedItems, snapshot, locale);
  const primary = items?.[0];
  // 启用清单后，由第一款填充原表单中映射到产品的选择器。其余自定义表单字段独立验证。
  const productField = primary && form.fields.find(field => field.type === 'product' && field.mapTo === 'product');
  const answers = answersFor(form, primary && productField ? { ...value.answers, [productField.id]: primary.productId } : value.answers, snapshot, locale);
  const mapped: Record<string, string> = {};
  for (const field of form.fields) { const answer = answers.find(a => a.id === field.id); if (field.mapTo && typeof answer?.value === 'string') mapped[field.mapTo] = field.type === 'select' ? field.options?.find(o => o.id === answer.value)?.label || answer.value : answer.value; }
  const product = snapshot.products.find(p => p.id === mapped.product) || source.page.product;
  // 来源是额外的未验证线索，不参与签名路径、答案哈希和旧回执核对；只随首次成功接收写入。
  let attribution;
  try { attribution = createInquiryAttribution(value.attribution === undefined ? {} : value.attribution, new URL(publicOrigin(snapshot)).hostname, now); }
  catch (error) { if (error instanceof AttributionValidationError) throw new ApiError(422, error.message); throw error; }
  const item: Inquiry = { id: `iq-${randomUUID()}`, name: mapped.name || '', company: mapped.company || '', email: mapped.email || '', phone: mapped.phone || '', country: mapped.country || '', product: primary?.name ?? product?.name ?? '', productId: primary?.productId ?? product?.id, ...(items ? { items } : {}), message: mapped.message || '', date: new Date(now).toISOString(), status: 'new', notes: '', origin: 'website', formId, formName: form.name, releaseId: token.releaseId, sourcePath: token.sourcePath, locale, answers, attribution };
  const response = { received: true, message: form.successMessage };
  return db.transaction(() => {
    // 并发重复点击在取得写锁后再查一次；重复回执不会新增询盘或通知。
    const duplicate = db.prepare('SELECT payload_hash,response_json FROM cms_form_submission WHERE nonce=?').get(token.nonce) as { payload_hash: string; response_json: string } | undefined;
    if (duplicate) { if (!equal(duplicate.payload_hash, payloadHash)) throw new FormSubmissionError(409, 'An earlier inquiry was already received. Changed answers were not sent.', 'SUBMISSION_CONFLICT'); return JSON.parse(duplicate.response_json); }
    const active = db.prepare('SELECT active_release_id FROM cms_runtime WHERE id=1').get() as { active_release_id: string | null };
    if (active.active_release_id !== token.releaseId) throw new FormSubmissionError(409, 'The website changed. Please review the refreshed form.', 'FORM_VERSION_CHANGED');
    db.prepare('INSERT INTO cms_inquiry(id,revision,payload_json,created_at,updated_at) VALUES(?,0,?,?,?)').run(item.id, JSON.stringify(item), item.date, item.date);
    db.prepare('INSERT INTO cms_form_submission(nonce,form_id,payload_hash,response_json,inquiry_id,created_at) VALUES(?,?,?,?,?,?)').run(token.nonce, formId, payloadHash, JSON.stringify(response), item.id, item.date);
    enqueueNotification(item.id, now);
    return response;
  }).immediate();
}
