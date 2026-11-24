import { requireActor, requirePermission } from '@/server/permissions';
import { json, apiError } from '@/server/http';
import { readLaunchCheck } from '@/server/launch-check';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 状态读取不代替验证，更不隐式执行模型、邮件、发布或网络检查。 */
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(readLaunchCheck(actor)); } catch (error) { return apiError(error); } }
