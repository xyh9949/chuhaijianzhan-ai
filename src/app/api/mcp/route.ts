import { handleExternalAiMcp } from '@/server/external-ai-mcp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = handleExternalAiMcp;
// 采用无会话JSON请求响应；本批没有独立SSE恢复流或服务器会话删除。
export function GET() { return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } }); }
export const DELETE = GET;
