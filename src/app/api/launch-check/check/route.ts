import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { json, apiError, readJsonObject } from '@/server/http';
import { checkLaunchReadiness } from '@/server/launch-check';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 只检查服务端确定的正式地址，浏览器不能指定探测目标或替代传输器。 */
export async function POST(request: Request) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJsonObject(request); /* 开始服务端检查前复核读体期间的撤权。 */ actor = revalidateActor(actor, 'manage'); return json(await checkLaunchReadiness(input, actor, request.signal)); } catch (error) { return apiError(error); } }
