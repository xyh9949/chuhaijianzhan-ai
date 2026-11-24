import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AttributionValidationError, ATTRIBUTION_UNVERIFIED_LABEL, SITE_ATTRIBUTION_STORAGE_KEY, SITE_ATTRIBUTION_TTL_MS, captureBrowserAttribution, capturePageAttribution, createInquiryAttribution, inquirySourceLabel, parseInquiryAttributionInput } from '../src/lib/inquiry-attribution';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, listInquiries, patchStudio } from '../src/server/studio';
import { publishSite } from '../src/server/publication';
import { createFormSession, submitPublicForm } from '../src/server/form-submissions';
import { inquiriesCsv } from '../src/server/inquiry-operations';

const now = Date.parse('2026-11-10T00:00:00.000Z');
function memoryStorage() {
  const data = new Map<string, string>(); let writes = 0;
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { writes++; data.set(key, value); }, removeItem: (key: string) => { data.delete(key); }, get writes() { return writes; } };
}

test('来源只接受有限线索，服务器派生分类时间及未经验证标识，缺失不猜直接访问', () => {
  const value = createInquiryAttribution({ utmSource: ' Google ', utmMedium: 'cpc', utmCampaign: '新品 发布', referrerHost: 'SEARCH.EXAMPLE', landingPath: '/products/sample-1' }, 'site.example', now);
  assert.deepEqual(value, { utmSource: 'Google', utmMedium: 'cpc', utmCampaign: '新品 发布', referrerHost: 'search.example', landingPath: '/products/sample-1', channel: 'campaign', capturedAt: new Date(now).toISOString(), source: 'visitor', verification: 'unverified' });
  assert.equal(inquirySourceLabel({ attribution: value }), 'Google');
  assert.equal(createInquiryAttribution({ referrerHost: 'other.example' }, 'site.example', now).channel, 'referral');
  assert.equal(createInquiryAttribution({ referrerHost: 'www.site.example' }, 'site.example', now).channel, 'unknown');
  assert.equal(inquirySourceLabel({ attribution: createInquiryAttribution({}, 'site.example', now) }), '来源未提供');
  assert.equal(inquirySourceLabel({ sourcePath: '/contact' }), '历史未采集');
  assert.equal(inquirySourceLabel({ origin: 'manual' }), '后台人工录入');
  assert.equal(inquirySourceLabel({}), '来源未记录');
});

test('来源校验拒额外字段、控制字符、完整URL、IP、端口、凭据与带查询的落地页', () => {
  const invalid: unknown[] = [null, [], { channel: 'campaign' }, { source: 'verified' }, { capturedAt: '2020-01-01' }, { gclid: 'private-click-id' }, { utmTerm: 'private-search' }, { utmSource: 1 }, { utmSource: 'x'.repeat(121) }, { utmCampaign: 'x'.repeat(201) }, { utmCampaign: 'line\nbreak' }, { utmSource: 'https://source.example/private' }, { landingPath: '/contact?email=private' }, { landingPath: '/contact#private' }, { landingPath: '//host' }, { landingPath: '/private\nvalue' }];
  for (const referrerHost of ['https://search.example/private?email=private', 'search.example/path', 'search.example:443', 'user@search.example', 'search.example\n', '127.0.0.1', '2130706433', '0x7f000001', '[::1]', 'user:pass@search.example']) invalid.push({ referrerHost });
  invalid.push({ utmCampaign: ' //source.example/private' });
  for (const value of invalid) assert.throws(() => parseInquiryAttributionInput(value, 'site.example'), AttributionValidationError);
  assert.deepEqual(parseInquiryAttributionInput({ referrerHost: 'xn--bcher-kva.example.' }, 'site.example'), { referrerHost: 'xn--bcher-kva.example' });
});

test('活动同标签页跨页保留原落地页和期限，只保存三项UTM及主机纯路径', () => {
  const storage = memoryStorage();
  const first = capturePageAttribution({ href: 'https://site.example/products?utm_source=google&utm_medium=cpc&utm_campaign=launch&utm_term=private&gclid=private#private', referrer: 'https://search.example/private?email=private', storage, now });
  assert.deepEqual(first, { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'launch', referrerHost: 'search.example', landingPath: '/products' });
  const raw = storage.getItem(SITE_ATTRIBUTION_STORAGE_KEY)!;
  for (const forbidden of ['private', 'https:', 'utm_term', 'gclid', '#', '?']) assert.equal(raw.includes(forbidden), false);
  assert.deepEqual(capturePageAttribution({ href: 'https://site.example/contact', referrer: 'https://site.example/products?private=x', storage, now: now + 60000 }), first);
  assert.equal(storage.writes, 1);
  assert.equal(storage.getItem(SITE_ATTRIBUTION_STORAGE_KEY), raw);
  // 同一文档提交时不再次提供外部referrer，也不丢失首次捕获的主机。
  assert.deepEqual(capturePageAttribution({ href: 'https://site.example/products?utm_source=google&utm_medium=cpc&utm_campaign=launch', storage, now: now + 120000 }), first);
  assert.equal(storage.writes, 1);
});

