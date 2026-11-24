import { beforeEach,afterEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join,resolve,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { getDatabase } from '../src/server/database';
import { getDraftRecord,patchStudio,getStudioEnvelope,readRelease } from '../src/server/studio';
import { publishSite,activateRelease,restoreDraft } from '../src/server/publication';
import { auditAuth,auditFailure,listAudit,recordAudit } from '../src/server/audit';
import { ApiError } from '../src/server/http';

let directory='',previous:string|undefined;
const actor={id:'audit-admin',name:'审计管理员'};
beforeEach(()=>{previous=process.env.FORM_STUDIO_DATA_DIR;directory=mkdtempSync(join(tmpdir(),'studio-audit-'));process.env.FORM_STUDIO_DATA_DIR=directory;});
afterEach(()=>{getDatabase().close();if(previous===undefined)delete process.env.FORM_STUDIO_DATA_DIR;else process.env.FORM_STUDIO_DATA_DIR=previous;if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-audit-`))rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const selection=()=>({expectedRevision:getDraftRecord().revision,baseReleaseId:getStudioEnvelope().activeReleaseId,pageIds:getDraftRecord().content.pages.map(p=>p.id),productIds:getDraftRecord().content.products.map(p=>p.id),includeTheme:true,includeSettings:true});

test('审计白名单只记标识/范围和代码启用，不记源码/设置正文；草稿写入与审计同事务',()=>{
 const before=getDraftRecord(),code={global:{css:'',js:'globalThis.secret="NEVER_STORE_CODE";',cssEnabled:false,jsEnabled:true},pages:{}};
 patchStudio({expectedRevision:before.revision,patch:{customCode:code,settings:{...before.content.settings,description:'NEVER_STORE_PRIVATE_INPUT'}}},actor);
 const items=listAudit(new URLSearchParams()).items;assert.equal(items.length,1);assert.equal(items[0].action,'draft.update');assert.deepEqual(items[0].details.jsEnabledScopes,['global']);assert.equal(JSON.stringify(items).includes('NEVER_STORE'),false);
 const rev=getDraftRecord().revision;getDatabase().exec("CREATE TRIGGER reject_audit BEFORE INSERT ON cms_audit BEGIN SELECT RAISE(ABORT,'audit-injected-failure'); END;");
 assert.throws(()=>patchStudio({expectedRevision:rev,patch:{settings:{...getDraftRecord().content.settings,name:'Should rollback'}}},actor),/audit-injected/);assert.equal(getDraftRecord().revision,rev);assert.equal(getDraftRecord().content.settings.name,before.content.settings.name);
 getDatabase().exec('DROP TRIGGER reject_audit');assert.throws(()=>getDatabase().prepare('DELETE FROM cms_audit').run(),/retained/);
});

test('发布/切换/恢复均留运行审计，快照不含审计；审计失败不切换公开指针',()=>{
 getDraftRecord();const first=publishSite(selection(),actor),second=publishSite(selection(),actor);activateRelease(first.releaseId,{expectedActiveReleaseId:second.releaseId},actor);restoreDraft(first.releaseId,{expectedRevision:getDraftRecord().revision,pageIds:['home']},actor);
 const actions=listAudit(new URLSearchParams()).items.map(x=>x.action);assert.deepEqual(actions,['draft.restore','release.activate','release.publish','release.publish']);assert.equal('audit' in readRelease(first.releaseId),false);
 const count=(getDatabase().prepare('SELECT count(*) n FROM cms_release').get() as {n:number}).n;
 getDatabase().exec("CREATE TRIGGER reject_audit BEFORE INSERT ON cms_audit BEGIN SELECT RAISE(ABORT,'audit-injected-failure'); END;");
 assert.throws(()=>publishSite(selection(),actor),/audit-injected/);assert.equal(getStudioEnvelope().activeReleaseId,first.releaseId);assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_release').get() as {n:number}).n,count);
});

test('失败审计只存状态码，异步认证有可关联的started和结果；游标分页/筛选不能获取任意SQL',async()=>{
 await assert.rejects(()=>auditFailure(actor,'release.publish',()=>{throw new ApiError(409,'NEVER_STORE_BUYER_ANSWERS');}),/NEVER_STORE/);
 await auditAuth(actor,'member.create',[],async()=>({id:'created-member',password:'NEVER_STORE_PASSWORD'}),r=>[r.id]);
 await assert.rejects(()=>auditAuth(actor,'member.password',['created-member'],async()=>{throw new ApiError(422,'NEVER_STORE_PASSWORD');}));
 const all=listAudit(new URLSearchParams()).items;assert.equal(all.length,5);assert.equal(JSON.stringify(all).includes('NEVER_STORE'),false);assert.equal(all[0].details.operationId,all[1].details.operationId);assert.equal(all[2].details.operationId,all[3].details.operationId);assert.deepEqual(all[2].details.objectIds,['created-member']);assert.equal(all[4].status,409);
 const first=listAudit(new URLSearchParams({limit:'2'})),second=listAudit(new URLSearchParams({limit:'2',before:String(first.nextCursor)}));assert.equal(first.items[1].id>second.items[0].id,true);assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,4);
 assert.throws(()=>listAudit(new URLSearchParams({before:'1 OR 1=1'})),/游标/);assert.throws(()=>listAudit(new URLSearchParams({action:'bogus'})),/筛选/);
 recordAudit(actor,'draft.update','success',{objectIds:Array.from({length:201},(_,i)=>`id-${i}`)});const truncated=listAudit(new URLSearchParams()).items[0];assert.equal(truncated.details.objectCount,201);assert.equal(truncated.details.objectIds.length,200);
});
