import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Data } from '@puckeditor/core';
import type { Product } from '../src/lib/types';
import type { RichNode } from '../src/lib/presentation-content';
import { richTextPlainText, textToRichText } from '../src/lib/presentation-content';
import { compileSeoContent } from '../src/lib/seo-content';
import type { SeoContentGroup, SeoContentRequest } from '../src/lib/seo-content-types';
import type { SeoSearchReport } from '../src/lib/seo-types';
import { createEmptyDraft } from '../src/server/seed';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { saveAiProvider } from '../src/server/ai-provider';
import { applySeoContent, deleteSeoContent, generateSeoContent, getSeoContentContext, listSeoContent, readSeoContent, resolveSeoContentPreview, undoSeoContent } from '../src/server/seo-content';
import type { Actor } from '../src/server/permissions';
import { ApiError } from '../src/server/http';

const admin: Actor = { id: 'seo-body-admin', name: '正文管理员', email: 'body@example.invalid', role: 'admin' }, other: Actor = { ...admin, id: 'seo-body-other' }, editor: Actor = { ...admin, id: 'seo-body-editor', role: 'editor' };
let directory = '', previous: NodeJS.ProcessEnv, server: Server | undefined, calls = 0;
type Prompt = { field: { currentText: string }; reports: { id: string; rows: { rowNumber: number }[] }[]; linkTargets: { key: string }[] };
let answer: ((input: Prompt) => unknown) | undefined, lastPrompt: Prompt | undefined, lastSystem = '';
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
const originalDoc: RichNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Factory supplied MODEL-25 steel sample 25 mm.', marks: [{ type: 'link', attrs: { href: '/about' } }] }] }, { type: 'image', attrs: { src: '/images/chair.jpg', alt: 'Original product photograph' } }] };
const body = (product = 'p-source') => getDraftRecord().content.products.find(item => item.id === product)!;
const save = (patch: object) => patchStudio({ expectedRevision: getDraftRecord().revision, patch });
const request = (extra: Partial<SeoContentRequest> = {}): SeoContentRequest => ({ target: { kind: 'product', id: 'p-source' }, fieldKey: 'detailContent', expectedRevision: getDraftRecord().revision, instruction: 'Clarify supplied product selection information and supported buyer questions.', reportRows: [], linkTargetKeys: ['page:about'], ...extra });
function output(input: Prompt) { return { summary: 'Clarify the supplied material and buyer selection context.', body: [{ kind: 'heading', text: 'Material selection' }, { kind: 'paragraph', text: 'Use the supplied steel sample to discuss the intended application.' }], faq: [{ question: 'Which material is supplied?', answer: 'The supplied sample uses steel.' }], links: input.linkTargets.length ? [{ key: input.linkTargets[0].key, label: 'Read supplied company information' }] : [], metadata: { seoTitle: 'Steel sample selection', seoDescription: 'Review the supplied steel sample and discuss its intended application.' }, evidence: input.reports.map(report => ({ reportId: report.id, rowNumbers: [report.rows[0].rowNumber] })), warnings: [], missingFacts: ['Confirm packaging information before adding delivery statements.'] }; }
function report() {
  const value: SeoSearchReport = { id: `ser-${randomUUID()}`, kind: 'search', provider: 'gsc', connectionRevision: 0, createdAt: new Date().toISOString(), source: { name: 'Synthetic Google API fixture', url: 'https://search.google.com/search-console', sourceMock: true }, scope: { property: 'https://example.invalid/', startDate: '2026-10-01', endDate: '2026-10-31', timeZone: 'America/Los_Angeles', country: 'usa', device: 'MOBILE' }, coverage: { partial: true, reasons: ['Fixture returned selected rows only.'], rowCount: 2 }, warnings: ['Synthetic fixture, not real search performance.'], rows: [{ rowNumber: 1, page: 'https://example.invalid/products/source', query: 'steel sample', clicks: 0, impressions: 0, ctr: 0, position: 0 }, { rowNumber: 2, page: 'https://example.invalid/about', query: 'company information', clicks: 1, impressions: 10, ctr: 0.1, position: 9 }] };
  const { rows, ...metadata } = value; getDatabase().prepare('INSERT INTO cms_seo_report VALUES(?,?,?,?,?,?,?)').run(value.id, admin.id, value.provider, value.connectionRevision, JSON.stringify(metadata), JSON.stringify(rows), value.createdAt); return value;
}
beforeEach(async () => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-seo-body-')); process.env.FORM_STUDIO_DATA_DIR = directory; process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3291'; process.env.BETTER_AUTH_SECRET = 'synthetic-seo-body-secret-'.repeat(3); calls = 0; answer = undefined; lastPrompt = undefined;lastSystem='';
  getDraftRecord(); const content = createEmptyDraft(); content.settings = { ...content.settings, name: 'Factory', publicUrl: 'https://example.invalid', language: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }] };
  content.pages.push({ id: 'about', title: 'About Factory', slug: '/about', type: '普通页面', status: 'draft', updated: '' }, { id: 'product-detail', title: 'Product detail', slug: '/products/:slug', type: '产品详情', status: 'draft', updated: '' }, { id: 'entry-detail', title: 'News', slug: '/news/:slug', type: '内容详情', contentModelId: 'news', status: 'draft', updated: '' });
  content.editorData.home = { root: { props: { title: 'Factory', showChrome: 'no' } }, content: [{ type: 'Heading', props: { id: 'original-heading', text: 'Factory supplied steel samples', level: 'h1' } }] };
  content.editorData.about = { root: { props: { title: 'About', showChrome: 'no' } }, content: [] };
  content.editorData['product-detail'] = { root: { props: { title: 'Product', showChrome: 'no' } }, content: [{ type: 'ProductDetail', props: { id: 'native-product-detail' } }] };
  content.editorData['entry-detail'] = { root: { props: { title: 'News', showChrome: 'no' } }, content: [] };
  content.products = [{ id: 'p-source', name: 'Factory sample', slug: 'source', sku: 'MODEL-25', category: 'Steel', material: 'Steel', description: 'Factory supplied steel sample 25 mm.', detailContent: structuredClone(originalDoc), image: '/images/chair.jpg', status: 'draft', seoTitle: 'Original search title', seoDescription: 'Original search description' }];
  content.contentModels = [{ id: 'news', name: 'News', target: 'content', description: '', updated: '', fields: [{ id: 'body', key: 'body', label: 'Body', type: 'textarea', required: false }] } as NonNullable<typeof content.contentModels>[number]];
  content.contentEntries = [{ id: 'entry-source', title: 'Factory sample news', slug: 'source', modelId: 'news', status: 'draft', updated: '', customFields: { body: 'Factory supplied a steel sample.' } }];
  const db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(content)); db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
  server = createServer((incoming, response) => { let raw = ''; incoming.on('data', chunk => raw += chunk); incoming.on('end', () => { calls++;const sent=JSON.parse(raw);lastSystem=sent.messages[0].content;const input = JSON.parse(sent.messages.at(-1).content) as Prompt; lastPrompt = input; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer ? answer(input) : output(input)) } }] })); }); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string'); saveAiProvider({ expectedRevision: 0, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-seo-content', allowLocal: true, apiKey: 'synthetic-seo-content-key' }, admin);
});
afterEach(async () => { if (server) { const running = server; server = undefined; running.closeAllConnections(); await new Promise<void>(done => running.close(() => done())); } getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-seo-body-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('正文编译只接原生文字与明确内链目标，不接HTML、脚本、任意URL或伪报告结构', () => {
  const fake = output({ field: { currentText: '' }, reports: [], linkTargets: [] });
  assert.equal(compileSeoContent(fake, []).changes.length, 4);
  assert.throws(() => compileSeoContent({ ...fake, body: [{ kind: 'paragraph', text: '<script>bad()</script>' }] }, []), /HTML|纯文字/);
  assert.throws(() => compileSeoContent({ ...fake, links: [{ key: 'page:invented', label: 'Invented' }] }, []), /未明确/);
  assert.throws(() => compileSeoContent({ ...fake, body: [{ kind: 'paragraph', text: 'Read https://invented.invalid' }] }, []), /网址/);
  assert.throws(() => compileSeoContent({ ...fake, automaticPublish: true }, []), /未允许/);
});

test('可选metadata省略时仍编译正文，显式null/坏类型和未知字段继续拒绝', () => {
  const {metadata:ignored,...withoutMetadata}=output({field:{currentText:''},reports:[],linkTargets:[]});void ignored;
  const compiled=compileSeoContent(withoutMetadata,[]);assert.deepEqual(compiled.changes.map(change=>change.key),['body','faq']);
  assert.deepEqual(compileSeoContent({...withoutMetadata,metadata:undefined},[]),compiled);
  for(const metadata of [null,[],false,0,'', {unknownField:'Unexpected'}])assert.throws(()=>compileSeoContent({...withoutMetadata,metadata},[]),/格式无效|未允许/);
  assert.deepEqual(compileSeoContent({...withoutMetadata,metadata:{seoTitle:null,seoDescription:null}},[]),compiled);
});

test('可选metadata服务响应保留原搜索字段，真实原生预览采用撤销和引用闭环无需重试', async () => {
  answer=input=>{const{metadata:ignored,...result}=output(input);void ignored;return result;};
  const source=report(),before=getStudioEnvelope(),preview=await generateSeoContent(request({reportRows:[{reportId:source.id,rowNumbers:[1]}]}),admin);
  assert.equal(calls,1);assert.deepEqual(getStudioEnvelope(),before);assert.deepEqual(preview.changes.map(change=>change.key),['body','faq','links']);assert.deepEqual(preview.evidence[0].rowNumbers,[1]);
  assert.match(lastSystem,/metadata may be omitted/i);assert.match(lastSystem,/summary <=1500/);assert.match(lastSystem,/question <=300/);assert.match(lastSystem,/label <=300/);assert.match(lastSystem,/warnings <=12/);assert.match(lastSystem,/missingFacts <=15/);
  const resolved=resolveSeoContentPreview(preview.id,'after',admin,{groups:'body,faq,links'},['products','source'])!;assert.match(richTextPlainText(resolved.snapshot.products[0].detailContent!),/Material selection/);assert.equal(resolved.snapshot.products[0].seoTitle,before.state.products[0].seoTitle);
  const applied=applySeoContent(preview.id,{expectedRevision:before.revision,selectedGroups:['body','faq','links']},admin);assert.equal(body().seoTitle,before.state.products[0].seoTitle);assert.equal(body().seoDescription,before.state.products[0].seoDescription);
  undoSeoContent(preview.id,{expectedRevision:applied.revision},admin);assert.deepEqual(body().detailContent,originalDoc);assert.equal(calls,1);
});

test('未启用栏目时快照保留contentEntries缺省，合法正文可真实预览采用撤销', async () => {
  // 干净建站允许没有栏目记录；快照不能凭空制造undefined，再被严格JSON校验拒绝。
  const content=structuredClone(getDraftRecord().content);delete content.contentEntries;getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const before=getStudioEnvelope(),source=report(),preview=await generateSeoContent(request({reportRows:[{reportId:source.id,rowNumbers:[1]}]}),admin);assert.equal(calls,1);assert.deepEqual(getStudioEnvelope(),before);
  const resolved=resolveSeoContentPreview(preview.id,'after',admin,{groups:'body,faq,links'},['products','source'])!;assert.ok(resolved);assert.equal(Object.hasOwn(resolved.snapshot,'contentEntries'),false);assert.match(richTextPlainText(resolved.snapshot.products[0].detailContent!),/Material selection/);
  const applied=applySeoContent(preview.id,{expectedRevision:before.revision,selectedGroups:['body','faq','links']},admin);assert.equal(Object.hasOwn(getDraftRecord().content,'contentEntries'),false);assert.equal(body().seoTitle,before.state.products[0].seoTitle);
  const undone=undoSeoContent(preview.id,{expectedRevision:applied.revision},admin);assert.deepEqual(body().detailContent,originalDoc);assert.equal(Object.hasOwn(getDraftRecord().content,'contentEntries'),false);assert.equal(undone.activeReleaseId,before.activeReleaseId);assert.equal(calls,1);
});
test('字段/语言/正文范围/数据行和当前权限在模型调用前核对，不静默截断', async () => {
  const context = getSeoContentContext('product', 'p-source', admin); assert.equal(context.fields[0].key, 'detailContent'); assert.equal(context.links[0].key, 'page:home'); assert.throws(() => getSeoContentContext('product', 'p-source', editor), status(403));
  const source = report(); await assert.rejects(generateSeoContent(request({ reportRows: [{ reportId: source.id, rowNumbers: [2] }] }), admin), status(422)); await assert.rejects(generateSeoContent(request({ fieldKey: 'sku' }), admin), status(422)); await assert.rejects(generateSeoContent(request({ linkTargetKeys: ['page:missing'] }), admin), status(422)); await assert.rejects(generateSeoContent(request({ target: { kind: 'page', id: 'product-detail' }, fieldKey: 'content' }), admin), status(422));
  save({ products: [{ ...body(), detailContent: textToRichText('A'.repeat(24001)) }] }); await assert.rejects(generateSeoContent(request(), admin), status(413)); assert.equal(calls, 0);
});
test('正文/FAQ/内链精确组合为原生长详情，未选meta不变，确认前无草稿写，采用可幂等撤销', async () => {
  const before = getStudioEnvelope(), preview = await generateSeoContent(request(), admin); assert.equal(calls, 1); assert.deepEqual(getStudioEnvelope(), before); assert.equal(preview.changes.length, 5); assert.equal(preview.evidence.length, 0); assert.ok(preview.warnings.some(item => item.includes('未选择真实搜索')));
  assert.deepEqual(body().detailContent, originalDoc); assert.equal(resolveSeoContentPreview(preview.id, 'after', admin, { groups: 'body' })!.snapshot.products[0].seoTitle, 'Original search title'); assert.equal(richTextPlainText(resolveSeoContentPreview(preview.id, 'after', admin, { groups: 'body' })!.snapshot.products[0].detailContent!).includes('Which material'), false);
  const groups: SeoContentGroup[] = ['body', 'faq', 'links'], applied = applySeoContent(preview.id, { expectedRevision: before.revision, selectedGroups: groups }, admin), next = body(); assert.equal(next.seoTitle, before.state.products[0].seoTitle); assert.equal(next.seoDescription, before.state.products[0].seoDescription); assert.deepEqual(next.detailContent!.content!.slice(0, 2), originalDoc.content); const text = richTextPlainText(next.detailContent!); assert.match(text, /Material selection/); assert.match(text, /Which material/); assert.match(text, /Read supplied company/); assert.equal(applied.activeReleaseId, before.activeReleaseId);
  assert.equal(applySeoContent(preview.id, { expectedRevision: before.revision, selectedGroups: groups }, admin).revision, applied.revision); assert.throws(() => applySeoContent(preview.id, { expectedRevision: applied.revision, selectedGroups: ['body'] }, admin), status(409));
  const reverted = undoSeoContent(preview.id, { expectedRevision: applied.revision }, admin); assert.deepEqual(body().detailContent, originalDoc); assert.equal(reverted.activeReleaseId, before.activeReleaseId); assert.equal(undoSeoContent(preview.id, { expectedRevision: before.revision }, admin).revision, reverted.revision);
});
test('按报告明确选择真实匹配行，保0值、国家/设备/日期/覆盖与来源引用，未选行不发给模型', async () => {
  const source = report(), before = getStudioEnvelope(), preview = await generateSeoContent(request({ reportRows: [{ reportId: source.id, rowNumbers: [1] }] }), admin);
  assert.equal(lastPrompt!.reports[0].rows.length, 1); assert.equal((lastPrompt!.reports[0].rows[0] as unknown as { clicks: number }).clicks, 0); assert.equal(preview.evidence[0].country, 'usa'); assert.equal(preview.evidence[0].device, 'MOBILE'); assert.equal(preview.evidence[0].timeZone, 'America/Los_Angeles'); assert.equal(preview.evidence[0].partial, true); assert.deepEqual(preview.evidence[0].rowNumbers, [1]); assert.equal(preview.evidence[0].sourceMock, true); assert.deepEqual(getStudioEnvelope(), before);
  answer = input => ({ ...output(input), evidence: [{ reportId: source.id, rowNumbers: [2] }] }); await assert.rejects(generateSeoContent(request({ reportRows: [{ reportId: source.id, rowNumbers: [1] }] }), admin), status(422)); assert.equal(calls, 2); assert.deepEqual(getStudioEnvelope(), before);
});
test('报告/原文/内链目标后改使旧建议失效，不覆盖或重复模型请求', async () => {
  const source = report(), preview = await generateSeoContent(request({ reportRows: [{ reportId: source.id, rowNumbers: [1] }] }), admin); const rows = structuredClone(source.rows); rows[0].impressions = 99; getDatabase().prepare('UPDATE cms_seo_report SET payload_json=? WHERE id=?').run(JSON.stringify(rows), source.id); assert.equal(readSeoContent(preview.id, admin).stale, true); const current = getStudioEnvelope(); assert.throws(() => applySeoContent(preview.id, { expectedRevision: current.revision, selectedGroups: ['body'] }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), current); assert.equal(calls, 1);
  const linked = await generateSeoContent(request(), admin); save({ pages: getDraftRecord().content.pages.map(page => page.id === 'about' ? { ...page, slug: '/changed-about' } : page) }); assert.equal(readSeoContent(linked.id, admin).stale, true); assert.throws(() => applySeoContent(linked.id, { expectedRevision: getDraftRecord().revision, selectedGroups: ['links'] }, admin), status(409));
});
test('撤销保留其他字段后改，正文自身后改拒绝，不回退新的人工工作', async () => {
  const preview = await generateSeoContent(request(), admin); applySeoContent(preview.id, { expectedRevision: getDraftRecord().revision, selectedGroups: ['body'] }, admin); save({ products: [{ ...body(), material: 'Other manual material' }] }); undoSeoContent(preview.id, { expectedRevision: getDraftRecord().revision }, admin); assert.equal(body().material, 'Other manual material'); assert.deepEqual(body().detailContent, originalDoc);
  const next = await generateSeoContent(request(), admin); applySeoContent(next.id, { expectedRevision: getDraftRecord().revision, selectedGroups: ['faq'] }, admin); save({ products: [{ ...body(), detailContent: textToRichText('Later human content') }] }); const before = getStudioEnvelope(); assert.equal(readSeoContent(next.id, admin).canUndo, false); assert.throws(() => undoSeoContent(next.id, { expectedRevision: before.revision }, admin), status(409)); assert.deepEqual(getStudioEnvelope(), before);
});
test('已有纯文字文章生成原生富文本并同步镜像，撤销可回纯文字和显式空富文声明', async () => {
  const before = getDraftRecord().content.contentEntries![0], preview = await generateSeoContent(request({ target: { kind: 'entry', id: before.id }, fieldKey: 'customFields:body', linkTargetKeys: [] }), admin); applySeoContent(preview.id, { expectedRevision: getDraftRecord().revision, selectedGroups: ['body', 'faq'] }, admin); const entry = getDraftRecord().content.contentEntries![0]; assert.ok(entry.richTextFields?.body); assert.equal(entry.customFields.body, richTextPlainText(entry.richTextFields!.body)); undoSeoContent(preview.id, { expectedRevision: getDraftRecord().revision }, admin); const restored = getDraftRecord().content.contentEntries![0]; assert.equal(restored.customFields.body, before.customFields.body); assert.deepEqual(restored.richTextFields, {});
});
test('普通页面追加独立可拖拽RichText块，撤销只删除本次未改节点并保留无关页面手改', async () => {
  const preview = await generateSeoContent(request({ target: { kind: 'page', id: 'home' }, fieldKey: 'content', linkTargetKeys: ['page:about'] }), admin); applySeoContent(preview.id, { expectedRevision: getDraftRecord().revision, selectedGroups: ['body', 'faq', 'links'] }, admin); const current = getDraftRecord().content, data = current.editorData.home as Data; assert.equal(data.content.length, 4); assert.deepEqual(data.content.slice(1).map(item => item.type), ['RichText', 'RichText', 'RichText']);
  save({ editorData: { ...current.editorData, home: { ...data, content: [{ ...data.content[0], props: { ...data.content[0].props, text: 'Later original heading edit' } }, ...data.content.slice(1), { type: 'Text', props: { id: 'later-human-node', text: 'Later human paragraph' } }] } } }); undoSeoContent(preview.id, { expectedRevision: getDraftRecord().revision }, admin); const restored = getDraftRecord().content.editorData.home as Data; assert.equal(restored.content.length, 2); assert.equal(restored.content[0].props.text, 'Later original heading edit'); assert.equal(restored.content[1].props.id, 'later-human-node');
});
test('页面原布局后改拒绝旧采用，已采用新增节点后改也拒绝危险删除', async () => {
  const preview = await generateSeoContent(request({ target: { kind: 'page', id: 'home' }, fieldKey: 'content' }), admin); const content = getDraftRecord().content; save({ editorData: { ...content.editorData, home: { ...(content.editorData.home as Data), content: [{ type: 'Text', props: { id: 'human-replacement', text: 'Human layout replacement' } }] } } }); assert.throws(() => applySeoContent(preview.id, { expectedRevision: getDraftRecord().revision, selectedGroups: ['body'] }, admin), status(409));
  const next = await generateSeoContent(request({ target: { kind: 'page', id: 'home' }, fieldKey: 'content' }), admin); applySeoContent(next.id, { expectedRevision: getDraftRecord().revision, selectedGroups: ['body'] }, admin); const current = getDraftRecord().content, data = current.editorData.home as Data; save({ editorData: { ...current.editorData, home: { ...data, content: data.content.map((node, index) => index === 1 ? { ...node, props: { ...node.props, doc: textToRichText('Edited generated native block') } } : node) } } }); assert.equal(readSeoContent(next.id, admin).canUndo, false); assert.throws(() => undoSeoContent(next.id, { expectedRevision: getDraftRecord().revision }, admin), status(409));
});
test('真实冻结预览严格限制对象路径/分组、私有归属和期限，关闭客户JS', async () => {
  const preview = await generateSeoContent(request(), admin), resolved = resolveSeoContentPreview(preview.id, 'after', admin, { groups: 'body,faq' }, ['products', 'source'])!; assert.equal(resolved.resolved.product!.id, 'p-source'); assert.equal(resolved.snapshot.customCode!.global.jsEnabled, false); assert.equal(resolveSeoContentPreview(preview.id, 'after', admin, {}, ['products', 'different']), null); assert.equal(resolveSeoContentPreview(preview.id, 'after', admin, {}, []), null); assert.equal(resolveSeoContentPreview(preview.id, 'after', admin, { groups: 'unknown' }), null); assert.throws(() => readSeoContent(preview.id, other), status(404)); assert.throws(() => readSeoContent(preview.id, editor), status(403)); getDatabase().prepare('UPDATE cms_seo_content_proposal SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', preview.id); assert.throws(() => readSeoContent(preview.id, admin), status(410));
});
test('合法模型任务会话失效后保私有输出，降权仍拒，采用撤销必须fresh会话', async () => {
  let live = true, checks = 0; const access = () => { checks++; if (!live) throw new ApiError(401, '会话已失效'); }; answer = input => { live = false; return output(input); }; const before = getStudioEnvelope(), preview = await generateSeoContent(request(), admin, undefined, access); assert.equal(checks, 1); assert.equal(listSeoContent(admin).items[0].id, preview.id); assert.deepEqual(getStudioEnvelope(), before); assert.throws(() => applySeoContent(preview.id, { expectedRevision: before.revision, selectedGroups: ['body'] }, admin, access), status(401));
  live = true; applySeoContent(preview.id, { expectedRevision: before.revision, selectedGroups: ['body'] }, admin, access); live = false; assert.throws(() => undoSeoContent(preview.id, { expectedRevision: getDraftRecord().revision }, admin, access), status(401));
  answer = input => { getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); return output(input); }; await assert.rejects(generateSeoContent(request(), admin), status(403)); assert.equal(calls, 2);
});
test('完整候选容量在模型前预留；失败不留pending、不重试、无草稿写，删除仅清理本人记录', async () => {
  const db = getDatabase(), now = new Date().toISOString(); db.prepare('INSERT INTO cms_seo_content_proposal(id,actor_id,target_kind,target_id,base_revision,payload_json,reserved_bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(`sec-${randomUUID()}`, admin.id, 'product', 'p-source', 0, JSON.stringify({ pending: true, padding: ' '.repeat(9 * 1024 * 1024) }), 0, now, new Date(Date.now() + 600_000).toISOString()); await assert.rejects(generateSeoContent(request(), admin), status(429)); assert.equal(calls, 0); db.prepare('DELETE FROM cms_seo_content_proposal').run();
  answer = input => ({ ...output(input), links: [{ key: 'page:invented', label: 'Unexpected' }] }); const before = getStudioEnvelope(); await assert.rejects(generateSeoContent(request(), admin), status(422)); assert.equal(calls, 1); assert.equal((db.prepare('SELECT count(*) n FROM cms_seo_content_proposal').get() as { n: number }).n, 0); assert.deepEqual(getStudioEnvelope(), before); answer = undefined; const preview = await generateSeoContent(request(), admin); deleteSeoContent(preview.id, admin); assert.throws(() => readSeoContent(preview.id, admin), status(404)); assert.deepEqual(getStudioEnvelope(), before);
});
