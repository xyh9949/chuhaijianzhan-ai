import {test,expect,runtime,textButton,noOverflow} from './fixtures';
import {request as playwrightRequest,type APIRequestContext} from '@playwright/test';
import type {StudioEnvelope} from '../../src/lib/studio-client';
import type {RichNode} from '../../src/lib/presentation-content';
import type {AiWritingProposal,AiWritingReceipt} from '../../src/lib/ai-writing-types';

/** 仅使用包装器的随机合成实例；AI来源为当前测试进程启动的本机兼容模型。 */
async function api<T>(control:APIRequestContext,path:string,method='GET',data?:unknown):Promise<T>{
 const origin=new URL(runtime.origin);expect(origin.hostname).toBe('127.0.0.1');expect(origin.port).not.toBe('3200');
 const response=await control.fetch(`${runtime.origin}${path}`,{method,...(data===undefined?{}:{data})});expect(response.ok(),`${method} ${path}: ${response.status()}`).toBe(true);return response.json() as Promise<T>;
}

test('产品图文长详情：自配AI真实对比、保图链、原生编辑保存、实际页面与撤销',async({page,ui},testInfo)=>{
 test.setTimeout(120000);
 const control=await playwrightRequest.newContext({storageState:runtime.adminAuth,extraHTTPHeaders:{Origin:runtime.origin,Connection:'close'},timeout:15000});
 const original=await api<StudioEnvelope>(control,'/api/studio'),product=original.state.products.find(p=>p.id==='p2')!;
 const provider=await api<{revision:number;enabled:boolean;hasApiKey:boolean;baseUrl:string;model:string;allowLocal:boolean;visionModel?:string}>(control,'/api/ai/provider');let configured=false;
 const detail:RichNode={type:'doc',content:[{type:'heading',attrs:{level:2},content:[{type:'text',text:'Supplied original long product detail'}]},{type:'paragraph',content:[{type:'text',text:'Read company information',marks:[{type:'link',attrs:{href:'/about'}}]}]},{type:'image',attrs:{src:'/images/chair.jpg',alt:'Supplied long detail photo',caption:'Original photo remains editable',width:75,align:'center'}}]};
 try{
  expect(provider.enabled).toBe(false);expect(provider.hasApiKey).toBe(false);
  const seeded=await api<StudioEnvelope>(control,'/api/studio','PATCH',{expectedRevision:original.revision,patch:{products:original.state.products.map(p=>p.id===product.id?{...p,detailContent:detail}:p)}});
  await api(control,'/api/ai/provider','PATCH',{expectedRevision:provider.revision,enabled:true,baseUrl:`${runtime.modelOrigin}/v1`,model:'ui-product-detail-model',allowLocal:true,apiKey:'ui-design-synthetic'});configured=true;
  ui.allowWrite('POST','/api/ai/writing/proposals');ui.allowWrite('POST','/api/ai/writing/save');ui.allowWrite('PATCH','/api/studio');
  await page.goto('/admin#products');await page.locator(`tr[data-row-key="${product.id}"]`).getByRole('button',{name:product.name,exact:true}).click();
  const composer=page.getByRole('textbox',{name:'产品图文详情',exact:true});await expect(composer).toContainText('Supplied original long product detail');
  await page.setViewportSize({width:390,height:1000});await noOverflow(page);
  await textButton(page,'AI写图文详情').click();let writer=page.getByRole('dialog',{name:'AI写产品图文详情',exact:true});await expect(writer).toBeVisible();
  await writer.getByRole('textbox',{name:'AI写作要求',exact:true}).fill('UI_AI_PRODUCT_DETAIL');
  const generatedResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/ai/writing/proposals'&&r.request().method()==='POST');
  await textButton(writer,'生成内容建议').click();const generatedHttp=await generatedResponse;expect(generatedHttp.status()).toBe(201);const proposal=await generatedHttp.json() as AiWritingProposal;
  expect(proposal.fields.map(f=>f.key)).toEqual(['detailContent']);expect((await api<StudioEnvelope>(control,'/api/studio')).revision).toBe(seeded.revision);
  await textButton(writer,'查看原文与建议排版').click();await expect(writer.getByRole('heading',{name:'UI generated product details',exact:true})).toBeVisible();
  await expect(writer.locator('img[alt="Supplied long detail photo"]')).toHaveCount(2);await expect(writer.locator('a[href="/about"]')).toHaveCount(2);
  await testInfo.attach('product-long-detail-mobile-compare',{body:await writer.screenshot({animations:'disabled'}),contentType:'image/png'});
  await textButton(writer,'填入编辑区').click();await expect(writer).toBeHidden();await expect(composer).toContainText('UI generated product details');
  expect((await api<StudioEnvelope>(control,'/api/studio')).revision).toBe(seeded.revision);
  await textButton(page,'保存产品').click();await expect(composer).toBeHidden();
  const saved=await api<StudioEnvelope>(control,'/api/studio'),savedProduct=saved.state.products.find(p=>p.id===product.id)!;
  expect(savedProduct.description).toBe(product.description);expect(savedProduct.detailContent).toEqual(proposal.fields[0].after);expect(saved.activeReleaseId).toBe(original.activeReleaseId);
  const receipts=await api<{items:AiWritingReceipt[]}>(control,`/api/ai/writing/receipts?kind=product&id=${product.id}`),receipt=receipts.items.find(r=>r.fields.includes('detailContent')&&r.undoneRevision===null)!;expect(receipt).toBeTruthy();ui.allowWrite('POST',`/api/ai/writing/receipts/${receipt.id}/undo`);
  await page.setViewportSize({width:1600,height:1000});await page.locator(`tr[data-row-key="${product.id}"]`).getByRole('button',{name:product.name,exact:true}).click();await textButton(page,'AI写图文详情').click();writer=page.getByRole('dialog',{name:'AI写产品图文详情',exact:true});
  await writer.getByRole('tab',{name:'查看建议与修改',exact:true}).click();await textButton(writer,'撤销这次修改').first().click();await expect(textButton(writer,'已撤销').first()).toBeVisible();await textButton(writer,'返回编辑').click();await expect(writer).toBeHidden();
  await expect(composer).toContainText('Supplied original long product detail');await expect(composer).not.toContainText('UI generated product details');
  await composer.click();await composer.press('Control+End');await composer.press('Enter');await composer.pressSequentially('UI edited long detail in native editor');await textButton(page,'保存产品').click();await expect(composer).toBeHidden();
  const edited=await api<StudioEnvelope>(control,'/api/studio');expect(JSON.stringify(edited.state.products.find(p=>p.id===product.id)!.detailContent)).toContain('UI edited long detail in native editor');
  await page.setViewportSize({width:390,height:1000});await page.goto(`/preview/products/${product.slug||product.id}`);
  const preview=page.frameLocator('iframe[title="网站草稿隔离预览"]');await expect(preview.getByText('UI edited long detail in native editor',{exact:true})).toBeVisible();await expect(preview.locator('[data-product-detail-content] img[alt="Supplied long detail photo"]')).toBeVisible();
  expect(ui.writes).toEqual([{method:'POST',path:'/api/ai/writing/proposals'},{method:'POST',path:'/api/ai/writing/save'},{method:'POST',path:`/api/ai/writing/receipts/${receipt.id}/undo`},{method:'PATCH',path:'/api/studio'}]);
 }finally{
  await ui.closeOwnedPage();if(configured){const current=await api<{revision:number}>(control,'/api/ai/provider');await api(control,'/api/ai/provider','PATCH',{expectedRevision:current.revision,enabled:provider.enabled,baseUrl:provider.baseUrl,model:provider.model,allowLocal:provider.allowLocal,visionModel:provider.visionModel||'',clearApiKey:true});}
  const current=await api<StudioEnvelope>(control,'/api/studio');await api(control,'/api/studio','PATCH',{expectedRevision:current.revision,patch:{products:current.state.products.map(p=>p.id===product.id?product:p)}});await control.dispose();
 }
});

