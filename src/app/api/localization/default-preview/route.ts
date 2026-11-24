import {previewDefaultLocaleMigration} from '@/server/localization';
import {apiError,json,readJsonObject} from '@/server/http';
import {assertSameOrigin,requireActor,requirePermission,revalidateActor} from '@/server/permissions';
export const runtime='nodejs';
export async function POST(request:Request){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const input=await readJsonObject(request);/* 语言迁移预检包含私有草稿范围，读取body后复核。 */actor=revalidateActor(actor,'manage');return json(previewDefaultLocaleMigration(input));}catch(error){return apiError(error);}}
