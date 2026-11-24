import { createContentEntryPreview } from '@/server/content-entry-preview';
import { apiError, json, readJsonObject } from '@/server/http';
import { assertSameOrigin, requireActor, revalidateActor } from '@/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 预览写入内存候选，站点草稿、文章和发布历史都无需写入。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request);
    // 允许与草稿相同体积的长篇富文本，额外空间只用于请求的外层字段。
    const value = await readJsonObject(request, 4 * 1024 * 1024 + 1024);
    return json(createContentEntryPreview(revalidateActor(actor, 'edit'), value));
  } catch (error) { return apiError(error); }
}
