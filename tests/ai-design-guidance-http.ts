import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AiDesignGuidance } from '../src/lib/ai-design-guidance-types';
import type { StudioState } from '../src/lib/types';
import type { ExternalAiTokenSummary } from '../src/server/external-ai-tokens';
import type { ExternalAiDesignView } from '../src/server/external-ai-design';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Browser = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
type Issued = { credential: ExternalAiTokenSummary; token: string };
/** 只保留操作名，不把SDK异常携带的Bearer或请求头送进测试报告。 */
async function sdk<T>(label: string, work: () => Promise<T>): Promise<T> { try { return await work(); } catch { throw new Error(`Design guidance SDK ${label} failed`); } }
async function tool<T>(client: Client, name: string, args: Record<string, unknown> = {}, errorStatus?: number): Promise<T> {
  const result = await sdk(name, () => client.callTool({ name, arguments: args })), text = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text, value = result.structuredContent || (text ? JSON.parse(text) : undefined);
  // 仅输出合成控制端收到的固定状态与安全错误字段，不打印SDK对象、头或原始提案。
  const error = value as { status?: unknown; error?: unknown }, safeStatus = typeof error?.status === 'number' ? error.status : 'unknown';
  const safeMessage = typeof error?.error === 'string' ? error.error.replace(/fsai_[A-Za-z0-9_-]+|Bearer\s+\S+/gi, '[redacted]').replace(/[\r\n]/g, ' ').slice(0, 800) : 'no safe server message';
  if (errorStatus !== undefined) { assert.equal(result.isError, true, `${name} must reject`); assert.equal((value as { status: number }).status, errorStatus); } else assert.notEqual(result.isError, true, `${name} must succeed (${safeStatus}: ${safeMessage})`);
  return value as T;
}
/** 完整旧模型流程之后运行：恢复私有约定内容也会增加其版本，但不改草稿、服务配置或公开指针。 */
export async function runAiDesignGuidanceHttp(input: { admin: Browser; editor: Browser; viewer: Browser; anonymous: Browser; origin: string }, state: Envelope): Promise<Envelope> {
  const { admin, editor, viewer, anonymous, origin } = input, url = new URL(origin); assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(url.port, '3200');
  const endpoint = '/api/ai/design-guidance', before = await admin.api<Envelope>('/api/studio'), original = await admin.api<AiDesignGuidance>(endpoint), provider = await admin.api('/api/ai/provider');
  assert.equal(before.revision, state.revision); assert.equal(before.activeReleaseId, state.activeReleaseId);
  const clients: Client[] = [], issued: Issued[] = [], designs: string[] = [];
  const values = (profile: AiDesignGuidance) => { const { revision, updatedAt: _updatedAt, ...fields } = profile; return { ...fields, expectedRevision: revision }; };
  const connect = async (scope: boolean) => {
    const page = before.state.pages.find(page => !page.slug.includes(':')); assert.ok(page, 'Isolated fixture must contain a normal page');
    const created = await admin.api<Issued>('/api/external-ai/tokens', 'POST', { name: scope ? 'HTTP guidance authorized' : 'HTTP guidance legacy', scopes: ['read', 'propose', ...(scope ? ['design-guidance:read'] : [])], pageIds: [page.id], recordIds: { productIds: [], entryIds: [] }, templateIds: [] }, 201); issued.push(created);
    const client = new Client({ name: 'design-guidance-http-test', version: '1' }); clients.push(client);
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', origin), { requestInit: { headers: { Authorization: `Bearer ${created.token}` }, redirect: 'error' }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } })));
    return { client, created, page };
  };
  try {
    for (const [client, code] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) { await client.api(endpoint, 'GET', undefined, code); await client.api(endpoint, 'PATCH', values(original), code); }
    assert.equal((await admin.fetch(endpoint, { method: 'PATCH', headers: { Origin: 'https://wrong.example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(values(original)) })).status, 403);
    await admin.api(endpoint, 'PATCH', { ...values(original), unsupported: true }, 422); await admin.api(endpoint, 'PATCH', { ...values(original), expectedRevision: original.revision + 1 }, 409);
    const saved = await admin.api<AiDesignGuidance>(endpoint, 'PATCH', { ...values(original), enabled: true, preferredStyle: 'SYNTHETIC_PRIVATE_GUIDANCE_HTTP: clear editorial hierarchy', preserveNotes: 'Keep supplied image proportions', avoidStyles: 'Avoid crowded mobile rows', feedback: [{ id: 'http-feedback', text: 'SYNTHETIC_PRIVATE_FEEDBACK_HTTP: keep comfortable mobile spacing' }] });
    assert.equal(saved.revision, original.revision + 1); assert.deepEqual(await admin.api(endpoint), saved); assert.deepEqual(await admin.api('/api/studio'), before);
    const legacy = await connect(false), allowed = await connect(true);
    const oldTools = (await sdk('legacy-tools', () => legacy.client.listTools())).tools.map(item => item.name), newTools = (await sdk('authorized-tools', () => allowed.client.listTools())).tools.map(item => item.name); assert.equal(oldTools.includes('site_design_guidance'), false); assert.ok(newTools.includes('site_design_guidance')); assert.equal(newTools.length, oldTools.length + 1);
    const rawRequest = { expectedRevision: before.revision, instruction: 'Add a native divider without rewriting supplied content', preserveText: true, targets: { pageIds: [allowed.page.id], header: false, footer: false, navigation: false, style: false } };
    const oldContext = await tool<Record<string, unknown>>(legacy.client, 'site_design_context', rawRequest); assert.doesNotMatch(JSON.stringify(oldContext), /SYNTHETIC_PRIVATE_GUIDANCE_HTTP|SYNTHETIC_PRIVATE_FEEDBACK_HTTP|guidanceRevision|designGuidance/);
    const explicit = await tool<{ revision: number; preferredStyle: string; advisory: boolean }>(allowed.client, 'site_design_guidance'); assert.equal(explicit.revision, saved.revision); assert.equal(explicit.preferredStyle, saved.preferredStyle); assert.equal(explicit.advisory, true);
    const context = await tool<{ request: typeof rawRequest & { guidanceRevision: number }; context: { designGuidance: { preferredStyle: string } } }>(allowed.client, 'site_design_context', rawRequest); assert.equal(context.request.guidanceRevision, saved.revision); assert.equal(context.context.designGuidance.preferredStyle, saved.preferredStyle);
    const proposal = { summary: 'Add native editable spacing', operations: [{ kind: 'page', pageId: allowed.page.id, operations: [{ kind: 'insert', parentId: '$page', index: 0, node: { tempId: 'new-http-guidance-divider', type: 'Divider', design: { desktop: { borderColor: '#d8ded5' } } } }] }], warnings: [] }, submission = { requestId: 'http-guidance-stable', request: context.request, proposal };
    await tool(allowed.client, 'site_design_propose', { ...submission, request: rawRequest }, 422);
    const candidate = await tool<ExternalAiDesignView>(allowed.client, 'site_design_propose', submission); designs.push(candidate.designId); assert.equal(candidate.status, 'pending'); assert.equal(candidate.generatedContentEditable, true); assert.equal(candidate.designGuidance?.revision, saved.revision);
    assert.doesNotMatch(JSON.stringify(candidate), /SYNTHETIC_PRIVATE_GUIDANCE_HTTP|SYNTHETIC_PRIVATE_FEEDBACK_HTTP/); assert.ok(candidate.beforeUrl && candidate.afterUrl);
    const previewPath = new URL(candidate.afterUrl!, origin).pathname; assert.equal((await admin.fetch(previewPath)).status, 200); assert.equal((await anonymous.fetch(previewPath)).status, 404);
    const changed = await admin.api<AiDesignGuidance>(endpoint, 'PATCH', { ...values(saved), preferredStyle: 'A later explicitly saved design direction' });
    const retried = await tool<ExternalAiDesignView>(allowed.client, 'site_design_propose', submission); assert.equal(retried.designId, candidate.designId); assert.equal(retried.designGuidance?.stale, true);
    await tool(allowed.client, 'site_design_propose', { ...submission, requestId: 'http-guidance-stale' }, 409);
    assert.equal((await fetch(`${origin}${endpoint}`, { method: 'PATCH', headers: { Authorization: `Bearer ${allowed.created.token}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(values(changed)) })).status, 401, '机器读取约定不获得浏览器设置写权限');
    assert.deepEqual(await admin.api('/api/studio'), before); assert.deepEqual(await admin.api('/api/ai/provider'), provider);
  } finally {
    for (const client of clients) await client.close();
    for (const item of issued) await admin.api(`/api/external-ai/tokens/${item.credential.id}`, 'DELETE');
    for (const id of designs) await admin.api(`/api/ai/site-designs/${id}`, 'DELETE');
    const current = await admin.api<AiDesignGuidance>(endpoint); await admin.api(endpoint, 'PATCH', { ...values(original), expectedRevision: current.revision });
  }
  assert.deepEqual(await admin.api('/api/studio'), before); return before;
}
