import ExcelJS from 'exceljs';
import { request as playwrightRequest } from '@playwright/test';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import { test, expect, go, runtime, textButton } from './fixtures';

test('Excel 保留输入后刷新可恢复人工单元格，确认导入前草稿版本一致', async ({ page, ui }) => {
  const original = await page.request.get('/api/studio').then(response => response.json()) as StudioEnvelope;
  await go(page, 'templates');
  await textButton(page, '导入PDF / Excel').click();
  ui.allowWrite('POST', '/api/ai/sources');
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Fixture');
  sheet.addRow(['Product name', 'SKU']); sheet.addRow(['Original fixture', 'UI-RECOVERY-XLSX']);
  const upload = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/sources' && response.request().method() === 'POST');
  await page.locator('.ai-source-import-modal input[type=file]').first().setInputFiles({ name: 'fixture.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await book.xlsx.writeBuffer()) });
  const source = await (await upload).json() as { id: string };
  try {
    const cell = page.getByRole('textbox', { name: '第2行产品名称', exact: true });
    await expect(cell).toHaveValue('Original fixture');
    await cell.fill('Manually reviewed fixture');
    const panel = page.getByRole('dialog', { name: '导入公司资料与产品表', exact: true });
    await textButton(panel, '返回建站').click();
    const guard = page.getByRole('dialog', { name: '未保存 · 资料导入选项', exact: true });
    ui.allowWrite('POST', `/api/ai/sources/${source.id}/review`);
    await textButton(guard, '保留输入并离开').click();
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('Manually reviewed fixture');
    await page.reload();
    await expect(cell).toHaveValue('Manually reviewed fixture');
    expect((await page.request.get('/api/studio').then(response => response.json()) as StudioEnvelope).revision).toBe(original.revision);
    // 再改一处后直接刷新，已明确暂存的改值仍可读取。
    await cell.fill('Unconfirmed second change');
    page.once('dialog', dialog => void dialog.accept());
    await page.reload();
    await expect(cell).toHaveValue('Manually reviewed fixture');
    await textButton(panel, '返回建站').click();
    await textButton(guard, '放弃修改').click();
  } finally {
    await page.request.delete(`/api/ai/sources/${source.id}`, { headers: { Origin: runtime.origin } });
  }
});

test('手机文章单点预览使用未保存标题，关闭后草稿仍保留原值且可放弃修改', async ({ page, ui }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' } });
  const url = `${runtime.origin}/api/studio`;
  const read = () => control.get(url).then(response => response.json()) as Promise<StudioEnvelope>;
  const original = await read();
  try {
    // 隔离夹具尚无新闻栏目，首次点“启用后填写”会先保存栏目和详情模板。
    ui.allowWrite('PATCH', '/api/studio');
    await go(page, 'content-models');
    await textButton(page, '新建内容').click();
    await page.getByRole('button', { name: /新闻 · (启用后填写|\d+ 条)/ }).click();
    const title = page.locator('.content-entry-title input');
    await title.fill('Original review article');
    await page.locator('.rtc-writing-area [contenteditable=true]').first().fill('Synthetic paragraph for the review.');
    await textButton(page, '保存草稿').click();
    await expect(page.getByText('草稿已保存，可以继续编辑', { exact: true })).toBeVisible();
    const saved = await read(), entry = saved.state.contentEntries!.find(item => item.title === 'Original review article')!;
    expect(entry).toBeDefined();
    await title.fill('Unsaved article review title');
    await expect(page.getByText('有未保存修改', { exact: true })).toBeVisible();
    ui.allowWrite('POST', '/api/content-entry-preview');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.content-entry-toolbar').getByRole('button', { name: /预\s*览/ }).click()]);
    try {
      await popup.waitForURL(/\/preview\/~entry\//);
      await expect(popup.frameLocator('iframe[title="网站草稿隔离预览"]').getByText('Unsaved article review title', { exact: true }).first()).toBeVisible();
    } finally { await popup.close(); }
    await expect(title).toHaveValue('Unsaved article review title');
    const after = await read();
    expect(after.revision).toBe(saved.revision);
    expect(after.state.contentEntries!.find(item => item.id === entry.id)?.title).toBe('Original review article');
    await page.locator('.content-entry-toolbar').getByRole('button', { name: /返回.*列表/ }).click();
    await textButton(page.getByRole('dialog', { name: '当前修改尚未保存' }), '放弃修改').click();
    await expect(page.getByRole('button', { name: 'Original review article', exact: true })).toBeVisible();
  } finally {
    await ui.closeOwnedPage();
    const current = await read();
    if (current.revision !== original.revision) {
      // 启用新闻还会注册结构化数据映射，一起恢复，避免后续用例收到指向已移除模型的设置。
      const reverted = await control.patch(url, { data: { expectedRevision: current.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, contentModels: original.state.contentModels, contentEntries: original.state.contentEntries, settings: original.state.settings } } });
      expect(reverted.ok(), await reverted.text()).toBe(true);
      expect((await read()).state.pages.map(item => item.id)).toEqual(original.state.pages.map(item => item.id));
    }
    await control.dispose();
  }
});

test('长期建站方案抽屉刷新找回未保存修改，到期预览禁用确认且可无模型重建', async ({ page, ui }) => {
  const headers = { Origin: runtime.origin };
  const provider = await page.request.get('/api/ai/provider').then(response => response.json());
  expect(provider.enabled).toBe(false);
  expect(provider.hasApiKey).toBe(false);
  const configuring = await page.request.patch('/api/ai/provider', { headers, data: { expectedRevision: provider.revision, enabled: true, baseUrl: `${runtime.modelOrigin}/v1`, model: 'ui-industry-service-model', allowLocal: true, apiKey: 'ui-design-synthetic' } });
  expect(configuring.ok(), await configuring.text()).toBe(true);
  let keptPlan: string | undefined;
  try {
    await go(page, 'templates');
    for (const [field, value] of [['公司名称', 'UI_AI_INDUSTRY_SERVICES'], ['所属行业', 'Professional services'], ['业务说明', 'Synthetic brief for three advisory services and contact.'], ['目标买家', 'B2B companies'], ['重点市场', 'UK']]) {
      await page.getByRole('textbox', { name: `AI建站${field}`, exact: true }).fill(value);
    }
    ui.allowWrite('POST', '/api/ai/build/plan');
    ui.allowWrite('POST', '/api/ai/build/plan/retention');
    ui.allowWrite('POST', '/api/ai/build/preview');
    await page.getByRole('button').filter({ hasText: '生成整站方案' }).click();
    await expect(textButton(page, '长期保存方案')).toBeEnabled();
    await page.getByRole('textbox', { name: 'AI建站网址前缀', exact: true }).fill('/draft-audit-services');
    const keeping = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/build/plan/retention' && response.request().method() === 'POST');
    await textButton(page, '长期保存方案').click();
    keptPlan = (await (await keeping).json()).planId;
    await expect(textButton(page, '方案已长期保存')).toBeDisabled();
    await textButton(page, '修改页面、文案和按钮').click();
    const drawer = page.getByRole('dialog', { name: '修改建站方案' });
    const title = drawer.getByRole('textbox', { name: /页面名称$/ });
    await title.fill('Retained unsaved plan title');
    let unload = false;
    page.once('dialog', dialog => { unload = dialog.type() === 'beforeunload'; void dialog.accept(); });
    await page.reload();
    expect(unload).toBe(true);
    await textButton(page, '建站方案修改').click();
    await textButton(page, '返回恢复入口').click();
    await expect(title).toHaveValue('Retained unsaved plan title');
    await drawer.getByRole('button', { name: /^取\s*消$/ }).click();
    await textButton(page.getByRole('dialog', { name: '未保存 · 建站方案修改' }), '放弃修改').click();
    await expect(drawer).toBeHidden();
    const compiled = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/build/preview' && response.request().method() === 'POST');
    await page.getByRole('button').filter({ hasText: '生成页面并检查' }).click();
    const first = await (await compiled).json() as { previewId: string; expiresAt: string };
    const save = textButton(page, '保存为草稿并拖拽编辑');
    await expect(save).toBeEnabled();
    await save.click();
    const confirmation = page.getByRole('dialog', { name: '确认保存本次建站草稿？' });
    await expect(textButton(confirmation, '确认保存建站草稿')).toBeEnabled();
    await page.clock.setFixedTime(new Date(Date.parse(first.expiresAt) + 1000));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(textButton(confirmation, '确认保存建站草稿')).toBeDisabled();
    await textButton(confirmation, '返回检查').click();
    await expect(page.getByText('这份网站预览已过期', { exact: true })).toBeVisible();
    const regenerated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/build/preview' && response.request().method() === 'POST');
    await page.clock.setFixedTime(new Date());
    await textButton(page, '重新生成页面预览').click();
    const newPreview = await (await regenerated).json();
    expect(newPreview.previewId).not.toBe(first.previewId);
    await expect(save).toBeEnabled();
    expect(ui.writes.filter(write => write.path === '/api/ai/build/plan')).toHaveLength(1);
    expect(ui.writes.some(write => write.path === '/api/ai/build/apply')).toBe(false);
  } finally {
    const current = await page.request.get('/api/ai/provider').then(response => response.json());
    // 完整还原合成模型配置，避免同套件后续用例误读仍启用的测试服务。
    const restored = await page.request.patch('/api/ai/provider', { headers, data: { expectedRevision: current.revision, enabled: provider.enabled, baseUrl: provider.baseUrl, model: provider.model, visionModel: provider.visionModel || '', allowLocal: provider.allowLocal, clearApiKey: true } });
    expect(restored.ok(), await restored.text()).toBe(true);
    const summary = await restored.json();
    expect(summary.enabled).toBe(false);
    expect(summary.hasApiKey).toBe(false);
    if (keptPlan) {
      const removed = await page.request.post('/api/ai/build/plan/retention', { headers, data: { planId: keptPlan, keep: false } });
      expect(removed.ok(), await removed.text()).toBe(true);
    }
  }
});
