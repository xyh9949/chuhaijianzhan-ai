import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { StudioState } from '../src/lib/types';
import type { AiSiteBrief } from '../src/lib/ai-builder-types';
import type { AiSourceBriefResult } from '../src/lib/ai-source-brief-types';
import type { AiSourceRecord, AiSourceProductPreview } from '../src/server/ai-source-import';
import type { AiProviderSummary } from '../src/server/ai-provider';
import { aiBuilderHttpPlan } from './ai-builder-http';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
const privatePdfName = 'private-source-company-http.pdf', privateXlsxName = 'private-source-products-http.xlsx';
const company = 'Synthetic Source Factory', hidden = 'HTTP-HIDDEN-SOURCE-DO-NOT-SEND', unselected = 'HTTP-UNSELECTED-PDF-PAGE';

/** 实际生产路由上传合成PDF/XLSX；本机模型只校验显式选中的白名单上下文，不连接付费服务。 */
export async function runAiSourceHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }, state: Envelope, options: { dataDirectory: string; password: string }): Promise<Envelope> {
  const { admin, editor, viewer, anonymous } = clients, original = structuredClone(state);
  const missing = 'ais-00000000-0000-0000-0000-000000000000';
  for (const [client, expected] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) {
    await client.api('/api/ai/sources', 'GET', undefined, expected);
    await client.api('/api/ai/sources', 'POST', {}, expected);
    await client.api(`/api/ai/sources/${missing}`, 'GET', undefined, expected);
    await client.api(`/api/ai/sources/${missing}`, 'DELETE', undefined, expected);
    for (const suffix of ['preview', 'apply']) await client.api(`/api/ai/sources/${missing}/${suffix}`, 'POST', {}, expected);
    await client.api('/api/ai/sources/brief', 'POST', {}, expected);
  }
  const badOrigin = await admin.fetch('/api/ai/sources', { method: 'POST', headers: { Origin: 'https://wrong.example.invalid' } }); assert.equal(badOrigin.status, 403);
  const upload = async (bytes: Uint8Array, name: string, mime: string) => {
    const form = new FormData(); form.set('file', new File([Uint8Array.from(bytes)], name, { type: mime }));
    const response = await admin.fetch('/api/ai/sources', { method: 'POST', body: form }), result = await response.json() as AiSourceRecord & { error?: string };
    assert.equal(response.status, 201, result.error); assert.match(response.headers.get('cache-control') || '', /no-store/); return result;
  };
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Products');
  sheet.addRow(['Name', 'SKU', 'Material', 'Width (mm)', 'Enabled', 'Internal']);
  sheet.addRow(['Source chair', 'HTTP-SOURCE-0001', 'Wood', 0, false, hidden]);
  sheet.addRow(['Hidden product', 'HTTP-SOURCE-HIDDEN', hidden]); sheet.getRow(3).hidden = true;
  sheet.addRow(['Source desk', 'HTTP-SOURCE-0002', 'Steel', { formula: '600*2', result: 1200 }, true, hidden]); sheet.getColumn(6).hidden = true;
  const excel = await upload(new Uint8Array(await workbook.xlsx.writeBuffer()), privateXlsxName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(excel.source.kind, 'xlsx'); assert.equal(excel.source.sheets?.[0].rows[1].cells[1], 'HTTP-SOURCE-0001');
  // 原生布尔值按Excel General显示为FALSE；导入保留显示文字，不改写大小写。
  assert.equal(excel.source.sheets?.[0].rows[1].cells[4], 'FALSE');
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText(`${company}\nSynthetic furniture company information for local QA.`, { x: 30, y: 700, size: 12, font });
  document.addPage().drawText(unselected, { x: 30, y: 700, size: 12, font });
  const pdf = await upload(await document.save(), privatePdfName, 'application/pdf');
  assert.equal(pdf.source.kind, 'pdf'); assert.equal(pdf.source.pages?.length, 2); assert.ok(pdf.source.pages?.[0].text.includes(company), '生产PDF worker必须提取实际文字层');
  assert.deepEqual(await admin.api<AiSourceRecord>(`/api/ai/sources/${pdf.id}`), pdf);
  const listed = await admin.api<{ items: Record<string, unknown>[] }>('/api/ai/sources'); assert.ok(listed.items.some(item => item.id === excel.id), '本人资料列表包含上传记录'); assert.ok(listed.items.every(item => !Object.hasOwn(item, 'source') && !Object.hasOwn(item, 'text')), '列表只返回摘要');
  assert.deepEqual(await admin.api<Envelope>('/api/studio'), original, '上传和读取资料不写网站、素材、询盘与发布指针');
  const input = { expectedRevision: state.revision, sheetIndex: 1, headerRow: 1, mapping: { c1: 'builtin:name', c2: 'builtin:sku', c3: 'builtin:material' }, extraColumns: 'description' };
  const checked = await admin.api<AiSourceProductPreview>(`/api/ai/sources/${excel.id}/preview`, 'POST', input);
  const stale = await admin.api<AiSourceProductPreview>(`/api/ai/sources/${excel.id}/preview`, 'POST', input);
  assert.deepEqual(checked.errors, []); assert.ok(checked.previewId, '有效预检返回服务端记录'); assert.deepEqual(checked.rows.map(row => row.row), [2, 4]); assert.equal(checked.rowCount, 2); assert.equal(Object.hasOwn(checked, 'confirmation'), false);
  assert.match(String(checked.rows[0].values.description), /Width \(mm\)：0/); assert.match(String(checked.rows[0].values.description), /Enabled：FALSE/); assert.doesNotMatch(JSON.stringify(checked), /HTTP-HIDDEN-SOURCE/); assert.ok(checked.warnings.some(warning => warning.includes('公式')), '公式使用缓存值并提示');
  assert.deepEqual(await admin.api<Envelope>('/api/studio'), original, '审核预检不改网站');
  let promotedViewerId: string | undefined;
  const configBefore = await admin.api<AiProviderSummary>('/api/ai/provider'); assert.equal(configBefore.enabled, false); assert.equal(configBefore.hasApiKey, false);
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const mock = createServer((request, response) => {
    let raw = ''; request.on('data', chunk => raw += String(chunk)); request.on('end', () => {
      const body = JSON.parse(raw) as typeof requests[number]; requests.push(body);
      const value = body.messages[0].content.includes('Extract a REVIEWABLE') ? { brief: { companyName: company }, facts: [{ field: 'companyName', pageNumbers: [1], evidence: [{ pageNumber: 1, quote: company }] }], warnings: ['Synthetic company identity needs human review.'] } : aiBuilderHttpPlan();
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }));
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); const address = mock.address(); assert.ok(address && typeof address !== 'string', '本机模型需独立端口');
  let providerChanged = false;
  try {
    // 同为管理员也不能读取、预检、删除和应用其他账号上传的资料。
    const members = await admin.api<{ members: { id: string; email: string }[] }>('/api/members'); promotedViewerId = members.members.find(member => member.email === 'http-viewer@example.com')?.id; assert.ok(promotedViewerId, '复用测试成员验证创建者隔离');
    await admin.api(`/api/members/${promotedViewerId}`, 'PATCH', { role: 'admin' }); await viewer.api('/api/auth/sign-in/email', 'POST', { email: 'http-viewer@example.com', password: options.password });
    assert.deepEqual(await viewer.api('/api/ai/sources'), { items: [] });
    await viewer.api(`/api/ai/sources/${excel.id}`, 'GET', undefined, 404); await viewer.api(`/api/ai/sources/${excel.id}`, 'DELETE', undefined, 404);
    await viewer.api(`/api/ai/sources/${excel.id}/preview`, 'POST', input, 404); await viewer.api(`/api/ai/sources/${excel.id}/apply`, 'POST', { previewId: checked.previewId, expectedRevision: state.revision }, 404);
    await viewer.api('/api/ai/sources/brief', 'POST', { sourceId: pdf.id, pageNumbers: [1] }, 404);
    await admin.api(`/api/members/${promotedViewerId}`, 'PATCH', { role: 'viewer' }); promotedViewerId = undefined; await viewer.api('/api/auth/sign-in/email', 'POST', { email: 'http-viewer@example.com', password: options.password });

    const imported = await admin.api<Envelope & { importedProductIds: string[] }>(`/api/ai/sources/${excel.id}/apply`, 'POST', { previewId: checked.previewId, expectedRevision: state.revision }); state = { state: imported.state, revision: imported.revision, activeReleaseId: imported.activeReleaseId };
    assert.equal(state.revision, original.revision + 1); assert.equal(state.activeReleaseId, original.activeReleaseId); assert.equal(imported.importedProductIds.length, 2);
    for (const field of Object.keys(original.state) as (keyof StudioState)[]) if (field !== 'products') assert.deepEqual(state.state[field], original.state[field], `资料导入不改${field}`);
    for (const product of original.state.products) assert.deepEqual(state.state.products.find(item => item.id === product.id), product, '已有产品不覆盖');
    const added = state.state.products.filter(product => imported.importedProductIds.includes(product.id)); assert.ok(added.every(product => product.status === 'draft' && product.image === ''), '不造图片、不自动发布'); assert.doesNotMatch(JSON.stringify(added), /HTTP-HIDDEN-SOURCE|private-source-products-http/);
    const retried = await admin.api<Envelope & { importedProductIds: string[] }>(`/api/ai/sources/${excel.id}/apply`, 'POST', { previewId: checked.previewId, expectedRevision: original.revision }); assert.equal(retried.revision, state.revision); assert.deepEqual(retried.importedProductIds, imported.importedProductIds); assert.deepEqual(retried.state.products, state.state.products);
    await admin.api(`/api/ai/sources/${excel.id}/apply`, 'POST', { previewId: stale.previewId, expectedRevision: original.revision }, 409);
    const duplicates = await admin.api<AiSourceProductPreview>(`/api/ai/sources/${excel.id}/preview`, 'POST', { ...input, expectedRevision: state.revision }); assert.ok(duplicates.errors.length, '已有SKU再次导入必须人工处理'); assert.equal(duplicates.previewId, undefined);
    for (const product of added) assert.equal((await anonymous.fetch(`/products/${product.id}`)).status, 404);

    // 模型只在用户明确整理/建站时调用；所选PDF页与本批产品ID分别限定两次上下文。
    await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: configBefore.revision, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-source-http-model', allowLocal: true, apiKey: 'synthetic-source-http-secret' }); providerChanged = true;
    const organized = await admin.api<AiSourceBriefResult>('/api/ai/sources/brief', 'POST', { sourceId: pdf.id, pageNumbers: [1] }); assert.equal(organized.brief.companyName, company); assert.deepEqual(organized.sources, [{ pageNumber: 1 }]); assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(requests[0]).includes(unselected), false, '未选PDF页不发送模型'); assert.deepEqual(JSON.parse(requests[0].messages[1].content).pages.map((page: { pageNumber: number }) => page.pageNumber), [1]);
    const brief: AiSiteBrief = { companyName: organized.brief.companyName!, description: 'Synthetic furniture company information for local QA.', industry: 'Furniture', audience: 'Professional buyers', market: 'Global', language: state.state.settings.language, styleNotes: '' };
    await admin.api('/api/ai/build/plan', 'POST', { expectedRevision: state.revision, brief, selectedProductIds: ['not-existing'] }, 422); assert.equal(requests.length, 1, '坏产品选择在调用前拒绝');
    await admin.api('/api/ai/build/plan', 'POST', { expectedRevision: state.revision, brief, selectedProductIds: [...imported.importedProductIds].reverse() }); assert.equal(requests.length, 2);
    const context = JSON.parse(requests[1].messages[1].content) as { products: { id: string }[] }; assert.deepEqual(context.products.map(product => product.id), [...imported.importedProductIds].reverse()); assert.equal(JSON.stringify(context).includes(hidden), false); assert.deepEqual(await admin.api<Envelope>('/api/studio'), state, '整理与规划均保持网站草稿');
    const exported = await admin.api('/api/site-packages/export', 'POST', { name: 'Source runtime isolation', description: 'Synthetic local QA', license: 'Synthetic local QA' });
    for (const value of [exported, await admin.api('/api/studio')]) for (const marker of [privatePdfName, privateXlsxName, pdf.id, excel.id, organized.briefId, unselected, hidden, 'synthetic-source-http-secret']) assert.equal(JSON.stringify(value).includes(marker), false, '私有来源、提取原文与密钥不进入分发包/工作区');

    await admin.api(`/api/ai/sources/${pdf.id}`, 'DELETE'); await admin.api(`/api/ai/sources/${pdf.id}`, 'GET', undefined, 404);
    const database = new Database(join(options.dataDirectory, 'studio.sqlite'));
    try {
      assert.equal((database.prepare('SELECT count(*) n FROM cms_ai_source WHERE id=? OR source_id=?').get(pdf.id, pdf.id) as { n: number }).n, 0, '移除PDF级联删除私有整理结果');
      database.prepare('UPDATE cms_ai_source SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', stale.previewId);
    } finally { database.close(); }
    await admin.api(`/api/ai/sources/${excel.id}/apply`, 'POST', { previewId: stale.previewId, expectedRevision: state.revision }, 410);
    await admin.api(`/api/ai/sources/${excel.id}`, 'DELETE'); await admin.api(`/api/ai/sources/${excel.id}`, 'GET', undefined, 404);
    assert.deepEqual(await admin.api<Envelope>('/api/studio'), state, '移除来源保留已导入普通产品');
    return state;
  } finally {
    if (promotedViewerId) await admin.api(`/api/members/${promotedViewerId}`, 'PATCH', { role: 'viewer' });
    if (providerChanged) { const latest = await admin.api<AiProviderSummary>('/api/ai/provider'); await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: latest.revision, enabled: false, baseUrl: configBefore.baseUrl, model: configBefore.model, allowLocal: configBefore.allowLocal, clearApiKey: true }); }
    mock.closeAllConnections(); if (mock.listening) await new Promise<void>((resolveClose, reject) => mock.close(error => error ? reject(error) : resolveClose()));
  }
}
