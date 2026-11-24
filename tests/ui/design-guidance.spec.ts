import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { AiDesignGuidance, AiDesignGuidanceInput } from '../../src/lib/ai-design-guidance-types';
import { test, expect, runtime, noOverflow, textButton } from './fixtures';

/** 控制端只访问包装器创建的临时实例；不输出认证头或表单以外的私有配置。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown, status = 200): Promise<T> {
  let response;
  try { response = await control.fetch(path, { method, ...(data === undefined ? {} : { data }) }); }
  catch { throw new Error(`Isolated design guidance ${method} transport failed`); }
  expect(response.status(), `Isolated design guidance ${method} status`).toBe(status); return response.json();
}
const inputOf = (value: AiDesignGuidance): AiDesignGuidanceInput => ({ expectedRevision: value.revision, enabled: value.enabled, preferredStyle: value.preferredStyle, preserveNotes: value.preserveNotes, avoidStyles: value.avoidStyles, feedback: value.feedback });
const controlContext = () => playwrightRequest.newContext({ baseURL: runtime.origin, storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });

test('设计约定真实保存、未保存恢复、409保输入、手机阅读且网站资料保持', async ({ page, ui }, testInfo) => {
  test.setTimeout(100000); page.setDefaultTimeout(10000);
  const control = await controlContext(), before = await api(control, '/api/studio'), provider = await api(control, '/api/ai/provider');
  const original = await api<AiDesignGuidance>(control, '/api/ai/design-guidance');
  const reads: string[] = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/ai/design-guidance') reads.push(request.method()); });
  ui.allowWrite('PATCH', '/api/ai/design-guidance');
  try {
    await page.goto('/admin#products'); await expect(page.locator('.shell-layout')).toBeVisible(); await page.getByRole('menuitem', { name: /全站设计/ }).click();
    await expect(page.getByRole('heading', { name: '全站设计', exact: true })).toBeVisible(); expect(reads).toEqual([]);
    await textButton(page, 'AI设计约定').click(); const drawer = page.getByRole('dialog', { name: 'AI设计约定', exact: true });
    const style = drawer.getByRole('textbox', { name: '希望的网站风格', exact: true }), preserved = drawer.getByRole('textbox', { name: '希望保持的设计', exact: true }), avoided = drawer.getByRole('textbox', { name: '希望避免的设计', exact: true });
    await expect(style).toBeEnabled(); await style.fill('UI 设计约定：专业、清楚、采购导向，产品图片突出。'); await preserved.fill('延续品牌配色和真实产品资料，手机阅读舒适。'); await avoided.fill('避免拥挤首屏和夸张动效。');
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/design-guidance' && response.request().method() === 'PATCH');
    await textButton(drawer, '保存设计约定').click(); expect((await savedResponse).status()).toBe(200); await expect(drawer).toContainText('设计约定已保存');
    expect(await api(control, '/api/studio')).toEqual(before); expect(await api(control, '/api/ai/provider')).toEqual(provider);
    for (const width of [375, 390]) { await page.setViewportSize({ width, height: 844 }); await noOverflow(page, drawer); await testInfo.attach(`design-guidance-mobile-${width}`, { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }); }
    await drawer.locator('.ant-drawer-close').click(); await expect(drawer).toBeHidden();
    await textButton(page, 'AI设计约定').click(); await expect(style).toHaveValue('UI 设计约定：专业、清楚、采购导向，产品图片突出。');
    await avoided.fill('UI 尚未保存：不要重新安排已经确认的图文顺序。');
    // 真正点击浏览器返回触发路由保护；取消离开后抽屉及输入都必须仍在，不能先被Provider卸载。
    const guard = page.getByRole('dialog', { name: '未保存 · AI设计约定', exact: true });
    await page.goBack(); await expect(guard).toBeVisible();
    await textButton(guard, '继续编辑').click(); await expect(avoided).toHaveValue('UI 尚未保存：不要重新安排已经确认的图文顺序。');
    await expect(drawer).toBeVisible(); await expect(page).toHaveURL(/#global-design$/);
    await drawer.locator('.ant-drawer-close').click(); await textButton(guard, '保留输入并离开').click(); await expect(drawer).toBeHidden();
    await page.reload(); await expect(drawer).toBeVisible(); await expect(avoided).toHaveValue('UI 尚未保存：不要重新安排已经确认的图文顺序。');
    // 另一维护者先保存，浏览器仍真实提交旧版本；只有这一次明确409可作为预期资源错误。
    const server = await api<AiDesignGuidance>(control, '/api/ai/design-guidance');
    await api(control, '/api/ai/design-guidance', 'PATCH', { ...inputOf(server), avoidStyles: 'UI 另一维护者保存的约定。' });
    ui.expectHttpError('PATCH', '/api/ai/design-guidance', 409);
    const conflict = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/design-guidance' && response.request().method() === 'PATCH');
    await textButton(drawer, '保存设计约定').click(); expect((await conflict).status()).toBe(409); await expect(drawer).toContainText('设计约定操作未完成');
    await expect(avoided).toHaveValue('UI 尚未保存：不要重新安排已经确认的图文顺序。');
    await textButton(drawer, '读取最新版本').click(); await expect(drawer).toContainText('当前输入仍保留'); await expect(avoided).toHaveValue('UI 尚未保存：不要重新安排已经确认的图文顺序。');
    await drawer.getByText(/对照服务器已保存的内容/).click(); await expect(drawer).toContainText('UI 另一维护者保存的约定。');
    await drawer.locator('.ant-drawer-close').click(); await textButton(guard, '放弃修改').click(); await expect(drawer).toBeHidden();
    await textButton(page, 'AI设计约定').click(); await expect(avoided).toHaveValue('UI 另一维护者保存的约定。');
    await drawer.locator('.ant-drawer-close').click(); await expect(drawer).toBeHidden();
    expect(await api(control, '/api/studio')).toEqual(before); expect(await api(control, '/api/ai/provider')).toEqual(provider);
    expect(ui.writes).toEqual([{ method: 'PATCH', path: '/api/ai/design-guidance' }, { method: 'PATCH', path: '/api/ai/design-guidance' }]);
  } finally {
    await ui.closeOwnedPage(); const latest = await api<AiDesignGuidance>(control, '/api/ai/design-guidance'); await api(control, '/api/ai/design-guidance', 'PATCH', { ...inputOf(original), expectedRevision: latest.revision }); await control.dispose();
  }
});

test('记住这次设计要求先确认截取并编辑保存，不生成网站或改变原要求', async ({ page, ui }, testInfo) => {
  test.setTimeout(70000); page.setDefaultTimeout(10000); ui.allowWrite('PATCH', '/api/ai/design-guidance');
  const control = await controlContext(), before = await api(control, '/api/studio'), provider = await api(control, '/api/ai/provider'), original = await api<AiDesignGuidance>(control, '/api/ai/design-guidance');
  try {
    await page.goto('/admin#global-design'); await expect(page.getByRole('heading', { name: '全站设计', exact: true })).toBeVisible(); await textButton(page, 'AI设计整个网站').click();
    const dialog = page.getByRole('dialog', { name: 'AI整站设计', exact: true }), instruction = dialog.getByRole('textbox', { name: 'AI整站设计要求', exact: true });
    const long = 'UI 长要求：保留已经确认的设计，手机清楚展示产品。'.repeat(28); expect(long.length).toBeGreaterThan(600);
    await instruction.fill(long); await textButton(dialog, '记住这次要求').click();
    const confirm = page.getByRole('dialog', { name: '这次要求较长，先带入前600字？', exact: true }); await expect(confirm).toContainText(`当前有${long.length}字`); await textButton(confirm, '先不记住').click();
    await expect(page.getByRole('dialog', { name: 'AI设计约定', exact: true })).toHaveCount(0); expect(ui.writes).toEqual([]); await expect(instruction).toHaveValue(long);
    await textButton(dialog, '记住这次要求').click(); await textButton(confirm, '带入前600字再核对').click();
    const drawer = page.getByRole('dialog', { name: 'AI设计约定', exact: true }), feedback = drawer.getByRole('textbox', { name: '设计意见1', exact: true });
    await expect(feedback).toHaveValue(long.slice(0, 600)); expect(ui.writes).toEqual([]);
    await feedback.fill('UI 已核对的长期意见：保留满意的布局，后续优先改不合适的部分。');
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, drawer); await testInfo.attach('design-guidance-remember-mobile', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    await textButton(drawer, '保存设计约定').click(); await expect(drawer).toContainText('设计约定已保存');
    const saved = await api<AiDesignGuidance>(control, '/api/ai/design-guidance'); expect(saved.feedback.map(item => item.text)).toEqual(['UI 已核对的长期意见：保留满意的布局，后续优先改不合适的部分。']);
    await drawer.locator('.ant-drawer-close').click(); await expect(drawer).toBeHidden(); await expect(instruction).toHaveValue(long);
    expect(await api(control, '/api/studio')).toEqual(before); expect(await api(control, '/api/ai/provider')).toEqual(provider);
    expect(ui.writes).toEqual([{ method: 'PATCH', path: '/api/ai/design-guidance' }]);
  } finally { await ui.closeOwnedPage(); const latest = await api<AiDesignGuidance>(control, '/api/ai/design-guidance'); await api(control, '/api/ai/design-guidance', 'PATCH', { ...inputOf(original), expectedRevision: latest.revision }); await control.dispose(); }
});

test.describe('只读设计约定', () => {
  test.use({ storageState: runtime.viewerAuth });
  test('只读成员不显示约定入口，不读取或修改私有参考', async ({ page, ui }) => {
    const requests: string[] = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/ai/design-guidance') requests.push(request.method()); });
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/admin#global-design'); await expect(page.getByRole('heading', { name: '全站设计', exact: true })).toBeVisible();
    await expect(textButton(page, 'AI设计约定')).toHaveCount(0); await expect(textButton(page, '记住这次要求')).toHaveCount(0); await noOverflow(page); expect(requests).toEqual([]); expect(ui.writes).toEqual([]);
  });
});
