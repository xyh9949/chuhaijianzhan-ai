import {getDatabase} from '@/server/database';
import {getAuthEnvironment} from '@/server/env';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** 就绪检查只给状态；路径、配置、客户数量、错误正文均不向匿名访问者披露。 */
export function GET(){
  let ready=false;
  try{getAuthEnvironment();const db=getDatabase();ready=!!db.prepare('SELECT 1 FROM auth_user LIMIT 1').get()&&!!db.prepare('SELECT 1 FROM cms_draft WHERE id=1').get();}catch{}
  return Response.json({status:ready?'ready':'unavailable'},{status:ready?200:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
