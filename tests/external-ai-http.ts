import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Data } from '@puckeditor/core';
import type { StudioState } from '../src/lib/types';
import type { AiProviderSummary } from '../src/server/ai-provider';
import type { ExternalAiTokenSummary } from '../src/server/external-ai-tokens';
import type { ExternalAiDesignView } from '../src/server/external-ai-design';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type BrowserClient = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
type Issued = { credential: ExternalAiTokenSummary; token: string };
type Overview = { revision: number; pages: { id: string }[]; permissions: { read: boolean; propose: boolean; wholeSite: boolean; confirmInOwnerBrowser: boolean } };
const pageIds = ['http-external-ai-home', 'http-external-ai-contact'];
const pageData = (id: string): Data => ({ root: { props: { title: id, brand: '', showChrome: 'no' } }, zones: {}, content: [{ type: 'Heading', props: { id: `${id}-title`, text: 'Synthetic external design page', level: 'h1' } }, { type: 'Text', props: { id: `${id}-copy`, text: 'Original external design content.' } }] } as Data);

/** SDK原异常可能包含认证头，只保留固定操作名与数字错误类别，不能将cause带入报告。 */
async function sdk<T>(label: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : 'transport'; throw new Error(`External AI SDK ${label} failed (${code})`); }
}
async function tool<T>(client: McpClient, name: string, args: Record<string, unknown> = {}, expectedError?: number): Promise<T> {
  const result = await sdk(name, () => client.callTool({ name, arguments: args }, undefined, { timeout: 15000 }));
  const text = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text;
  const value = result.structuredContent || (text ? JSON.parse(text) as Record<string, unknown> : undefined);
  if (expectedError !== undefined) { assert.equal(result.isError, true, `${name} should reject this operation`); assert.equal((value as { status: number })?.status, expectedError); }
  else assert.equal(result.isError === true, false, `${name} should return a successful tool result`);
  return value as T;
}
async function connect(token: string, origin: string): Promise<McpClient> {
  const client = new McpClient({ name: 'form-studio-http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', origin), { requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
  try { await sdk('initialize', () => client.connect(transport)); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}

/** 真实SDK与生产HTTP验证机器授权/候选/本人浏览器确认，站内AI始终未配置、无模型调用。 */
export async function runExternalAiHttp(input: { admin: BrowserClient; editor: BrowserClient; viewer: BrowserClient; origin: string; milestones: string[] }): Promise<Envelope> {
  const { admin, editor, viewer, origin, milestones } = input, url = new URL(origin);
  assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(url.port, '3200');
  const original = await admin.api<Envelope>('/api/studio'), provider = await admin.api<AiProviderSummary>('/api/ai/provider');
  assert.equal(provider.enabled, false); assert.equal(provider.hasApiKey, false);
  const credentials: Issued[] = [], clients: McpClient[] = [], candidates: string[] = [];
  let state = original, seeded = false, bridge: McpClient | undefined, bodyFailure: unknown;
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-http-auth', version: '1' } } };
  const raw = (headers: Record<string, string> = {}) => fetch(`${origin}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(initialize), redirect: 'manual' });
  const issue = async (name: string, extra: Record<string, unknown> = {}) => { const issued = await admin.api<Issued>('/api/external-ai/tokens', 'POST', { name, ...extra }, 201); credentials.push(issued); return issued; };
  try {
    assert.equal((await raw()).status, 401); assert.equal((await admin.fetch('/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(initialize) })).status, 401);
    for (const browser of [editor, viewer]) { await browser.api('/api/external-ai/tokens', 'GET', undefined, 403); await browser.api('/api/external-ai/tokens', 'POST', { name: 'untrusted' }, 403); }
    assert.equal((await fetch(`${origin}/api/external-ai/tokens`)).status, 401);
    assert.equal((await admin.fetch('/api/external-ai/tokens', { method: 'POST', headers: { Origin: 'https://wrong.example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'wrong origin' }) })).status, 403);
    const download = await admin.fetch('/api/external-ai/skill'); assert.equal(download.status, 200); assert.match(download.headers.get('content-type') || '', /text\/markdown/); assert.match(await download.text(), /^---[\s\S]*form-studio-site-design/); assert.equal((await fetch(`${origin}/api/external-ai/skill`)).status, 401); await viewer.api('/api/external-ai/skill', 'GET', undefined, 403);

    const pages = pageIds.map((id, index) => ({ id, title: `External AI synthetic ${index + 1}`, slug: `/http-external-ai-${index + 1}`, status: 'draft', type: '普通页面', locale: original.state.settings.language, updated: new Date().toISOString() }));
    state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: [...state.state.pages, ...pages], editorData: { ...state.state.editorData, ...Object.fromEntries(pageIds.map(id => [id, pageData(id)])) } } }); seeded = true;
    const baseline = structuredClone(state), full = await issue('HTTP MCP whole site'), readOnly = await issue('HTTP MCP read only', { scopes: ['read'] }), limited = await issue('HTTP MCP selected page', { pageIds: [pageIds[0]] });
    const listed = await admin.api<{ items: ExternalAiTokenSummary[] }>('/api/external-ai/tokens'); assert.equal(JSON.stringify(listed).includes(full.token), false); assert.equal(JSON.stringify(listed).includes('token_hash'), false);
    assert.equal((await fetch(`${origin}/api/external-ai/tokens`, { method: 'POST', headers: { Authorization: `Bearer ${full.token}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'machine cannot mint credentials' }) })).status, 401);
    assert.equal((await raw({ Authorization: `Bearer ${full.token}`, Origin: 'https://wrong.example.invalid' })).status, 403);
    // Node22 fetch会重建Host；用真实HTTP请求验证错误Host不能绕过DNS重绑定保护。
    const wrongHost = await new Promise<number>((done, reject) => {
      const body = JSON.stringify(initialize), outgoing = httpRequest({ hostname: url.hostname, port: Number(url.port), path: '/api/mcp', method: 'POST', headers: { Host: 'wrong.example.invalid', Authorization: `Bearer ${full.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body) } }, response => { response.resume(); done(response.statusCode || 0); });
      outgoing.once('error', () => reject(new Error('External AI raw Host request failed'))); outgoing.end(body);
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(`${origin}/api/mcp?access_token=${encodeURIComponent(full.token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(initialize) })).status, 401);

    let machine = await connect(full.token, origin);
    const read = await connect(readOnly.token, origin), scoped = await connect(limited.token, origin); clients.push(machine, read, scoped);
    assert.equal(machine.getServerVersion()?.name, 'form-studio'); assert.ok(machine.getServerCapabilities()?.tools);
    const names = (await sdk('listTools', () => machine.listTools())).tools.map(item => item.name).sort();
    assert.deepEqual(names, ['site_capabilities', 'site_design_context', 'site_design_propose', 'site_design_review', 'site_design_select', 'site_design_status', 'site_overview']);
    const readNames = (await sdk('read-listTools', () => read.listTools())).tools.map(item => item.name); assert.equal(readNames.includes('site_design_propose'), false);
    const overview = await tool<Overview>(machine, 'site_overview'), selectedOverview = await tool<Overview>(scoped, 'site_overview');
    assert.equal(overview.revision, state.revision); assert.equal(overview.permissions.wholeSite, true); assert.equal(selectedOverview.permissions.wholeSite, false); assert.deepEqual(selectedOverview.pages.map(page => page.id), [pageIds[0]]);
    const capabilities = await tool<{ siteModelCalls: boolean; editable: boolean }>(machine, 'site_capabilities'); assert.equal(capabilities.siteModelCalls, false); assert.equal(capabilities.editable, true);
    const designRequest = (extra: Record<string, unknown> = {}) => ({ expectedRevision: baseline.revision, instruction: 'Improve the two synthetic pages for procurement readers. Keep other pages and whole-site settings.', targets: { pageIds, header: false, footer: false, navigation: false, style: false }, preserveText: false, ...extra });
    await tool(scoped, 'site_design_context', designRequest(), 403);
    await tool(scoped, 'site_design_context', designRequest({ targets: { pageIds: [pageIds[0]], header: true, footer: false, navigation: false, style: false } }), 403);
    const context = await tool<{ context: unknown }>(machine, 'site_design_context', designRequest()); assert.match(JSON.stringify(context.context), /Original external design content/); assert.equal(JSON.stringify(context).includes(full.token), false);
    const proposal = (round: number) => ({ summary: `Refine synthetic procurement pages ${round}`, intent: { goal: 'Make procurement information clearer', decisions: ['Use native editable text'], preserve: ['Other pages and company facts'], assumptions: [] }, operations: pageIds.map(pageId => ({ kind: 'page', pageId, operations: [{ kind: 'text', id: `${pageId}-copy`, text: `EXTERNAL_AI_HTTP_COPY_${round} for ${pageId}` }] })), warnings: [] });
    const submission = { requestId: 'http-external-ai-first', request: designRequest(), proposal: proposal(1) };
    let readDenied = false;
    try { const attempt = await sdk('read-only-propose', () => read.callTool({ name: 'site_design_propose', arguments: submission }, undefined, { timeout: 15000 })); readDenied = attempt.isError === true; } catch { readDenied = true; }
    assert.equal(readDenied, true, 'read-only credential must not submit a hidden tool directly'); assert.equal((await tool<Overview>(read, 'site_overview')).permissions.propose, false);
    await tool(scoped, 'site_design_propose', submission, 403);
    const first = await tool<ExternalAiDesignView>(machine, 'site_design_propose', submission); candidates.push(first.designId);
    assert.equal(first.status, 'pending'); assert.equal(first.requiresBrowserConfirmation, true); assert.equal(first.generatedContentEditable, true); assert.equal(first.previewAuthentication, 'creator-browser-session'); assert.deepEqual(await admin.api('/api/studio'), baseline);
    assert.equal((await tool<ExternalAiDesignView>(machine, 'site_design_propose', submission)).designId, first.designId);
    await tool(machine, 'site_design_propose', { ...submission, proposal: proposal(2) }, 409);
    // 关闭客户端后重新初始化同一凭据，幂等结果来自私有持久记录，不依赖SDK连接内存。
    await machine.close(); machine = await connect(full.token, origin); clients.push(machine);
    assert.equal((await tool<ExternalAiDesignView>(machine, 'site_design_propose', submission)).designId, first.designId);
    await tool(scoped, 'site_design_status', { designId: first.designId }, 404);
    await tool(read, 'site_design_review', { designId: first.designId, action: 'apply' }, 403);
    const selected = first.previewPages.find(page => page.pageId === pageIds[0]); assert.ok(selected?.beforeUrl && selected.afterUrl);
    const originalPreview = await admin.fetch(selected.beforeUrl), proposedPreview = await admin.fetch(selected.afterUrl);
    assert.equal(originalPreview.status, 200); assert.match(await originalPreview.text(), /Original external design content/); assert.equal(proposedPreview.status, 200); assert.match(await proposedPreview.text(), /EXTERNAL_AI_HTTP_COPY_1/); assert.match(proposedPreview.headers.get('x-robots-tag') || '', /noindex/);
    assert.equal((await fetch(`${origin}${selected.afterUrl}`)).status, 404); assert.equal((await fetch(`${origin}${selected.afterUrl}`, { headers: { Authorization: `Bearer ${full.token}` } })).status, 404); assert.equal((await viewer.fetch(selected.afterUrl)).status, 404);

    const next = await tool<ExternalAiDesignView>(machine, 'site_design_propose', { requestId: 'http-external-ai-continue', request: designRequest({ baseDesignId: first.designId, instruction: 'Keep the first direction and make the two procurement descriptions more concise.' }), proposal: proposal(2) }); candidates.push(next.designId);
    assert.equal(next.refinement?.baseDesignId, first.designId); assert.equal(next.refinement?.round, 1); assert.deepEqual(await admin.api('/api/studio'), baseline);
    const review = await tool<{ reviewUrl: string; requiresBrowserConfirmation: boolean }>(machine, 'site_design_review', { designId: next.designId, action: 'apply' });
    const reviewLink = new URL(review.reviewUrl); assert.equal(reviewLink.origin, origin); assert.equal(reviewLink.searchParams.get('externalDesign'), next.designId); assert.equal(review.requiresBrowserConfirmation, true);
    assert.equal((await admin.fetch(reviewLink.pathname + reviewLink.search + reviewLink.hash)).status, 200); assert.deepEqual(await admin.api('/api/studio'), baseline);
    const machineApply = await fetch(`${origin}/api/ai/site-designs/apply`, { method: 'POST', headers: { Authorization: `Bearer ${full.token}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ designId: next.designId, expectedRevision: state.revision }) }); assert.equal(machineApply.status, 401);
    state = await admin.api<Envelope>('/api/ai/site-designs/apply', 'POST', { designId: next.designId, expectedRevision: state.revision });
    assert.equal(state.activeReleaseId, baseline.activeReleaseId); for (const id of pageIds) assert.match(JSON.stringify(state.state.editorData[id]), /EXTERNAL_AI_HTTP_COPY_2/);
    assert.deepEqual(state.state.theme, baseline.state.theme); assert.deepEqual(state.state.siteLayout, baseline.state.siteLayout); assert.deepEqual(state.state.products, baseline.state.products);
    assert.equal((await tool<ExternalAiDesignView>(machine, 'site_design_status', { designId: next.designId })).status, 'applied');
    await tool(machine, 'site_design_review', { designId: next.designId, action: 'undo' }); const stillApplied = await admin.api<Envelope>('/api/studio'); assert.equal(stillApplied.revision, state.revision);
    state = await admin.api<Envelope>('/api/ai/site-designs/undo', 'POST', { designId: next.designId, expectedRevision: state.revision });
    assert.equal((await tool<ExternalAiDesignView>(machine, 'site_design_status', { designId: next.designId })).status, 'undone');
    assert.deepEqual(state.state.editorData, baseline.state.editorData); assert.deepEqual(state.state.theme, baseline.state.theme); assert.deepEqual(state.state.siteLayout, baseline.state.siteLayout); assert.equal(state.activeReleaseId, baseline.activeReleaseId);

    // stdio凭据只进入该子进程环境，不拼命令行；stdout必须保持SDK可解析的MCP消息。
    bridge = new McpClient({ name: 'form-studio-stdio-http-test', version: '1' });
    const stdio = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'scripts/mcp-bridge.mjs')], cwd: process.cwd(), env: { FORM_STUDIO_MCP_URL: `${origin}/api/mcp`, FORM_STUDIO_MCP_TOKEN: full.token }, stderr: 'pipe' });
    let stderr = ''; stdio.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    await sdk('stdio-initialize', () => bridge!.connect(stdio)); assert.ok(stdio.pid);
    assert.deepEqual((await sdk('stdio-listTools', () => bridge!.listTools())).tools.map(item => item.name).sort(), names);
    assert.equal((await tool<Overview>(bridge, 'site_overview')).revision, state.revision); await bridge.close(); bridge = undefined;
    assert.equal(stdio.pid, null); assert.equal(Boolean(stderr.trim()), false, 'stdio bridge must not print protocol diagnostics or credentials');
    await admin.api(`/api/external-ai/tokens/${full.credential.id}`, 'DELETE');
    assert.equal((await raw({ Authorization: `Bearer ${full.token}` })).status, 401);
    assert.deepEqual(await admin.api('/api/ai/provider'), provider);
    milestones.push('官方MCP Streamable与stdio真实初始化/发现/调用、独立Bearer/只读/页面授权、零站内模型原生提案与幂等续调、本人真实HTML及浏览器确认采用撤销、吊销与Skill权限通过');
  } catch (error) { bodyFailure = error; throw error; }
  finally {
    await bridge?.close().catch(() => {}); for (const client of clients) await client.close().catch(() => {});
    // 清理各步独立执行，避免一次失败留下其余凭据；原业务失败不被二次清理异常覆盖。
    let cleanupFailures = 0;
    for (const id of candidates) try { await admin.api(`/api/ai/site-designs/${id}`, 'DELETE'); } catch { cleanupFailures++; }
    for (const issued of credentials) try { await admin.api(`/api/external-ai/tokens/${issued.credential.id}`, 'DELETE'); } catch { cleanupFailures++; }
    if (seeded) try { const latest = await admin.api<Envelope>('/api/studio'); state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: original.state.pages, editorData: original.state.editorData } }); } catch { cleanupFailures++; }
    if (cleanupFailures && !bodyFailure) throw new Error(`External AI HTTP cleanup failed (${cleanupFailures} steps)`);
  }
  assert.deepEqual(state.state.editorData, original.state.editorData); assert.deepEqual(state.state.pages, original.state.pages); assert.equal(state.activeReleaseId, original.activeReleaseId);
  return state;
}
