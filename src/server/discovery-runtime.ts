import {randomUUID} from 'node:crypto';
import {getDatabase} from './database';
import {ApiError} from './http';
import {publicSiteOrigin} from '../lib/site-seo';
import {discoveryDiagnostics,DISCOVERY_POLICY_DATE,DISCOVERY_SOURCES,indexableRoutes} from '../lib/discovery';
import {getDraftRecord,getActiveReleaseId,readRelease} from './studio';
import type {SiteSnapshot,ActorIdentity} from './types';
import {recordAudit} from './audit';

export const OBSERVATION_KINDS=['google-ai-impressions','bing-ai-citations','indexed-url-count','manual-answer','ai-referral-visits','qualified-inquiries'] as const;
export type ObservationKind=typeof OBSERVATION_KINDS[number];
export interface DiscoveryObservation {kind:ObservationKind;platform:string;date:string;timezone:string;count:number;url:string;source:string;notes:string;}
/** 外部指标只记录来源和原始口径；人工回答样本不当作全站排名或官方统计。 */
export function addObservations(input:unknown,actor:ActorIdentity){
  if(!Array.isArray(input)||input.length<1||input.length>100)throw new ApiError(422,'每批需要1–100条观测');
  const rows=input.map(v=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new ApiError(422,'观测格式无效');const o=v as DiscoveryObservation;
    if(Object.keys(o).some(k=>!['kind','platform','date','timezone','count','url','source','notes'].includes(k))||!OBSERVATION_KINDS.includes(o.kind)||!Number.isSafeInteger(o.count)||o.count<0||o.count>1e12||!/^\d{4}-\d{2}-\d{2}$/.test(o.date)||!Number.isFinite(Date.parse(o.date))||new Date(o.date).toISOString().slice(0,10)!==o.date)throw new ApiError(422,'观测类型、数值或日期无效');
    for(const [k,max] of Object.entries({platform:100,timezone:80,url:2048,source:2000,notes:4000}))if(typeof o[k as keyof DiscoveryObservation]!=='string'||String(o[k as keyof DiscoveryObservation]).length>max)throw new ApiError(422,'观测文字超过长度或类型错误');
    if(!o.platform.trim()||!o.source.trim())throw new ApiError(422,'观测必须说明平台和证据来源');try{new Intl.DateTimeFormat('en',{timeZone:o.timezone});}catch{throw new ApiError(422,'观测时区无效');}
    if(o.url){try{const u=new URL(o.url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error();}catch{throw new ApiError(422,'被引网址无效');}}
    return o;
  });
  getDatabase().transaction(()=>{const total=(getDatabase().prepare('SELECT count(*) n FROM cms_discovery_observation').get() as {n:number}).n;if(total+rows.length>10000)throw new ApiError(422,'观测达到10000条，请先导出并清理旧记录');const stmt=getDatabase().prepare('INSERT INTO cms_discovery_observation(payload_json,actor_id,created_at) VALUES(?,?,?)');for(const o of rows)stmt.run(JSON.stringify(o),actor.id,new Date().toISOString());recordAudit(actor,'discovery.observe','success',{objectCount:rows.length});}).immediate();
}
export function deleteObservation(id:number,actor:ActorIdentity){if(!Number.isSafeInteger(id)||id<1)throw new ApiError(422,'观测ID无效');getDatabase().transaction(()=>{if(getDatabase().prepare('DELETE FROM cms_discovery_observation WHERE id=?').run(id).changes!==1)throw new ApiError(404,'观测不存在');recordAudit(actor,'discovery.observe','success',{objectIds:[String(id)],fields:['delete']});}).immediate();}
export function listObservations(before=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(before)||before<1)throw new ApiError(422,'观测游标无效');return (getDatabase().prepare('SELECT id,payload_json,created_at createdAt FROM cms_discovery_observation WHERE id < ? ORDER BY id DESC LIMIT 100').all(before) as {id:number;payload_json:string;createdAt:string}[]).map(({payload_json,...v})=>({...v,...JSON.parse(payload_json)}));}
function indexNowConfig(){const key=process.env.FORM_STUDIO_INDEXNOW_KEY||'';return {enabled:process.env.FORM_STUDIO_INDEXNOW_ENABLED==='true',key: /^[A-Za-z0-9-]{8,128}$/.test(key)?key:''};}
/** 对外发送只由实例环境显式启用；公开草稿里的开关不能越过运维授权。 */
export function indexNowKey(){const c=indexNowConfig();return c.enabled?c.key:'';}
export function enqueuePublicChanges(before:SiteSnapshot|null,after:SiteSnapshot,eventId:string){
  const c=indexNowConfig(),origin=publicSiteOrigin(after.settings.publicUrl);if(!c.enabled||!c.key||!origin||/^http:\/\/(localhost|127\.|\[::1\])/i.test(origin))return;
  const oldOrigin=publicSiteOrigin(before?.settings.publicUrl),oldState=before?.urlState||{},state=after.urlState||{};
  const urls=new Set<string>();for(const [path,value] of Object.entries(state))if(oldOrigin!==origin||oldState[path]?.hash!==value.hash)urls.add(origin+path);
  if(oldOrigin===origin)for(const path of Object.keys(oldState))if(!state[path])urls.add(origin+path);
  const stmt=getDatabase().prepare('INSERT OR IGNORE INTO cms_discovery_job(id,event_id,origin,urls_json,status,attempts,next_attempt,created_at) VALUES(?,?,?,?,\'pending\',0,0,?)');
  const all=[...urls];for(let start=0;start<all.length;start+=1000)stmt.run(randomUUID(),`${eventId}:${start}`,origin,JSON.stringify(all.slice(start,start+1000)),new Date().toISOString());
}
/** 固定官方端点、同源网址、有限重试与租约；200仅记为接收，绝不标作“已收录”。 */
export async function processIndexNowOnce(fetcher:typeof fetch=fetch){const c=indexNowConfig();if(!c.enabled||!c.key)return;const db=getDatabase(),now=Date.now();
  const row=db.transaction(()=>{const r=db.prepare("SELECT * FROM cms_discovery_job WHERE (status='pending' AND next_attempt<=?) OR (status='processing' AND next_attempt<=?) ORDER BY created_at LIMIT 1").get(now,now) as {id:string;origin:string;urls_json:string;attempts:number}|undefined;if(r)db.prepare("UPDATE cms_discovery_job SET status='processing',next_attempt=? WHERE id=?").run(now+60000,r.id);return r;}).immediate();if(!row)return;
  const attempts=row.attempts+1;let status='pending',code='network-error';
  try{const origin=publicSiteOrigin(row.origin),urls=JSON.parse(row.urls_json) as string[],active=getActiveReleaseId(),current=active?readRelease(active):null;if(!origin||publicSiteOrigin(current?.settings.publicUrl)!==origin||urls.length>1000||urls.some(u=>new URL(u).origin!==origin||new URL(u).pathname.startsWith('/api/')||new URL(u).pathname.startsWith('/admin')||new URL(u).pathname.startsWith('/preview'))){status='failed';code='invalid-or-retired-origin';}else{const r=await fetcher('https://api.indexnow.org/indexnow',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({host:new URL(origin).host,key:c.key,keyLocation:`${origin}/api/discovery-key`,urlList:urls})});code=String(r.status);status=r.status===200?'accepted':r.status===202?'verification-pending':[400,403,422].includes(r.status)?'failed':'pending';}}
  catch{/* 不保存可能含凭据或URL正文的第三方异常。 */}
  if(attempts>=5&&status==='pending')status='failed';db.prepare('UPDATE cms_discovery_job SET status=?,attempts=?,next_attempt=?,response_code=? WHERE id=?').run(status,attempts,now+Math.min(3600000,30000*2**attempts),code,row.id);
}
const globalWorker=globalThis as typeof globalThis&{discoveryWorker?:boolean};
export function startDiscoveryWorker(){if(globalWorker.discoveryWorker||!indexNowConfig().enabled)return;globalWorker.discoveryWorker=true;let busy=false;const timer=setInterval(()=>{if(busy)return;busy=true;void processIndexNowOnce().catch(()=>console.error('discovery_job_failed')).finally(()=>{busy=false;});},15000);timer.unref();}
/** 可选的最小抓取计数：UA只是声称身份，不保存IP/Cookie/查询串，不冒充核验成功。 */
export function recordCrawl(path:string,headers:Headers){if(process.env.FORM_STUDIO_CRAWL_LOG!=='true'||headers.has('rsc')||headers.has('next-router-prefetch'))return;const ua=headers.get('user-agent')||'',bot=['Googlebot','bingbot','OAI-SearchBot','GPTBot','Claude-SearchBot','ClaudeBot','Claude-User','ChatGPT-User','PerplexityBot','Perplexity-User'].find(x=>ua.toLowerCase().includes(x.toLowerCase()));if(!bot)return;const day=new Date().toISOString().slice(0,10);getDatabase().prepare('INSERT INTO cms_discovery_crawl(day,path,agent,count) VALUES(?,?,?,1) ON CONFLICT(day,path,agent) DO UPDATE SET count=count+1').run(day,path.slice(0,500),bot);getDatabase().prepare("DELETE FROM cms_discovery_crawl WHERE day < date('now','-30 days')").run();}
/** 概览只展示当前发布版本的开关与网址，不能把未发布草稿显示成已经生效。 */
export function discoveryStatus(before=Number.MAX_SAFE_INTEGER){const activeId=getActiveReleaseId(),active=activeId?readRelease(activeId):null,draft=getDraftRecord().content;return {policyDate:DISCOVERY_POLICY_DATE,sources:DISCOVERY_SOURCES,activeReleaseId:activeId,publicFeatures:{llms:!!active?.settings.discovery?.llms,publicUrl:publicSiteOrigin(active?.settings.publicUrl)||null},scope:'仅本实例；诊断不等于收录或排名',draftIssues:discoveryDiagnostics({...draft,schemaVersion:16}),publicIssues:active?discoveryDiagnostics(active):[],publicRoutes:active?indexableRoutes(active).length:0,indexNow:{enabled:indexNowConfig().enabled,keyConfigured:!!indexNowConfig().key,jobs:getDatabase().prepare('SELECT id,event_id eventId,origin,status,attempts,response_code responseCode,created_at createdAt FROM cms_discovery_job ORDER BY created_at DESC LIMIT 100').all()},crawl:{enabled:process.env.FORM_STUDIO_CRAWL_LOG==='true',identity:'仅UA声称，未经身份核验',timezone:'UTC',retentionDays:30,items:getDatabase().prepare('SELECT day,agent,sum(count) count FROM cms_discovery_crawl GROUP BY day,agent ORDER BY day DESC LIMIT 300').all() as {day:string;agent:string;count:number}[]},observations:listObservations(before)};}
