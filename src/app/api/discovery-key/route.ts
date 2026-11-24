import {indexNowKey} from '@/server/discovery-runtime';
export const dynamic='force-dynamic';
/** IndexNow所有权文件按协议公开；平台账号和实例密钥永不由此输出。 */
export function GET(){const key=indexNowKey();return new Response(key||'Not found',{status:key?200:404,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex'}});}
