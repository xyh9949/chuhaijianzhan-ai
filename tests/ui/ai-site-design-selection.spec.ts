import { test, expect, runtime, go, select, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiSiteDesignPreview, AiSiteDesignRequest } from '../../src/lib/ai-site-design-types';

const aboutId = 'ui-selection-about';
const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'AI整站设计', exact: true });
const quote = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 控制通道只使用包装器的合成实例；失败不回显SDK或Playwright携带的认证头。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  const origin = new URL(runtime.origin); expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Only isolated API paths are allowed');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated API ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}
async function sdk<T>(label: string, work: () => Promise<T>): Promise<T> { try { return await work(); } catch { throw new Error(`Isolated MCP ${label} failed`); } }
async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await sdk(name, () => client.callTool({ name, arguments: args })); expect(result.isError, `${name} should succeed`).not.toBe(true);
  return (result.structuredContent || JSON.parse((result.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text)) as T;
}
function pageData(prefix: string, title: string): Data {
  return { root: { props: { title, brand: '', showChrome: 'yes' } }, zones: {}, content: [
    { type: 'Heading', props: { id: `${prefix}-title`, text: title, level: 'h1', size: 36, mobileSize: 28, style: 'sans', align: 'left', spacing: 0 } },
    { type: 'Text', props: { id: `${prefix}-body`, text: 'Synthetic saved content for selection verification.', size: 16, align: 'left', maxWidth: 680 } },
  ] } as Data;
}

