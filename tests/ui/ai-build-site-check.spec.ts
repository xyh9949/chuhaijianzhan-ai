import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { AiBuildSiteCheckReport } from '../../src/lib/ai-build-site-check-types';
import type { AiBuildPreviewRun } from '../../src/lib/ai-build-resume-types';
import type { AiVisualCapture } from '../../src/lib/ai-visual-types';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import { aiBuilderHttpPlan } from '../ai-builder-http';
import { test, expect, runtime, noOverflow, textButton } from './fixtures';

async function api<T>(client: APIRequestContext, path: string, data?: unknown) {
  const result = await client.fetch(`${runtime.origin}${path}`, { method: data === undefined ? 'GET' : 'POST', ...(data === undefined ? {} : { data }) });
  expect(result.ok(), `${path} ${result.status()}: ${await result.text()}`).toBe(true);
  return result.json() as Promise<T>;
}

test('首次建站用真实预览检查手机询盘，并能打开截图和设备预览', async ({ page, ui }, testInfo) => {
  test.setTimeout(145000);
  const options = { extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 20000, maxRedirects: 0 };
  const control = await playwrightRequest.newContext({ ...options, storageState: runtime.adminAuth });
  const viewer = await playwrightRequest.newContext({ ...options, storageState: runtime.viewerAuth });
  const anonymous = await playwrightRequest.newContext({ ...options, storageState: { cookies: [], origins: [] } });
  try {
    const origin = new URL(runtime.origin); expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200'); expect(runtime.dataDirectory).toBeTruthy();
    const provider = await api<{ enabled: boolean; hasApiKey: boolean }>(control, '/api/ai/provider');
    expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
    const session = await api<{ user: { id: string } }>(control, '/api/auth/get-session');
    const before = await api<StudioEnvelope>(control, '/api/studio'), planId = `aip-${randomUUID()}`;
    // 只在隔离数据库播种纯文本方案，由生产接口实际编译并打开冻结预览，无模型调用。
    const brief = { companyName: 'Synthetic catalog', description: 'Fictional product information for checking the native inquiry path.', industry: 'Furniture', audience: 'Project buyers', market: 'Global', language: 'en', styleNotes: '' };
    const selectedProductIds = before.state.products.slice(0, 2).map(product => product.id);
    const plan = aiBuilderHttpPlan(), homeSection = plan.pages[0].sections[0];
    homeSection.cta = { label: 'Request project details', pageKey: 'contact' };
    const db = new Database(join(runtime.dataDirectory!, 'studio.sqlite'), { fileMustExist: true });
    try {
      db.prepare('INSERT INTO cms_ai_build(id,actor_id,kind,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(planId, session.user.id, 'plan', before.revision, JSON.stringify({ brief, plan, selectedProductIds }), new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 600_000).toISOString());
    } finally { db.close(); }
    const preview = await api<AiBuildPreviewRun>(control, '/api/ai/build/preview', { planId, directionId: 'editorial', prefix: '/first-build-check' });
    const body = { previewId: preview.previewId };
    const route = `${runtime.origin}/api/ai/build/check`;
    for (const [client, headers, status] of [[anonymous, {}, 401], [viewer, {}, 403], [control, { Origin: 'https://off-site.invalid' }, 403]] as const) {
      expect((await client.post(route, { data: body, headers })).status()).toBe(status);
    }
    ui.allowWrite('POST', '/api/ai/build/check');
    ui.allowWrite('POST', '/api/ai/visual/captures');
    await page.goto('/admin#templates');
    await textButton(page, '继续之前的建站').click();
    const restore = page.getByRole('dialog', { name: '继续之前的建站', exact: true });
    await textButton(restore, '读取预览').first().click();
    await expect(page.getByText('整站检查', { exact: true })).toBeVisible();

    const checkRequest = page.waitForResponse(response => response.url() === route && response.request().method() === 'POST', { timeout: 110000 });
    await textButton(page, '检查整站').click();
    const response = await checkRequest;
    expect(response.ok(), await response.text()).toBe(true);
    const report = await response.json() as AiBuildSiteCheckReport;
    expect(report.previewId).toBe(preview.previewId); expect(report.baseRevision).toBe(before.revision);
    expect(report.pageLimit).toBe(12);
    expect(report.languages).toContainEqual({ code: 'en', notSampled: expect.any(Number) });
    expect(report.pages.filter(item => !item.dynamic).map(item => item.path)).toEqual(expect.arrayContaining(['/first-build-check', '/first-build-check/products', '/first-build-check/contact']));
    for (const item of report.pages.filter(item => !item.dynamic)) expect(item.mobile.map(result => result.width)).toEqual([390, 375]);
    const home = report.pages.find(item => item.path === '/first-build-check')!;
    expect(report.journeys.find(journey => journey.entry === 'home')).toMatchObject({ status: 'checked', steps: [{ from: '/first-build-check', to: '/first-build-check/contact' }], form: { path: '/first-build-check/contact', unlabelled: 0 } });
    await expect(page.getByText('首页询盘路径', { exact: true })).toBeVisible();
    await expect(page.getByText('已在手机预览中实际点击至原生询盘表单。', { exact: true }).first()).toBeVisible();
    await page.getByText('逐页手机检查', { exact: true }).click();
    const homeRow = page.locator('.ant-list-item').filter({ has: page.getByText(home.path!, { exact: true }) });
    await textButton(homeRow, '查看手机').click();
    const dialog = page.getByRole('dialog', { name: '生成网站的私有预览', exact: true });
    await expect(dialog.locator('iframe[title="AI生成网站预览"]')).toHaveCSS('width', '390px');
    const actual = dialog.frameLocator('iframe[title="AI生成网站预览"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(actual.getByRole('heading', { name: 'Synthetic AI HTTP factory', level: 1 })).toBeVisible();
    await textButton(dialog, '关闭预览').click();
    await page.getByText('让AI看看实际页面（可选）', { exact: true }).click();
    const captureRequest = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/visual/captures' && response.request().method() === 'POST', { timeout: 60000 });
    await textButton(page, '生成真实截图').click();
    const captureResponse = await captureRequest; expect(captureResponse.ok(), await captureResponse.text()).toBe(true);
    const capture = await captureResponse.json() as AiVisualCapture;
    expect(capture.target).toMatchObject({ kind: 'site-build', id: preview.previewId });
    expect(capture.images.some(image => image.device === 'mobile')).toBe(true);
    await expect(textButton(page, '发送所选截图检查')).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: '我已核对，允许将勾选截图和本次要求发送给自配AI' })).not.toBeChecked();
    expect(await api<StudioEnvelope>(control, '/api/studio')).toEqual(before);
    expect(ui.writes).toEqual([{ method: 'POST', path: '/api/ai/build/check' }, { method: 'POST', path: '/api/ai/visual/captures' }]);
    await page.setViewportSize({ width: 390, height: 1000 }); await noOverflow(page);
    await testInfo.attach('first-build-check-report', { body: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json' });
  } finally {
    await ui.closeOwnedPage(); await anonymous.dispose(); await viewer.dispose(); await control.dispose();
  }
});
