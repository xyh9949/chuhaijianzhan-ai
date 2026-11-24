import { testMailSettings } from '@/server/mail-settings';
import { apiError, json, readJsonObject } from '@/server/http';
import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { auditFailure } from '@/server/audit';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 此按钮才授权一封固定测试邮件；测试不读取询盘或自动重试。 */
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function POST(request: Request) {
  try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const value = await readJsonObject(request); actor = revalidateActor(actor, 'manage'); return json(await auditFailure(actor, 'mail.test', () => testMailSettings(value, actor, request.signal))); }
  catch (error) { return apiError(error); }
}
