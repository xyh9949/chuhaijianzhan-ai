import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { request as playwrightRequest, type Locator, type Page } from '@playwright/test';
import { test, expect, runtime, textButton, noOverflow } from './fixtures';
import type { AiSourceRecord } from '../../src/server/ai-source-import';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiSourceMergePrepared } from '../../src/lib/ai-source-merge-types';

/** 门闩只延迟本人真实GET响应，不伪造来源、OCR或业务结果。 */
async function choose(page:Page,combo:Locator,label:string){
 await expect(combo).toBeVisible();
 // 嵌套Modal的入场焦点定位会关闭过早打开的Select；包含外层门户，一并等到可交互。
 await expect.poll(()=>page.locator('.ant-modal:visible').evaluateAll(panels=>panels.some(panel=>/(?:^|\s)\S+-(?:enter|appear|leave)(?:-\S+)?(?=\s|$)/.test(panel.className)))).toBe(false);
 await expect(combo).toBeEnabled();if(await combo.getAttribute('aria-expanded')!=='true')await combo.click();
 await expect(combo).toHaveAttribute('aria-controls',/.+/);const popupId=await combo.getAttribute('aria-controls')||await combo.getAttribute('aria-owns');expect(popupId).toMatch(/^[\w:.-]+$/);
 // 0px辅助list只锁定当前popup；等真实开关动画结束后单击实际option，再核对受控选中值。
 const popup=page.locator('.ant-select-dropdown:visible').filter({has:page.locator(`[id="${popupId}"]`)});await expect(popup).not.toHaveClass(/(?:^|\s)\S+-(?:enter|appear|leave)(?:-\S+)?(?=\s|$)/);
 const option=popup.locator('.ant-select-item-option').and(page.getByTitle(label,{exact:true}));await expect(option).toHaveCount(1);await expect(option).toBeVisible();await option.hover();await expect(option).toHaveClass(/(?:^|\s)ant-select-item-option-active(?=\s|$)/);await option.click();
 await expect.poll(()=>combo.evaluate(input=>{const root=input.closest('.ant-select')!,tags=root.querySelectorAll('.ant-select-selection-item-content'),items=tags.length?tags:root.querySelectorAll('.ant-select-content[title],.ant-select-content-value[title]');return[...items].map(item=>(item.getAttribute('title')||item.textContent||'').replace(/\s+/g,' ').trim());})).toContain(label.replace(/\s+/g,' ').trim());
}
test('资料合并快速多选：立即保留选择、等待最新资料并忽略已移除来源的迟到GET',async({page,ui},testInfo)=>{
 test.setTimeout(90000);const control=await playwrightRequest.newContext({storageState:runtime.adminAuth,extraHTTPHeaders:{Origin:runtime.origin,Connection:'close'},timeout:20000});
 const before=await(await control.get(`${runtime.origin}/api/studio`)).json() as StudioEnvelope,ids:string[]=[];
 let releaseGate:()=>void=()=>{},gateReleased=false,held=0,fulfilled=0,failed=0;const gate=new Promise<void>(resolve=>{releaseGate=()=>{gateReleased=true;resolve();}});
 try{
  const pdf=await PDFDocument.create();pdf.addPage().drawText('Supplied company evidence for deterministic source selection.',{x:40,y:700,size:14});const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Products');sheet.addRow(['Product','SKU']);sheet.addRow(['Supplied product','MERGE-RACE-001']);
  async function upload(bytes:Uint8Array,name:string,mimeType:string){const response=await control.post(`${runtime.origin}/api/ai/sources`,{multipart:{file:{name,mimeType,buffer:Buffer.from(bytes)}}});expect(response.status()).toBe(201);const value=await response.json() as AiSourceRecord;ids.push(value.id);return value;}
  const first=await upload(await pdf.save(),'merge-first-company.pdf','application/pdf'),second=await upload(new Uint8Array(await book.xlsx.writeBuffer()),'merge-second-products.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const firstPath=`/api/ai/sources/${first.id}`;
  await page.route(`${runtime.origin}${firstPath}`,async route=>{expect(route.request().method()).toBe('GET');const response=await route.fetch();if(!gateReleased){held++;await gate;}try{await route.fulfill({response});fulfilled++;}catch{failed++;}});
  await page.goto('/admin#templates');await textButton(page,'导入PDF / Excel').click();await textButton(page.getByRole('dialog',{name:'导入公司资料与产品表',exact:true}),'合并多份资料').click();
  const dialog=page.getByRole('dialog',{name:'合并多份公司资料',exact:true}),combo=dialog.getByRole('combobox',{name:'合并来源文件',exact:true}),tag=(name:string)=>dialog.locator('.ant-select-selection-item').filter({hasText:name}),prepare=textButton(dialog,'准备合并证据');
  await choose(page,combo,'merge-first-company.pdf');await expect.poll(()=>held,{message:'首次PDF真实GET响应应进入门闩'}).toBeGreaterThan(0);
  // 原缺陷在此确定性变红：GET尚未放行，受控选择仍为空；不能靠加等待掩盖选择丢失窗口。
  await expect(tag('merge-first-company.pdf')).toBeVisible();await expect(prepare).toBeDisabled();
  await choose(page,combo,'merge-second-products.xlsx');await expect(tag('merge-first-company.pdf')).toBeVisible();await expect(tag('merge-second-products.xlsx')).toBeVisible();await expect(prepare).toBeDisabled();
  await tag('merge-first-company.pdf').locator('.ant-select-selection-item-remove').click();await expect(tag('merge-first-company.pdf')).toHaveCount(0);
  const sheetBox=dialog.getByRole('combobox',{name:'merge-second-products.xlsx合并工作表',exact:true});await expect(sheetBox).toBeEnabled();await choose(page,sheetBox,'Products');const rows=dialog.getByRole('combobox',{name:'merge-second-products.xlsx合并原行号',exact:true});await choose(page,rows,'第2行 · Supplied product / MERGE-RACE-001');if(await rows.getAttribute('aria-expanded')==='true')await rows.press('Escape');await expect(prepare).toBeEnabled();
  releaseGate();await expect.poll(()=>fulfilled).toBe(held);expect(failed).toBe(0);
  // 真实回包后跨绘制核对，不能在fetch回调尚未处理时就宣称迟到结果已被忽略。
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(tag('merge-first-company.pdf')).toHaveCount(0);await expect(dialog.getByRole('checkbox',{name:'第1页',exact:true})).toHaveCount(0);await expect(prepare).toBeEnabled();
  // 再加入来源不得丢掉现有工作表/行范围；只有最新集合全部加载后才能准备。
  await choose(page,combo,'merge-first-company.pdf');await expect(dialog.getByRole('checkbox',{name:'第1页',exact:true})).toBeEnabled();await expect(rows).toBeEnabled();await expect(dialog.locator('.ant-select-selection-item').filter({hasText:'第2行 · Supplied product / MERGE-RACE-001'})).toBeVisible();await dialog.getByRole('checkbox',{name:'第1页',exact:true}).check();if(await combo.getAttribute('aria-expanded')==='true')await combo.press('Escape');
  ui.allowWrite('POST','/api/ai/sources/merge/prepare');const evidenceResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/ai/sources/merge/prepare'&&response.request().method()==='POST');await prepare.click();const response=await evidenceResponse;expect(response.ok()).toBe(true);const prepared=await response.json() as AiSourceMergePrepared;expect(new Set(prepared.items.map(item=>item.sourceId))).toEqual(new Set([first.id,second.id]));
  const after=await(await control.get(`${runtime.origin}/api/studio`)).json() as StudioEnvelope;expect(after.revision).toBe(before.revision);expect(after.state).toEqual(before.state);
  await page.setViewportSize({width:390,height:1000});await noOverflow(page,dialog);await testInfo.attach('source-merge-latest-selection-mobile',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'});
 }catch(cause){
  // 关闭页面前保留实际选中标签和当前受控值，区分原生选择未生效与业务状态覆盖。
  const controls=await page.locator('input[role="combobox"]').evaluateAll(inputs=>inputs.filter(input=>(input.getAttribute('aria-label')||'').includes('merge-')||input.getAttribute('aria-label')==='合并来源文件').map(input=>{
   type Fiber={memoizedProps?:Record<string,unknown>;return?:Fiber|null;alternate?:Fiber|null};const key=Object.keys(input).find(key=>key.startsWith('__reactFiber$')),values:unknown[]=[];let fiber=key?(input as unknown as Record<string,unknown>)[key] as Fiber:undefined;
   while(fiber){const props=fiber.memoizedProps;if(props?.['aria-label']===input.getAttribute('aria-label')&&Array.isArray(props.options))values.push({value:props.value,alternateValue:fiber.alternate?.memoizedProps?.value,options:props.options.map(option=>({value:option.value,label:option.label}))});fiber=fiber.return||undefined;}
   return{label:input.getAttribute('aria-label'),disabled:(input as HTMLInputElement).disabled,expanded:input.getAttribute('aria-expanded'),controls:input.getAttribute('aria-controls'),renderedText:input.closest('.ant-select')?.textContent,controlled:values};
  }));
  await testInfo.attach('merge-race-failure-controls',{body:Buffer.from(JSON.stringify({held,fulfilled,failed,controls},null,2)),contentType:'application/json'});await testInfo.attach('merge-race-failure-screen',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'});throw cause;
 }finally{releaseGate();if(held)await expect.poll(()=>fulfilled+failed).toBeGreaterThanOrEqual(held);await ui.closeOwnedPage();for(const id of ids)await control.delete(`${runtime.origin}/api/ai/sources/${id}`);await control.dispose();}
});
