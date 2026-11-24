import { apiError } from '@/server/http';
import { readRelease } from '@/server/studio';
import { identifier } from '@/server/validation';
import { siteCodeResponse } from '@/server/site-code';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ releaseId: string; target: string; kind: string }> }) {
  try {
    const { releaseId, target, kind } = await context.params;
    // 历史发布资源仍支持缓存与回滚；此入口从不读取草稿或编辑器预览。
    return siteCodeResponse(readRelease(identifier(releaseId, '发布版本')), identifier(target, '代码目标'), kind);
  } catch (error) { return apiError(error); }
}
