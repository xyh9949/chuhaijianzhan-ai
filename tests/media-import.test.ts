import protocol from '../src/lib/protocol.json';
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { parseImportFile } from '../src/lib/content-import';
import { imageAttributes } from '../src/lib/media-images';
import { resolveSitePage } from '../src/lib/site-routing';
import { createSiteConfig } from '../src/lib/site-render-config';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, patchStudio, getStudioEnvelope, readRelease } from '../src/server/studio';
import { uploadMedia, readMediaFile, readImageVariant, deleteMedia, isPublishedMedia } from '../src/server/media';
import { mediaInventory, batchMedia, mediaUsage } from '../src/server/media-operations';
import { previewContentImport, commitContentImport, readImportRequest } from '../src/server/content-import';
import { activateRelease, publishSite, restoreDraft } from '../src/server/publication';

let directory = '', previous: NodeJS.ProcessEnv;
const actor = { id: 'media-import-admin', name: '素材导入验收' };
beforeEach(() => { previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'form-studio-media-import-')); process.env.FORM_STUDIO_DATA_DIR = directory; process.env.BETTER_AUTH_URL = 'https://media.example.invalid'; process.env.BETTER_AUTH_SECRET = randomBytes(48).toString('base64url'); });
afterEach(() => { getDatabase().close(); for (const k of Object.keys(process.env)) if (!Object.hasOwn(previous, k)) delete process.env[k]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-media-import-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
function save(patch: object) { return patchStudio({ expectedRevision: getDraftRecord().revision, patch }); }
async function upload(bytes: Uint8Array, name: string, type: string) { const form = new FormData(); form.set('file', new File([new Uint8Array(bytes)], name, { type })); form.set('expectedRevision', String(getDraftRecord().revision)); return uploadMedia(form); }
const selection = () => ({ expectedRevision: getDraftRecord().revision, baseReleaseId: getStudioEnvelope().activeReleaseId, pageIds: ['home'], productIds: [], includeTheme: true, includeSettings: true });
async function image() { return upload(await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#345678' } }).png().toBuffer(), 'large.png', 'image/png'); }
const jsonSpec = (rows: object[], extra: object = {}) => ({ expectedRevision: getDraftRecord().revision, format: 'json', target: 'product', content: JSON.stringify({ schemaVersion: 1, kind: 'product', rows }), mapping: { name: 'builtin:name', sku: 'builtin:sku' }, ...extra });

test('严格CSV解析保留引号/换行/UTF8 BOM，拒绝列数、重复列与非法JSON结构', () => {
  const parsed = parseImportFile('csv', '\uFEFFname,sku,description\r\n"Sample, chair",A1,"Two ""quoted"" lines\nnext"\r\n', 'product');
  assert.equal(parsed.rows[0].name, 'Sample, chair'); assert.equal(parsed.rows[0].description, 'Two "quoted" lines\nnext');
  assert.deepEqual(parseImportFile('csv', 'name,sku\n"first\nsecond",A\nnext,B\n', 'product').lineNumbers, [2, 4]);
  for (const text of ['name,name\na,b', 'name,sku\n"unclosed,a', 'name,sku\na,b,c', 'constructor,sku\na,b', 'name,sku\n"a"x,b']) assert.throws(() => parseImportFile('csv', text, 'product'));
  for (const value of [{ schemaVersion: 2, kind: 'product', rows: [{}] }, { schemaVersion: 1, kind: 'entry', rows: [{}] }, { schemaVersion: 1, kind: 'product', rows: [{ name: {} }] }, { schemaVersion: 1, kind: 'product', rows: [{ ' name': 'a' }] }]) assert.throws(() => parseImportFile('json', JSON.stringify(value), 'product'));
  assert.throws(() => parseImportFile('json', JSON.stringify({ schemaVersion: 1, kind: 'product', rows: Array.from({ length: 501 }, () => ({ name: 'a' })) }), 'product'), /500/);
});

test('导入HTTP读取严格UTF8和请求长度，不把非法编码替换后写入资料', async () => {
  const bytes = Buffer.concat([Buffer.from('{"content":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await assert.rejects(() => readImportRequest(new Request('https://example.invalid/api/content-import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bytes })), /UTF-8/);
  await assert.rejects(() => readImportRequest(new Request('https://example.invalid/api/content-import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '6000000' }, body: '{}' })), /过大/);
  assert.equal(getDraftRecord().content.products.length, 4);
});

test('真实图片重编码与衍生尺寸可重建，原URL/哈希稳定、EXIF转向和固有尺寸正确', async () => {
  const result = await image(), media = result.media;
  assert.equal(media.width, 1000); assert.equal(media.height, 600); assert.deepEqual(media.variants, [{ width: 320, height: 192 }, { width: 768, height: 461 }]);
  const source = readMediaFile(media.id), small = await readImageVariant(media.id, 320), info = await sharp(small.bytes).metadata(); assert.equal(info.width, 320); assert.equal(info.height, 192);
  unlinkSync(join(directory, 'media', `${source.etag}.w320.webp`)); assert.equal((await readImageVariant(media.id, 320)).etag, small.etag); assert.equal(readMediaFile(media.id).etag, source.etag);
  await assert.rejects(() => readImageVariant(media.id, 999), /320/);
  const attrs = imageAttributes(media.url, [media]); assert.match(attrs.srcSet!, /width=320 320w/); assert.equal(attrs.width, 1000); assert.equal(imageAttributes(media.url, [media], '320').src, `${media.url}?width=320`); assert.equal(imageAttributes(media.url, [media], 'auto', false).srcSet, undefined);
  assert.equal(imageAttributes('/images/chair.jpg').height, 1201);
  assert.throws(() => save({ media: getDraftRecord().content.media.map(m => ({ ...m, width: 999 })) }), /衍生尺寸|固有尺寸/);
  const oriented = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#678901' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const rotated = (await upload(oriented, 'portrait.jpg', 'image/jpeg')).media; assert.equal(rotated.width, 120); assert.equal(rotated.height, 80);
});

test('PDF真实结构解析、签名/脚本/扩展名拒绝；目录依赖发布和历史回滚继续可用', async () => {
  const document = await PDFDocument.create(); document.addPage([300, 200]); const bytes = await document.save();
  const uploaded = await upload(bytes, 'catalog.pdf', 'application/pdf'); assert.equal(uploaded.media.kind, 'document'); assert.equal(uploaded.media.pages, 1); assert.equal(readMediaFile(uploaded.media.id).mime, 'application/pdf');
  await assert.rejects(() => upload(Buffer.from('%PDF-1.7\n<script>fake</script>\n%%EOF'), 'fake.pdf', 'application/pdf'), /PDF无法解析/);
  await assert.rejects(() => upload(Buffer.from('<html>fake</html>'), 'fake.pdf', 'application/pdf'), /签名/);
  await assert.rejects(() => upload(bytes, 'fake.html', 'application/pdf'), /扩展名/);
  await assert.rejects(() => upload(bytes, 'catalog.pdf', 'text/html'), /仅支持/);
  document.addJavaScript('test', 'app.alert("synthetic test")');
  const activeBytes = await document.save(); await assert.rejects(() => upload(activeBytes, 'active.pdf', 'application/pdf'), /主动内容/);
  const draft = getDraftRecord().content;
  save({ editorData: { ...draft.editorData, home: { root: { props: { showChrome: 'no' } }, content: [{ type: 'Download', props: { id: 'catalog-download', text: 'Download PDF', fileUrl: uploaded.media.url, design: { desktop: { backgroundColor: '#234567' } } } }] } } });
  assert.throws(() => deleteMedia(uploaded.media.id, { expectedRevision: getDraftRecord().revision }), /引用/);
  const first = publishSite(selection(), actor), snapshot = readRelease(first.releaseId); assert.equal(snapshot.schemaVersion, protocol.snapshot); assert.ok(snapshot.media.some(m => m.id === uploaded.media.id));
  const html = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...snapshot, pageId: 'home' }), data: snapshot.editorData.home as never })); assert.ok(html.includes(`href="${uploaded.media.url}"`));
  assert.match(html, />\.editor-site-action\.ant-btn\{[^}]*background-color:#234567/);
  save({ editorData: { ...getDraftRecord().content.editorData, home: { root: { props: {} }, content: [] } } }); const second = publishSite(selection(), actor);
  const usage = mediaUsage(uploaded.media.id); assert.equal(usage.draft.length, 0); assert.equal(usage.historical.length, 1);
  deleteMedia(uploaded.media.id, { expectedRevision: getDraftRecord().revision }); assert.equal(isPublishedMedia(uploaded.media.id), true); assert.ok(readMediaFile(uploaded.media.id).bytes.length);
  activateRelease(first.releaseId, { expectedActiveReleaseId: second.releaseId }, actor); restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: ['home'] }, actor); assert.ok(getDraftRecord().content.media.some(m => m.id === uploaded.media.id));
});

test('批量素材移动/删除原子检查所有引用，容量和清理预检只读且保护历史文件', async () => {
  const a = (await image()).media, b = (await upload(await sharp({ create: { width: 20, height: 20, channels: 3, background: '#111111' } }).png().toBuffer(), 'unused.png', 'image/png')).media;
  save({ products: getDraftRecord().content.products.map((p, i) => i === 0 ? { ...p, image: a.url } : p) });
  const current = getDraftRecord().revision; assert.throws(() => batchMedia({ expectedRevision: current, ids: [b.id, a.id], action: 'remove' }), /引用/); assert.equal(getDraftRecord().revision, current); assert.ok(getDraftRecord().content.media.some(m => m.id === b.id));
  batchMedia({ expectedRevision: current, ids: [a.id, b.id], action: 'move', folder: 'New catalog' }); assert.equal(getDraftRecord().content.media.filter(m => [a.id, b.id].includes(m.id) && m.folder === 'New catalog').length, 2);
  assert.ok(mediaUsage(a.id).draft.some(r => r.kind === '产品'));
  const orphan = `${'f'.repeat(64)}.webp`; writeFileSync(join(directory, 'media', orphan), 'orphan fixture');
  const inventory = mediaInventory(true); assert.ok(inventory.physicalBytes > 0); assert.equal(inventory.candidateCount, 1); assert.ok(inventory.candidates?.some(c => c.filename === orphan)); assert.ok(existsSync(join(directory, 'media', orphan)));
});

test('协议10表单快照没有衍生元数据/PDF组件，仍可激活并选择恢复', () => {
  const draft = getDraftRecord().content, form = { id: 'legacy-contact', name: 'Legacy form', enabled: true, fields: [{ id: 'name', label: 'Name', type: 'text', required: true, mapTo: 'name' }], submitLabel: 'Send', successMessage: 'Received' };
  save({ forms: [form], editorData: { ...draft.editorData, home: { root: { props: { showChrome: 'no' } }, content: [{ type: 'Form', props: { id: 'legacy-form-node', formId: form.id } }] } } });
  const first = publishSite({ ...selection(), includeForms: true }, actor), legacy = structuredClone(readRelease(first.releaseId));
  // 使用协议10已支持的Form节点，且素材不带协议11新元数据；不是把Download换个版本数字。
  legacy.schemaVersion = 10; legacy.releaseId = 'legacy-media-v10';
  for (const m of legacy.media) { delete m.width; delete m.height; delete m.bytes; delete m.pages; delete m.variants; }
  getDatabase().prepare('INSERT INTO cms_release(id,title,manifest_json,manifest_hash,schema_version,renderer_version,created_by,author_name,created_at,selection_json) VALUES(?,?,?,?,10,10,?,?,?,?)').run(legacy.releaseId, '协议10资料', JSON.stringify(legacy), 'legacy-v10-fixture', actor.id, actor.name, new Date().toISOString(), JSON.stringify({ pageIds: ['home'], includeForms: true }));
  activateRelease(legacy.releaseId, { expectedActiveReleaseId: first.releaseId }, actor);
  restoreDraft(legacy.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: ['home'], includeForms: true }, actor);
  assert.equal(getDraftRecord().content.forms![0].id, form.id); assert.equal(getStudioEnvelope().activeReleaseId, legacy.releaseId);
});

test('CSV/JSON字段映射、0/false、逐行错误与重复导入保护，不写入半批数据', () => {
  const spec = jsonSpec([{ name: 'First item', sku: 'IMPORT-001' }, { name: 'Second item', sku: 'IMPORT-002' }]);
  const preview = previewContentImport(spec); assert.deepEqual(preview.errors, []); assert.equal(getDraftRecord().revision, spec.expectedRevision);
  const committed = commitContentImport({ ...spec, confirmation: preview.confirmation }); assert.equal(committed.state.products.length, 6); assert.equal(committed.state.products.filter(p => p.sku.startsWith('IMPORT-') && p.status === 'draft').length, 2); assert.equal(committed.state.releases.length, 0);
  const repeated = previewContentImport({ ...spec, expectedRevision: committed.revision }); assert.ok(repeated.errors.some(e => e.field === 'sku')); assert.equal(repeated.confirmation, undefined);
  const bad = jsonSpec([{ name: 'Valid', sku: 'NEW-001', slug: 'same' }, { name: 'Invalid duplicate', sku: 'NEW-001', slug: 'same' }], { mapping: { name: 'builtin:name', sku: 'builtin:sku', slug: 'builtin:slug' } });
  const before = getDraftRecord().revision, failure = previewContentImport(bad); assert.ok(failure.errors.some(e => e.row === 2 && e.field === 'sku')); assert.ok(failure.errors.some(e => e.row === 2 && e.field === 'slug')); assert.equal(getDraftRecord().revision, before);
  const model = { id: 'cases', name: 'Cases', description: '', target: 'content', updated: '', fields: [{ id: 'qty', key: 'quantity', label: 'Quantity', type: 'number', required: false, min: 0 }, { id: 'available', key: 'available', label: 'Available', type: 'boolean', required: false }] };
  save({ contentModels: [model] });
  const entries = { expectedRevision: getDraftRecord().revision, target: 'entry', modelId: model.id, format: 'csv', content: 'key,title,quantity,available\ncase-1,Demo case,0,false\n', mapping: { key: 'builtin:key', title: 'builtin:title', quantity: 'field:qty', available: 'field:available' } };
  const checked = previewContentImport(entries); assert.deepEqual(checked.errors, []); const result = commitContentImport({ ...entries, confirmation: checked.confirmation }); assert.equal(result.state.contentEntries![0].customFields.qty, 0); assert.equal(result.state.contentEntries![0].customFields.available, false);
  const invalid = previewContentImport({ ...entries, expectedRevision: result.revision, content: 'key,title,quantity,available\ncase-2,Demo case,bad,0\n' }); assert.equal(invalid.errors.length, 2); assert.ok(invalid.errors.every(e => e.row === 2));
});

test('确认绑定文件/映射/版本与5分钟有效期，恶意签名/远程图片/巨大文件被拒绝', () => {
  const spec = jsonSpec([{ name: 'Safe item', sku: 'SAFE-1' }]), now = Date.now(), preview = previewContentImport(spec, now);
  assert.throws(() => commitContentImport({ ...spec, content: spec.content.replace('Safe', 'Altered'), confirmation: preview.confirmation }, now), /重新预检/);
  assert.throws(() => commitContentImport({ ...spec, confirmation: preview.confirmation }, now + 300001), /过期/);
  assert.throws(() => commitContentImport({ ...spec, confirmation: `1.${spec.expectedRevision}.${now}.${'汉'.repeat(43)}` }, now), /重新预检/);
  save({ theme: { ...getDraftRecord().content.theme, radius: 8 } }); assert.throws(() => commitContentImport({ ...spec, confirmation: preview.confirmation }, now), /工作区已变化/);
  const remote = jsonSpec([{ name: 'Remote', sku: 'REMOTE', image: 'https://invalid.example/x.jpg' }], { mapping: { name: 'builtin:name', sku: 'builtin:sku', image: 'builtin:image' } }); assert.ok(previewContentImport(remote).errors.some(e => e.field === 'image'));
  assert.throws(() => previewContentImport({ ...remote, content: 'a'.repeat(2 * 1024 * 1024 + 1) }), /2 MB|超过/);
});

test('200产品加100独立记录负载真实保存，4MB总量上限不通过分批导入绕过', t => {
  const started = performance.now();
  const products = jsonSpec(Array.from({ length: 200 }, (_, i) => ({ name: `Demo product ${i}`, sku: `SCALE-${i}` })));
  let preview = previewContentImport(products); commitContentImport({ ...products, confirmation: preview.confirmation });
  save({ contentModels: [{ id: 'scale-model', name: 'Scale model', target: 'content', description: '', updated: '', fields: [] }] });
  const entries = { expectedRevision: getDraftRecord().revision, format: 'json', target: 'entry', modelId: 'scale-model', content: JSON.stringify({ schemaVersion: 1, kind: 'entry', rows: Array.from({ length: 100 }, (_, i) => ({ key: `scale-${i}`, title: `Demo case ${i}` })) }), mapping: { key: 'builtin:key', title: 'builtin:title' } };
  preview = previewContentImport(entries); commitContentImport({ ...entries, confirmation: preview.confirmation });
  const content = getDraftRecord().content;
  const detail = { id: 'scale-detail', title: 'Scale case detail', type: '动态模板', slug: '/scale-cases/:slug', contentModelId: 'scale-model', status: 'draft', updated: '' };
  const listing = { id: 'scale-list', title: 'Scale cases', type: '普通页面', slug: '/scale-cases', status: 'draft', updated: '' };
  const titleNode = { type: 'Heading', props: { id: 'scale-title', text: '', bindings: { text: { source: 'entry', mode: 'current', modelId: 'scale-model', field: 'builtin:title' } } } };
  save({ pages: [...content.pages, detail, listing], sharedBlocks: [{ id: 'scale-card', name: 'Scale card', updated: '', data: { root: { props: {} }, content: [titleNode] } }], editorData: { ...content.editorData, [detail.id]: { root: { props: { showChrome: 'no' } }, content: [titleNode] }, [listing.id]: { root: { props: { showChrome: 'no' } }, content: [{ type: 'ContentLoop', props: { id: 'scale-loop', source: 'entry', modelId: 'scale-model', itemBlockId: 'scale-card', title: 'Scale cases', query: { paginate: true, pageSize: 12, sort: 'builtin:title' } } }] } } });
  const all = getDraftRecord().content, release = publishSite({ ...selection(), pageIds: all.pages.map(p => p.id), productIds: all.products.map(p => p.id), contentModelIds: ['scale-model'], contentEntryIds: all.contentEntries!.map(e => e.id), sharedBlockIds: ['scale-card'] }, actor), snapshot = readRelease(release.releaseId);
  for (const entry of [snapshot.contentEntries![0], snapshot.contentEntries![99]]) assert.equal(resolveSitePage(snapshot, ['scale-cases', entry.id])?.entry?.id, entry.id);
  const rendered = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...snapshot, pageId: listing.id, queryParams: { 'page_scale-loop': '9' } }), data: snapshot.editorData[listing.id] as never }));
  assert.equal((rendered.match(/data-loop-record=/g) || []).length, 4); assert.ok(rendered.replace(/<!--.*?-->/g, '').includes('100 results'));
  const fetchStart = performance.now(), envelope = getStudioEnvelope(), serialized = JSON.stringify(envelope), loadMs = performance.now() - fetchStart;
  assert.equal(envelope.state.products.length, 204); assert.equal(envelope.state.contentEntries!.length, 100); assert.ok(Buffer.byteLength(serialized) < 4 * 1024 * 1024);
  t.diagnostic(JSON.stringify({ products: 204, entries: 100, envelopeBytes: Buffer.byteLength(serialized), envelopeMs: Math.round(loadMs), totalMs: Math.round(performance.now() - started), runtime: process.version, isolated: true }));
  save({ products: getDraftRecord().content.products.map((p, i) => i < 110 ? { ...p, description: 'x'.repeat(24000) } : p) });
  const large = jsonSpec(Array.from({ length: 100 }, (_, i) => ({ name: `Boundary ${i}`, sku: `BOUNDARY-${i}`, description: 'y'.repeat(18000) })), { mapping: { name: 'builtin:name', sku: 'builtin:sku', description: 'builtin:description' } });
  const before = getDraftRecord().revision, invalid = previewContentImport(large); assert.ok(invalid.errors.some(e => e.message.includes('4 MB'))); assert.equal(invalid.confirmation, undefined); assert.equal(getDraftRecord().revision, before); assert.equal(getDraftRecord().content.products.length, 204);
});

