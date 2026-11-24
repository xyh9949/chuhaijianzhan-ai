import {extensionInventory} from '@/server/extensions';
import {requireActor,requirePermission} from '@/server/permissions';
import {apiError,json} from '@/server/http';
export const runtime='nodejs';
export async function GET(request:Request){try{const actor=await requireActor(request);requirePermission(actor,'manage');return json(extensionInventory());}catch(error){return apiError(error);}}
