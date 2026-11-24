import { beforeEach,afterEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { storeLocalRecovery,readLocalRecovery,clearLocalRecovery,clearOtherLocalRecoveries,localRecoveries } from '../src/lib/local-recovery';
class MemoryStorage implements Storage{data=new Map<string,string>();reject=false;get length(){return this.data.size;}key(i:number){return [...this.data.keys()][i]||null;}getItem(k:string){return this.data.get(k)??null;}setItem(k:string,v:string){if(this.reject)throw new Error('QuotaExceeded');this.data.set(k,v);}removeItem(k:string){this.data.delete(k);}clear(){this.data.clear();}}
let previous:PropertyDescriptor|undefined,s:MemoryStorage;
beforeEach(()=>{previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');s=new MemoryStorage();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:s});clearOtherLocalRecoveries('test-owner');});
afterEach(()=>{for(const e of localRecoveries('test-owner'))clearLocalRecovery('test-owner',e.scope);if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else Reflect.deleteProperty(globalThis,'sessionStorage');});

test('同账号可恢复尚未满足必填的结构，跨账号隔离并明确清除旧账号副本',()=>{
 storeLocalRecovery('test-owner','form-definition:f','global-design','未完成表单',{name:'',fields:[]});const snapshot=readLocalRecovery<{name:string;fields:unknown[]}>('test-owner','form-definition:f',v=>!!v&&typeof (v as {name:string}).name==='string');assert.equal(snapshot?.snapshot.name,'');assert.equal(snapshot?.persisted,true);assert.equal(readLocalRecovery('other-owner','form-definition:f',()=>true),undefined);
 clearOtherLocalRecoveries('other-owner');assert.equal(readLocalRecovery('test-owner','form-definition:f',()=>true),undefined);assert.equal(s.length,0);
});

test('大包原文件仅留窗口内存，持久投影含选项/需重选标记；存储失败不假报可跨刷新恢复',()=>{
 const source={format:'form-studio-site',files:[{content:'Synthetic public media'}]},snapshot={source,filename:'package.json',options:{mode:'merge',prefix:'demo'}};
 const result=storeLocalRecovery('test-owner','site-package','templates','整站包输入',snapshot,{filename:snapshot.filename,options:snapshot.options},true);assert.equal(result.persisted,true);assert.equal(readLocalRecovery<typeof snapshot>('test-owner','site-package',()=>true)?.snapshot.source,source);
 const disk=JSON.parse(s.getItem('form-studio:local-recovery:v1:test-owner:site-package')!);assert.equal(disk.requiresFile,true);assert.equal('source' in disk.snapshot,false);assert.deepEqual(disk.snapshot.options,snapshot.options);
 s.reject=true;const failed=storeLocalRecovery('test-owner','inquiry-notes','inquiries','备注',{notes:'Unsaved private text'});assert.equal(failed.persisted,false);assert.equal(readLocalRecovery<{notes:string}>('test-owner','inquiry-notes',()=>true)?.snapshot.notes,'Unsaved private text');
});

test('不可信/过期/错误账号/错误结构缓存不进入界面，清理不改变任何服务器对象',()=>{
 const key='form-studio:local-recovery:v1:test-owner:corrupt';s.setItem(key,'{invalid');assert.equal(readLocalRecovery('test-owner','corrupt',()=>true),undefined);
 for(const item of [{version:1,actorId:'other',scope:'corrupt',screen:'inquiries',title:'X',updatedAt:Date.now(),snapshot:{},persisted:true,requiresFile:false},{version:1,actorId:'test-owner',scope:'corrupt',screen:'inquiries',title:{html:'unsafe'},updatedAt:Date.now(),snapshot:{},persisted:true,requiresFile:false}]){s.setItem(key,JSON.stringify(item));assert.equal(readLocalRecovery('test-owner','corrupt',()=>true),undefined);}
 storeLocalRecovery('test-owner','expired','products','输入',{name:'old'},{name:'old'},false,1);assert.equal(readLocalRecovery('test-owner','expired',()=>true,24*60*60*1000+2),undefined);clearLocalRecovery('test-owner','expired');assert.equal(readLocalRecovery('test-owner','expired',()=>true),undefined);
 storeLocalRecovery('test-owner','typed','products','输入',{name:123});assert.equal(readLocalRecovery('test-owner','typed',v=>typeof (v as {name:unknown}).name==='string'),undefined);
});
