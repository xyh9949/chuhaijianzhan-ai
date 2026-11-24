import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { ApiError, apiError, json } from '@/server/http';
import { readJson } from '@/server/validation';
import { validateSnippet } from '@/server/site-code';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage');
    const source = await readJson(request, 256 * 1024);
    // 校验仍是管理员操作，读取源码期间撤销的会话不能继续执行此入口。
    actor = revalidateActor(actor, 'manage');
    // 主动检查包含尚未启用的 JS；保存接口仍允许关闭状态的不完整源码。
    try {
      const snippet = validateSnippet(source, '当前代码');
      if (!snippet.jsEnabled) {
        try { validateSnippet(snippet, '当前代码', true); }
        catch (error) { if (error instanceof ApiError) return json({ errors: [], warnings: [`${error.message}；当前 JS 未启用，可以保存为草稿`] }); throw error; }
      }
      return json({ errors: [], warnings: [] });
    }
    catch (error) { if (error instanceof ApiError) return json({ errors: [error.message], warnings: [] }); throw error; }
  } catch (error) { return apiError(error); }
}
