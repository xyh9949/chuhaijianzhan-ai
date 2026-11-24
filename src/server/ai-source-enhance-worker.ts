/** 独立worker仅接二进制与固定本地库路径；PDF页面渲染只供OCR，绝不作为抽取产品图返回。 */
export const SOURCE_ENHANCE_WORKER = String.raw`
const threads=require('node:worker_threads'),{parentPort,workerData:w}=threads,path=require('node:path');
const {pathToFileURL}=require('node:url'),{createHash}=require('node:crypto');
const warnings=[],images=[],pages=[];let imageBytes=0,ocrWorker;
const warn=message=>{if(!warnings.includes(message))warnings.push(message);};
const fail=code=>{const e=new Error(code);e.sourceCode=code;throw e;};
const noNetwork=()=>{globalThis.fetch=()=>Promise.reject(new Error('network_disabled'));for(const name of ['node:http','node:https']){const module=require(name);module.request=()=>{throw new Error('network_disabled');};module.get=module.request;}};
noNetwork();
// Tesseract另起一个本地子worker；同样禁止网络、限定JS堆，主worker取消时一并终止。
const NativeWorker=threads.Worker;const children=new Set();
threads.Worker=class extends NativeWorker{constructor(file){if(file!==w.tessWorker)throw new Error('unexpected_worker');super('('+noNetwork.toString()+')();require('+JSON.stringify(file)+');',{eval:true,resourceLimits:{maxOldGenerationSizeMb:384,maxYoungGenerationSizeMb:16,stackSizeMb:4}});children.add(this);this.once('exit',()=>children.delete(this));}};
parentPort.on('message',message=>{if(message?.cancel){for(const child of children)void child.terminate();}});
const sharp=require(w.sharpLibrary),bytes=Buffer.from(w.bytes);
async function addImage(raw,source){
 if(images.length>=40){warn('嵌入图片超过40张，本次仅提取前40张；请缩小页范围或拆分文件。');return;}
 try{const instance=sharp(raw,{limitInputPixels:6000000,animated:false,failOn:'warning'}),info=await instance.metadata();
  if(!['jpeg','png','webp'].includes(info.format)||!info.width||!info.height||(info.pages||1)>1)throw new Error('unsupported');
  const output=await instance.rotate().webp({quality:92}).toBuffer({resolveWithObject:true});
  if(output.data.length>2*1024*1024||imageBytes+output.data.length>24*1024*1024){warn('部分嵌入图片超过单张2 MB或本次24 MB限制，未提取；请另行整理原图。');return;}
  imageBytes+=output.data.length;const sha256=createHash('sha256').update(output.data).digest('hex'),id='img-'+createHash('sha256').update(sha256+JSON.stringify(source)).digest('hex').slice(0,24);
  if(images.some(item=>item.id===id))return;images.push({id,mime:'image/webp',width:output.info.width,height:output.info.height,bytes:output.data.length,sha256,source,data:output.data});
 }catch{warn('部分文档位图格式不受支持、已损坏或超过600万像素，未提取；没有用整页截图替代。');}
}
async function xlsx(){
 const ExcelJS=require(w.excelLibrary),book=new ExcelJS.Workbook();await book.xlsx.load(bytes,{ignoreNodes:['extLst']});let anchored=new Set(),count=0;
 for(let i=0;i<book.worksheets.length;i++){const sheet=book.worksheets[i];for(const image of sheet.getImages()){
  if(++count>100){warn('工作簿图片引用超过100项，只处理前100项；请拆分文件。');break;}
  const media=book.getImage(image.imageId),range=image.range,tl=range?.tl;if(!media||!tl||!Number.isFinite(tl.row)||!Number.isFinite(tl.col)){warn('部分工作簿图片缺少可回查单元格锚点，未提取。');continue;}
  anchored.add(String(image.imageId));const row=Math.floor(tl.row)+1,column=Math.floor(tl.col)+1,endRow=range.br?Math.ceil(range.br.row):undefined;
  if(row<1||row>1048576||column<1||column>16384){warn('部分图片锚点无效，未提取。');continue;}
  const raw=media.buffer?Buffer.from(media.buffer):media.base64?Buffer.from(media.base64.replace(/^data:[^,]+,/,''),'base64'):null;
  if(!raw||raw.length>8*1024*1024){warn('部分工作簿图片没有内嵌二进制或超过8 MB，未下载外部图片。');continue;}
  await addImage(raw,{kind:'xlsx',sheetIndex:i+1,sheetName:String(sheet.name),row,column,...(endRow?{endRow}:{}),hidden:sheet.state!=='visible'||Boolean(sheet.getRow(row).hidden||sheet.getColumn(column).hidden)});
 }}
 if((book.model.media||[]).some((_,i)=>!anchored.has(String(i))))warn('工作簿包含没有单元格锚点的背景或其他图片，未将其猜测为产品配图。');
 warn('Excel图片来自真实绘图锚点；锚点与产品行的关系只是待核对建议，不能自动确认产品配图。');
}
async function pdf(){
 const canvas=require(w.canvasLibrary);globalThis.DOMMatrix=canvas.DOMMatrix;globalThis.ImageData=canvas.ImageData;globalThis.Path2D=canvas.Path2D;
 const library=await import(pathToFileURL(w.pdfLibrary).href),packageDir=path.resolve(path.dirname(w.pdfLibrary),'../..');
 const task=library.getDocument({data:Uint8Array.from(bytes),isEvalSupported:false,useWorkerFetch:false,useSystemFonts:false,isOffscreenCanvasSupported:false,isImageDecoderSupported:false,useWasm:false,stopAtErrors:true,verbosity:0,maxImageSize:6000000,canvasMaxAreaInBytes:24000000,cMapUrl:path.join(packageDir,'cmaps')+'/',cMapPacked:true,standardFontDataUrl:path.join(packageDir,'standard_fonts')+'/'});
 try{const doc=await task.promise;
  if(w.options.ocr){const tess=require(w.tessLibrary);ocrWorker=await tess.createWorker(w.options.language,1,{workerPath:w.tessWorker,langPath:w.langDir,cacheMethod:'none',gzip:true,logger:()=>{},errorHandler:()=>{}},{preserve_interword_spaces:'1'});}
  for(const pageNumber of w.options.pageNumbers){if(pageNumber>doc.numPages)fail('page');const page=await doc.getPage(pageNumber),natural=page.getViewport({scale:1});
   if(w.options.images){const ops=await page.getOperatorList(),seen=new Set();if(ops.fnArray.length>20000)warn('部分页面绘图指令过多，只检查前20000项，未提取项请人工整理。');
    for(let i=0;i<Math.min(ops.fnArray.length,20000);i++){
     const op=ops.fnArray[i],args=ops.argsArray[i];let image;
     if(op===library.OPS.paintImageXObject||op===library.OPS.paintImageXObjectRepeat){const id=args[0];if(seen.has(id))continue;seen.add(id);const objects=String(id).startsWith('g_')?page.commonObjs:page.objs;image=await new Promise(resolve=>objects.get(id,resolve));}
     else if(op===library.OPS.paintInlineImageXObject)image=args[0];
     else{if([library.OPS.paintImageMaskXObject,library.OPS.paintInlineImageXObjectGroup].includes(op))warn('部分PDF图片使用蒙版或组合绘图，未将其猜作完整原图；请从原始设计文件导出。');continue;}
     if(!image?.data||!image.width||!image.height||image.width*image.height>6000000){warn('部分PDF位图不可独立提取或超过600万像素，已跳过。');continue;}
     let raw,channels;if(image.kind===library.ImageKind.RGB_24BPP){raw=Buffer.from(image.data);channels=3;}else if(image.kind===library.ImageKind.RGBA_32BPP){raw=Buffer.from(image.data);channels=4;}else if(image.kind===library.ImageKind.GRAYSCALE_1BPP){channels=1;raw=Buffer.alloc(image.width*image.height);const stride=Math.ceil(image.width/8);for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)raw[y*image.width+x]=(image.data[y*stride+(x>>3)]&(128>>(x%8)))?255:0;}else{warn('部分PDF图片像素格式不受支持，已跳过。');continue;}
     const encoded=await sharp(raw,{raw:{width:image.width,height:image.height,channels},limitInputPixels:6000000}).png().toBuffer();
     await addImage(encoded,{kind:'pdf',pageNumber,objectIndex:i,possiblePageScan:image.width/image.height>natural.width/natural.height*0.9&&image.width/image.height<natural.width/natural.height*1.1});
    }
   }
   if(w.options.ocr){const scale=Math.min(2.5,2600/Math.max(natural.width,natural.height),Math.sqrt(6000000/(natural.width*natural.height))),view=page.getViewport({scale});if(!Number.isFinite(scale)||scale<=0||view.width*view.height>6000000)fail('pixels');
    const surface=canvas.createCanvas(Math.ceil(view.width),Math.ceil(view.height)),context=surface.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,surface.width,surface.height);await page.render({canvasContext:context,viewport:view}).promise;
    const result=await ocrWorker.recognize(surface.toBuffer('image/png'));const text=String(result.data.text||'').trim();if(text.length>30000)fail('text');pages.push({pageNumber,text,confidence:Number.isFinite(result.data.confidence)?Math.max(0,Math.min(100,result.data.confidence)):0});surface.width=1;surface.height=1;
   }page.cleanup();
  }
  if(w.options.ocr)warn('OCR在本机离线识别，文字、数字、单位和阅读顺序可能有误，全部需人工核对；不是已确认企业事实。');
  if(w.options.images)warn('PDF图片仅来自文档实际嵌入位图；可能是整页扫描或图形片段，不能保证为产品原图。');
 }finally{if(ocrWorker)await ocrWorker.terminate();await task.destroy();}
}
(async()=>{try{if(w.kind==='pdf')await pdf();else await xlsx();parentPort.postMessage({ok:true,value:{pages,images,warnings}});}catch(error){parentPort.postMessage({ok:false,code:error?.sourceCode||'invalid'});}finally{for(const child of children)void child.terminate();}})();
`;
