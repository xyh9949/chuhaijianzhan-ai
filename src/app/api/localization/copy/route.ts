import {copyTranslation} from '@/server/localization';
import {apiError,json} from '@/server/http';
import {readJson} from '@/server/validation';
import {assertSameOrigin,requireActor,requirePermission,revalidateActor} from '@/server/permissions';
import {auditFailure} from '@/server/audit';
export const runtime='nodejs';
export async function POST(request:Request){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const input=await readJson(request);/* 译文复制紧接同步写入，先复核等待期间的撤权。 */actor=revalidateActor(actor,'manage');return json(await auditFailure(actor,'draft.update',()=>copyTranslation(input,actor)),201);}catch(error){return apiError(error);}}
