import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio发现失败仅返回固定错误，不把上游诊断正文交给客户端', { timeout: 15000 }, async () => {
  const marker = 'SYNTHETIC_PRIVATE_UPSTREAM_DIAGNOSTIC';
  // 此上游仅模拟协议成功后的代理故障；真实MCP服务另有官方SDK HTTP端到端验证。
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-upstream', version: '1' } } }));
    } else if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); }
    else { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end(marker); }
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const address = upstream.address(); assert.ok(address && typeof address !== 'string'); assert.notEqual(address.port, 3200);
  const env: Record<string, string> = { FORM_STUDIO_MCP_URL: `http://127.0.0.1:${address.port}/api/mcp`, FORM_STUDIO_MCP_TOKEN: 'synthetic-not-a-live-token' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]!;
  const client = new Client({ name: 'bridge-privacy-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('scripts/mcp-bridge.mjs')], env, stderr: 'pipe' }));
    let message = ''; try { await client.listTools(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    assert.match(message, /无法读取网站工具列表/); assert.equal(message.includes(marker), false);
  } finally {
    await client.close(); upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done()));
  }
});
