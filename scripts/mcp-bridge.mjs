#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// stdio只传MCP消息；凭据从环境读取，不接收命令行密钥、不打印上游错误或认证头。
const remote = new Client({ name: 'form-studio-local-bridge', version: '0.31.1' });
let local;
async function main() {
  const value = process.env.FORM_STUDIO_MCP_URL, token = process.env.FORM_STUDIO_MCP_TOKEN;
  if (!value || !token || /\s/.test(token) || token.length > 256) throw Error('configuration');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/mcp' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw Error('configuration');
  await remote.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' } }));
  // 低层Server用于透传上游动态JSON Schema，连接和协议生命周期仍由官方SDK实现。
  local = new Server({ name: 'form-studio-bridge', version: '0.31.1' }, { capabilities: { tools: {} }, instructions: remote.getInstructions() });
  local.setRequestHandler(ListToolsRequestSchema, async () => {
    try { return await remote.listTools(); }
    // 上游代理错误正文可能含诊断或认证信息，发现阶段也不能把原异常交给外部模型。
    catch { throw new Error('无法读取网站工具列表，请检查连接权限与网站状态'); }
  });
  local.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try { return await remote.callTool(params); }
    catch { return { isError: true, content: [{ type: 'text', text: '网站连接未完成，请检查凭据、授权范围和服务状态；没有自动重试或采用。' }] }; }
  });
  await local.connect(new StdioServerTransport());
}
async function close() { await local?.close(); await remote.close(); }
process.on('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().finally(() => process.exit(0)); });
main().catch(async () => { try { await close(); } catch { /* 失败退出也不输出上游认证或请求正文。 */ } process.stderr.write('Form Studio连接失败：请核对FORM_STUDIO_MCP_URL和FORM_STUDIO_MCP_TOKEN，以及网站是否已启动。\n'); process.exitCode = 1; });
