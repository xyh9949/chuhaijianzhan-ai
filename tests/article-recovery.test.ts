import {test} from 'node:test';
import assert from 'node:assert/strict';
import {richTextErrors,richTextPlainText,richTextRecoveryErrors,textToRichText,type RichNode} from '../src/lib/presentation-content';

test('恢复可完整检查超过保存上限的正文，普通保存校验仍拒绝',()=>{
 const doc=textToRichText('文'.repeat(60001));
 assert.ok(richTextErrors(doc).length);
 assert.deepEqual(richTextErrors(doc,{nodes:20000,characters:240000}),[]);
 assert.deepEqual(richTextRecoveryErrors(doc,''),[]);
 assert.deepEqual(richTextRecoveryErrors(doc,'文'.repeat(60001)),[]);
 assert.equal(richTextPlainText(doc),'');
 assert.ok(richTextErrors(doc).length);
});

test('恢复超过2000节点或单个内容列表上限的正文仍保留全部节点',()=>{
 for(const doc of [paragraphs(1100),{type:'doc' as const,content:Array.from({length:2100},()=>({type:'paragraph' as const}))}]){
  const before=JSON.stringify(doc);assert.ok(richTextErrors(doc).length);assert.deepEqual(richTextRecoveryErrors(doc,''),[]);assert.equal(JSON.stringify(doc),before);
 }
});

test('恢复完整检查保存上限之后的节点，不接受危险HTML、远程图片、链接或属性',()=>{
 const unsafe:unknown[]=[
  {type:'iframe',attrs:{src:'https://invalid.example'}},
  {type:'image',attrs:{src:'https://invalid.example/photo.jpg'}},
  {type:'paragraph',content:[{type:'text',text:'bad',marks:[{type:'link',attrs:{href:'javascript:alert(1)'}}]}]},
  {type:'paragraph',attrs:{onclick:'alert(1)'},content:[{type:'text',text:'bad'}]},
  {type:'paragraph',content:[{type:'text',text:'bad',marks:[{type:'script'}]}]},
 ];
 for(const tail of unsafe){const doc={...paragraphs(1100),content:[...paragraphs(1100).content!,tail]};assert.ok(richTextRecoveryErrors(doc,'').length,'后置危险节点不能因普通节点限额被跳过');}
});

test('恢复仍拒绝超过独立硬上限的字符、节点和12层深度',()=>{
 assert.ok(richTextRecoveryErrors(textToRichText('文'.repeat(240001)),'').length);
 assert.ok(richTextRecoveryErrors(paragraphs(10000),'').length);
 let nested:RichNode={type:'paragraph',content:[{type:'text',text:'deep'}]};for(let i=0;i<13;i++)nested={type:'blockquote',content:[nested]};assert.ok(richTextRecoveryErrors({type:'doc',content:[nested]},'').length);
});

test('恢复文字投影只兼容超限时的空串，合法正文及图注必须严格一致',()=>{
 const doc:RichNode={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Opening'},{type:'hardBreak'},{type:'text',text:'line'}]},{type:'image',attrs:{src:'/images/chair.jpg',caption:'Caption',alt:'Not body'}}]};
 assert.deepEqual(richTextRecoveryErrors(doc,'Opening\nline\n\nCaption'),[]);
 for(const plain of ['',undefined,'Opening line Caption'])assert.ok(richTextRecoveryErrors(doc,plain).length);
 assert.ok(richTextRecoveryErrors(textToRichText('文'.repeat(60001)),'Wrong projection').length);
});

function paragraphs(count:number):RichNode{return {type:'doc',content:Array.from({length:count},()=>({type:'paragraph',content:[{type:'text',text:'x'}]}))};}
