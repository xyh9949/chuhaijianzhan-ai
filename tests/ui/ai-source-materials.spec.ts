import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { request as playwrightRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiSourceRecord } from '../../src/server/ai-source-import';
import type { AiSourceMergePrepared, AiSourceMergePreview } from '../../src/lib/ai-source-merge-types';

async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  expect(new URL(runtime.origin).hostname).toBe('127.0.0.1'); expect(new URL(runtime.origin).port).not.toBe('3200');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated materials ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}
async function upload(control: APIRequestContext, bytes: Uint8Array, name: string, mimeType: string): Promise<AiSourceRecord> {
  const response = await control.post(`${runtime.origin}/api/ai/sources`, { multipart: { file: { name, mimeType, buffer: Buffer.from(bytes) } }, timeout: 30000 }); expect(response.status()).toBe(201); return response.json();
}
/** rc-select虚拟列表的role=option属于零尺寸辅助节点；实际点击可视门户，不修改组件来迁就测试。 */
async function chooseOption(page: Page, combobox: Locator, label: string | RegExp) {
  await expect(combobox).toBeVisible();
  // 外层/内层Modal入场后的焦点定位会关闭过早打开的下拉，先等真实可交互状态。
  await expect.poll(() => page.locator('.ant-modal:visible').evaluateAll(panels => panels.some(panel => /(?:^|\s)\S+-(?:enter|appear|leave)(?:-\S+)?(?=\s|$)/.test(panel.className)))).toBe(false);
  await expect(combobox).toBeEnabled();
  if (await combobox.getAttribute('aria-expanded') !== 'true') await combobox.click();
  await expect(combobox).toHaveAttribute('aria-controls', /.+/);
  const popupId = await combobox.getAttribute('aria-controls') || await combobox.getAttribute('aria-owns'); expect(popupId).toMatch(/^[\w:.-]+$/);
  // 动画中的外层同名来源不可作为当前选择；隐藏list只定位popup，点击仍使用真实option。
  const popup = page.locator('.ant-select-dropdown:visible').filter({ has: page.locator(`[id="${popupId}"]`) });
  await expect(popup).not.toHaveClass(/(?:^|\s)\S+-(?:enter|appear|leave)(?:-\S+)?(?=\s|$)/);
  // 证据标题有原文换行，只归一展示空白；整段文件名/位置/摘要仍须完整相同，不能改点任意一项。
  const text = typeof label === 'string' ? new RegExp(`^${label.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}$`) : label;
  const option = popup.locator('.ant-select-item-option').filter({ hasText: text });
  await expect(option).toHaveCount(1); await expect(option).toBeVisible(); await option.hover(); await expect(option).toHaveClass(/(?:^|\s)ant-select-item-option-active(?=\s|$)/); await option.click();
  const explicitSwitch = await combobox.getAttribute('aria-label') === '当前导入资料';
  await expect.poll(async () => {
    if (explicitSwitch && await page.getByRole('dialog', { name: '切换资料前请确认', exact: true }).isVisible()) return true;
    const selected = await combobox.evaluate(input => { const root = input.closest('.ant-select')!, tags = root.querySelectorAll('.ant-select-selection-item-content'), items = tags.length ? tags : root.querySelectorAll('.ant-select-content[title],.ant-select-content-value[title]'); return [...items].map(item => (item.getAttribute('title') || item.textContent || '').replace(/\s+/g, ' ').trim()); });
    return selected.some(value => text.test(value));
  }, { message: '原生选择必须已反映到控件，或明确等待切换确认' }).toBe(true);
}
async function closeOptions(combobox: Locator) { if (await combobox.getAttribute('aria-expanded') === 'true') await combobox.press('Escape'); }
async function materials() {
  // 固定双语扫描位图与服务端真实OCR用例共用，不依赖Windows/Linux系统中文字体。
  const doc = await PDFDocument.create(), image = await doc.embedPng(readFileSync(join(process.cwd(), 'tests/fixtures/source-ocr-en-zh.png'))), page = doc.addPage([800, 325]); page.drawImage(image, { x: 0, y: 0, width: 800, height: 325 });
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Products'); sheet.addRow(['Product name', 'SKU', 'Category', 'Material', 'Description']); sheet.addRow(['Synthetic steel sample', 'UI-MATERIAL-025', 'Samples', 'Steel', 'Synthetic source import only.']);
  const png = await sharp({ create: { width: 180, height: 120, channels: 3, background: '#334455' } }).png().toBuffer(), id = book.addImage({ buffer: png as never, extension: 'png' }); sheet.addImage(id, { tl: { col: 5, row: 1 }, ext: { width: 180, height: 120 } });
  return { pdf: await doc.save(), xlsx: new Uint8Array(await book.xlsx.writeBuffer()) };
}

