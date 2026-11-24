import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/demo';
import { saveWritingDraft, WritingSaveUncertainError, writingRecordDifferences } from '../src/lib/ai-writing-save-client';
import { RequestError } from '../src/lib/studio-client';

const product=()=>structuredClone(initialState.products[0]);
test('保存核对仅归一化原表单顶层缺省，不忽略参数、嵌套updated和图文差异',()=>{
  const local={...product(),seoTitle:'',noindex:false,sortOrder:0,updated:'old'},server={...product(),updated:'new'};
  delete server.seoTitle;delete server.noindex;delete server.sortOrder;
  assert.deepEqual(writingRecordDifferences(local,server),[]);
  assert.equal(writingRecordDifferences({...local,customFields:{updated:'人工新值',noindex:false}}, {...server,customFields:{updated:'原值',noindex:true}})[0].key,'customFields');
  assert.ok(writingRecordDifferences({...local,images:['/a','/b']},{...server,images:['/b','/a']}).some(item=>item.key==='images'));
  assert.equal(writingRecordDifferences(local)[0].key,'record');
});
test('响应丢失只发一次带稳定操作ID的保存，返回核对信息而非自动重试',async()=>{
  const original=globalThis.fetch;let calls=0;let id='';
  globalThis.fetch=async(_url,options)=>{calls++;id=JSON.parse(String(options?.body)).saveAttemptId;throw new Error('lost response');};
  try{const env={revision:4,activeReleaseId:null,state:structuredClone(initialState)},record=product();await assert.rejects(saveWritingDraft(env,{products:[record]},[],{kind:'product',id:record.id},record),cause=>{assert.ok(cause instanceof WritingSaveUncertainError);assert.equal(cause.pending.id,id);assert.equal(cause.pending.record.id,record.id);return true;});assert.match(id,/^aws-/);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
test('明确409保留原冲突语义，不误称已提交或丢包',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:'source changed'}),{status:409,headers:{'Content-Type':'application/json'}});};
  try{const env={revision:4,activeReleaseId:null,state:structuredClone(initialState)},record=product();await assert.rejects(saveWritingDraft(env,{products:[record]},[],{kind:'product',id:record.id},record),cause=>cause instanceof RequestError&&cause.status===409);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
