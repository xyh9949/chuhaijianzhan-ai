import { getMailSettingsSummary, saveMailSettings } from '@/server/mail-settings';
import { startNotificationWorker } from '@/server/notification-jobs';
import { apiError, json, readJsonObject } from '@/server/http';
import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { auditFailure } from '@/server/audit';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(getMailSettingsSummary(actor)); } catch (error) { return apiError(error); } }
/** 管理员保存私有运行配置，立即同步领取状态；配置不进入网站发布或普通草稿。 */
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const value = await readJsonObject(request); actor = revalidateActor(actor, 'manage');
    const result = await auditFailure(actor, 'mail.settings', () => saveMailSettings(value, actor)); startNotificationWorker(); return json(result);
  } catch (error) { return apiError(error); }
}
