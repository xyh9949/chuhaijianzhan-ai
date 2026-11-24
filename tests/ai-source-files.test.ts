import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import ExcelJS from 'exceljs';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import { extractAiSourceFile } from '../src/server/ai-source-files';
import { validatePdf } from '../src/server/pdf-validation';
import { AI_SOURCE_LIMITS } from '../src/lib/ai-source-types';
import { ApiError } from '../src/server/http';

let directory = '', oldDirectory: string | undefined;
beforeEach(() => { oldDirectory=process.env.FORM_STUDIO_DATA_DIR;directory=mkdtempSync(join(tmpdir(),'studio-ai-source-'));process.env.FORM_STUDIO_DATA_DIR=directory; });
afterEach(() => { if(oldDirectory===undefined)delete process.env.FORM_STUDIO_DATA_DIR;else process.env.FORM_STUDIO_DATA_DIR=oldDirectory;if(resolve(directory).startsWith(resolve(tmpdir())+sep+'studio-ai-source-'))rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50}); });
function status(code:number){return(error:unknown)=>error instanceof ApiError&&error.status===code;}
async function pdf(...pages:(string|null)[]){const doc=await PDFDocument.create();for(const text of pages){const page=doc.addPage();if(text!==null)page.drawText(text,{x:40,y:700,size:18});}return doc.save();}
async function workbook(build:(book:ExcelJS.Workbook)=>void){const book=new ExcelJS.Workbook();build(book);return new Uint8Array(await book.xlsx.writeBuffer());}
function zip(entries:{name:string;value:Buffer;declared?:number;encrypted?:boolean}[]){
  const locals:Buffer[]=[],directory:Buffer[]=[];let offset=0;
  for(const entry of entries){const name=Buffer.from(entry.name),compressed=deflateRawSync(entry.value),size=entry.declared??entry.value.length,flags=entry.encrypted?1:0;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(8,8);local.writeUInt32LE(crc32(entry.value),14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(size,22);local.writeUInt16LE(name.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(flags,8);central.writeUInt16LE(8,10);central.writeUInt32LE(crc32(entry.value),16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(size,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    locals.push(local,name,compressed);directory.push(central,name);offset+=local.length+name.length+compressed.length;
  }
  const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,central,end]);
}
const xmlEntries=()=>[{name:'[Content_Types].xml',value:Buffer.from('<Types/>')},{name:'xl/workbook.xml',value:Buffer.from('<workbook/>')}];

test('真实PDF逐页提取文字，保留页码和扫描/空页，不修改文件或创建公开素材',async()=>{
  const bytes=await pdf('Company brochure',null,'Product specifications'),before=Buffer.from(bytes);
  const result=await extractAiSourceFile(bytes,'公司宣传册.pdf','application/pdf');
  assert.equal(result.kind,'pdf');assert.equal(result.pages?.length,3);assert.equal(result.pages?.[0].pageNumber,1);assert.match(result.pages![0].text,/Company brochure/);assert.equal(result.pages?.[1].needsOcr,true);assert.equal(result.pages?.[1].text,'');assert.equal(result.pages?.[2].pageNumber,3);assert.match(result.warnings.join(' '),/部分页面.*OCR/);
  assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(result.bytes,bytes.length);assert.deepEqual(Buffer.from(bytes),before);assert.deepEqual(readdirSync(directory),[]);
});

test('真实Type0中文PDF按ToUnicode/CMap提取中文，不需要联网字体或OCR',async()=>{
  const doc=await PDFDocument.create(),context=doc.context,page=doc.addPage();
  const descriptor=context.register(context.obj({Type:'FontDescriptor',FontName:'STSong-Light',Flags:6,FontBBox:[0,-200,1000,900],ItalicAngle:0,Ascent:900,Descent:-200,CapHeight:700,StemV:80}));
  const descendant=context.register(context.obj({Type:'Font',Subtype:'CIDFontType0',BaseFont:'STSong-Light',CIDSystemInfo:{Registry:PDFHexString.fromText('Adobe'),Ordering:PDFHexString.fromText('GB1'),Supplement:4},FontDescriptor:descriptor,DW:1000}));
  const cmap=context.register(context.flateStream('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n4 beginbfchar\n<5DE5> <5DE5>\n<5382> <5382>\n<8D44> <8D44>\n<6599> <6599>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'));
  const font=context.register(context.obj({Type:'Font',Subtype:'Type0',BaseFont:'STSong-Light',Encoding:'UniGB-UCS2-H',DescendantFonts:[descendant],ToUnicode:cmap}));
  page.node.set(PDFName.of('Resources'),context.obj({Font:{F1:font}}));page.node.set(PDFName.of('Contents'),context.register(context.flateStream('BT /F1 18 Tf 40 700 Td <5DE553828D446599> Tj ET')));
  const result=await extractAiSourceFile(await doc.save(),'工厂资料.pdf','application/pdf');assert.match(result.pages![0].text.replace(/\s/g,''),/工厂资料/);assert.equal(result.pages![0].needsOcr,false);
});

test('整份无文字PDF明确需要OCR，损坏/主动脚本/声明加密文件不会提取或外发',async()=>{
  const empty=await extractAiSourceFile(await pdf(null),'scan.pdf','');assert.ok(empty.pages?.every(page=>page.needsOcr));assert.match(empty.warnings.join(' '),/未检测到.*OCR/);
  await assert.rejects(extractAiSourceFile(Buffer.from('%PDF-1.7\nbroken\n%%EOF'),'broken.pdf','application/pdf'),status(422));
  const active=await PDFDocument.create();active.addPage();active.catalog.set(PDFName.of('OpenAction'),active.context.obj({S:'JavaScript',JS:PDFHexString.fromText('app.alert(1)')}));
  await assert.rejects(extractAiSourceFile(await active.save(),'active.pdf','application/pdf'),status(422));
  const encrypted=await PDFDocument.create();encrypted.addPage();encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,P:-4,O:PDFHexString.of('00'.repeat(32)),U:PDFHexString.of('00'.repeat(32))}));
  await assert.rejects(extractAiSourceFile(await encrypted.save(),'password.pdf','application/pdf'),status(422));
});