test('新显式活动和新外部引荐可以替换旧来源，过期活动不会沿用', () => {
  const storage = memoryStorage();
  capturePageAttribution({ href: 'https://site.example/?utm_source=first&utm_medium=cpc&utm_campaign=old', storage, now });
  assert.deepEqual(capturePageAttribution({ href: 'https://site.example/new?utm_source=second', storage, now: now + 1 }), { utmSource: 'second', landingPath: '/new' });
  assert.deepEqual(capturePageAttribution({ href: 'https://site.example/contact', referrer: 'https://new.example/article?private=x', storage, now: now + 2 }), { referrerHost: 'new.example', landingPath: '/contact' });
  assert.deepEqual(capturePageAttribution({ href: 'https://site.example/quote', storage, now: now + 2 + SITE_ATTRIBUTION_TTL_MS }), {});
  assert.equal(storage.getItem(SITE_ATTRIBUTION_STORAGE_KEY), null);
  storage.setItem(SITE_ATTRIBUTION_STORAGE_KEY, JSON.stringify({ version: 1, expiresAt: now + SITE_ATTRIBUTION_TTL_MS + 1, attribution: { utmSource: 'future' } }));
  assert.deepEqual(capturePageAttribution({ href: 'https://site.example/', storage, now }), {});
});

test('存储禁用仍可读取当前URL，后台与预览从不读写来源存储', () => {
  let attempts = 0;
  const storage = { getItem() { attempts++; throw new Error('disabled'); }, setItem() { attempts++; throw new Error('disabled'); }, removeItem() { attempts++; throw new Error('disabled'); } };
  assert.deepEqual(capturePageAttribution({ href: 'https://site.example/?utm_source=current', referrer: 'https://outside.example/path', storage, now }), { utmSource: 'current', referrerHost: 'outside.example', landingPath: '/' });
  attempts = 0;
  for (const path of ['/admin', '/admin/settings', '/preview/contact', '/preview/~starter/services', '/api/inquiries']) assert.deepEqual(capturePageAttribution({ href: `https://site.example${path}?utm_source=forbidden`, storage, now }), {});
  assert.equal(attempts, 0);
  assert.deepEqual(capturePageAttribution({ href: 'not a URL', storage, now }), {});
  assert.deepEqual(capturePageAttribution({ href: 'https://site.example/contact', referrer: 'https://127.0.0.1/private', storage, now }), {});
});

test('浏览器禁用sessionStorage时同一文档内仍保留有限来源，后台不触碰浏览器存储', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const location = { href: 'https://site.example/landing?utm_source=memory', pathname: '/landing' }; let attempts = 0;
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, get sessionStorage() { attempts++; throw new Error('disabled'); } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: 'https://outside.example/private' } });
    const first = captureBrowserAttribution();
    assert.deepEqual(first, { utmSource: 'memory', referrerHost: 'outside.example', landingPath: '/landing' });
    location.href = 'https://site.example/contact'; location.pathname = '/contact';
    assert.deepEqual(captureBrowserAttribution(), first);
    location.href = 'https://site.example/admin?utm_source=forbidden'; location.pathname = '/admin'; attempts = 0;
    assert.deepEqual(captureBrowserAttribution(), {}); assert.equal(attempts, 0);
    location.pathname = '/contact'; Object.defineProperty(location, 'href', { get() { throw new Error('browser unavailable'); } });
    assert.deepEqual(captureBrowserAttribution(), {});
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

