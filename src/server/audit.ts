import type { ActorIdentity } from './types';
import { getDatabase } from './database';
import { ApiError } from './http';

export const AUDIT_ACTIONS = ['ai.detailDesign.select','external.ai.template.select','ai.designGuidance.save','auth.recovery.request','auth.recovery.reset','auth.recovery.local','launch.check','mail.settings','mail.test','external.ai.token.create','external.ai.token.revoke','external.ai.design.propose','external.ai.design.select','external.ai.template.propose','external.ai.content.propose','external.ai.seo.propose','ai.siteDesign.generate','ai.siteDesign.select','ai.detailDesign.generate','ai.detailDesign.apply','ai.detailDesign.undo','ai.detailDesign.delete','ai.siteDesign.apply','ai.siteDesign.undo','ai.siteDesign.delete','ai.writing.profile','ai.writing.generate','ai.writing.save','ai.writing.undo','seo.source.config','seo.source.connect','seo.source.sync','seo.source.delete','seo.proposal.generate','seo.proposal.apply','seo.proposal.undo','seo.proposal.delete','ai.edit.generate','ai.edit.apply','ai.edit.undo','ai.edit.delete','ai.source','ai.provider','ai.generate','ai.apply','ai.undo','discovery.observe','discovery.preset','draft.update','release.publish','release.activate','draft.restore','package.import','content.import','member.create','member.update','member.password'] as const;
export type AuditAction = typeof AUDIT_ACTIONS[number];
export type AuditDetails = { objectIds?: string[]; fields?: string[]; revision?: number; releaseId?: string; role?: string; disabled?: boolean; jsEnabledScopes?: string[]; operationId?: string; objectCount?:number };
/** 审计只接受结构化元数据白名单；不记录输入正文、密码、邮箱、密钥、完整表单答案或错误堆栈。 */
export function recordAudit(actor: ActorIdentity, action: AuditAction, result: 'success'|'failure'|'started', details: AuditDetails = {}, status = result==='success'?200:result==='started'?202:500) {
  const safe: AuditDetails = {};
  for (const key of ['objectIds','fields','jsEnabledScopes'] as const) if (details[key]) safe[key] = details[key]!.filter(v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(v)).slice(0,200);
  if(details.objectIds)safe.objectCount=details.objectIds.length;
  if(Number.isSafeInteger(details.revision))safe.revision=details.revision;
  if(typeof details.releaseId==='string')safe.releaseId=details.releaseId.slice(0,100);
  if(['admin','editor','viewer'].includes(details.role||''))safe.role=details.role;
  if(typeof details.disabled==='boolean')safe.disabled=details.disabled;
  if(typeof details.operationId==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(details.operationId))safe.operationId=details.operationId;
  getDatabase().prepare('INSERT INTO cms_audit(actor_id,actor_name,action,result,status,details_json,created_at) VALUES(?,?,?,?,?,?,?)').run(actor.id.slice(0,100),actor.name.slice(0,200),action,result,status,JSON.stringify(safe),new Date().toISOString());
}
/** CMS成功事件与业务事务一起写；失败事件单独记录状态码，不能泄漏校验错误中的私人正文。 */
export async function auditFailure<T>(actor:ActorIdentity,action:AuditAction,work:()=>T|Promise<T>, details:AuditDetails={}):Promise<T> {
  try{return await work();}catch(error){try{recordAudit(actor,action,'failure',details,error instanceof ApiError?error.status:500);}catch{/* 保留原失败；数据库故障由运行日志处理，不把审计错误伪装成原业务错误。 */}throw error;}
}
/** 认证库的异步写入不能加入同步CMS事务；先留意图，崩溃时显示started，不能假报成功。 */
export async function auditAuth<T>(actor:ActorIdentity,action:AuditAction,objectIds:string[],work:()=>Promise<T>,identify?:(result:T)=>string[]) {
  const operationId=crypto.randomUUID();recordAudit(actor,action,'started',{objectIds,operationId});
  return auditFailure(actor,action,async()=>{const result=await work();recordAudit(actor,action,'success',{objectIds:identify?identify(result):objectIds,operationId});return result;},{objectIds,operationId});
}
export function listAudit(params:URLSearchParams) {
  const limit=Number(params.get('limit')||50),before=Number(params.get('before')||Number.MAX_SAFE_INTEGER),action=params.get('action')||'';
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(before)||before<1||action&&!AUDIT_ACTIONS.includes(action as AuditAction))throw new ApiError(422,'审计筛选或游标无效');
  const rows=getDatabase().prepare('SELECT id,actor_id actorId,actor_name actorName,action,result,status,details_json details,created_at createdAt FROM cms_audit WHERE id < ? AND (? = ? OR action = ?) ORDER BY id DESC LIMIT ?').all(before,action,'',action,limit) as {id:number;actorId:string;actorName:string;action:string;result:string;status:number;details:string;createdAt:string}[];
  return {items:rows.map(r=>({...r,details:JSON.parse(r.details)})),nextCursor:rows.length===limit?rows[rows.length-1].id:null};
}