test('真实Excel保留显示格式、空列、原行号、0/false、缓存公式与错误，不执行或访问超链接',async()=>{
  const bytes=await workbook(book=>{const sheet=book.addWorksheet('产品表');sheet.getRow(3).values=['名称','SKU','厚度','数量','可用','公式零','公式假','缺结果','超链接','富文本','错误','日期'];
    sheet.getRow(4).values=['Board',12,1.5,0,false,{formula:'1-1',result:0},{formula:'1=2',result:false},{formula:'999+1'},{text:'Supplier details',hyperlink:'http://169.254.169.254/DO_NOT_FETCH'},{richText:[{text:'Layer '},{text:'A'}]},{error:'#DIV/0!'},new Date('2026-02-03T00:00:00Z')];
    sheet.getCell('B4').numFmt='00000';sheet.getCell('C4').numFmt='0.00" mm"';sheet.getCell('L4').numFmt='yyyy-mm-dd';sheet.getCell('N4').value='End';});
  const result=await extractAiSourceFile(bytes,'产品.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),sheet=result.sheets![0],row=sheet.rows[1];
  assert.equal(sheet.index,1);assert.equal(sheet.name,'产品表');assert.equal(sheet.rows[0].rowNumber,3);assert.equal(row.rowNumber,4);assert.equal(row.cells.length,14);assert.equal(row.cells[1],'00012');assert.equal(row.cells[2],'1.50 mm');assert.equal(row.cells[3],'0');assert.equal(row.cells[4],'FALSE');assert.equal(row.cells[5],'0');assert.equal(row.cells[6],'FALSE');assert.equal(row.cells[7],'');assert.equal(row.cells[8],'Supplier details');assert.equal(row.cells[9],'Layer A');assert.equal(row.cells[10],'#DIV/0!');assert.equal(row.cells[11],'2026-02-03');assert.equal(row.cells[12],'');assert.equal(row.cells[13],'End');assert.deepEqual(row.formulaColumns,[6,7,8]);assert.match(result.warnings.join(' '),/没有缓存结果/);assert.match(result.warnings.join(' '),/计算错误/);assert.deepEqual(readdirSync(directory),[]);
});

test('1904日期系统、隐藏工作表/行列与重复表头按原结构保留待用户核对',async()=>{
  const bytes=await workbook(book=>{book.properties.date1904=true;const visible=book.addWorksheet('Visible');visible.addRow(['产品','型号','型号','']);visible.addRow(['Chair','001','002',new Date('2026-02-03T00:00:00Z')]);visible.getCell('D2').numFmt='yyyy-mm-dd';visible.getRow(2).hidden=true;visible.getColumn(3).hidden=true;const hidden=book.addWorksheet('Internal');hidden.state='veryHidden';hidden.addRow(['Cost']);hidden.addRow([0]);});
  const result=await extractAiSourceFile(bytes,'dated.xlsx','');assert.deepEqual(result.sheets![0].rows[0].cells.slice(0,3),['产品','型号','型号']);assert.equal(result.sheets![0].rows[1].cells[3],'2026-02-03');assert.equal(result.sheets![0].rows[1].hidden,true);assert.deepEqual(result.sheets![0].hiddenColumns,[3]);assert.equal(result.sheets![1].hidden,true);assert.match(result.warnings.join(' '),/隐藏/);
});

test('Excel压缩炸弹、伪造解包长度、路径越界、加密与宏对象在解析前拒绝',async()=>{
  const bomb=Buffer.alloc(17*1024*1024,65);
  await assert.rejects(extractAiSourceFile(zip([...xmlEntries(),{name:'xl/worksheets/sheet1.xml',value:bomb}]),'bomb.xlsx',''),status(413));
  await assert.rejects(extractAiSourceFile(zip([...xmlEntries(),{name:'xl/worksheets/sheet1.xml',value:bomb,declared:1}]),'forged.xlsx',''),status(413));
  await assert.rejects(extractAiSourceFile(zip([...xmlEntries(),{name:'../escape',value:Buffer.from('x')}]),'traversal.xlsx',''),status(422));
  await assert.rejects(extractAiSourceFile(zip([{name:'xl/workbook.xml',value:Buffer.from('<workbook/>'),encrypted:true}]),'encrypted.xlsx',''),status(422));
  await assert.rejects(extractAiSourceFile(zip([...xmlEntries(),{name:'xl/vbaProject.bin',value:Buffer.from('not executed')}]),'macro.xlsx',''),status(422));assert.deepEqual(readdirSync(directory),[]);
});

test('大小、PDF页数及Excel工作表/行列/单元格上限明确拒绝，不静默截断',async()=>{
  await assert.rejects(extractAiSourceFile(new Uint8Array(AI_SOURCE_LIMITS.maxFileBytes+1),'large.xlsx',''),status(413));
  const doc=await PDFDocument.create();for(let i=0;i<101;i++)doc.addPage();await assert.rejects(extractAiSourceFile(await doc.save(),'pages.pdf',''),status(413));
  await assert.rejects(extractAiSourceFile(await workbook(book=>{for(let i=0;i<11;i++)book.addWorksheet('Sheet '+i).addRow(['Data']);}),'sheets.xlsx',''),status(413));
  await assert.rejects(extractAiSourceFile(await workbook(book=>{const s=book.addWorksheet('Products');for(let i=0;i<1001;i++)s.addRow(['Unique product '+i]);}),'rows.xlsx',''),status(413));
  await assert.rejects(extractAiSourceFile(await workbook(book=>{book.addWorksheet('Products').getCell('BM1').value='Too wide';}),'columns.xlsx',''),status(413));
  await assert.rejects(extractAiSourceFile(await workbook(book=>{book.addWorksheet('Products').getCell('A1').value='x'.repeat(6001);}),'cell.xlsx',''),status(413));
});

test('文件格式与MIME核对，旧xls/宏扩展及空文件不进入解析器',async()=>{
  const bytes=await pdf('Source');
  await assert.rejects(extractAiSourceFile(bytes,'source.xls',''),status(415));await assert.rejects(extractAiSourceFile(bytes,'source.xlsm',''),status(415));await assert.rejects(extractAiSourceFile(bytes,'source.pdf','text/html'),status(415));await assert.rejects(extractAiSourceFile(new Uint8Array(),'empty.pdf',''),status(422));await assert.rejects(extractAiSourceFile(bytes,'bad\u0000name.pdf',''),status(422));
});

test('同实例单解析器、取消会停止worker并释放并发位，PDF旧调用仍兼容',async()=>{
  const bytes=await workbook(book=>book.addWorksheet('Products').addRow(['SKU','001']));
  const first=extractAiSourceFile(bytes,'first.xlsx','');await assert.rejects(extractAiSourceFile(bytes,'second.xlsx',''),status(429));await first;
  const controller=new AbortController(),cancelled=extractAiSourceFile(bytes,'cancelled.xlsx','',controller.signal);controller.abort();await assert.rejects(cancelled,status(499));
  assert.equal((await extractAiSourceFile(bytes,'after.xlsx','')).sheets![0].rows.length,1);
  const p=await pdf('PDF cancellation'),pdfController=new AbortController(),pdfPending=validatePdf(Buffer.from(p),pdfController.signal);pdfController.abort();await assert.rejects(pdfPending,status(499));assert.equal(await validatePdf(Buffer.from(p)),1);
});

test('PDF段落保留空行，文档URI和Excel超链接不会触发实际HTTP访问',async()=>{
  let requests=0;const server=createServer((_request,response)=>{requests++;response.end('unexpected document fetch');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address==='object');const url='http://127.0.0.1:'+address.port+'/private-source';
    const doc=await PDFDocument.create(),page=doc.addPage();page.drawText('Company overview',{x:40,y:700,size:12});page.drawText('Manufacturing expertise',{x:40,y:650,size:12});
    const annotation=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[40,640,300,660],A:{S:'URI',URI:PDFHexString.fromText(url)}}));page.node.set(PDFName.of('Annots'),doc.context.obj([annotation]));
    const result=await extractAiSourceFile(await doc.save(),'paragraphs.pdf','');assert.match(result.pages![0].text,/Company overview\n\nManufacturing expertise/);
    const xlsx=await workbook(book=>book.addWorksheet('Products').getCell('A1').value={text:'Supplier catalog',hyperlink:url});
    assert.equal((await extractAiSourceFile(xlsx,'links.xlsx','')).sheets![0].rows[0].cells[0],'Supplier catalog');assert.equal(requests,0);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
