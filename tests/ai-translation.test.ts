import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { buildTranslationTask, compileTranslationTask, normalizeTranslationTerms } from '../src/lib/ai-translation';
import type { AiTranslationField } from '../src/lib/ai-translation-types';
import type { RichNode } from '../src/lib/presentation-content';
import { textToRichText } from '../src/lib/presentation-content';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { saveAiProvider } from '../src/server/ai-provider';
import { applyAiTranslation, deleteAiTranslation, generateAiTranslation, getAiTranslationContext, listAiTranslations, readAiTranslation, resolveAiTranslationPreview, undoAiTranslation } from '../src/server/ai-translation';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';

const admin: Actor = { id: 'translation-admin', name: '翻译管理员', email: 'translation@example.invalid', role: 'admin' }, other: Actor = { ...admin, id: 'translation-other' }, editor: Actor = { ...admin, id: 'translation-editor', role: 'editor' };
let previous: NodeJS.ProcessEnv, directory = '', server: Server | undefined, calls = 0;
let answer: ((input: { slots: { id: string; text: string }[] }) => unknown) | undefined;
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
const product = () => getDraftRecord().content.products.find(item => item.id === 'source-product')!;
const request = (extra: Record<string, unknown> = {}) => ({ kind: 'product', sourceId: 'source-product', targetLocale: 'de', expectedRevision: getDraftRecord().revision, fieldKeys: ['description'], terms: [], ...extra });
const save = (patch: object) => patchStudio({ expectedRevision: getDraftRecord().revision, patch });
beforeEach(async () => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-translation-test-')); process.env.FORM_STUDIO_DATA_DIR = directory; process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3297'; process.env.BETTER_AUTH_SECRET = 'translation-test-secret-'.repeat(3); calls = 0; answer = undefined;
  getDraftRecord(); const content = createEmptyDraft(); content.settings = { ...content.settings, name: 'Factory', language: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }, { code: 'fr', label: 'French' }] };
  content.pages.push({ id: 'product-detail', title: 'Product', slug: '/products/:slug', type: '产品详情', status: 'draft', updated: '' }, { id: 'news-detail', title: 'News', slug: '/news/:slug', contentModelId: 'news', type: '内容详情', status: 'draft', updated: '' });
  content.editorData['product-detail'] = { root: { props: { title: 'Product' } }, content: [] }; content.editorData['news-detail'] = { root: { props: { title: 'News' } }, content: [] };
  content.products = [{ id: 'source-product', name: 'Factory sample', sku: 'MODEL-25', slug: 'sample', category: 'Steel', material: 'Steel', description: 'Factory steel sample 25 mm and 2 kg.', image: '/images/chair.jpg', status: 'draft', detailContent: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Factory MODEL-25 25 mm', marks: [{ type: 'link', attrs: { href: '/products/sample?ref=source#details' } }] }] }, { type: 'image', attrs: { src: '/images/chair.jpg', alt: 'Original Factory image', caption: 'Original image caption' } }] } }];
  content.contentModels = [{ id: 'news', name: 'News', description: '', target: 'content', updated: '', fields: [{ id: 'body', key: 'body', label: 'Body', type: 'textarea', required: false }] }];
  content.contentEntries = [{ id: 'source-entry', title: 'Factory news', slug: 'story', modelId: 'news', status: 'draft', updated: '', customFields: { body: 'Factory supplied 25 mm sample.' }, richTextFields: { body: textToRichText('Factory supplied 25 mm sample.') } }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(content)); db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
  server = createServer((request, response) => { let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => { calls++; const input = JSON.parse(JSON.parse(body).messages.at(-1).content); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer ? answer(input) : { translations: input.slots.map((slot: { id: string; text: string }) => ({ id: slot.id, text: `Übersetzt ${slot.text}` })) }) }, finish_reason: 'stop' }] })); }); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string'); saveAiProvider({ expectedRevision: 0, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-translation', allowLocal: true, apiKey: 'synthetic-translation-key' }, admin);
});
afterEach(async () => { if (server) { const current = server; server = undefined; current.closeAllConnections(); await new Promise<void>(done => current.close(() => done())); } getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-translation-test-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('文字槽位保护品牌/术语/数字单位，并保留图文骨架、图片、链接和标记', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Factory sample 25 mm', marks: [{ type: 'bold' }] }] }, { type: 'image', attrs: { src: '/images/chair.jpg', alt: 'Unchanged' } }] } as RichNode;
  const field: AiTranslationField = { key: 'detailContent', label: 'Details', kind: 'richtext', maxLength: 60000, source: doc, before: null }, task = buildTranslationTask([field], [{ source: 'sample', target: 'Muster' }], ['Factory'], 'test');
  const result = compileTranslationTask(task, { translations: task.slots.map(slot => ({ id: slot.id, text: `Deutsch ${slot.text}` })) })[0] as RichNode;
  assert.equal(result.content![0].content![0].text, 'Deutsch Factory Muster 25 mm'); assert.deepEqual(result.content![1], doc.content![1]); assert.deepEqual(result.content![0].content![0].marks, doc.content![0].content![0].marks);
  assert.throws(() => compileTranslationTask(task, { translations: task.slots.map(slot => ({ id: slot.id, text: slot.text.replace('⟦', '') })) }), /受保护/);
  assert.throws(() => compileTranslationTask(task, { translations: task.slots.map(slot => ({ id: slot.id, text: `${slot.text} 999 mm` })) }), /数字/);
  assert.throws(() => normalizeTranslationTerms([{ source: '25 mm', target: '25 cm' }]), /数字|单位/);
  assert.throws(() => buildTranslationTask([{ ...field, kind: 'text', source: 'Factory steel sample' }], [{ source: 'Factory steel', target: 'Acme metal' }], ['Factory'], 'test'), /固定品牌/);
  const identity = buildTranslationTask([{ ...field, kind: 'text', source: 'Factory steel sample' }], [{ source: 'factory steel', target: 'factory steel' }], ['Factory'], 'test');
  assert.equal(compileTranslationTask(identity, { translations: identity.slots.map(slot => ({ id: slot.id, text: slot.text })) })[0], 'Factory steel sample');
  const chinese = buildTranslationTask([{ ...field, kind: 'text', source: '汉斯工厂生产25 mm产品' }], [], ['汉斯工厂'], 'test');
  assert.equal(chinese.slots[0].text.includes('汉斯工厂'), false); assert.throws(() => buildTranslationTask([{ ...field, kind: 'text', source: '汉斯工厂生产产品' }], [{ source: '汉斯工厂生产', target: '其他品牌生产' }], ['汉斯工厂'], 'test'), /固定品牌/);
});
test('上下文仅本条文字且权限受限，字段和语言缺失在模型前拒绝', async () => {
  assert.equal(getAiTranslationContext('product', 'source-product', admin).locales.length, 2); assert.throws(() => getAiTranslationContext('product', 'source-product', editor), status(403));
  await assert.rejects(generateAiTranslation(request({ targetLocale: 'es' }), admin), status(422)); await assert.rejects(generateAiTranslation(request({ fieldKeys: ['sku'] }), admin), status(422)); await assert.rejects(generateAiTranslation(request({ terms: [{ source: 'Factory', target: 'Different brand' }] }), admin), status(422)); assert.equal(calls, 0);
  await assert.rejects(generateAiTranslation(request({ terms: [{ source: 'Factory steel', target: 'Acme metal' }] }), admin), status(422));
  await assert.rejects(generateAiTranslation(request({ terms: [{ source: 'MODEL-25 panel', target: 'OTHER-25 panel' }] }), admin), status(422)); assert.equal(calls, 0);
});
test('产品新译文真实预览、部分采用、幂等、原生可编及撤销恢复源组，不改公开版本', async () => {
  const before = getStudioEnvelope(), preview = await generateAiTranslation(request({ fieldKeys: ['description', 'detailContent'] }), admin); assert.equal(calls, 1); assert.deepEqual(getStudioEnvelope(), before);
  assert.match(preview.fields.find(item => item.key === 'description')!.after as string, /25 mm and 2 kg/); const translatedDoc = preview.fields.find(item => item.key === 'detailContent')!.after as RichNode; assert.equal(translatedDoc.content![0].content![0].marks![0].attrs!.href, '/de/products/sample?ref=source#details'); assert.equal(translatedDoc.content![1].attrs!.alt, 'Original Factory image');
  assert.equal(resolveAiTranslationPreview(preview.id, 'before', admin)!.resolved.product!.id, 'source-product'); assert.equal(resolveAiTranslationPreview(preview.id, 'after', admin)!.resolved.product!.id, preview.targetId); assert.throws(() => readAiTranslation(preview.id, other), status(404));
  const applied = applyAiTranslation(preview.id, { expectedRevision: before.revision, selectedKeys: ['description'] }, admin); const target = applied.state.products.find(item => item.id === preview.targetId)!; assert.match(target.description, /Übersetzt Factory/); assert.deepEqual(target.detailContent, product().detailContent); assert.equal(target.sku, 'MODEL-25-de'); assert.equal(target.translationState, 'needs-review'); assert.equal(applied.activeReleaseId, before.activeReleaseId);
  assert.equal(applyAiTranslation(preview.id, { expectedRevision: before.revision, selectedKeys: ['description'] }, admin).revision, applied.revision);
  assert.throws(() => applyAiTranslation(preview.id, { expectedRevision: applied.revision, selectedKeys: ['detailContent'] }, admin), status(409));
  const undone = undoAiTranslation(preview.id, { expectedRevision: applied.revision }, admin); assert.equal(undone.state.products.some(item => item.id === preview.targetId), false); assert.equal(product().translationGroupId, undefined); assert.equal(undoAiTranslation(preview.id, { expectedRevision: applied.revision }, admin).revision, undone.revision);
});
test('已有目标只更新所选字段，撤销保留目标其他后改，不重复新建', async () => {
  const source = product(); save({ products: [{ ...source, locale: 'en', translationGroupId: 'group-existing', translationState: 'source' }, { ...source, id: 'target-product', locale: 'de', sku: 'MODEL-25-de', translationGroupId: 'group-existing', translationState: 'reviewed', name: 'Existing German', description: 'Previous translation' }] });
  const preview = await generateAiTranslation(request(), admin); assert.equal(preview.isNew, false); assert.equal(preview.targetId, 'target-product'); const applied = applyAiTranslation(preview.id, { expectedRevision: getDraftRecord().revision, selectedKeys: ['description'] }, admin); assert.equal(applied.state.products.length, 2);
  save({ products: getDraftRecord().content.products.map(item => item.id === 'target-product' ? { ...item, material: 'Other manual material' } : item) }); const restored = undoAiTranslation(preview.id, { expectedRevision: getDraftRecord().revision }, admin).state.products.find(item => item.id === 'target-product')!; assert.equal(restored.description, 'Previous translation'); assert.equal(restored.material, 'Other manual material'); assert.equal(restored.translationState, 'reviewed');
});
test('原文/目标后改和目标同语新增会拒绝旧候选，输入与原记录保持', async () => {
  const preview = await generateAiTranslation(request(), admin); save({ products: [{ ...product(), material: 'Changed by user' }] }); const changed = getStudioEnvelope(); assert.equal(readAiTranslation(preview.id, admin).stale, true); assert.throws(() => applyAiTranslation(preview.id, { expectedRevision: changed.revision, selectedKeys: ['description'] }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), changed);
});
test('新译文后改或后来加入第三语言，撤销原子拒绝，不取消有效翻译组', async () => {
  const preview = await generateAiTranslation(request(), admin), applied = applyAiTranslation(preview.id, { expectedRevision: getDraftRecord().revision, selectedKeys: ['description'] }, admin), target = applied.state.products.find(item => item.id === preview.targetId)!;
  save({ products: [...getDraftRecord().content.products, { ...target, id: 'french-third', sku: 'MODEL-25-fr', locale: 'fr' }] }); const before = getStudioEnvelope(); assert.throws(() => undoAiTranslation(preview.id, { expectedRevision: before.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), before);
});
test('文章富文本单条翻译经原生字段及镜像保存，选中正文和标题可精确撤销', async () => {
  const preview = await generateAiTranslation(request({ kind: 'entry', sourceId: 'source-entry', fieldKeys: ['title', 'customFields:body'] }), admin), result = applyAiTranslation(preview.id, { expectedRevision: getDraftRecord().revision, selectedKeys: ['title', 'customFields:body'] }, admin), translated = result.state.contentEntries!.find(item => item.id === preview.targetId)!;
  assert.match(translated.title, /Übersetzt/); assert.match(String(translated.customFields.body), /25 mm/); assert.ok(translated.richTextFields?.body); assert.equal(resolveAiTranslationPreview(preview.id, 'after', admin)!.resolved.entry!.id, preview.targetId); undoAiTranslation(preview.id, { expectedRevision: result.revision }, admin); assert.equal(getDraftRecord().content.contentEntries!.length, 1);
});
test('模型坏锚点、生成期间降权、缺字段以及删除记录均不写草稿，不偷偷重试', async () => {
  answer = input => ({ translations: input.slots.map(slot => ({ id: slot.id, text: 'Changed 999 kg' })) }); const before = getStudioEnvelope(); await assert.rejects(generateAiTranslation(request(), admin), status(422)); assert.deepEqual(getStudioEnvelope(), before); assert.equal(listAiTranslations(admin).items.length, 0); assert.equal(calls, 1);
  answer = input => { getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); return { translations: input.slots.map(slot => ({ id: slot.id, text: slot.text })) }; }; await assert.rejects(generateAiTranslation(request(), admin), status(403)); assert.equal(calls, 2); getDatabase().prepare("UPDATE auth_user SET role='admin' WHERE id=?").run(admin.id); answer = undefined; const p = await generateAiTranslation(request(), admin); deleteAiTranslation(p.id, admin); assert.throws(() => readAiTranslation(p.id, admin), status(404));
});
test('合法受理的任务在会话失效后仍保留本人私有结果，采用和撤销仍要求新会话', async () => {
  let sessionLive = true, accessChecks = 0;
  const freshSession = () => { accessChecks++; if (!sessionLive) throw new ApiError(401, '会话已失效'); };
  answer = input => { sessionLive = false; return { translations: input.slots.map(slot => ({ id: slot.id, text: slot.text })) }; };
  const before = getStudioEnvelope(), p = await generateAiTranslation(request(), admin, undefined, freshSession);
  assert.equal(accessChecks, 1); assert.equal(calls, 1); assert.deepEqual(getStudioEnvelope(), before);
  assert.equal(listAiTranslations(admin).items[0].id, p.id); assert.throws(() => readAiTranslation(p.id, other), status(404));
  assert.throws(() => applyAiTranslation(p.id, { expectedRevision: before.revision, selectedKeys: ['description'] }, admin, freshSession), status(401));
  sessionLive = true; const applied = applyAiTranslation(p.id, { expectedRevision: before.revision, selectedKeys: ['description'] }, admin, freshSession);
  sessionLive = false; assert.throws(() => undoAiTranslation(p.id, { expectedRevision: applied.revision }, admin, freshSession), status(401));
  assert.equal(getDraftRecord().revision, applied.revision);
});
test('待核对记录的原图链接被后来引用时，删除式撤销拒绝且保持全部当前记录', async () => {
  const p = await generateAiTranslation(request(), admin), saved = applyAiTranslation(p.id, { expectedRevision: getDraftRecord().revision, selectedKeys: ['description'] }, admin);
  const current = getDraftRecord(); save({ editorData: { ...current.content.editorData, home: { root: { props: { title: 'Home' } }, content: [{ type: 'ActionButton', props: { id: 'translation-later-reference', text: 'Target', href: `/de/products/sample` } }] } } });
  const before = getStudioEnvelope(); assert.equal(readAiTranslation(p.id, admin).canUndo, false); assert.throws(() => undoAiTranslation(p.id, { expectedRevision: before.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), before); assert.equal(saved.state.products.length, 2);
});
test('已有语言组无审核标记的旧译文，翻译后仍能精确恢复缺省状态', async () => {
  const source = product(); save({ products: [{ ...source, locale: 'en', translationGroupId: 'legacy-group' }, { ...source, id: 'legacy-target', sku: 'LEGACY-de', locale: 'de', translationGroupId: 'legacy-group', description: 'Legacy target' }] });
  const p = await generateAiTranslation(request(), admin), applied = applyAiTranslation(p.id, { expectedRevision: getDraftRecord().revision, selectedKeys: ['description'] }, admin);
  assert.equal(applied.state.products.find(item => item.id === 'legacy-target')!.translationState, undefined); const restored = undoAiTranslation(p.id, { expectedRevision: applied.revision }, admin).state.products.find(item => item.id === 'legacy-target')!; assert.equal(restored.description, 'Legacy target'); assert.equal(Object.hasOwn(restored, 'translationState'), false);
});
test('正文只映射真实目标语言链接，目标地址在生成后变更时拒绝旧映射', async () => {
  const current = getDraftRecord(), detail = structuredClone(product().detailContent!); detail.content![0].content![0].marks![0].attrs!.href = '/about?ref=kept#section';
  save({ products: [{ ...product(), detailContent: detail }], pages: [...current.content.pages, { id: 'about-en', title: 'About', slug: '/about', locale: 'en', translationGroupId: 'about-group', status: 'draft', type: '普通页面', updated: '' }, { id: 'about-de', title: 'Über uns', slug: '/de/about', locale: 'de', translationGroupId: 'about-group', status: 'draft', type: '普通页面', updated: '' }], editorData: { ...current.content.editorData, 'about-en': { root: { props: { title: 'About' } }, content: [] }, 'about-de': { root: { props: { title: 'Über uns' } }, content: [] } } });
  const p = await generateAiTranslation(request({ fieldKeys: ['detailContent'] }), admin); assert.equal((p.fields[0].after as RichNode).content![0].content![0].marks![0].attrs!.href, '/de/about?ref=kept#section');
  save({ pages: getDraftRecord().content.pages.map(item => item.id === 'about-de' ? { ...item, slug: '/de/about-new' } : item) });
  assert.equal(readAiTranslation(p.id, admin).stale, true); assert.throws(() => applyAiTranslation(p.id, { expectedRevision: getDraftRecord().revision, selectedKeys: ['detailContent'] }, admin), status(409));
});
test('已有纯文字文章目标采用富文本译文后，可以恢复纯文字及显式空富文本字典', async () => {
  const current = getDraftRecord(), source = current.content.contentEntries![0];
  save({ contentEntries: [{ ...source, locale: 'en', translationGroupId: 'entry-text-group', translationState: 'source' }, { ...source, id: 'target-text-entry', locale: 'de', translationGroupId: 'entry-text-group', translationState: 'reviewed', customFields: { body: 'Original target plain body' }, richTextFields: {} }] });
  const p = await generateAiTranslation(request({ kind: 'entry', sourceId: source.id, fieldKeys: ['customFields:body'] }), admin), applied = applyAiTranslation(p.id, { expectedRevision: getDraftRecord().revision, selectedKeys: ['customFields:body'] }, admin);
  assert.equal(readAiTranslation(p.id, admin).canUndo, true); const result = undoAiTranslation(p.id, { expectedRevision: applied.revision }, admin).state.contentEntries!.find(item => item.id === 'target-text-entry')!;
  assert.equal(result.customFields.body, 'Original target plain body'); assert.deepEqual(result.richTextFields, {}); assert.equal(result.translationState, 'reviewed');
});
test('翻译实际预览路径精确匹配各侧冻结对象，拒绝截短、尾随及其他快照记录', async () => {
  const p = await generateAiTranslation(request(), admin);
  const segments = (url: string) => new URL(url, 'http://127.0.0.1').pathname.split('/').filter(Boolean).slice(4);
  const before = segments(p.beforeUrl!), after = segments(p.afterUrl!);
  assert.deepEqual(before, ['products', 'sample']); assert.deepEqual(after, ['de', 'products', 'sample']);
  assert.equal(resolveAiTranslationPreview(p.id, 'before', admin, {}, before)!.resolved.product!.id, 'source-product');
  assert.equal(resolveAiTranslationPreview(p.id, 'after', admin, {}, after)!.resolved.product!.id, p.targetId);
  for (const invalid of [[], before, [...after, 'extra'], ['de', 'news', 'story'], ['de', 'products', 'other'], ['de', 'products/sample'], ['de', 'products', '.', 'sample']]) assert.equal(resolveAiTranslationPreview(p.id, 'after', admin, {}, invalid), null);
  assert.equal(resolveAiTranslationPreview(p.id, 'before', admin, {}, after), null);
  assert.throws(() => resolveAiTranslationPreview(p.id, 'after', other, {}, after), status(404));
});