// 默认产品相册必须独立于自定义模型，非封面图片同样受发布和删除保护。
test('原生多图真实上传、部分发布隔离、历史回退及恢复均保留有序图片',async()=>{
 const a=(await image()).media,b=(await upload(await sharp({create:{width:640,height:480,channels:3,background:'#abcdef'}}).png().toBuffer(),'second.png','image/png')).media;
 const d=getDraftRecord().content,p=d.products.find(p=>p.id==='p1')!;assert.equal(d.contentModels?.length||0,0);
 save({products:d.products.map(x=>x.id===p.id?{...x,image:a.url,images:[a.url,b.url]}:x)});
 assert.equal(isPublishedMedia(b.id),false);assert.ok(mediaUsage(b.id).draft.some(u=>u.kind==='产品'));
 assert.throws(()=>deleteMedia(b.id,{expectedRevision:getDraftRecord().revision}),/引用|使用/);
 const first=publishSite({...selection(),productIds:[p.id]},actor),old=readRelease(first.releaseId);
 assert.equal(old.schemaVersion,protocol.snapshot);assert.deepEqual(old.products[0].images,[a.url,b.url]);assert.ok(old.media.some(m=>m.id===b.id));assert.equal(isPublishedMedia(b.id),true);
 save({products:getDraftRecord().content.products.map(x=>x.id===p.id?{...x,image:b.url,images:[b.url,a.url]}:x)});
 const partial=publishSite({...selection(),includeTheme:false,includeSettings:false},actor);assert.deepEqual(readRelease(partial.releaseId).products[0].images,[a.url,b.url]);
 const second=publishSite({...selection(),pageIds:[],productIds:[p.id],includeTheme:false,includeSettings:false},actor);assert.deepEqual(readRelease(second.releaseId).products[0].images,[b.url,a.url]);
 activateRelease(first.releaseId,{expectedActiveReleaseId:getStudioEnvelope().activeReleaseId},actor);
 restoreDraft(first.releaseId,{expectedRevision:getDraftRecord().revision,pageIds:[],productIds:[p.id],includeTheme:false,includeSettings:false},actor);assert.deepEqual(getDraftRecord().content.products.find(x=>x.id===p.id)!.images,[a.url,b.url]);
});
test('原生相册批量JSON及CSV导入自动采用首图，拒绝冲突封面且失败不写入',()=>{
 const photos=['/images/chair.jpg','/images/studio.jpg'];
 const spec=jsonSpec([{name:'Native photos',sku:'NATIVE-JSON',photos}],{mapping:{name:'builtin:name',sku:'builtin:sku',photos:'builtin:images'}}),preview=previewContentImport(spec);assert.deepEqual(preview.errors,[]);
 const committed=commitContentImport({...spec,confirmation:preview.confirmation}),product=committed.state.products.find(p=>p.sku==='NATIVE-JSON')!;assert.equal(product.image,photos[0]);assert.deepEqual(product.images,photos);
 const csv='name,sku,photos\nCSV photos,NATIVE-CSV,"'+JSON.stringify(photos).replaceAll('"','""')+'"\n';
 const csvSpec={...spec,expectedRevision:getDraftRecord().revision,format:'csv',content:csv},csvPreview=previewContentImport(csvSpec);assert.deepEqual(csvPreview.errors,[]);commitContentImport({...csvSpec,confirmation:csvPreview.confirmation});
 const bad=jsonSpec([{name:'Mismatch',sku:'NATIVE-BAD',photos,image:photos[1]}],{mapping:{...spec.mapping,image:'builtin:image'}}),before=getDraftRecord().revision;
 assert.ok(previewContentImport(bad).errors.some(e=>e.field==='image'));assert.equal(getDraftRecord().revision,before);
});
