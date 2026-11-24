import {commitDefaultLocaleMigration} from '@/server/localization';
import {apiError,json,readJsonObject} from '@/server/http';
import {assertSameOrigin,requireActor,requirePermission,revalidateActor} from '@/server/permissions';
import {auditFailure} from '@/server/audit';
export const runtime='nodejs';
export async function POST(request:Request){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const input=await readJsonObject(request);/* 语言迁移写入设置和多类内容，以读体后的会话权限为准。 */actor=revalidateActor(actor,'manage');return json(await auditFailure(actor,'draft.update',()=>commitDefaultLocaleMigration(input,actor)));}catch(error){return apiError(error);}}
