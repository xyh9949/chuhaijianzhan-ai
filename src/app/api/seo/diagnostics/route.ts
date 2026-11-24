import { requireActor, requirePermission } from '@/server/permissions';
import { json, apiError } from '@/server/http';
import { getDraftRecord } from '@/server/studio';
import { getSeoSourceSummary, listSeoReports, readSeoReport } from '@/server/seo-sources';
import { diagnoseSeo } from '@/lib/seo-diagnostics';
export const runtime='nodejs'; export const dynamic='force-dynamic';
/** 诊断只读本机已有报告，旧连接不会混进当前建议；这里不联网、不调用AI。 */
export async function GET(request:Request){try{const actor=await requireActor(request);requirePermission(actor,'manage');const source=getSeoSourceSummary(actor),reports=listSeoReports(actor).items.filter(item=>item.provider==='csv'||item.connectionRevision===(item.provider==='gsc'?source.gsc.revision:source.keywords.revision)).slice(0,10).map(item=>readSeoReport(item.id,actor)),draft=getDraftRecord();return json({...diagnoseSeo(draft.content,reports),revision:draft.revision});}catch(error){return apiError(error);}}
