import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireActor, requirePermission } from '@/server/permissions';
import { apiError, ApiError } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 下载固定交付文件，不从URL读取路径，也不把实例凭据写进Skill。 */
export async function GET(request: Request) {
  try {
    requirePermission(await requireActor(request), 'manage');
    let body: string;
    try { body = await readFile(join(process.cwd(), 'docs/skills/form-studio-site-design/SKILL.md'), 'utf8'); }
    catch { throw new ApiError(503, '当前部署缺少操作Skill，请使用完整交付包更新'); }
    return new Response(body, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="SKILL.md"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return apiError(error); }
}
