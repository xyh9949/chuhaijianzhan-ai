import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ApiError } from './http';

// PDF解析在有内存/时间上限的worker中运行；不会执行文档脚本、网络请求或嵌入附件。
const parser = `const {parentPort,workerData}=require('node:worker_threads');
(async()=>{try{
 const {PDFDocument,PDFDict,PDFArray,PDFName,PDFStream}=require(workerData.library);
 const doc=await PDFDocument.load(workerData.bytes,{throwOnInvalidObject:true,updateMetadata:false});
 if(doc.isEncrypted||doc.getPageCount()<1||doc.getPageCount()>1000)throw Error('invalid');
 const forbidden=new Set(['JavaScript','JS','Launch','EmbeddedFiles','EmbeddedFile','RichMedia','XFA','OpenAction','AA','SubmitForm','ImportData','GoToR']);
 const seen=new Set();let count=0;
 const walk=(v,depth=0)=>{if(!v||seen.has(v))return;if(depth>64||++count>100000)throw Error('complex');seen.add(v);
 if(v instanceof PDFName){if(forbidden.has(v.decodeText()))throw Error('active');}
 else if(v instanceof PDFStream)walk(v.dict,depth+1);
 else if(v instanceof PDFDict)for(const [k,x]of v.entries()){walk(k,depth+1);walk(x,depth+1);}
 else if(v instanceof PDFArray)for(let i=0;i<v.size();i++)walk(v.get(i),depth+1);};
 for(const [,v]of doc.context.enumerateIndirectObjects())walk(v);
 parentPort.postMessage({pages:doc.getPageCount()});
 }catch{parentPort.postMessage({error:true});}})();`;

/** 基本结构解析与主动内容拒绝不是杀毒承诺；目录仍始终以附件下载。 */
export async function validatePdf(bytes: Buffer, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw new ApiError(499, 'PDF解析已取消');
  if (!bytes.subarray(0, 8).toString('ascii').match(/^%PDF-[12]\.\d/) || !bytes.subarray(-2048).includes(Buffer.from('%%EOF'))) throw new ApiError(422, 'PDF签名或结束结构无效');
  return new Promise((resolve, reject) => {
    // Worker需要真实文件路径。Turbopack默认会把require.resolve折叠成内部数字ID，须使用官方忽略标记。
    const library = createRequire(join(process.cwd(), 'package.json')).resolve(/* turbopackIgnore: true */ 'pdf-lib');
    const worker = new Worker(parser, { eval: true, workerData: { library, bytes }, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    worker.stdout.resume(); worker.stderr.resume(); // 不把解析器的原始文档错误或内容带入应用日志。
    let settled = false;
    // 资料导入取消时也停止同一静态解析器，避免后台继续占用worker并阻塞下一份上传。
    const finish = (pages?: number, cancelled = false) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); void worker.terminate().finally(() => { if (cancelled) reject(new ApiError(499, 'PDF解析已取消')); else if (pages) resolve(pages); else reject(new ApiError(422, 'PDF无法解析、过于复杂、已加密或包含脚本/主动内容；请导出静态PDF目录')); }); };
    const cancel = () => finish(undefined, true);
    const timer = setTimeout(() => finish(), 8000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.once('message', result => finish(result.pages)); worker.once('error', () => finish()); worker.once('exit', () => finish());
  });
}
