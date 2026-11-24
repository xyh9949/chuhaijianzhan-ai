import { test, expect, runtime, go, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Data } from '@puckeditor/core';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiSiteDesignRequest } from '../../src/lib/ai-site-design-types';
import type { ExternalAiDesignView } from '../../src/server/external-ai-design';
import type { ExternalAiTokenSummary } from '../../src/server/external-ai-tokens';

type Credential = { credential: ExternalAiTokenSummary; token: string };
type Context = { request: AiSiteDesignRequest; context: { chrome: { header: { nodes: { id: string; type: string }[] }; footer: { nodes: { id: string; type: string }[] } } } };
async function api<T>(control: APIRequestContext, path: string, method: 'GET' | 'PATCH' | 'DELETE' = 'GET', data?: unknown): Promise<T> {
  const origin = new URL(runtime.origin); expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Only isolated API paths are allowed');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, ...(data === undefined ? {} : { data }) }).catch(cause => {
    // 控制通道异常只记固定类别，避免Playwright把临时认证请求头写入公共失败报告。
    const category = cause instanceof Error ? cause.message.match(/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND)\b/)?.[0] || 'request failed' : 'request failed';
    throw new Error(`Isolated API ${method} ${path}: ${category}`);
  });
  expect(response.ok(), `Isolated API status ${method} ${path}: ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}
async function mcp<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await sdkCall(name, () => client.callTool({ name, arguments: args }));
  expect(result.isError, `${name} should return a checked result`).not.toBe(true);
  return (result.structuredContent || JSON.parse((result.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text)) as T;
}
async function sdkCall<T>(label: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (cause) {
    // SDK错误也可能携带Bearer请求细节；仅保留静态动作名及数字/固定传输类别。
    const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'number' && Number.isFinite(cause.code) ? String(cause.code) : undefined;
    const category = cause instanceof Error ? cause.message.match(/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND)\b/)?.[0] || (cause.name === 'TimeoutError' ? 'TimeoutError' : 'request failed') : 'request failed';
    throw new Error(`Isolated MCP ${label}: ${code || category}`);
  }
}
/** 权限范围以真实键盘输入选择；先确认过滤及活动项，再Enter，避免依赖弹层变化期间的坐标。
 * 这验证原生可达交互，不把间歇性指针现象写成已修复，也不绕过Form或服务端scope校验。 */
async function selectWithKeyboard(page: Page, label: string, value: string) {
  const input = page.getByRole('combobox', { name: label, exact: true });
  await input.click(); await input.fill(value);
  const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
  await expect(options).toHaveCount(1); await expect(options).toHaveAttribute('title', value);
  await expect(options).toHaveClass(/ant-select-item-option-active/); await input.press('Enter');
}
const designModal = (page: Page) => page.getByRole('dialog', { name: 'AI整站设计', exact: true });
function pageContent(): Data {
  return { root: { props: { title: 'External AI UI', brand: '', showChrome: 'yes' } }, zones: {}, content: [
    { type: 'Container', props: { id: 'external-ui-section', layout: 'column', gap: 24, padding: 40, inset: 24, minHeight: 0, image: '', background: 'transparent', align: 'start', content: [
      { type: 'Heading', props: { id: 'external-ui-heading', text: 'External design preview', level: 'h1', size: 38, mobileSize: 28, style: 'sans', align: 'left', spacing: 0 } },
      { type: 'Text', props: { id: 'external-ui-text', text: 'Synthetic content for native website design testing.', size: 16, align: 'left', maxWidth: 680 } },
    ] } },
  ] } as Data;
}

test('外部AI连接一次密钥、范围撤销及无站内模型的真实审核拖拽闭环', async ({ page, ui }, testInfo) => {
  test.setTimeout(150000); page.setDefaultTimeout(10000);
  const origin = new URL(runtime.origin); expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 10000 });
  try {
  const credentials: Credential[] = []; let seeded = false, client: Client | undefined, bodyError: unknown;
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const provider = await api<{ enabled: boolean; hasApiKey: boolean }>(control, '/api/ai/provider');
  expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
  const home = original.state.pages.find(item => item.slug === '/'); expect(home).toBeTruthy();
  ui.allowWrite('PATCH', '/api/studio'); ui.allowWrite('POST', '/api/external-ai/tokens'); ui.allowWrite('POST', '/api/ai/site-designs/apply'); ui.allowWrite('POST', '/api/ai/site-designs/undo');
  try {
    const baseline = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { editorData: { ...original.state.editorData, [home!.id]: pageContent() }, siteLayout: { header: { ...original.state.siteLayout?.header, mode: 'default', blockId: '' }, footer: { ...original.state.siteLayout?.footer, mode: 'default', blockId: '' }, menus: original.state.siteLayout?.menus || [] } } }); seeded = true;
    await go(page, 'settings'); await page.getByRole('tab').filter({ hasText: 'AI服务' }).click(); await page.getByRole('tab', { name: '外部AI连接', exact: true }).click();
    await expect(page.getByText('让你自己的AI帮助设计和写内容', { exact: true })).toBeVisible();
    async function createConnection(name: string, scoped: boolean, allowContentAndSeo = false) {
      await page.getByRole('button', { name: '创建AI连接', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '创建AI连接', exact: true });
      await expect(dialog).toBeVisible();
      await testInfo.attach('external-connection-form-labels', { body: Buffer.from(JSON.stringify(await dialog.locator('label').evaluateAll(labels => labels.map(label => ({ text: label.textContent, requiredMark: getComputedStyle(label, '::before').content }))))), contentType: 'application/json' });
      const nameInput = dialog.getByLabel('连接名称', { exact: true });
      expect(await nameInput.evaluate(element => element instanceof HTMLInputElement && Array.from(element.labels || []).some(label => label.textContent === '连接名称') && element.ownerDocument.querySelectorAll(`[id="${element.id}"]`).length === 1), '原生label应唯一关联当前弹窗字段').toBe(true);
      await nameInput.fill(name);
      const contentPermission = dialog.getByRole('checkbox', { name: '读取并创作文章、产品文案', exact: true }), seoPermission = dialog.getByRole('checkbox', { name: '读取并提交搜索优化建议', exact: true });
      await expect(contentPermission).not.toBeChecked(); await expect(seoPermission).not.toBeChecked();
      if (allowContentAndSeo) {
        // 新权限必须经真实表单勾选；空的内容选择仍应保持拒绝，不能隐式授权整类记录。
        await contentPermission.check(); await seoPermission.check();
        await dialog.getByRole('radio', { name: '指定记录', exact: true }).check();
        await selectWithKeyboard(page, '外部AI可访问产品', original.state.products[1].name);
        await expect(dialog.locator('.ant-select-selection-item').filter({ hasText: original.state.products[1].name })).toBeVisible();
        await page.keyboard.press('Escape');
      }
      if (scoped) {
        await dialog.getByRole('checkbox', { name: '生成可预览的设计方案', exact: true }).uncheck(); await dialog.getByRole('radio', { name: '指定页面', exact: true }).check();
        await selectWithKeyboard(page, '外部AI可访问页面', `${home!.title} · ${home!.slug}`);
        // 先确认用户能看见所选范围，再关闭选单；避免只凭click完成就假设选择已提交。
        const selectedPage = dialog.locator('.ant-select-selection-item').filter({ hasText: `${home!.title} · ${home!.slug}` });
        await expect(selectedPage).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(selectedPage).toBeVisible();
      }
      if (allowContentAndSeo) await testInfo.attach('external-connection-explicit-permissions', { body: await dialog.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
      const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/external-ai/tokens' && item.request().method() === 'POST');
      await textButton(dialog, '创建连接').click(); const http = await response; expect(http.status()).toBe(201); const value = await http.json() as Credential; credentials.push(value);
      const secret = page.getByRole('dialog', { name: '保存你的连接密钥', exact: true }); await expect(secret).toContainText('仅显示这一次');
      expect(await secret.getByLabel('新创建的外部AI连接密钥').inputValue() === value.token, '一次显示应为刚创建的密钥').toBe(true);
      expect(await page.evaluate(() => [localStorage, sessionStorage].some(storage => Object.keys(storage).some(key => /fsai_[A-Za-z0-9_-]{43}/.test(storage.getItem(key) || '')))), '密钥不能进入任何浏览器恢复存储').toBe(false);
      await textButton(secret, '我已保存，关闭').click(); await expect(page.getByLabel('新创建的外部AI连接密钥')).toHaveCount(0);
      const listed = await api<{ items: ExternalAiTokenSummary[] }>(control, '/api/external-ai/tokens'); expect(JSON.stringify(listed).includes(value.token), '列表不能返回明文密钥').toBe(false);
      return value;
    }
    const reader = await createConnection('UI scoped reader', true);
    expect(reader.credential.scopes).toEqual(['read']); expect(reader.credential.pageIds).toEqual([home!.id]);
    expect(reader.credential.recordIds).toEqual({ productIds: [], entryIds: [] });
    const readerRow = page.locator('.ant-list-item').filter({ hasText: reader.credential.name }); await expect(readerRow).toContainText('1 个指定页面'); await expect(readerRow).not.toContainText('生成设计方案');
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByText('只支持本地命令的客户端（可选）', { exact: true }).click();
    const environmentLabel = page.getByText('FORM_STUDIO_MCP_TOKEN', { exact: true }); await environmentLabel.scrollIntoViewIfNeeded();
    await expect.poll(() => environmentLabel.evaluate(element => { const bounds = element.getBoundingClientRect(), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); return element === hit || element.contains(hit); })).toBe(true);
    await noOverflow(page); await page.evaluate(() => window.scrollTo(0, 0));
    await testInfo.attach('external-ai-settings-mobile', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }); await page.setViewportSize({ width: 1600, height: 1000 });
    ui.allowWrite('DELETE', `/api/external-ai/tokens/${reader.credential.id}`);
    await textButton(readerRow, '撤销连接').click(); const revoke = page.getByRole('dialog', { name: `撤销「${reader.credential.name}」连接？`, exact: true }); await textButton(revoke, '撤销连接').click(); await expect(readerRow).toContainText('已撤销');
    const designer = await createConnection('UI external designer', false, true);
    expect(designer.credential.scopes).toEqual(['read', 'propose', 'content:read', 'content:propose', 'seo:read', 'seo:propose']); expect(designer.credential.pageIds).toBe(null);
    expect(designer.credential.recordIds).toEqual({ productIds: [original.state.products[1].id], entryIds: [] });
    const designerRow = page.locator('.ant-list-item').filter({ hasText: designer.credential.name });
    await expect(designerRow).toContainText('文章与产品创作'); await expect(designerRow).toContainText('搜索优化');
    await expect(designerRow).toContainText('产品：1 条指定记录 · 内容：0 条指定记录');
    client = new Client({ name: 'form-studio-ui-verifier', version: '1.0.0' });
    await sdkCall('connect', () => client!.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Authorization: `Bearer ${designer.token}`, Origin: runtime.origin, Connection: 'close' } } })));
    const discovered = await sdkCall('listTools', () => client!.listTools()); expect(discovered.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['site_overview', 'site_capabilities', 'site_design_context', 'site_design_propose', 'site_design_status', 'site_design_review']));
    const overview = await mcp<{ revision: number }>(client, 'site_overview', {});
    const input: AiSiteDesignRequest = { expectedRevision: overview.revision, instruction: '统一原生页眉页脚和手机层级，保留真实企业资料，用真实预览核对。', preserveText: false, targets: { pageIds: baseline.state.pages.map(item => item.id), header: true, footer: true, navigation: true, style: true } };
    const prepared = await mcp<Context>(client, 'site_design_context', input as unknown as Record<string, unknown>);
    const container = (slot: 'header' | 'footer', context: Context) => { const id = context.context.chrome[slot].nodes.find(node => node.type === 'Container')?.id; expect(id).toBeTruthy(); return id!; };
    const first = await mcp<ExternalAiDesignView>(client, 'site_design_propose', { requestId: 'ui-external-design-initial', request: prepared.request, proposal: { summary: 'UI external whole site design', intent: { goal: '清楚展示企业并方便移动浏览', decisions: ['统一原生头尾和字体层级'], preserve: ['真实企业资料'], assumptions: [] }, operations: [
      { kind: 'chrome', slot: 'header', operations: [{ kind: 'design', id: container('header', prepared), design: { desktop: { paddingTop: 28, paddingBottom: 28 }, mobile: { paddingTop: 16 } } }] },
      { kind: 'chrome', slot: 'footer', operations: [] }, { kind: 'theme', theme: { primary: '#2456a6', font: 'system' } },
      { kind: 'page', pageId: home!.id, operations: [{ kind: 'design', id: 'external-ui-heading', design: { mobile: { fontSize: 26 } } }] },
    ], warnings: [] } });
    const continuedInput = { ...prepared.request, baseDesignId: first.designId, instruction: '保留已满意部分，只让手机页脚更紧凑。' };
    const nextContext = await mcp<Context>(client, 'site_design_context', continuedInput as unknown as Record<string, unknown>);
    const candidate = await mcp<ExternalAiDesignView>(client, 'site_design_propose', { requestId: 'ui-external-design-refined', request: nextContext.request, proposal: { summary: 'UI external refined design', operations: [{ kind: 'chrome', slot: 'footer', operations: [{ kind: 'design', id: container('footer', nextContext), design: { mobile: { paddingTop: 24 } } }] }], warnings: [] } });
    expect(candidate.refinement?.baseDesignId).toBe(first.designId); expect(candidate.status).toBe('pending'); expect(candidate.requiresBrowserConfirmation).toBe(true);
    const beforeApply = await api<StudioEnvelope>(control, '/api/studio'); expect(beforeApply.state.editorData).toEqual(baseline.state.editorData); expect(beforeApply.state.theme).toEqual(baseline.state.theme); expect(beforeApply.state.siteLayout).toEqual(baseline.state.siteLayout);
    const review = await mcp<{ reviewUrl: string }>(client, 'site_design_review', { designId: candidate.designId, action: 'apply' }); expect(new URL(review.reviewUrl).origin).toBe(runtime.origin);
    await go(page, 'global-design'); await page.getByRole('button', { name: 'AI设计整个网站', exact: true }).click();
    const localRequirement = 'UI pending requirement must remain until I choose to leave';
    await designModal(page).getByRole('textbox', { name: 'AI整站设计要求', exact: true }).fill(localRequirement);
    page.once('dialog', async native => { expect(native.type()).toBe('beforeunload'); await native.accept(); });
    await page.goto(review.reviewUrl); let dialog = designModal(page); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'AI整站设计要求', exact: true })).toHaveValue(localRequirement);
    await textButton(dialog, '查看外部AI方案').click(); const localGuard = page.getByRole('dialog', { name: '未保存 · AI整站设计要求', exact: true });
    await textButton(localGuard, '继续编辑').click(); await expect(dialog.getByRole('textbox', { name: 'AI整站设计要求', exact: true })).toHaveValue(localRequirement);
    // 取消审核仍保留原输入；只有本次显式选择放弃后才打开另一候选。
    await textButton(dialog, '查看外部AI方案').click(); await textButton(localGuard, '放弃修改').click(); await expect(dialog).toContainText(candidate.summary);
    await expect(dialog).toContainText('这是外部AI提交的方案，可直接预览和采用');
    await expect(dialog.getByText('使用你自己配置的AI服务', { exact: true })).toHaveCount(0);
    const frame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(frame.getByRole('heading', { name: 'External design preview', exact: true })).toBeVisible(); await expect(frame.locator('header.editor-site-shared-header')).toBeVisible(); await expect(frame.locator('footer.editor-site-shared-footer')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '确认应用到网站草稿', exact: true })).toBeEnabled(); expect(new URL(page.url()).searchParams.has('externalDesign')).toBe(false);
    const stillPending = await api<StudioEnvelope>(control, '/api/studio'); expect(stillPending.revision).toBe(baseline.revision);
    await textButton(dialog, '确认应用到网站草稿').click(); await expect(dialog).toContainText('已应用到网站草稿'); const applied = await api<StudioEnvelope>(control, '/api/studio'); expect(applied.activeReleaseId).toBe(original.activeReleaseId);
    expect((await mcp<ExternalAiDesignView>(client, 'site_design_status', { designId: candidate.designId })).status).toBe('applied');
    // 头尾确实走同一Puck编辑器；无操作往返不能制造撤销冲突。
    for (const [slot, label] of [['header', '页眉'], ['footer', '页脚']] as const) {
      const block = applied.state.sharedBlocks?.find(item => item.id === applied.state.siteLayout?.[slot].blockId); expect(block).toBeTruthy();
      await textButton(dialog, `拖拽编辑${label}`).click(); await expect(page.locator('.editor-screen')).toBeVisible(); await expect(page.locator('.editor-topbar')).toContainText(block!.name);
      await page.getByRole('button', { name: '返回页面管理', exact: true }).click(); await expect(page.getByRole('heading', { name: '全站设计', exact: true })).toBeVisible();
      const visited = await api<StudioEnvelope>(control, '/api/studio'); expect(visited.state.sharedBlocks?.find(item => item.id === block!.id)?.data).toEqual(block!.data);
      await page.goto(review.reviewUrl); dialog = designModal(page); await expect(dialog).toContainText(candidate.summary);
      // 等真实候选完成后再切编辑器，避免把正常卸载造成的document取消当成网络故障。
      for (const title of ['修改前', 'AI建议']) await expect(dialog.frameLocator(`iframe[title="${title}"]`).frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: 'External design preview', exact: true })).toBeVisible();
    }
    await testInfo.attach('external-ai-review-preview', { body: await dialog.locator('iframe[title="AI建议"]').screenshot(), contentType: 'image/png' });
    const undoReview = await mcp<{ reviewUrl: string }>(client, 'site_design_review', { designId: candidate.designId, action: 'undo' }); expect(undoReview.reviewUrl).toBe(review.reviewUrl);
    await textButton(dialog, '撤销本次整站设计').click(); await expect(dialog).toContainText('已撤销本次整站设计');
    const undone = await api<StudioEnvelope>(control, '/api/studio'); expect(undone.state.editorData).toEqual(baseline.state.editorData); expect(undone.state.theme).toEqual(baseline.state.theme); expect(undone.state.siteLayout).toEqual(baseline.state.siteLayout); expect(undone.state.sharedBlocks || []).toEqual(baseline.state.sharedBlocks || []); expect(undone.activeReleaseId).toBe(original.activeReleaseId);
    expect((await mcp<ExternalAiDesignView>(client, 'site_design_status', { designId: candidate.designId })).status).toBe('undone');
    const providerAfter = await api<{ enabled: boolean; hasApiKey: boolean }>(control, '/api/ai/provider'); expect(providerAfter).toEqual(provider);
    await testInfo.attach('external-ai-flow-checks', { body: Buffer.from(JSON.stringify({ siteProviderConfigured: false, realSdkDiscovery: true, continuedCandidate: true, browserConfirmedApplyAndUndo: true, editableHeaderAndFooterRoundTrip: true, finalStatus: 'undone' })), contentType: 'application/json' });
  } catch (cause) {
    bodyError = cause;
    try {
      await testInfo.attach('external-ui-failure-form-state', { body: Buffer.from(JSON.stringify({ url: page.url(), dialogs: await page.getByRole('dialog').count(), fields: await page.locator('input,textarea').evaluateAll(fields => fields.map(field => ({ id: field.id, type: field.getAttribute('type'), label: field.getAttribute('aria-label'), labels: field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? Array.from(field.labels || []).map(label => label.textContent) : [] }))) })), contentType: 'application/json' });
      await testInfo.attach('external-ui-failure-screen', { body: await page.screenshot({ fullPage: true, timeout: 3000 }), contentType: 'image/png' });
    } catch { /* 诊断不替代原断言；不收集输入值或请求认证头。 */ }
    throw cause;
  }
  finally {
    const errors: string[] = [];
    try { await ui.closeOwnedPage(); } catch { errors.push('page close'); }
    if (client) try { await client.close(); } catch { errors.push('MCP close'); }
    for (const item of credentials) try { await api(control, `/api/external-ai/tokens/${item.credential.id}`, 'DELETE'); } catch { errors.push('credential revoke'); }
    if (seeded) try { const current = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: { pages: original.state.pages, editorData: original.state.editorData, siteLayout: original.state.siteLayout, theme: original.state.theme, sharedBlocks: original.state.sharedBlocks || [] } }); } catch { errors.push('studio restore'); }
    await testInfo.attach('external-ai-cleanup', { body: Buffer.from(JSON.stringify({ independentControlContext: true, errors })), contentType: 'application/json' });
    if (!bodyError && errors.length) throw new Error(`Isolated cleanup failed: ${errors.join(', ')}`);
  }
  } finally { await control.dispose(); }
});