function withPublicForm(run: (request: () => Request, session: () => string) => void) {
  const previous = { ...process.env }, directory = mkdtempSync(join(tmpdir(), 'form-studio-attribution-'));
  try {
    process.env.FORM_STUDIO_DATA_DIR = directory; process.env.BETTER_AUTH_SECRET = randomBytes(48).toString('base64url'); process.env.BETTER_AUTH_URL = 'https://attribution.example.invalid'; process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock'; process.env.FORM_STUDIO_TRUST_PROXY = 'false';
    const draft = getDraftRecord();
    patchStudio({ expectedRevision: draft.revision, patch: { forms: [{ id: 'attribution-form', name: 'Attribution fixture', enabled: true, submitLabel: 'Send', successMessage: 'Received', fields: [{ id: 'name', label: 'Name', type: 'text', mapTo: 'name', required: true }, { id: 'email', label: 'Email', type: 'email', mapTo: 'email', required: true }] }], editorData: { ...draft.content.editorData, home: { root: { props: { showChrome: 'no' } }, content: [{ type: 'Form', props: { id: 'attribution-node', formId: 'attribution-form' } }] } } } });
    publishSite({ expectedRevision: getDraftRecord().revision, baseReleaseId: getStudioEnvelope().activeReleaseId, pageIds: ['home'], productIds: [], includeForms: true, includeTheme: true, includeSettings: true }, { id: 'attribution-admin', name: '来源验收' });
    const request = () => new Request(`${process.env.BETTER_AUTH_URL}/api/public/forms/attribution-form`, { method: 'POST', headers: { Origin: process.env.BETTER_AUTH_URL! } });
    run(request, () => createFormSession('attribution-form', { sourcePath: '/' }, request(), now).token);
  } finally {
    getDatabase().close();
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
    if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-attribution-`)) rmSync(directory, { recursive: true, force: true });
  }
}
const answers = { name: 'Attribution visitor', email: 'attribution@example.invalid' };

test('公开表单独立接收来源，签名仍为纯路径，历史回执哈希和来源不可被重试改写', () => withPublicForm((request, session) => {
  assert.throws(() => createFormSession('attribution-form', { sourcePath: '/?utm_source=google' }, request(), now), /source/);
  assert.throws(() => createFormSession('attribution-form', { sourcePath: '/', attribution: { utmSource: 'google' } }, request(), now), /source/);
  const token = session(), payload = { token, answers, honeypot: '', attribution: { utmSource: '=campaign', utmMedium: 'cpc', utmCampaign: '@launch', referrerHost: 'outside.example', landingPath: '/products' } };
  const result = submitPublicForm('attribution-form', payload, request(), now + 2000), item = listInquiries()[0];
  assert.equal(item.sourcePath, '/'); assert.equal(item.origin, 'website'); assert.equal(item.attribution?.utmSource, '=campaign'); assert.equal(item.attribution?.channel, 'campaign'); assert.equal(item.attribution?.verification, 'unverified');
  assert.deepEqual(submitPublicForm('attribution-form', { token, answers }, request(), now + 86400000), result);
  assert.deepEqual(submitPublicForm('attribution-form', { ...payload, attribution: { utmSource: 'changed' } }, request(), now + 86400000), result);
  assert.equal(listInquiries().length, 1); assert.deepEqual(listInquiries()[0].attribution, item.attribution);
  const csv = inquiriesCsv({});
  assert.ok(csv.startsWith('\ufeff"联系人","公司","邮箱"')); assert.ok(csv.includes('"\'=campaign"')); assert.ok(csv.includes('"\'@launch"')); assert.ok(csv.includes(ATTRIBUTION_UNVERIFIED_LABEL));
  assert.throws(() => inquiriesCsv({ followUpFilter: 'mine' }), /跟进导出/);
  assert.throws(() => inquiriesCsv({ followUpFilter: ['all'] }), /跟进导出/);
  assert.throws(() => inquiriesCsv({ actorId: 'forged', followUpFilter: 'mine' }, 'real'), /导出筛选/);
  getDatabase().prepare('UPDATE cms_inquiry SET payload_json=? WHERE id=?').run(JSON.stringify({ ...item, assignee: { id: 'real', name: '=Owner' }, priority: 'urgent', qualification: 'qualified', nextFollowUpAt: new Date(now - 1000).toISOString() }), item.id);
  assert.ok(inquiriesCsv({ followUpFilter: 'mine' }, 'real', now).includes('"\'=Owner"'));
  assert.equal(inquiriesCsv({ followUpFilter: 'mine' }, 'other', now).split('\r\n').length, 1);
  assert.ok(inquiriesCsv({ followUpFilter: 'overdue' }, 'real', now).includes('Attribution visitor'));
  assert.ok(inquiriesCsv({ followUpFilter: 'priority' }, 'real', now).includes('Attribution visitor'));
}));

test('公开来源元数据不能注入验证标识，未知新提交可接收且不被误称直接访问', () => withPublicForm((request, session) => {
  for (const attribution of [null, { referrerHost: '127.0.0.1' }, { referrerHost: 'https://outside.example' }, { source: 'verified' }, { landingPath: '/?private=x' }]) assert.throws(() => submitPublicForm('attribution-form', { token: session(), answers, attribution }, request(), now + 2000), error => (error as { status: number }).status === 422);
  assert.equal(listInquiries().length, 0);
  submitPublicForm('attribution-form', { token: session(), answers }, request(), now + 2000);
  assert.equal(inquirySourceLabel(listInquiries()[0]), '来源未提供');
  assert.equal(listInquiries()[0].attribution?.channel, 'unknown');
}));
