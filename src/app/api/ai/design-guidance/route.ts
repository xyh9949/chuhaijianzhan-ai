import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readJson } from '@/server/validation';
import { readAiDesignGuidance, saveAiDesignGuidance } from '@/server/ai-design-guidance';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 设计约定正文只供当前管理员读写，外部机器另走显式只读权限，不接受模型代写。 */
export async function GET(request: Request) { try { const actor = await requireActor(request); requirePermission(actor, 'manage'); return json(readAiDesignGuidance(actor)); } catch (error) { return apiError(error); } }
/** 完整接收输入后复核会话和当前角色，撤权后的旧请求不能继续操作。 */
export async function PATCH(request: Request) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'manage'); const input = await readJson(request, 32 * 1024); actor = revalidateActor(actor, 'manage'); return json(saveAiDesignGuidance(input, actor)); } catch (error) { return apiError(error); } }
