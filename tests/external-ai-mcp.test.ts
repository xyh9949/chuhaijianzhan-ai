import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getDatabase } from '../src/server/database';
import { getDraftRecord } from '../src/server/studio';
import { createExternalAiToken, revokeExternalAiToken } from '../src/server/external-ai-tokens';
import { handleExternalAiMcp } from '../src/server/external-ai-mcp';
import type { Actor } from '../src/server/permissions';

const origin = 'http://127.0.0.1:3291';
const owner: Actor = { id: 'mcp-owner', name: 'Synthetic MCP owner', email: 'mcp-owner@example.invalid', role: 'admin' };
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-mcp-wire-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-mcp-wire-secret-'.repeat(3);
  getDraftRecord(); const db = getDatabase();
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(owner.id, owner.name, owner.email, owner.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-mcp-wire-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const create = (scopes = ['read', 'propose']) => createExternalAiToken({ name: 'MCP wire test', scopes }, owner);
function rpc(token: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

test('MCP仅接受独立Bearer和配置来源，错误不回显认证或内部堆栈', async () => {
  const issued = create();
  const unauthenticated = await handleExternalAiMcp(rpc('', 'tools/list', {}, { Cookie: 'better-auth.session_token=not-a-machine-token' }));
  assert.equal(unauthenticated.status, 401); assert.match(unauthenticated.headers.get('www-authenticate') || '', /^Bearer/);
  for (const headers of [{ Origin: 'https://untrusted.example.invalid' }, { Host: 'other.example.invalid' }] as Record<string, string>[]) {
    const response = await handleExternalAiMcp(rpc(issued.token, 'tools/list', {}, headers)); assert.equal(response.status, 403); assert.equal((await response.text()).includes(issued.token), false);
  }
});

test('官方SDK处理无会话初始化、跨请求工具发现和真实调用，连接之间权限不串用', { timeout: 10000 }, async () => {
  const issued = create();
  const init = await handleExternalAiMcp(rpc(issued.token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'unit-wire', version: '1' } }));
  assert.equal(init.status, 200); const initialized = await init.json(); assert.equal(initialized.result.protocolVersion, '2025-11-25'); assert.equal(initialized.result.serverInfo.name, 'form-studio'); assert.equal(init.headers.get('mcp-session-id'), null);
  const discovered = await handleExternalAiMcp(rpc(issued.token, 'tools/list')); const list = await discovered.json(); assert.ok(list.result.tools.some((item: { name: string }) => item.name === 'site_design_propose'));
  const called = await handleExternalAiMcp(rpc(issued.token, 'tools/call', { name: 'site_overview', arguments: {} })); const result = await called.json();
  assert.equal(result.result.structuredContent.pages[0].id, 'home'); assert.equal(JSON.stringify(result).includes(owner.email), false); assert.match(called.headers.get('cache-control') || '', /no-store/);
  const readOnly = create(['read']); const readList = await (await handleExternalAiMcp(rpc(readOnly.token, 'tools/list'))).json(); assert.equal(readList.result.tools.some((item: { name: string }) => item.name === 'site_design_propose'), false);
  revokeExternalAiToken(issued.credential.id, owner); assert.equal((await handleExternalAiMcp(rpc(issued.token, 'tools/list'))).status, 401);
});

test('MCP拒绝未知协议与无长度声明超大JSON，SDK保留真实传输错误语义', { timeout: 10000 }, async () => {
  const issued = create(); const invalid = await handleExternalAiMcp(rpc(issued.token, 'tools/list', {}, { 'MCP-Protocol-Version': 'unknown-version' })); assert.equal(invalid.status, 400);
  const oversized = new Request(`${origin}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', padding: 'x'.repeat(512 * 1024) }) });
  assert.equal((await handleExternalAiMcp(oversized)).status, 413);
});

test('文案与SEO工具按新域分别发现，旧连接和只读连接不能调用提交能力', async () => {
  const names = async (token: string) => (await (await handleExternalAiMcp(rpc(token, 'tools/list'))).json()).result.tools.map((tool: { name: string }) => tool.name) as string[];
  const old = create(), legacy = await names(old.token); assert.equal(legacy.length, 7);
  assert.ok(legacy.includes('site_design_select')); assert.equal(legacy.some(name => name.startsWith('site_content_') || name.startsWith('site_seo_')), false);
  const both = createExternalAiToken({ name: 'Writing and SEO', scopes: ['read','content:read','content:propose','seo:read','seo:propose'], recordIds: { productIds: null, entryIds: null } }, owner);
  const tools = await names(both.token); assert.equal(tools.length, 16); assert.ok(tools.includes('site_content_propose')); assert.ok(tools.includes('site_seo_propose')); assert.equal(tools.includes('site_design_propose'), false);
  const contentRead = createExternalAiToken({ name: 'Read writing', scopes: ['read','content:read'], recordIds: { productIds: [], entryIds: [] } }, owner);
  const readTools = await names(contentRead.token); assert.ok(readTools.includes('site_content_context')); assert.equal(readTools.includes('site_content_propose'), false); assert.equal(readTools.includes('site_seo_context'), false);
  const called = await (await handleExternalAiMcp(rpc(contentRead.token, 'tools/call', { name: 'site_content_capabilities', arguments: {} }))).json();
  assert.equal(called.result.structuredContent.siteModelCalls, false); assert.equal(called.result.structuredContent.editable, true);
  const refused = await (await handleExternalAiMcp(rpc(old.token, 'tools/call', { name: 'site_content_overview', arguments: {} }))).json(); assert.equal(refused.result.isError, true);
});
