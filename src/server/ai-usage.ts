import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AiModelRate, AiPricing, AiUsageItem, AiUsageList, AiUsageTask } from '../lib/ai-usage-types';
import { getDatabase } from './database';
import { ApiError } from './http';
import { isMemberDisabled, requirePermission, type Actor, type MemberRow } from './permissions';
import { object, revision } from './validation';

const tasks: AiUsageTask[] = ['build','design','writing','translation','site-translation','seo','seo-content','vision','source','connection'];
const context = new AsyncLocalStorage<{ actorId: string; task: AiUsageTask; jobId?: string }>();
const retention = 30 * 24 * 60 * 60_000;
function administrator(actor: Actor) {
  requirePermission(actor,'manage'); const row=getDatabase().prepare('SELECT id,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as MemberRow|undefined;
  if(!row||isMemberDisabled(row))throw new ApiError(401,'账号已停用或会话失效');
  if(row.role!=='admin')throw new ApiError(403,'AI用量由管理员查看');
}
/** 只在服务器已鉴权业务中绑定归属；嵌套调用保留同一人的批量任务标识，不接收浏览器自报用户。 */
export function withAiUsage<T>(actor: Actor,task: AiUsageTask,action:()=>T,jobId?:string):T {
  administrator(actor); if(!tasks.includes(task))throw new ApiError(422,'AI任务类型无效');
  const outer=context.getStore();return context.run({actorId:actor.id,task,...(jobId?{jobId}:outer?.actorId===actor.id&&outer.jobId?{jobId:outer.jobId}:{})},action);
}
function pricing():AiPricing {
  const row=getDatabase().prepare('SELECT revision,config_json,updated_at FROM cms_ai_pricing WHERE id=1').get() as {revision:number;config_json:string;updated_at:string}|undefined;
  return row?{revision:row.revision,rates:JSON.parse(row.config_json).rates,updatedAt:row.updated_at}:{revision:0,rates:[],updatedAt:''};
}
export function getAiPricing(actor:Actor){administrator(actor);return pricing();}
/** 金额仅按用户自填的每百万token价格估算，未配置不猜服务商价格或汇率。 */
export function saveAiPricing(value:unknown,actor:Actor,checkAccess?:()=>void):AiPricing {
  administrator(actor);const input=object(value,'用量价格');if(Object.keys(input).some(key=>!['expectedRevision','rates'].includes(key)))throw new ApiError(422,'用量价格字段无效');
  const expected=revision(input.expectedRevision);if(!Array.isArray(input.rates)||input.rates.length>20)throw new ApiError(422,'最多配置20个模型价格');
  const rates:AiModelRate[]=input.rates.map(raw=>{const item=object(raw);if(Object.keys(item).some(key=>!['model','currency','inputPerMillion','outputPerMillion'].includes(key))||typeof item.model!=='string'||!item.model.trim()||item.model.length>150||/[\u0000-\u001f\u007f]/.test(item.model)||typeof item.currency!=='string'||!/^[A-Z]{3}$/.test(item.currency)||[item.inputPerMillion,item.outputPerMillion].some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>100000))throw new ApiError(422,'请填写模型、三位大写币种和非负价格');return{model:item.model.trim(),currency:item.currency,inputPerMillion:item.inputPerMillion as number,outputPerMillion:item.outputPerMillion as number};});
  if(new Set(rates.map(rate=>rate.model)).size!==rates.length)throw new ApiError(422,'每个模型只配置一种币种的价格');
  return getDatabase().transaction(()=>{checkAccess?.();administrator(actor);if(pricing().revision!==expected)throw new ApiError(409,'价格已被其他窗口更新，请读取最新版本');getDatabase().prepare('INSERT INTO cms_ai_pricing VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,updated_at=excluded.updated_at').run(expected+1,JSON.stringify({rates}),new Date().toISOString());return pricing();}).immediate();
}
export type AiUsageTicket={id:string;actorId:string;started:number;rate:AiModelRate|null;pricingRevision:number;inputTokens:number|null;outputTokens:number|null;totalTokens:number|null;outputChars:number|null;warning?:string};
/** 先成功记录再请求模型；仅保存计数，不保存提示词、正文、图片或凭据。无业务上下文的内部CLI不冒认其他用户。 */
export function startAiUsage(model:string,inputChars:number,imageCount:number):AiUsageTicket|undefined {
  const current=context.getStore();if(!current)return undefined;
  const now=new Date().toISOString(),rates=pricing(),ticket:AiUsageTicket={id:`aiu-${randomUUID()}`,actorId:current.actorId,started:Date.now(),rate:rates.rates.find(rate=>rate.model===model)||null,pricingRevision:rates.revision,inputTokens:null,outputTokens:null,totalTokens:null,outputChars:null};
  getDatabase().transaction(()=>{getDatabase().prepare('DELETE FROM cms_ai_usage WHERE actor_id=? AND created_at<?').run(current.actorId,new Date(Date.now()-retention).toISOString());
    getDatabase().prepare('DELETE FROM cms_ai_usage WHERE id IN (SELECT id FROM cms_ai_usage WHERE actor_id=? ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 4999)').run(current.actorId);
    getDatabase().prepare('INSERT INTO cms_ai_usage(id,actor_id,task,model,status,error_code,input_chars,output_chars,input_tokens,output_tokens,total_tokens,image_count,duration_ms,pricing_json,job_id,created_at) VALUES(?,?,?,?,\'started\',\'\',?,NULL,NULL,NULL,NULL,?,0,?,?,?)').run(ticket.id,current.actorId,current.task,model,inputChars,imageCount,JSON.stringify({rate:ticket.rate,revision:rates.revision}),current.jobId||null,now);
  }).immediate();return ticket;
}
/** 缺失与真实0分开，拒把字符数当token；无效供应商usage只标记未知，不影响合法正文。 */
export function observeAiUsage(ticket:AiUsageTicket|undefined,envelope:unknown){
  if(!ticket||!envelope||typeof envelope!=='object'||Array.isArray(envelope))return;
  const value=envelope as {usage?:unknown;choices?:{message?:{content?:unknown}}[]};const text=value.choices?.[0]?.message?.content;if(typeof text==='string')ticket.outputChars=text.length;
  if(!value.usage||typeof value.usage!=='object'||Array.isArray(value.usage))return;
  const usage=value.usage as Record<string,unknown>;
  const number=(key:string)=>{const v=usage[key];if(v===undefined||v===null)return null;if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=100_000_000)return v;ticket.warning='接口返回的部分用量无效，已标为未提供';return null;};
  ticket.inputTokens=number('prompt_tokens');ticket.outputTokens=number('completion_tokens');ticket.totalTokens=number('total_tokens');
  // 不替供应商修正账目；分项与总量不一致仍保留原值并提示，费用只使用实际给出的输入/输出分项。
  if(ticket.inputTokens!==null&&ticket.outputTokens!==null&&ticket.totalTokens!==null&&ticket.inputTokens+ticket.outputTokens!==ticket.totalTokens)ticket.warning='接口总token与输入/输出分项合计不一致；保留接口原值，估算仅按分项计算';
}
export function finishAiUsage(ticket:AiUsageTicket|undefined,error?:unknown){
  if(!ticket)return;const status=error?'failed':'succeeded';const code=error instanceof ApiError?(error.status===499?'cancelled':error.status===504?'timeout':error.status===429?'rate-limited':error.status===422?'configuration':'provider-response'):error?'internal':'';
  // 模型已消费后的统计落库失败不能丢弃有效输出；原started记录保留为未确认，不伪造成功或0费用。
  try{getDatabase().prepare('UPDATE cms_ai_usage SET status=?,error_code=?,output_chars=?,input_tokens=?,output_tokens=?,total_tokens=?,duration_ms=?,pricing_json=? WHERE id=? AND actor_id=?').run(status,code,ticket.outputChars,ticket.inputTokens,ticket.outputTokens,ticket.totalTokens,Math.max(0,Date.now()-ticket.started),JSON.stringify({rate:ticket.rate,revision:ticket.pricingRevision,...(ticket.warning?{warning:ticket.warning}:{})}),ticket.id,ticket.actorId);}catch{console.error('AI usage record completion unavailable');}
}
type Row={id:string;task:AiUsageTask;model:string;status:AiUsageItem['status'];error_code:string;input_chars:number;output_chars:number|null;input_tokens:number|null;output_tokens:number|null;total_tokens:number|null;image_count:number;duration_ms:number;pricing_json:string;job_id:string|null;created_at:string};
function view(row:Row):AiUsageItem{const price=JSON.parse(row.pricing_json) as {rate:AiModelRate|null;revision:number;warning?:string};return{id:row.id,task:row.task,model:row.model,status:row.status,errorCode:row.error_code,inputChars:row.input_chars,outputChars:row.output_chars,inputTokens:row.input_tokens,outputTokens:row.output_tokens,totalTokens:row.total_tokens,imageCount:row.image_count,durationMs:row.duration_ms,createdAt:row.created_at,jobId:row.job_id,estimate:price.rate&&row.input_tokens!==null&&row.output_tokens!==null?{currency:price.rate.currency,amount:(row.input_tokens*price.rate.inputPerMillion+row.output_tokens*price.rate.outputPerMillion)/1_000_000,pricingRevision:price.revision}:null,...(price.warning?{usageWarning:price.warning}:{})};}
export function listAiUsage(actor:Actor,value:unknown={}):AiUsageList{
  administrator(actor);const input=object(value);if(Object.keys(input).some(key=>!['page','task'].includes(key)))throw new ApiError(422,'用量查询字段无效');const page=input.page===undefined?1:Number(input.page);if(!Number.isInteger(page)||page<1||page>250||input.task!==undefined&&!tasks.includes(input.task as AiUsageTask))throw new ApiError(422,'用量筛选无效');
  const from=new Date(Date.now()-retention).toISOString(),to=new Date().toISOString(),args=[actor.id,from,...(input.task?[input.task]:[])],where=`actor_id=? AND created_at>=?${input.task?' AND task=?':''}`,db=getDatabase();const total=(db.prepare(`SELECT count(*) n FROM cms_ai_usage WHERE ${where}`).get(...args) as {n:number}).n;
  return{items:(db.prepare(`SELECT * FROM cms_ai_usage WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?`).all(...args,(page-1)*20) as Row[]).map(view),total,page,pageSize:20,period:{from,to,timezone:'UTC'}};
}
