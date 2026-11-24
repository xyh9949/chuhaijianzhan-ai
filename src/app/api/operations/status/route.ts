import {readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {requireActor,requirePermission} from '@/server/permissions';
import {json,apiError} from '@/server/http';
export const runtime='nodejs';
/** 仅管理员读取白名单运维状态，不返回目录、密钥或备份内业务内容。 */
export async function GET(request:Request){try{requirePermission(await requireActor(request),'manage');const enabled=process.env.FORM_STUDIO_AUTOMATIC_BACKUP==='1';let latest:Record<string,unknown>|null=null;try{const file=join(resolve(/* turbopackIgnore:true */process.env.FORM_STUDIO_BACKUP_DIR||'backups'),'STATUS.json');if(statSync(file).size<=4096){const data=JSON.parse(readFileSync(file,'utf8'));if(['success','failure'].includes(data.status))latest={status:data.status,at:typeof(data.createdAt||data.at)==='string'?data.createdAt||data.at:null,bytes:Number.isSafeInteger(data.bytes)?data.bytes:null,files:Number.isSafeInteger(data.files)?data.files:null,keep:Number.isInteger(data.keep)?data.keep:null};}}catch{}return json({automatic:enabled,intervalHours:enabled?Number(process.env.FORM_STUDIO_BACKUP_INTERVAL_HOURS||24):null,latest});}catch(error){return apiError(error);}}