test('Excel 按型号更新核对差异并在保留后来编辑时撤销', async ({ page, ui }, testInfo) => {
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 20000 });
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const product = original.state.products.find(item => item.id === 'p2')!, skipped = original.state.products.find(item => item.id === 'p3')!;
  const updatedCopy = 'UI imported white oak specification';
  const manualMaterial = 'Later manual material retained';
  let sourceId = '';
  try {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Catalog');
    sheet.addRow(['SKU', 'Product Name', 'Description', 'Material']);
    sheet.addRow([product.sku.toLowerCase(), 'Ignore this renamed product', updatedCopy, 'Ignore this material']);
    sheet.addRow([skipped.sku, 'Skip this whole row', 'Do not write to this product', 'Skip this material']);
    const buffer = Buffer.from(await book.xlsx.writeBuffer());
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/admin#products');
    const initialRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/sources' && response.request().method() === 'GET');
    await textButton(page, '按型号更新').click();
    const dialog = page.getByRole('dialog', { name: 'Excel 按型号更新产品', exact: true });
    // 等真实资料列表请求和按钮恢复再选择文件，模拟访客能点击原生输入的时机。
    expect((await initialRead).ok()).toBe(true);
    await expect(textButton(dialog, '上传产品 Excel')).toBeEnabled();
    ui.allowWrite('POST', '/api/ai/sources');
    const uploading = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/sources' && response.request().method() === 'POST', { timeout: 18000 });
    await dialog.locator('.ai-source-toolbar input[type=file]').setInputFiles({ name: 'ui-sku-update.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    const uploaded = await uploading; expect(uploaded.status()).toBe(201); sourceId = (await uploaded.json() as AiSourceRecord).id;
    await chooseOption(page, dialog.getByRole('combobox', { name: '对应产品介绍的列', exact: true }), 'C · Description');
    await dialog.locator('tr[data-row-key="3"]').getByRole('checkbox').uncheck();
    await expect(dialog.getByText('核对产品 · 已选择1行', { exact: true })).toBeVisible();
    ui.allowWrite('POST', `/api/ai/sources/${sourceId}/preview`);
    await textButton(dialog, '预览更新差异').click();
    await expect(dialog.getByText('检查通过 · 1个产品，5分钟内确认', { exact: true })).toBeVisible();
    const diff = dialog.locator('.ant-table-expanded-row');
    await expect(diff.getByText(product.description, { exact: true })).toBeVisible();
    await expect(diff.getByText(updatedCopy, { exact: true })).toBeVisible();
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(original.revision);
    await noOverflow(page, dialog);
    await testInfo.attach('excel-sku-diff-mobile', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    ui.allowWrite('POST', `/api/ai/sources/${sourceId}/apply`);
    await textButton(dialog, '确认更新1个产品草稿').click();
    await expect(dialog.getByText('已更新1个产品草稿。最近更新中可在7天内撤销。', { exact: true })).toBeVisible();
    const saved = await api<StudioEnvelope>(control, '/api/studio');
    expect(saved.state.products.find(item => item.id === product.id)).toMatchObject({ id: product.id, sku: product.sku, slug: product.slug, locale: product.locale, name: product.name, material: product.material, description: updatedCopy });
    expect(saved.state.products.find(item => item.id === skipped.id)).toEqual(skipped);
    expect(saved.activeReleaseId).toBe(original.activeReleaseId);

    // 另一写入将材质改为新值。刷新后从持久回执撤销描述，必须保留这次无关修改。
    await api(control, '/api/studio', 'PATCH', { expectedRevision: saved.revision, patch: { products: saved.state.products.map(item => item.id === product.id ? { ...item, material: manualMaterial } : item) } });
    await page.reload();
    await textButton(page, '按型号更新').click();
    await dialog.getByText('最近更新 · 1 批', { exact: true }).click();
    ui.allowWrite('POST', '/api/ai/sources/product-updates');
    await textButton(dialog, '撤销本批').click();
    await page.getByRole('dialog', { name: '撤销 1 个产品的这次更新？', exact: true }).getByRole('button', { name: '确认撤销', exact: true }).click();
    await expect(dialog.getByText('已撤销本次产品草稿更新。', { exact: true })).toBeVisible();
    const restored = await api<StudioEnvelope>(control, '/api/studio');
    expect(restored.state.products.find(item => item.id === product.id)).toMatchObject({ description: product.description, material: manualMaterial, slug: product.slug });
    expect(restored.activeReleaseId).toBe(original.activeReleaseId);
  } finally {
    await ui.closeOwnedPage();
    const current = await api<StudioEnvelope>(control, '/api/studio');
    if (current.revision !== original.revision) await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { products: original.state.products } });
    if (sourceId) await api(control, `/api/ai/sources/${sourceId}`, 'DELETE');
    await control.dispose();
  }
});