test('产品图文长详情：撤销新增详情后清空编辑区，续存不会恢复缺省字段',async({page,ui})=>{
 test.setTimeout(120000);
 const control=await playwrightRequest.newContext({storageState:runtime.adminAuth,extraHTTPHeaders:{Origin:runtime.origin,Connection:'close'},timeout:15000});
 const original=await api<StudioEnvelope>(control,'/api/studio'),product=original.state.products.find(p=>p.id==='p2')!;
 const provider=await api<{revision:number;enabled:boolean;hasApiKey:boolean;baseUrl:string;model:string;allowLocal:boolean;visionModel?:string}>(control,'/api/ai/provider');let configured=false;
 try{
  expect(provider.enabled).toBe(false);expect(provider.hasApiKey).toBe(false);
  // 原字段确实缺省；服务端撤销删除属性后，Ant表单也必须显式清空旧文档。
  const seed={...product};delete seed.detailContent;
  await api(control,'/api/studio','PATCH',{expectedRevision:original.revision,patch:{products:original.state.products.map(p=>p.id===product.id?seed:p)}});
  await api(control,'/api/ai/provider','PATCH',{expectedRevision:provider.revision,enabled:true,baseUrl:`${runtime.modelOrigin}/v1`,model:'ui-product-detail-model',allowLocal:true,apiKey:'ui-design-synthetic'});configured=true;
  ui.allowWrite('POST','/api/ai/writing/proposals');ui.allowWrite('POST','/api/ai/writing/save');ui.allowWrite('PATCH','/api/studio');
  await page.goto('/admin#products');await page.locator(`tr[data-row-key="${product.id}"]`).getByRole('button',{name:product.name,exact:true}).click();
  const composer=page.getByRole('textbox',{name:'产品图文详情',exact:true});await expect(composer).toHaveText('');
  await textButton(page,'AI写图文详情').click();let writer=page.getByRole('dialog',{name:'AI写产品图文详情',exact:true});
  await writer.getByRole('textbox',{name:'AI写作要求',exact:true}).fill('UI_AI_PRODUCT_DETAIL');await textButton(writer,'生成内容建议').click();await textButton(writer,'填入编辑区').click();await expect(writer).toBeHidden();await expect(composer).toContainText('UI generated product details');
  await textButton(page,'保存产品').click();await expect(composer).toBeHidden();
  const receipts=await api<{items:AiWritingReceipt[]}>(control,`/api/ai/writing/receipts?kind=product&id=${product.id}`),receipt=receipts.items.find(r=>r.fields.includes('detailContent')&&r.undoneRevision===null)!;expect(receipt).toBeTruthy();ui.allowWrite('POST',`/api/ai/writing/receipts/${receipt.id}/undo`);
  await page.locator(`tr[data-row-key="${product.id}"]`).getByRole('button',{name:product.name,exact:true}).click();await textButton(page,'AI写图文详情').click();writer=page.getByRole('dialog',{name:'AI写产品图文详情',exact:true});
  await writer.getByRole('tab',{name:'查看建议与修改',exact:true}).click();await textButton(writer,'撤销这次修改').first().click();await expect(textButton(writer,'已撤销').first()).toBeVisible();await textButton(writer,'返回编辑').click();await expect(writer).toBeHidden();await expect(composer).toHaveText('');
  const undone=await api<StudioEnvelope>(control,'/api/studio');expect(Object.hasOwn(undone.state.products.find(p=>p.id===product.id)!,'detailContent')).toBe(false);
  await page.getByRole('textbox',{name:'产品名称',exact:true}).fill(`${product.name} UI continued edit`);await textButton(page,'保存产品').click();await expect(composer).toBeHidden();
  const edited=await api<StudioEnvelope>(control,'/api/studio');expect(Object.hasOwn(edited.state.products.find(p=>p.id===product.id)!,'detailContent')).toBe(false);
  expect(ui.writes).toEqual([{method:'POST',path:'/api/ai/writing/proposals'},{method:'POST',path:'/api/ai/writing/save'},{method:'POST',path:`/api/ai/writing/receipts/${receipt.id}/undo`},{method:'PATCH',path:'/api/studio'}]);
 }finally{
  await ui.closeOwnedPage();if(configured){const current=await api<{revision:number}>(control,'/api/ai/provider');await api(control,'/api/ai/provider','PATCH',{expectedRevision:current.revision,enabled:provider.enabled,baseUrl:provider.baseUrl,model:provider.model,allowLocal:provider.allowLocal,visionModel:provider.visionModel||'',clearApiKey:true});}
  const current=await api<StudioEnvelope>(control,'/api/studio');await api(control,'/api/studio','PATCH',{expectedRevision:current.revision,patch:{products:current.state.products.map(p=>p.id===product.id?product:p)}});await control.dispose();
 }
});
