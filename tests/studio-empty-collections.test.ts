import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, patchStudio } from '../src/server/studio';
import { createEmptyDraft } from '../src/server/seed';
import { createFormDefinition } from '../src/lib/form-content';

let directory='', saved:NodeJS.ProcessEnv;
beforeEach(()=>{
  saved={...process.env};directory=mkdtempSync(join(tmpdir(),'studio-empty-collection-'));
  process.env.FORM_STUDIO_DATA_DIR=directory;getDraftRecord();
  const content=createEmptyDraft();delete content.forms;delete content.pageTemplates;
  getDatabase().prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(content));
});
afterEach(()=>{
  getDatabase().close();for(const key of Object.keys(process.env))if(!Object.hasOwn(saved,key))delete process.env[key];Object.assign(process.env,saved);
  const checked=resolve(directory);assert(checked.startsWith(resolve(tmpdir())+sep+'studio-empty-collection-'));
  rmSync(checked,{recursive:true,force:true});
});

test('仅内部撤销可还原空集合的缺省状态，普通保存不能借JSON字段删除集合',()=>{
  patchStudio({expectedRevision:0,patch:{forms:[],pageTemplates:[]},removeEmptyCollections:['forms','pageTemplates']});
  assert(Object.hasOwn(getDraftRecord().content,'forms'));
  assert(Object.hasOwn(getDraftRecord().content,'pageTemplates'));
  patchStudio({expectedRevision:1,patch:{}},undefined,'draft.update',{removeEmptyCollections:['forms','pageTemplates']});
  const result=getDraftRecord();assert.equal(result.revision,2);
  assert(!Object.hasOwn(result.content,'forms'));assert(!Object.hasOwn(result.content,'pageTemplates'));
});

test('内部空集合还原不能删除后来加入的真实表单，失败不写revision',()=>{
  const form=createFormDefinition('later-form');
  patchStudio({expectedRevision:0,patch:{forms:[form]}});
  const before=getDraftRecord();
  assert.throws(()=>patchStudio({expectedRevision:before.revision,patch:{}},undefined,'draft.update',{removeEmptyCollections:['forms']}),error=>(error as {status?:number}).status===409);
  assert.deepEqual(getDraftRecord(),before);
});