test('整站方案选择范围后真实预览、保留本地输入、确认及原生编辑撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(150000); page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  const client = new Client({ name: 'selection-ui', version: '1' });
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<{ enabled: boolean; hasApiKey: boolean }>(control, '/api/ai/provider');
  const home = original.state.pages.find(item => item.slug === '/')!; expect(home).toBeTruthy();
  expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
  let seeded = false, tokenId = '', bodyFailure: unknown; const candidates: string[] = [];
  for (const [method, path] of [['POST', '/api/ai/site-designs/select'], ['POST', '/api/ai/site-designs/apply'], ['POST', '/api/ai/site-designs/undo'], ['PATCH', '/api/studio']] as const) ui.allowWrite(method, path);
  try {
    const baseline = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: {
      pages: [...original.state.pages, { id: aboutId, title: 'Selection about', slug: '/selection-about', locale: 'en', status: 'draft', type: '普通页面', updated: '' }],
      editorData: { ...original.state.editorData, [home.id]: pageData('selection-home', 'Original selection home'), [aboutId]: pageData('selection-about', 'Original selection about') },
      siteLayout: { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: original.state.siteLayout?.menus || [] },
    } }); seeded = true;
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI selection designer', scopes: ['read', 'propose'], pageIds: null }); tokenId = credential.credential.id;
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const input: AiSiteDesignRequest = { expectedRevision: baseline.revision, instruction: '准备多页、头尾和风格方案，供用户选择只采用页眉。', targets: { pageIds: baseline.state.pages.map(item => item.id), header: true, footer: true, navigation: true, style: true }, preserveText: false };
    const context = await tool<{ request: AiSiteDesignRequest; context: { chrome: { header: { nodes: { id: string; type: string }[] } } } }>(client, 'site_design_context', input as unknown as Record<string, unknown>);
    const headerId = context.context.chrome.header.nodes.find(item => item.type === 'Container')!.id;
    const source = await tool<AiSiteDesignPreview>(client, 'site_design_propose', { requestId: 'ui-select-source', request: context.request, proposal: { summary: 'UI selection source proposal', operations: [
      { kind: 'page', pageId: home.id, operations: [{ kind: 'text', id: 'selection-home-title', text: 'Changed selection home' }] },
      { kind: 'page', pageId: aboutId, operations: [{ kind: 'text', id: 'selection-about-title', text: 'Changed selection about' }] },
      { kind: 'chrome', slot: 'header', operations: [{ kind: 'design', id: headerId, design: { desktop: { paddingTop: 32, paddingBottom: 32 }, mobile: { paddingTop: 20 } } }] },
      { kind: 'navigation', slot: 'header', items: [{ label: 'Home', pageId: home.id }, { label: 'Selection about', pageId: aboutId }] },
      { kind: 'chrome', slot: 'footer', operations: [] },
      { kind: 'theme', theme: { primary: baseline.state.theme.primary === '#244c77' ? '#355c88' : '#244c77', radius: 9 } },
    ], warnings: [] } }); candidates.push(source.designId);
    expect(source.selectionUnits.map(item => item.id)).toEqual(expect.arrayContaining([`page:${home.id}`, `page:${aboutId}`, 'header', 'footer', 'style']));
    const review = await tool<{ reviewUrl: string }>(client, 'site_design_review', { designId: source.designId, action: 'apply' });
    await page.goto(review.reviewUrl); let dialog = dialogOf(page); await expect(dialog).toBeVisible();
    await select(page, '整站设计预览页面', `${home.title} · ${home.slug}`);
    let afterFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(afterFrame.getByRole('heading', { name: 'Changed selection home', exact: true })).toBeVisible();
    const pendingRequirement = 'Keep this new request until I choose to use it', pendingFollowup = 'Keep this follow-up while I choose which areas to accept';
    await dialog.getByRole('textbox', { name: '继续整站设计要求', exact: true }).fill(pendingFollowup);
    await dialog.getByRole('tab', { name: '描述整站想法', exact: true }).click(); await dialog.getByRole('textbox', { name: 'AI整站设计要求', exact: true }).fill(pendingRequirement);
    await dialog.getByRole('tab', { name: '逐页看效果与继续调整', exact: true }).click();
    await dialog.getByText(/^只采用部分修改/).click();
    await dialog.getByRole('checkbox', { name: '选择全部修改', exact: true }).uncheck();
    const headerUnit = source.selectionUnits.find(item => item.id === 'header')!;
    await dialog.locator('.ai-site-design-selection-units').getByRole('checkbox', { name: new RegExp(`^${quote(headerUnit.label)}`) }).check();
    await expect(textButton(dialog, '确认应用到网站草稿')).toBeDisabled(); await expect(dialog.getByText('采用范围已改变，当前仍显示上一版预览', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog);
    await testInfo.attach('selection-mobile-choices', { body: await dialog.locator('.ai-site-design-selection').screenshot({ animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 });
    // 实际保留/刷新恢复未提交的范围、要求与追问，不能只在同一组件内存里保留。
    await textButton(dialog, '返回后台').click(); const guard = page.getByRole('dialog', { name: '未保存 · AI整站设计要求', exact: true });
    await textButton(guard, '保留输入并离开').click(); await expect(dialog).not.toBeVisible(); await page.reload(); dialog = dialogOf(page); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: '继续整站设计要求', exact: true })).toHaveValue(pendingFollowup);
    await dialog.getByText(/^只采用部分修改/).click();
    await expect(dialog.locator('.ai-site-design-selection-units').getByRole('checkbox', { checked: true })).toHaveCount(1);
    const selectedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/site-designs/select' && response.request().method() === 'POST');
    await textButton(dialog, '预览选中修改').click(); const selectedHttp = await selectedResponse; expect(selectedHttp.status()).toBe(201); const selected = await selectedHttp.json() as AiSiteDesignPreview; candidates.push(selected.designId);
    expect(selected.selection).toEqual({ sourceDesignId: source.designId, unitIds: ['header'] }); expect(selected.selectionUnits.map(item => item.id)).toEqual(['header']);
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(baseline.revision);
    await expect(dialog.getByText('当前预览只包含已选择的修改', { exact: true })).toBeVisible(); await expect(dialog.getByRole('textbox', { name: '继续整站设计要求', exact: true })).toHaveValue(pendingFollowup);
    await dialog.getByRole('tab', { name: '描述整站想法', exact: true }).click(); const description = dialog.getByRole('textbox', { name: 'AI整站设计要求', exact: true }); await expect(description).toHaveValue(pendingRequirement); await description.fill('');
    await dialog.getByRole('tab', { name: '逐页看效果与继续调整', exact: true }).click(); await textButton(dialog, '保留当前方案').click();
    afterFrame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    const beforeFrame = dialog.frameLocator('iframe[title="修改前"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(beforeFrame.getByRole('heading', { name: 'Original selection home', exact: true })).toBeVisible(); await expect(afterFrame.getByRole('heading', { name: 'Original selection home', exact: true })).toBeVisible();
    await expect(afterFrame.locator('header.editor-site-shared-header')).toBeVisible(); await expect(afterFrame.locator('footer.editor-site-shared-footer')).toHaveCount(0);
    await testInfo.attach('selection-selected-header-real-after', { body: await dialog.locator('iframe[title="AI建议"]').screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog); await testInfo.attach('selection-mobile-real-preview', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(textButton(dialog, '确认应用到网站草稿')).toBeEnabled(); await textButton(dialog, '确认应用到网站草稿').click(); await expect(dialog).toContainText('已应用到网站草稿');
    const applied = await api<StudioEnvelope>(control, '/api/studio'); expect(applied.state.editorData).toEqual(baseline.state.editorData); expect(applied.state.theme).toEqual(baseline.state.theme); expect(applied.state.siteLayout?.footer).toEqual(baseline.state.siteLayout?.footer); expect(applied.activeReleaseId).toBe(baseline.activeReleaseId);
    const block = applied.state.sharedBlocks!.find(item => item.id === applied.state.siteLayout?.header.blockId)!; expect(block).toBeTruthy();
    await textButton(dialog, '拖拽编辑页眉').click(); await expect(page.locator('.editor-screen')).toBeVisible(); await expect(page.locator('.editor-topbar')).toContainText(block.name);
    await page.getByRole('button', { name: '返回页面管理', exact: true }).click(); await expect(page.getByRole('heading', { name: '全站设计', exact: true })).toBeVisible();
    expect((await api<StudioEnvelope>(control, '/api/studio')).state.sharedBlocks?.find(item => item.id === block.id)?.data).toEqual(block.data);
    await page.getByRole('button', { name: 'AI设计整个网站', exact: true }).click(); dialog = dialogOf(page); await dialog.getByRole('tab', { name: '设计记录', exact: true }).click(); await dialog.locator('.ant-list-item').filter({ hasText: selected.summary }).first().getByRole('button', { name: '查看方案', exact: true }).click();
    for (const side of ['修改前', 'AI建议']) await expect(dialog.frameLocator(`iframe[title="${side}"]`).frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: 'Original selection home', exact: true })).toBeVisible();
    await textButton(dialog, '撤销本次整站设计').click(); await expect(dialog).toContainText('已撤销本次整站设计');
    const undone = await api<StudioEnvelope>(control, '/api/studio'); expect(undone.state.editorData).toEqual(baseline.state.editorData); expect(undone.state.siteLayout).toEqual(baseline.state.siteLayout); expect(undone.state.theme).toEqual(baseline.state.theme); expect(undone.state.sharedBlocks || []).toEqual(baseline.state.sharedBlocks || []);
    expect((await tool<{ status: string }>(client, 'site_design_status', { designId: source.designId })).status).toBe('pending'); expect((await tool<{ status: string }>(client, 'site_design_status', { designId: selected.designId })).status).toBe('undone');
    expect(await api(control, '/api/ai/provider')).toEqual(provider); expect(ui.writes.filter(item => item.path === '/api/ai/site-designs')).toHaveLength(0); expect(ui.writes.filter(item => item.path === '/api/ai/site-designs/select')).toHaveLength(1);
  } catch (error) { bodyFailure = error; throw error; }
  finally {
    const errors: string[] = [];
    try { await ui.closeOwnedPage(); } catch { errors.push('close-owned-page'); }
    try { await sdk('close', () => client.close()); } catch { errors.push('close-client'); }
    for (const id of candidates.reverse()) try { await api(control, `/api/ai/site-designs/${id}`, 'DELETE'); } catch { errors.push('delete-candidate'); }
    if (tokenId) try { await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); } catch { errors.push('revoke-token'); }
    if (seeded) try { const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, theme: original.state.theme, siteLayout: original.state.siteLayout, sharedBlocks: original.state.sharedBlocks || [] } }); } catch { errors.push('restore-isolated-state'); }
    await testInfo.attach('selection-cleanup', { body: Buffer.from(JSON.stringify({ errors, usedIndependentApiContext: true })), contentType: 'application/json' }); await control.dispose();
    if (!bodyFailure && errors.length) throw new Error(`Isolated selection cleanup failed: ${errors.join(',')}`);
  }
});
