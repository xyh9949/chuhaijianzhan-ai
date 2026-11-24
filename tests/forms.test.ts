import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import type { FormDefinition } from '../src/lib/types';
import { formContentErrors, csvDocument } from '../src/lib/form-content';
import { publicMultiProductInquiryPath } from '../src/lib/site-form-availability';
import { createSiteConfig } from '../src/lib/site-render-config';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio, listInquiries, readRelease, createInquiry, updateInquiry } from '../src/server/studio';
import { activateRelease, previewPublication, publishSite, restoreDraft } from '../src/server/publication';
import { createFormSession, formAvailableAt, submitPublicForm } from '../src/server/form-submissions';
import { listNotificationJobs, processNotificationJob, retryNotification, notificationMail, notificationStatus } from '../src/server/notification-jobs';
import { getInquiryPolicy, saveInquiryPolicy, previewInquiryCleanup, applyInquiryCleanup, deleteInquiryRecord, inquiriesCsv } from '../src/server/inquiry-operations';

const actor = { id: 'forms-admin', name: '表单验收' }, now = Date.parse('2026-11-07T00:00:00.000Z');
let directory = ''; let previous: NodeJS.ProcessEnv;
beforeEach(() => { previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'form-studio-forms-')); process.env.FORM_STUDIO_DATA_DIR = directory; process.env.BETTER_AUTH_SECRET = randomBytes(48).toString('base64url'); process.env.BETTER_AUTH_URL = 'https://forms.example.invalid'; process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock'; process.env.FORM_STUDIO_TRUST_PROXY = 'false'; });
afterEach(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-forms-`)) rmSync(directory, { recursive: true, force: true }); });
const definition = (): FormDefinition => ({ id: 'contact', name: 'Contact inquiry', enabled: true, submitLabel: 'Send inquiry', successMessage: 'Your inquiry has been received.', fields: [
  { id: 'name', label: 'Name', type: 'text', mapTo: 'name', required: true, maxLength: 100 }, { id: 'email', label: 'Email', type: 'email', mapTo: 'email', required: true, maxLength: 254 },
  { id: 'message', label: 'Message', type: 'textarea', mapTo: 'message', required: true, maxLength: 2000 }, { id: 'company', label: 'Company', type: 'text', mapTo: 'company', required: false },
  { id: 'country', label: 'Country', type: 'country', mapTo: 'country', required: false }, { id: 'phone', label: 'Phone', type: 'phone', mapTo: 'phone', required: false },
  { id: 'product', label: 'Product', type: 'product', mapTo: 'product', required: false }, { id: 'choice', label: 'Request type', type: 'select', required: false, options: [{ id: 'quote', label: 'Request a quote' }, { id: 'sample', label: 'Request a sample' }] },
  { id: 'confirm', label: 'Confirmation', type: 'checkbox', required: false },
] });
const answers = () => ({ name: 'Test visitor', email: 'visitor@example.invalid', message: 'A synthetic inquiry for verification.', product: 'p1', choice: 'quote', confirm: false });
function request(cookie?: string, origin = process.env.BETTER_AUTH_URL!) { return new Request(`${process.env.BETTER_AUTH_URL}/api/public/forms/contact`, { method: 'POST', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } }); }
function save(patch: object) { return patchStudio({ expectedRevision: getDraftRecord().revision, patch }); }
function selection(extra: object = {}) { return { expectedRevision: getDraftRecord().revision, baseReleaseId: getStudioEnvelope().activeReleaseId, pageIds: ['home', 'product-detail'], productIds: ['p1'], includeForms: true, includeTheme: true, includeSettings: true, ...extra }; }
function setup(form = definition(), scope: object = {}) {
  const draft = getDraftRecord().content;
  save({ forms: [form], editorData: { ...draft.editorData, home: { root: { props: { title: 'Form test', showChrome: 'no' } }, content: [{ type: 'Form', props: { id: 'contact-node', formId: 'contact', design: { desktop: { display: 'grid', columns: 2, gap: 20 }, mobile: { columns: 1 } }, fieldDesign: { desktop: { borderRadius: 8 } }, submitDesign: { desktop: { backgroundColor: '#123d66' } } } }] } } });
  return publishSite(selection(scope), actor);
}
function session(cookie?: string, at = now) { return createFormSession('contact', { sourcePath: '/' }, request(cookie), at); }
function submit(token: string, values: object = answers(), at = now + 2000) { return submitPublicForm('contact', { token, answers: values, honeypot: '' }, request(), at); }

test('表单定义保护字段稳定ID、资料映射、公开配置白名单和引用删除', () => {
  const form = definition(), base = { forms: [form], editorData: {} };
  assert.deepEqual(formContentErrors(base), []);
  assert.deepEqual(formContentErrors({ ...base, forms: [{ ...form, multiProduct: true }] }), []);
  assert.ok(formContentErrors({ ...base, forms: [{ ...form, multiProduct: 'true' } as never] }).length);
  for (const mapTo of ['constructor', { toString: 'bad' }, 'unknown']) assert.ok(formContentErrors({ ...base, forms: [{ ...form, fields: [{ ...form.fields[0], mapTo }] } as never] }).length);
  assert.ok(formContentErrors({ ...base, forms: [{ ...form, recipient: 'attacker@example.invalid' } as never] }).length);
  assert.ok(formContentErrors({ ...base, forms: [{ ...form, fields: [{ ...form.fields[0], id: '__proto__' }] }] }).length);
  assert.ok(formContentErrors({ ...base, forms: [{ ...form, fields: [form.fields[0], form.fields[0]] }] }).length);
  assert.ok(formContentErrors({ forms: [], editorData: { home: { content: [{ type: 'Form', props: { formId: form.id } }] } } }).length);
  setup(); const revision = getDraftRecord().revision; assert.throws(() => save({ forms: [] }), /表单不存在/); assert.equal(getDraftRecord().revision, revision);
});

test('协议9无表单的展示组件快照可激活和恢复，运行询盘不受影响', () => {
  const draft = getDraftRecord().content;
  save({ editorData: { ...draft.editorData, home: { root: { props: { showChrome: 'no' } }, content: [{ type: 'RichText', props: { id: 'legacy-rich', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy protocol 9' }] }] } } }] } } });
  const first = publishSite(selection({ includeForms: false }), actor), legacy = structuredClone(readRelease(first.releaseId));
  // 明确去掉协议10新增定义；历史表示只含协议9已有的结构化正文，不用新Form节点冒充旧数据。
  legacy.schemaVersion = 9; legacy.releaseId = 'legacy-forms-v9'; delete legacy.forms;
  getDatabase().prepare('INSERT INTO cms_release(id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES(?,?,?,?,9,9,?,?,?,?)').run(legacy.releaseId, '协议9兼容资料', JSON.stringify(legacy), 'legacy-v9-fixture', actor.id, actor.name, new Date().toISOString(), JSON.stringify({ pageIds: ['home'] }));
  setup(); const inquiry = createInquiry({ name: 'Legacy manual visitor', email: 'legacy@example.invalid', message: 'Synthetic compatibility record' });
  activateRelease(legacy.releaseId, { expectedActiveReleaseId: getStudioEnvelope().activeReleaseId }, actor);
  restoreDraft(legacy.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: ['home'], includeForms: true }, actor);
  assert.deepEqual(getDraftRecord().content.editorData.home, legacy.editorData.home); assert.deepEqual(getDraftRecord().content.forms, []);
  assert.ok(listInquiries().some(i => i.id === inquiry.item.id)); assert.equal(listNotificationJobs().length, 0);
});
test('真实匿名提交事务保存完整答案与单一通知，重复及延迟回执不产生第二条', () => {
  setup(); const token = session().token; const result = submit(token);
  assert.deepEqual(Object.keys(result).sort(), ['message', 'received']); assert.equal(result.received, true);
  const items = listInquiries(); assert.equal(items.length, 1); assert.equal(listNotificationJobs().length, 1);
  assert.equal(items[0].answers!.find(a => a.id === 'confirm')!.value, false); assert.equal(items[0].answers!.find(a => a.id === 'country')!.value, null);
  assert.equal(items[0].answers!.find(a => a.id === 'choice')!.displayValue, 'Request a quote'); assert.equal(items[0].productId, 'p1'); assert.equal(items[0].sourcePath, '/');
  assert.deepEqual(submit(token), result); assert.deepEqual(submit(token, answers(), now + 86400000), result);
  assert.throws(() => submit(token, { ...answers(), message: 'Changed answers' }), /already received/); assert.equal(listInquiries().length, 1);
  getDatabase().close(); assert.equal(listInquiries().length, 1); assert.equal(listNotificationJobs().length, 1);
});

test('多产品询价沿用签名会话，一次保存清单、回执和通知，换型号和回退后保留原始资料', () => {
  const form = { ...definition(), multiProduct: true };
  form.fields.find(field => field.mapTo === 'product')!.required = true;
  const first = setup(form, { productIds: ['p1', 'p2'] });
  const started = session(), unused = session();
  const [p1, p2] = readRelease(first.releaseId).products;
  assert.deepEqual(started.products, [p1, p2].map(p => ({ id: p.id, name: p.name, sku: p.sku })));
  const { product: _hiddenProduct, ...contact } = answers();
  const payload = { token: started.token, answers: contact, items: [{ productId: p2.id, quantity: 7, requirements: '  Blue\nPackaging A  ' }, { productId: p1.id, quantity: 35 }] };
  const received = submitPublicForm(form.id, payload, request(), now + 2000);
  assert.equal(received.received, true);
  const initial = listInquiries()[0];
  assert.equal(initial.product, p2.name);
  assert.equal(initial.productId, p2.id);
  assert.equal(initial.answers?.find(answer => answer.id === 'product')?.value, p2.id);
  assert.deepEqual(initial.items, [{ productId: p2.id, sku: p2.sku, name: p2.name, quantity: 7, requirements: 'Blue\nPackaging A' }, { productId: p1.id, sku: p1.sku, name: p1.name, quantity: 35 }]);
  assert.deepEqual(submitPublicForm(form.id, { ...payload, items: payload.items.map(line => ({ requirements: line.requirements?.trim(), quantity: line.quantity, productId: line.productId })) }, request(), now + 2500), received);
  assert.throws(() => submitPublicForm(form.id, { ...payload, items: [{ ...payload.items[0], quantity: 8 }, payload.items[1]] }, request(), now + 2600), { code: 'SUBMISSION_CONFLICT' });
  assert.equal(listNotificationJobs(initial.id).length, 1);
  assert.equal(listInquiries().length, 1);

  const current = getDraftRecord().content;
  save({ products: current.products.map(product => product.id === p2.id ? { ...product, sku: 'NEW-RELEASE-SKU', name: 'Panel sofa renamed' } : product) });
  const next = publishSite(selection({ pageIds: [], productIds: [p2.id], includeForms: false, includeTheme: false, includeSettings: false }), actor);
  assert.throws(() => submitPublicForm(form.id, { ...payload, token: unused.token }, request(), now + 3000), { code: 'FORM_VERSION_CHANGED' });
  assert.deepEqual(submitPublicForm(form.id, payload, request(), now + 86400000), received);
  activateRelease(first.releaseId, { expectedActiveReleaseId: next.releaseId }, actor);
  assert.deepEqual(listInquiries()[0].items, initial.items);
  assert.ok(notificationMail(listInquiries()[0]).text.includes(`${p2.name} [${p2.sku}] × 7 — Blue\nPackaging A`));
  const csv = inquiriesCsv({ search: p1.sku });
  assert.ok(csv.includes(`${p1.name} [${p1.sku}] × 35`));
  assert.equal(listNotificationJobs(initial.id).length, 1);
});

test('多产品询价拒绝空清单、重复行、伪造快照、其他语言或未发布产品', () => {
  const draft = getDraftRecord().content;
  const german = { ...draft.products[0], id: 'rfq-product-de', name: 'Stuhl', sku: 'RFQ-DE', locale: 'de' };
  save({ settings: { ...draft.settings, locales: [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }] }, products: [...draft.products, german] });
  const form = { ...definition(), multiProduct: true };
  setup(form, { productIds: ['p1', 'p2', german.id] });
  const valid = { productId: 'p1', quantity: 1 };
  for (const items of [undefined, [], [valid, valid], [{ ...valid, sku: 'forged' }], [{ ...valid, quantity: 1.5 }], [{ ...valid, quantity: 1_000_001 }], [{ ...valid, requirements: 'a'.repeat(501) }], [{ ...valid, productId: german.id }], [{ ...valid, productId: 'p3' }]]) {
    assert.throws(() => submitPublicForm(form.id, { token: session().token, answers: answers(), items }, request(), now + 2000), { status: 422 });
  }
  assert.deepEqual(listInquiries(), []);
  assert.deepEqual(listNotificationJobs(), []);
  save({ forms: [definition()] });
  publishSite(selection({ pageIds: [], includeForms: true, includeTheme: false, includeSettings: false }), actor);
  assert.throws(() => submitPublicForm(form.id, { token: session().token, answers: answers(), items: [valid] }, request(), now + 2000), /does not accept/);
  assert.equal(submit(session().token).received, true);
  assert.equal(listInquiries()[0].items, undefined);
});

test('多产品询价入口优先指向当前语言的联系页，页面无可选产品时阻止发布', () => {
  assert.throws(() => setup({ ...definition(), multiProduct: true }, { productIds: [] }), /该语言没有可选产品/);
  const release = setup({ ...definition(), multiProduct: true }, { pageIds: ['home', 'contact', 'product-detail'], productIds: ['p1', 'p2'] });
  const snapshot = readRelease(release.releaseId);
  assert.equal(publicMultiProductInquiryPath(snapshot, 'en'), '/');
  assert.equal(publicMultiProductInquiryPath(snapshot, 'de'), undefined);
  snapshot.editorData.contact = structuredClone(snapshot.editorData.home);
  assert.equal(publicMultiProductInquiryPath(snapshot, 'en'), '/contact');
  snapshot.editorData['product-detail'] = snapshot.editorData.contact;
  snapshot.editorData.home = snapshot.editorData.contact = { root: { props: {} }, content: [] };
  assert.equal(publicMultiProductInquiryPath(snapshot, 'en', '/products/p2'), '/products/p2');
});

test('公开来源、签名、时间、蜜罐、必填、类型、邮件头和未发布产品均重新检查', () => {
  setup(); const token = session().token;
  assert.throws(() => createFormSession('contact', { sourcePath: '/' }, request(undefined, 'https://untrusted.invalid'), now), /origin/);
  assert.throws(() => createFormSession('contact', { sourcePath: '/preview' }, request(), now), /not available/);
  assert.throws(() => submit(`${token}x`), /refresh/); assert.throws(() => submit(token, answers(), now + 10), /wait a moment/);
  assert.throws(() => submitPublicForm('contact', { token, answers: answers(), honeypot: 'spam' }, request(), now + 2000), /review/);
  assert.throws(() => submitPublicForm('contact', { token, answers: answers(), recipient: 'attacker@example.invalid' }, request(), now + 2000), /review/);
  const invalid = [{ ...answers(), email: '' }, { ...answers(), email: 'visitor@example.invalid\r\nBcc:bad@example.invalid' }, { ...answers(), message: 'a'.repeat(2001) }, { ...answers(), product: 'p2' }, { ...answers(), confirm: 'false' }];
  // 每种字段错误使用独立会话，避免把命中限流误算成字段校验通过。
  for (const values of invalid) assert.throws(() => submit(session().token, values), error => (error as { status: number }).status === 422);
  assert.equal(listInquiries().length, 0); assert.equal(listNotificationJobs().length, 0);
  assert.throws(() => submit(token, answers(), now + 3600001), /expired/);
});
test('同一访客限流与幂等回执独立，改变伪造IP头不能绕过访客上限', () => {
  setup(); const first = session(), cookie = first.cookie.split(';')[0];
  submit(first.token);
  for (let i = 1; i < 5; i++) submit(session(cookie).token);
  assert.throws(() => submit(session(cookie).token), error => (error as { status: number }).status === 429);
  assert.equal(submit(first.token).received, true); assert.equal(listInquiries().length, 5);
});
test('通知写入失败回滚询盘和幂等记录，不出现半份成功数据', () => {
  setup(); const token = session().token;
  getDatabase().exec("CREATE TRIGGER form_test_fail_job BEFORE INSERT ON cms_notification_job BEGIN SELECT RAISE(ABORT,'Simulated outbox failure'); END");
  assert.throws(() => submit(token), /Simulated/); assert.equal(listInquiries().length, 0); assert.equal((getDatabase().prepare('SELECT count(*) AS n FROM cms_form_submission').get() as { n: number }).n, 0);
  getDatabase().exec('DROP TRIGGER form_test_fail_job'); assert.equal(submit(token).received, true); assert.equal(listInquiries().length, 1);
});
test('表单部分发布/停用/回退/恢复保留原始询盘，未发布定义不能借用', () => {
  const first = setup(); const token = session().token; submit(token); const saved = listInquiries()[0];
  const form = definition(); form.name = 'Updated inquiry'; form.fields[0].label = 'Full name'; form.fields.find(f => f.id === 'choice')!.options![0].label = 'New quote label';
  save({ forms: [form] }); publishSite(selection({ pageIds: [], productIds: [], includeTheme: false, includeSettings: false }), actor);
  assert.throws(() => submit(session(undefined, now - 3600001).token), /expired/); assert.throws(() => submit(token, { ...answers(), name: 'Different' }), /already received/);
  assert.equal(listInquiries()[0].answers![0].label, 'Name'); assert.equal(listInquiries()[0].answers!.find(a => a.id === 'choice')!.displayValue, 'Request a quote');
  const stale = session().token; save({ forms: [{ ...form, enabled: false }] }); const disabled = publishSite(selection({ pageIds: [], productIds: [] }), actor);
  assert.throws(() => session(), /not available/); assert.throws(() => submit(stale), /website changed/);
  activateRelease(first.releaseId, { expectedActiveReleaseId: disabled.releaseId }, actor); assert.equal(session().form.name, 'Contact inquiry');
  restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: [], includeForms: true }, actor); assert.equal(getDraftRecord().content.forms![0].fields[0].label, 'Name'); assert.deepEqual(listInquiries()[0], saved);
  const next = { ...definition(), id: 'new-contact' }; save({ forms: [...getDraftRecord().content.forms!, next], editorData: { ...getDraftRecord().content.editorData, home: { root: { props: {} }, content: [{ type: 'Form', props: { id: 'new-node', formId: next.id } }] } } });
  assert.ok(previewPublication(selection({ includeForms: false })).errors.some(e => e.includes('表单不存在')));
});
test('全站头尾和同步区块中的表单仅在当前页面实际引用图生效', () => {
  setup(); const snapshot = readRelease(getStudioEnvelope().activeReleaseId!); const data = snapshot.editorData.home;
  snapshot.sharedBlocks = [{ id: 'contact-block', name: 'Shared contact', data: data as never, updated: '' }]; snapshot.editorData.home = { root: { props: { showChrome: 'yes' } }, content: [] };
  snapshot.siteLayout = { header: { mode: 'hidden', blockId: '' }, footer: { mode: 'block', blockId: 'contact-block' } };
  assert.equal(formAvailableAt(snapshot, 'contact', '/'), true); (snapshot.editorData.home as { root: { props: { showChrome: string } } }).root.props.showChrome = 'no'; assert.equal(formAvailableAt(snapshot, 'contact', '/'), false);
  snapshot.editorData.home = { root: { props: {} }, content: [{ type: 'SharedBlock', props: { id: 'embedded', blockId: 'contact-block' } }] }; assert.equal(formAvailableAt(snapshot, 'contact', '/'), true);
});
test('SSR公开表单不暴露邮件配置，预览为可操作演示，字段与提交样式分开编译', () => {
  setup(); const snapshot = readRelease(getStudioEnvelope().activeReleaseId!);
  const publicHtml = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...snapshot, pageId: 'home', currentPath: '/' }), data: snapshot.editorData.home as never }));
  assert.match(publicHtml, /JavaScript is required/); assert.match(publicHtml, /grid-template-columns:repeat\(2/); assert.match(publicHtml, /border-radius:8px/); assert.ok(!publicHtml.includes('SMTP_PASSWORD'));
  assert.equal(publicHtml.match(/\sid="contact-node"/g)?.length, 1);
  assert.match(publicHtml, /<label[^>]*for="contact-node_email"/); assert.match(publicHtml, /<input[^>]*id="contact-node_email"/);
  const demo = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...snapshot, pageId: 'home', currentPath: '/', editorCanvas: true }), data: snapshot.editorData.home as never }));
  assert.match(demo, /data-form-demo="true"/); assert.match(demo, /Preview only/); assert.match(demo, /<select/);
});
test('未配置通知仍收件，配置mock后恢复积压，模拟不外发且不能重复重试已完成任务', async () => {
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'none'; setup(); submit(session().token); const job = listNotificationJobs()[0];
  assert.equal(job.status, 'unconfigured'); assert.equal(await processNotificationJob(now), false);
  assert.throws(() => retryNotification(job.id), /尚未配置/);
  process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'mock'; assert.equal(await processNotificationJob(now + 3000), true); assert.equal(listNotificationJobs()[0].status, 'mock_sent'); assert.equal(listNotificationJobs()[0].attempts, 1);
  assert.equal(await processNotificationJob(now + 4000), false); assert.throws(() => retryNotification(job.id), /已完成/);
});
test('通知有限退避、错误脱敏、人工重试与单租约并发保护', async () => {
  setup(); submit(session().token); let at = now + 3000, delivered = 0;
  for (let i = 0; i < 5; i++) { assert.equal(await processNotificationJob(at, async () => { throw Object.assign(new Error('password=DO_NOT_STORE'), { code: 'EAUTH' }); }), true); const job = listNotificationJobs()[0]; assert.equal(job.attempts, i + 1); assert.equal(job.error_code, 'EAUTH'); assert.ok(!JSON.stringify(job).includes('DO_NOT_STORE')); if (i < 4) { assert.equal(await processNotificationJob(at), false); at = job.next_attempt + 1; } }
  assert.equal(listNotificationJobs()[0].status, 'failed'); retryNotification(listNotificationJobs()[0].id, at); assert.equal(listNotificationJobs()[0].attempts, 0);
  let release!: () => void;
  const first = processNotificationJob(at, async () => { delivered++; await new Promise<void>(resolve => { release = resolve; }); return 'mock-message'; });
  assert.equal(await processNotificationJob(at, async () => { delivered++; return 'duplicate'; }), false); release(); await first; assert.equal(delivered, 1); assert.equal(listNotificationJobs()[0].status, 'mock_sent');
});
test('进程中断的租约可恢复，连续五次中断后停止自动尝试', async () => {
  setup(); submit(session().token); const id = listNotificationJobs()[0].id;
  getDatabase().prepare("UPDATE cms_notification_job SET status='processing',attempts=4,lease_token='crashed',lease_until=? WHERE id=?").run(now - 1, id); getDatabase().close();
  assert.equal(await processNotificationJob(now + 3000), true); assert.equal(listNotificationJobs()[0].attempts, 5);
  getDatabase().prepare("UPDATE cms_notification_job SET status='processing',lease_token='crashed-again',lease_until=? WHERE id=?").run(now - 1, id);
  assert.equal(await processNotificationJob(now + 4000), false); assert.equal(listNotificationJobs()[0].status, 'failed'); assert.equal(listNotificationJobs()[0].error_code, 'LEASE_EXPIRED');
});
test('邮件收件人仅取私有配置，访客只作reply-to，subject去除邮件头换行', () => {
  setup(); submit(session().token); process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'smtp'; process.env.FORM_STUDIO_NOTIFY_TO = 'owner@example.invalid'; process.env.FORM_STUDIO_SMTP_FROM = 'sender@example.invalid'; process.env.FORM_STUDIO_SMTP_HOST = 'smtp.example.invalid';
  assert.equal(notificationStatus().configured, true);
  const mail = notificationMail({ ...listInquiries()[0], formName: 'Contact\r\nBcc:bad@example.invalid' }); assert.deepEqual(mail.to, ['owner@example.invalid']); assert.equal(mail.from, 'sender@example.invalid'); assert.equal(mail.replyTo, 'visitor@example.invalid'); assert.ok(!/[\r\n]/.test(mail.subject));
  // 此测试只构造消息，不调用SMTP投递。
});
test('处理备注兼容旧状态更新，409保留旧数据，CSV阻止公式注入', () => {
  const result = createInquiry({ name: '=1+1', company: '@example', email: 'visitor@example.invalid', message: '-message', country: 'CN' });
  const updated = updateInquiry(result.item.id, { expectedRevision: 0, notes: 'First note' }); assert.equal(updated.item.status, 'new');
  assert.throws(() => updateInquiry(result.item.id, { expectedRevision: 0, notes: 'Overwrite' }), /已变更/);
  const status = updateInquiry(result.item.id, { expectedRevision: 1, status: 'contacted' }); assert.equal(status.item.notes, 'First note');
  const csv = inquiriesCsv({ search: '', status: 'all', country: 'all' }); assert.ok(csv.startsWith('\ufeff')); assert.ok(csv.includes('"\'=1+1"')); assert.ok(csv.includes('"\'@example"'));
  assert.ok(csvDocument([['\t=bad', '"quoted"']]).includes('"\'\t=bad"')); assert.equal(listNotificationJobs().length, 0);
});
test('保留策略默认不删除，清理有范围/并发检查并级联通知，不影响发布版本', () => {
  const release = setup(); submit(session().token);
  // 使用独立测试记录模拟历史到达时间；只在隔离库模拟保留范围，不改正式记录。
  const item = listInquiries()[0]; getDatabase().prepare('UPDATE cms_inquiry SET created_at=? WHERE id=?').run(new Date(now - 31 * 86400000).toISOString(), item.id);
  assert.equal(getInquiryPolicy().retentionDays, 0); assert.throws(() => previewInquiryCleanup(now), /明确设置/);
  saveInquiryPolicy({ expectedRevision: 0, retentionDays: 30 }); const plan = previewInquiryCleanup(now); assert.equal(plan.count, 1);
  updateInquiry(item.id, { expectedRevision: 0, notes: 'Concurrent note' }); assert.throws(() => applyInquiryCleanup(plan, now), /范围或备注/); assert.equal(listInquiries().length, 1);
  const fresh = previewInquiryCleanup(now); assert.equal(applyInquiryCleanup(fresh, now).removed, 1); assert.equal(listInquiries().length, 0); assert.equal(listNotificationJobs().length, 0); assert.equal(getStudioEnvelope().activeReleaseId, release.releaseId);
});
test('删除与清理保护活动中的通知，单条删除使用询盘自己的revision', () => {
  setup(); submit(session().token); const item = listInquiries()[0];
  getDatabase().prepare("UPDATE cms_notification_job SET status='processing',lease_until=? WHERE inquiry_id=?").run(now + 120000, item.id);
  assert.throws(() => deleteInquiryRecord(item.id, { expectedRevision: 0 }, now), /处理中/);
  getDatabase().prepare("UPDATE cms_notification_job SET status='failed',lease_until=NULL WHERE inquiry_id=?").run(item.id);
  assert.throws(() => deleteInquiryRecord(item.id, { expectedRevision: 1 }, now), /已变化/); deleteInquiryRecord(item.id, { expectedRevision: 0 }, now); assert.equal(listInquiries().length, 0); assert.equal(listNotificationJobs().length, 0);
});
test('条件详情内表单按实际命中布局验证来源，未命中记录不得获取会话',()=>{
 const draft=getDraftRecord().content;
 save({forms:[definition()],pageTemplates:[{id:'form-layout',name:'Form layout',description:'',kind:'product',updated:'',detailRule:{enabled:true,priority:10,recordIds:['p1']},data:{root:{props:{showChrome:'no'}},content:[{type:'Form',props:{id:'conditional-form',formId:'contact'}}]}}]});
 const release=publishSite(selection({productIds:['p1','p2'],includeTemplates:true}),actor),snapshot=readRelease(release.releaseId);
 assert.equal(formAvailableAt(snapshot,'contact','/products/p1'),true);assert.equal(formAvailableAt(snapshot,'contact','/products/p2'),false);
 const created=createFormSession('contact',{sourcePath:'/products/p1'},request(),now);submit(created.token);assert.equal(listInquiries()[0].sourcePath,'/products/p1');assert.throws(()=>createFormSession('contact',{sourcePath:'/products/p2'},request(),now),/not available/);assert.deepEqual(getDraftRecord().content.editorData,draft.editorData);
});

// 以实际公开来源记录语言；旧后台录入不凭当前配置补猜语言。
test('德语条件页表单独立文案和产品范围，拒绝英文产品并记录提交语言',()=>{
 const d=getDraftRecord().content,de={...d.products[0],id:'de-goods',name:'Stuhl',sku:'DE-ONE',locale:'de',slug:'stuhl'};
 save({settings:{...d.settings,locales:[{code:'en',label:'English'},{code:'de',label:'Deutsch'}]},products:[...d.products,de],forms:[{...definition(),name:'Anfrage',submitLabel:'Senden'}],pageTemplates:[{id:'de-form-layout',name:'De layout',description:'',kind:'product',updated:'',detailRule:{enabled:true,priority:10,locale:'de'},data:{root:{props:{showChrome:'no'}},content:[{type:'Form',props:{id:'de-contact',formId:'contact'}}]}}]});
 publishSite(selection({productIds:['p1',de.id],includeTemplates:true}),actor);
 const created=createFormSession('contact',{sourcePath:'/de/products/stuhl'},request(),now);
 assert.deepEqual(created.products,[{id:de.id,name:'Stuhl'}]);assert.equal(created.form.submitLabel,'Senden');
 assert.throws(()=>submit(created.token),/available product/);submit(created.token,{...answers(),product:de.id});
 assert.equal(listInquiries()[0].locale,'de');assert.equal(listInquiries()[0].productId,de.id);assert.ok(inquiriesCsv({}).includes('"de"'));
 assert.throws(()=>createFormSession('contact',{sourcePath:'/products/p1'},request(),now),/not available/);
 const replay=submit(created.token,{...answers(),product:de.id});assert.equal(replay.received,true);assert.equal(listInquiries().length,1);
});

test('语言专用头尾按当前页面授权，部分发布或下线最后的同语言产品不能留下不可提交询盘', () => {
  const draft = getDraftRecord().content;
  const germanPage = { id: 'de-landing', slug: '/de', title: 'Startseite', type: '普通页面', status: 'draft', updated: '', locale: 'de' };
  const germanProduct = { ...draft.products[0], id: 'de-product', name: 'Stuhl', sku: 'DE-FORM', locale: 'de', slug: 'stuhl' };
  const form = { ...definition(), name: 'Anfrage', fields: definition().fields.map(field => field.type === 'product' ? { ...field, required: true } : field) };
  const block = { id: 'de-header', name: 'Deutsche Kopfzeile', updated: '', data: { root: { props: {} }, content: [{ type: 'Form', props: { id: 'de-header-form', formId: form.id } }] } };
  save({
    pages: [...draft.pages, germanPage],
    products: [...draft.products, germanProduct],
    editorData: { ...draft.editorData, [germanPage.id]: { root: { props: {} }, content: [] } },
    sharedBlocks: [block], forms: [form],
    siteLayout: { header: { mode: 'default', blockId: '', localeBlockIds: { de: block.id } }, footer: { mode: 'hidden', blockId: '' }, menus: [] },
    settings: { ...draft.settings, locales: [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }] },
  });
  const scope = selection({ pageIds: ['home', 'product-detail', germanPage.id], includeLayout: true, sharedBlockIds: [block.id] });
  // 虽然德语商品已在草稿里，发布范围没选它时，预检和实际发布都必须阻止。
  const invalid = previewPublication(scope);
  assert.ok(invalid.errors.some(error => error.includes('Startseite') && error.includes('/de，de') && error.includes('Anfrage')));
  assert.throws(() => publishSite(scope, actor), /该语言没有可选产品/);
  assert.equal(getStudioEnvelope().activeReleaseId, null);
  const release = publishSite({ ...scope, productIds: ['p1', germanProduct.id] }, actor);
  assert.throws(() => session(), /not available/);
  const localized = createFormSession(form.id, { sourcePath: '/de' }, request(), now);
  assert.deepEqual(localized.products, [{ id: germanProduct.id, name: germanProduct.name }]);
  assert.throws(() => submit(localized.token), /available product/);
  const values = { ...answers(), product: germanProduct.id };
  assert.equal(submit(localized.token, values).received, true);
  assert.equal(submit(localized.token, values).received, true);
  assert.equal(listInquiries().length, 1);
  assert.equal(listInquiries()[0].locale, 'de');

  const snapshot = readRelease(release.releaseId);
  const footer = { ...snapshot.siteLayout!.header };
  snapshot.siteLayout = { header: { mode: 'hidden', blockId: '' }, footer, menus: [] };
  assert.equal(formAvailableAt(snapshot, form.id, '/de'), true);
  snapshot.editorData[germanPage.id] = { root: { props: { footerMode: 'hidden' } }, content: [] };
  assert.equal(formAvailableAt(snapshot, form.id, '/de'), false);

  const removeLast = { pageIds: [], productIds: [], removeProductIds: [germanProduct.id], includeForms: false, includeTheme: false, includeSettings: false };
  assert.throws(() => publishSite(selection(removeLast), actor), /该语言没有可选产品/);
  save({ forms: [definition()] });
  const optional = publishSite(selection({ ...removeLast, includeForms: true }), actor);
  const withoutProducts = createFormSession(form.id, { sourcePath: '/de' }, request(), now);
  assert.deepEqual(withoutProducts.products, []);
  assert.equal(submit(withoutProducts.token, { ...answers(), product: '' }).received, true);
  activateRelease(release.releaseId, { expectedActiveReleaseId: optional.releaseId }, actor);
  assert.equal(listInquiries().length, 2);
});
