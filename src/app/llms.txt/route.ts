import {readActiveSite} from '@/lib/site-request';
import {llmsText} from '@/lib/discovery';
import {publicSiteOrigin} from '@/lib/site-seo';
export const dynamic='force-dynamic';
/** 只从当前公开快照生成可选目录；未启用或未设置规范域名时明确404。 */
export async function GET(){const s=await readActiveSite();if(!s?.settings.discovery?.llms||!publicSiteOrigin(s.settings.publicUrl))return new Response('Not found',{status:404});return new Response(llmsText(s),{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
