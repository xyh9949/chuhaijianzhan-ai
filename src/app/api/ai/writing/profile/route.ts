import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readJson } from '@/server/validation';
import { readAiWritingProfile, saveAiWritingProfile } from '@/server/ai-writing';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(readAiWritingProfile(actor)); } catch (error) { return apiError(error); } }
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function PATCH(request: Request) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJson(request, 256 * 1024); actor = revalidateActor(actor, 'manage'); return json(saveAiWritingProfile(input, actor)); } catch (error) { return apiError(error); } }