test('离线中英扫描识别、实际抽图明确入库、逐行选图和多来源证据合并撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(180000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 20000 });
  const original = await api<StudioEnvelope>(control, '/api/studio'), bytes = await materials(), sourceIds: string[] = [];
  try {
    const pdf = await upload(control, bytes.pdf, 'ui-scanned-company.pdf', 'application/pdf'); sourceIds.push(pdf.id); const xlsx = await upload(control, bytes.xlsx, 'ui-products-with-image.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); sourceIds.push(xlsx.id);
    await page.goto('/admin#templates'); await textButton(page, '导入PDF / Excel').click(); const dialog = page.getByRole('dialog', { name: '导入公司资料与产品表', exact: true }); await expect(dialog).toBeVisible();
    await chooseOption(page, dialog.getByRole('combobox', { name: '当前导入资料' }), 'ui-scanned-company.pdf');
    await dialog.getByText('识别扫描文字与提取文件图片', { exact: true }).click(); await expect(dialog.getByRole('checkbox', { name: '第1页 · 建议识别', exact: true })).toBeChecked();
    ui.allowWrite('POST', `/api/ai/sources/${pdf.id}/enhance`);
    const ocrResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/ai/sources/${pdf.id}/enhance` && response.request().method() === 'POST', { timeout: 120000 }); await textButton(dialog, '开始本机识别与提取').click(); const ocr = await ocrResponse; expect(ocr.ok()).toBe(true); const enhanced = await ocr.json() as AiSourceRecord;
    expect(enhanced.source.pages![0].ocr!.needsReview).toBe(true); expect(enhanced.source.pages![0].text.replace(/\s/g, '')).toContain('工厂资料'); expect(enhanced.source.pages![0].text).toMatch(/STEEL SAMPLE/i); expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(original.revision);
    await expect(dialog.getByText('本机识别稿 · 待核对', { exact: true })).toBeVisible();
    const pdfPage = dialog.locator('.ai-source-page-selection').getByRole('checkbox', { name: '第1页', exact: true });
    await pdfPage.check();
    await textButton(dialog, '把选中页作为说明草稿').click();
    const editedBrief = dialog.locator('.ai-source-brief-review textarea').first();
    await editedBrief.fill('Reviewed copy before changing the source range.');
    await pdfPage.uncheck();
    await expect(dialog.getByText('页码已改变，上次整理稿仍保留', { exact: true })).toBeVisible();
    await expect(editedBrief).toHaveValue('Reviewed copy before changing the source range.');
    await textButton(dialog, '使用勾选的建站资料').click();
    const previousBrief = page.getByRole('dialog', { name: '使用上一次整理的资料？' });
    await previousBrief.getByRole('button', { name: '继续核对' }).click();
    await pdfPage.check();
    await expect(dialog.getByText('页码已改变，上次整理稿仍保留', { exact: true })).toHaveCount(0);
    await expect(editedBrief).toHaveValue('Reviewed copy before changing the source range.');
    // OCR只产生待核对来源；选择后也不调用任何外部模型、生成或发布网站。
    await chooseOption(page, dialog.getByRole('combobox', { name: '当前导入资料' }), 'ui-products-with-image.xlsx'); const switchDialog = page.getByRole('dialog', { name: '切换资料前请确认', exact: true }); await switchDialog.getByRole('button', { name: '放弃本次修改并切换', exact: true }).click();
    ui.allowWrite('POST', `/api/ai/sources/${xlsx.id}/enhance`); const imagesResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/ai/sources/${xlsx.id}/enhance` && response.request().method() === 'POST'); await textButton(dialog, '提取工作簿图片').click(); expect((await imagesResponse).ok()).toBe(true);
    await expect(dialog.getByText('Products · 第2行6列', { exact: true })).toBeVisible(); ui.allowWrite('POST', `/api/ai/sources/${xlsx.id}/images/adopt`); await textButton(dialog, '选入素材中心').click(); await page.getByRole('button', { name: /^确\s*定$/ }).click(); await expect(dialog.getByRole('button', { name: '已在素材中心', exact: true })).toBeVisible();
    const saved = await api<StudioEnvelope>(control, '/api/studio'); expect(saved.state.media.length).toBe(original.state.media.length + 1); expect(saved.state.products.length).toBe(original.state.products.length);
    await dialog.getByText('逐行确认产品图片（默认不匹配）', { exact: true }).click(); const rowImage = dialog.getByRole('combobox', { name: '第2行产品图片', exact: true }); await expect(dialog.getByRole('img', { name: '第2行已选产品图', exact: true })).toHaveCount(0); await chooseOption(page, rowImage, 'Products · 第2行6列'); await expect(dialog.getByRole('img', { name: '第2行已选产品图', exact: true })).toBeVisible();
    ui.allowWrite('POST', `/api/ai/sources/${xlsx.id}/preview`); ui.allowWrite('POST', `/api/ai/sources/${xlsx.id}/apply`); await textButton(dialog, '检查选中的产品').click(); await expect(dialog.getByText('检查通过 · 1个产品，5分钟内确认', { exact: true })).toBeVisible(); await dialog.getByText('产品导入说明', { exact: true }).click(); await expect(dialog.getByText('本次已配图 1 行，未配图 0 行。', { exact: true })).toBeVisible(); await textButton(dialog, '确认新增1个产品草稿').click(); const imported = await api<StudioEnvelope>(control, '/api/studio'); const product = imported.state.products.find(product => product.sku === 'UI-MATERIAL-025')!; expect(product.image).toBe(saved.state.media.find(media => !original.state.media.some(item => item.id === media.id))!.url); expect(imported.activeReleaseId).toBe(original.activeReleaseId);
    await textButton(dialog, '合并多份资料').click(); const merge = page.getByRole('dialog', { name: '合并多份公司资料', exact: true }); await expect(merge).toBeVisible(); const source = merge.getByRole('combobox', { name: '合并来源文件', exact: true }); await chooseOption(page, source, 'ui-scanned-company.pdf'); await chooseOption(page, source, 'ui-products-with-image.xlsx'); await closeOptions(source);
    await merge.getByRole('checkbox', { name: '第1页 · 识别稿', exact: true }).check(); await chooseOption(page, merge.getByRole('combobox', { name: 'ui-products-with-image.xlsx合并工作表', exact: true }), 'Products'); const rows = merge.getByRole('combobox', { name: 'ui-products-with-image.xlsx合并原行号', exact: true }); await chooseOption(page, rows, /^第2行 · Synthetic steel sample/); await closeOptions(rows);
    ui.allowWrite('POST', '/api/ai/sources/merge/prepare'); const evidenceResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/sources/merge/prepare' && response.request().method() === 'POST'); await textButton(merge, '准备合并证据').click(); const evidence = await (await evidenceResponse).json() as AiSourceMergePrepared; expect(evidence.items.some(item => item.kind === 'pdf' && item.ocrNeedsReview)).toBe(true); expect(evidence.items.some(item => item.kind === 'xlsx')).toBe(true);
    await chooseOption(page, merge.getByRole('combobox', { name: '公司与产品说明合并方式', exact: true }), '选择一份证据，核对后替换');
    const selectedEvidence = evidence.items.find(item => item.kind === 'xlsx' && item.sourceId === xlsx.id && item.fileName === 'ui-products-with-image.xlsx' && item.location === 'Products · 第2行')!;
    expect(selectedEvidence).toBeTruthy(); expect(selectedEvidence.text).toContain('UI-MATERIAL-025');
    const evidenceSelect = merge.getByRole('combobox', { name: '公司与产品说明来源证据', exact: true });
    // 与实际选项契约一致：文件名 + 原工作表/行 + 前70字原文摘要；选择后还须验证回传证据ID。
    await chooseOption(page, evidenceSelect, `${selectedEvidence.fileName} · ${selectedEvidence.location} · ${selectedEvidence.text.slice(0, 70)}`); await closeOptions(evidenceSelect); await merge.getByRole('textbox', { name: '公司与产品说明待合并文字1', exact: true }).fill('Synthetic steel sample from reviewed product sheet.');
    ui.allowWrite('POST', '/api/ai/sources/merge/preview'); const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/sources/merge/preview' && response.request().method() === 'POST'); await textButton(merge, '查看合并前后对比').click(); const preview = await (await previewResponse).json() as AiSourceMergePreview; expect(preview.changes.length).toBe(1); expect(preview.changes[0].field).toBe('description'); expect(preview.changes[0].edited).toBe(true); expect(preview.changes[0].evidence).toHaveLength(1); expect(preview.changes[0].evidence[0]).toMatchObject({ id: selectedEvidence.id, sourceId: xlsx.id, fileName: 'ui-products-with-image.xlsx', location: 'Products · 第2行' }); expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(imported.revision);
    await page.setViewportSize({ width: 390, height: 1000 }); await noOverflow(page, merge); await testInfo.attach('materials-mobile-merge-review', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    ui.allowWrite('POST', '/api/ai/sources/merge/confirm'); await textButton(merge, '使用合并资料').click(); await page.getByRole('dialog', { name: '使用这些合并资料？', exact: true }).getByRole('button', { name: '确认使用合并资料', exact: true }).click(); await expect(merge).toContainText('已将核对过的合并资料带入建站表单');
    ui.allowWrite('POST', '/api/ai/sources/merge/undo'); await textButton(merge, '撤销本次合并').click(); await page.getByRole('dialog', { name: '撤销本次资料合并？', exact: true }).getByRole('button', { name: '确认撤销资料合并', exact: true }).click(); await expect(merge).toContainText('已撤销本次触及的建站资料'); expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(imported.revision);
    expect(ui.writes.some(item => /\/api\/ai\/(plan|preview|apply|sources\/brief)|\/api\/releases/.test(item.path))).toBe(false);
  } finally {
    await ui.closeOwnedPage(); const current = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { products: original.state.products, media: original.state.media } }); for (const id of sourceIds) await api(control, `/api/ai/sources/${id}`, 'DELETE'); await control.dispose();
  }
});
