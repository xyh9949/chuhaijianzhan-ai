import { completeGscAuthorization } from '@/server/seo-sources';
import { requireActor } from '@/server/permissions';
import { getAuthEnvironment } from '@/server/env';
export const runtime='nodejs';export const dynamic='force-dynamic';
/** OAuth回调来自Google导航，不用Origin代替state；只返回固定站内结果，不泄漏上游代码。 */
export async function GET(request:Request){let result='failed';try{await completeGscAuthorization(new URL(request.url).searchParams,await requireActor(request),request.signal);result='connected';}catch{/* 前端只收到固定状态；需要重新授权时不回传敏感上游正文。 */}return new Response(null,{status:303,headers:{Location:`${getAuthEnvironment().baseURL}/admin?seoConnection=${result}#seo`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}
