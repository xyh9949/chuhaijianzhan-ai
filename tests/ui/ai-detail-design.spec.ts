import { test, expect, runtime, noOverflow, textButton } from './fixtures';
import { request as playwrightRequest, type APIRequestContext, type Locator, type FrameLocator, type Page } from '@playwright/test';
import type { ComponentData } from '@puckeditor/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createContentDesignData } from '../../src/lib/content-design-presets';
import { withEditorRootDefaults } from '../../src/lib/editor-root-defaults';
import { createContentColumn } from '../../src/lib/content-columns';
import { getContentEntryPath, getProductPath } from '../../src/lib/content-routes';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import type { AiDetailDesignPreview, AiDetailDesignRequest } from '../../src/lib/ai-detail-design-types';
import type { ContentEntry, PageTemplate } from '../../src/lib/types';
import type { RichNode } from '../../src/lib/presentation-content';
import { richTextPlainText } from '../../src/lib/presentation-content';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileAiSitePlan, normalizeAiSitePlan } from '../../src/lib/ai-site-generator';
import type { AiSiteBrief, AiSitePlan } from '../../src/lib/ai-builder-types';
import type { Product, MediaItem } from '../../src/lib/types';
import type { AiProviderSummary } from '../../src/server/ai-provider';

/** 只连接包装器的临时实例；失败不把SDK请求头和临时Bearer写进报告。 */
async function api<T>(control: APIRequestContext, path: string, method = 'GET', data?: unknown): Promise<T> {
  const origin = new URL(runtime.origin); expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Only isolated API paths are allowed');
  const response = await control.fetch(`${runtime.origin}${path}`, { method, ...(data === undefined ? {} : { data }) }).catch(() => { throw new Error(`Isolated API ${method} ${path} failed`); });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return response.json() as Promise<T>;
}
async function sdk<T>(name: string, work: () => Promise<T>): Promise<T> { try { return await work(); } catch { throw new Error(`Isolated template MCP ${name} failed`); } }
async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const value = await sdk(name, () => client.callTool({ name, arguments: args })); expect(value.isError, `${name} should succeed`).not.toBe(true);
  return (value.structuredContent || JSON.parse((value.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text)) as T;
}
type ExternalPreview = AiDetailDesignPreview & { reviewUrl: string; status: string };

/** 仅观察真实渲染文档；截图是当前视口，完整正文另以DOM与原生字段比对，不冒称整页都在首屏。 */
async function captureHierarchy(frame: FrameLocator, page: Page, name: string, testInfo: import('@playwright/test').TestInfo) {
  await frame.locator('html').evaluate(element => element.ownerDocument.fonts.ready);
  // 灯箱未打开时，大图副本没有布局盒，截图准备只滚动页面上实际可见的图片。
  for (const picture of await frame.locator('img:visible').all()) { await picture.scrollIntoViewIfNeeded({ timeout: 5000 }); await expect.poll(() => picture.evaluate(value => (value as HTMLImageElement).complete && (value as HTMLImageElement).naturalWidth > 0)).toBe(true); }
  await frame.locator('html').evaluate(() => scrollTo(0, 0));
  // 普通草稿iframe随正文增高；载入长页图片会滚动宿主，须回顶后截真实宿主视口，不能截数千像素iframe造成裁剪空白。
  await page.evaluate(() => scrollTo(0, 0)); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  const facts = await frame.locator('html').evaluate(element => {
    const box = (node: Element) => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; };
    return { width: innerWidth, height: innerHeight, scrollWidth: element.scrollWidth, h1: [...element.querySelectorAll('h1')].map(node => ({ text: node.textContent, ...box(node) })), images: [...element.querySelectorAll('.editor-site img')].map(node => ({ src: node.getAttribute('src'), alt: node.getAttribute('alt'), ...box(node) })), bodyText: element.querySelector('.editor-site')?.textContent || '' };
  });
  expect(facts.scrollWidth).toBeLessThanOrEqual(facts.width + 1); expect(facts.h1).toHaveLength(1);
  await testInfo.attach(name, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  await testInfo.attach(`${name}-hierarchy`, { body: Buffer.from(JSON.stringify(facts, null, 2)), contentType: 'application/json' });
  return facts;
}

function nodeWithType(data: unknown, type: string): ComponentData | undefined {
  if (Array.isArray(data)) return data.map(value => nodeWithType(value, type)).find(Boolean);
  if (!data || typeof data !== 'object') return undefined;
  const value = data as ComponentData; if (value.type === type) return value;
  return Object.values(data).map(item => nodeWithType(item, type)).find(Boolean);
}

/** 审核摘要先于iframe脚本就绪；离开前核对两侧真实内容并完成文档加载，避免测试导航取消仍在加载的预览包。 */
async function waitForDetailPreview(dialog: Locator, recordLabel: string) {
  for (const side of ['修改前', 'AI建议']) {
    const frame = dialog.frameLocator(`iframe[title="${side}"]`);
    await expect(frame.frameLocator('iframe[title="网站草稿隔离预览"]').getByRole('heading', { name: recordLabel, exact: true })).toBeVisible();
    await expect.poll(() => frame.locator('html').evaluate(element => element.ownerDocument.readyState), { message: `${side}的真实预览文档应完成加载` }).toBe('complete');
  }
}

test('详情模板面板隔离历史、失效确认并避免空保存', async ({ page, ui }, testInfo) => {
  test.setTimeout(120000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 15000 });
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const client = new Client({ name: 'detail-template-scope-ui', version: '1.0.0' });
  const product = original.state.products[1];
  const templates = ['scope-a', 'scope-b'].map(id => {
    const name = `UI Detail ${id}`;
    // 故意采用合法的旧键顺序：编辑器重挂时会整理对象，但不应写入草稿。
    const data = { root: { props: { title: name, brand: '', showChrome: 'no' } }, zones: {}, content: ['First', 'Second', 'Third'].map((text, index) => ({ type: 'Heading', props: { id: `${id}-${index}`, text: `${name} ${text}`, level: index ? 'h2' : 'h1' } })) };
    return { id, name, kind: 'product' as const, description: 'Isolated detail scope fixture', updated: new Date().toISOString(), detailRule: { enabled: false, priority: 950, recordIds: [product.id] }, data };
  });
  const read = () => api<StudioEnvelope>(control, '/api/studio');
  async function openTemplates(tab: Page) {
    await tab.goto('/admin#templates');
    await tab.getByRole('tab', { name: '我的页面模板', exact: true }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'AI详情布局设计', exact: true });
  const other = await page.context().newPage();
  let tokenId = '', seeded = false;
  ui.allowWrite('PATCH', '/api/studio');
  try {
    const initial = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { pageTemplates: [...(original.state.pageTemplates || []), ...templates] } });
    seeded = true;
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI detail scope reviewer', scopes: ['read', 'propose'], pageIds: [original.state.pages[0].id], templateIds: templates.map(item => item.id), recordIds: { productIds: [product.id], entryIds: [] } });
    tokenId = credential.credential.id;
    await sdk('connect detail scope fixture', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const proposals: ExternalPreview[] = [];
    for (const template of templates) {
      const request: AiDetailDesignRequest = { templateId: template.id, expectedRevision: initial.revision, recordId: product.id, instruction: '调整标题的桌面留白，保留文字和其余细节。', preserveText: true, viewport: 'all' };
      const prepared = await tool<{ request: AiDetailDesignRequest }>(client, 'site_template_context', { request });
      proposals.push(await tool<ExternalPreview>(client, 'site_template_propose', { requestId: `${template.id}-scope-preview`, request: prepared.request, proposal: { summary: `Synthetic proposal for ${template.id}`, operations: [{ kind: 'design', id: template.data.content[0].props.id, design: { desktop: { paddingTop: 28 } } }], warnings: [] } }));
    }
    const [first, second] = proposals;
    const firstRow = (tab: Page) => tab.getByRole('row').filter({ hasText: templates[0].name });
    async function assertHistoryIsScoped() {
      await dialog.getByRole('tab', { name: '历史方案', exact: true }).click();
      await expect(dialog.getByRole('listitem').filter({ hasText: first.summary })).toBeVisible();
      await expect(dialog.getByRole('listitem').filter({ hasText: second.summary })).toHaveCount(0);
    }

    await openTemplates(page);
    await textButton(firstRow(page), 'AI调整布局').click();
    await assertHistoryIsScoped();
    await dialog.locator('.ant-modal-footer').getByRole('button', { name: /^关\s*闭$/ }).click();
    await textButton(firstRow(page), '编辑布局').click();
    const field = (tab: Page) => tab.getByRole('textbox', { name: '编辑器中的模板名称', exact: true });
    await expect(field(page)).toHaveValue(templates[0].name);
    await page.getByRole('button', { name: 'AI调整详情模板', exact: true }).click();
    await expect(dialog).toBeVisible();
    expect((await read()).revision).toBe(initial.revision);
    expect(ui.writes).toEqual([]);
    await assertHistoryIsScoped();
    await textButton(dialog.getByRole('listitem').filter({ hasText: first.summary }), '查看方案').click();
    const confirm = textButton(dialog, '确认保存为模板草稿');
    await expect(confirm).toBeEnabled();
    await waitForDetailPreview(dialog, `${templates[0].name} First`);

    await openTemplates(other);
    await textButton(firstRow(other), '编辑布局').click();
    const newerTitle = 'UI detail title saved in the other tab';
    await field(other).fill(newerTitle);
    await other.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect.poll(async () => (await read()).state.pageTemplates!.find(item => item.id === templates[0].id)!.data.root.props?.title).toBe(newerTitle);
    const updated = await read();

    await textButton(dialog, '读取最新状态').click();
    await expect(dialog).toContainText('已读取最新状态，输入仍保留。');
    await expect(dialog).toContainText('这版方案基于旧草稿');
    await expect(confirm).toBeDisabled();
    await expect(textButton(dialog, '在这版上继续调整')).toBeDisabled();
    expect((await read()).revision).toBe(updated.revision);
    expect(ui.writes.filter(item => item.path === '/api/ai/detail-designs/apply')).toHaveLength(0);
    await testInfo.attach('outdated-detail-disabled', { body: await dialog.screenshot(), contentType: 'image/png' });
    await dialog.locator('.ant-modal-footer').getByRole('button', { name: /^关\s*闭$/ }).click();
    await expect(dialog).toBeHidden();
    await page.bringToFront();
    await expect(field(page)).toHaveValue(newerTitle);

    const savedByOther = updated.state.pageTemplates!.find(item => item.id === templates[0].id)!.data;
    const templateData = async () => (await read()).state.pageTemplates!.find(item => item.id === templates[0].id)!.data;
    const canvasHeadings = page.frameLocator('.editor-scaled-frame iframe').locator('.editor-site-heading');
    const firstHeading = canvasHeadings.first(), lastHeading = canvasHeadings.last();
    await firstHeading.scrollIntoViewIfNeeded(); await lastHeading.scrollIntoViewIfNeeded();
    const start = await firstHeading.boundingBox(), finish = await lastHeading.boundingBox();
    if (!start || !finish) throw Error('找不到模板区块的真实拖拽坐标');
    const x = start.x + start.width / 2, y = start.y + start.height / 2;
    await expect.poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('.editor-scaled-frame iframe'), { x, y })).toBe(true);
    // 实际拖动并预览，随后撤销只反转这次拖动，保留另一个标签保存的模板名称。
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y + 12, { steps: 5 });
    await page.mouse.move(finish.x + finish.width / 2, finish.y + Math.max(3, finish.height - 3), { steps: 20 });
    await page.mouse.up();
    const [head, ...rest] = savedByOther.content;
    const reordered = [...rest, head];
    await expect(canvasHeadings).toHaveText(reordered.map(node => node.props.text));
    await expect.poll(templateData).toEqual({ ...savedByOther, content: reordered });
    await page.getByRole('button', { name: '预览页面', exact: true }).click();
    const rendered = page.frameLocator('iframe[title="网站完整草稿预览"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(rendered.locator('.editor-site-heading')).toHaveText(reordered.map(node => node.props.text));
    await textButton(page, '返回编辑器').click();
    await expect(canvasHeadings).toHaveText(reordered.map(node => node.props.text));
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(templateData).toEqual(savedByOther);
    const afterUndo = await read();

    const review = await tool<{ reviewUrl: string }>(client, 'site_template_review', { designId: second.designId, action: 'apply' });
    await page.goto(review.reviewUrl);
    await expect(dialog).toContainText(second.summary);
    await expect(dialog).toContainText('这版方案基于旧草稿');
    await waitForDetailPreview(dialog, `${templates[1].name} First`);
    const last = await read();
    expect(last.revision).toBe(afterUndo.revision);
    expect(last.activeReleaseId).toBe(original.activeReleaseId);
  } finally {
    await other.close(); await ui.closeOwnedPage(); await sdk('close', () => client.close());
    if (seeded) {
      const latest = await read();
      await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pageTemplates: latest.state.pageTemplates?.filter(item => !templates.some(template => template.id === item.id)) } });
    }
    if (tokenId) await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE');
    await control.dispose();
  }
});

test('产品与案例详情经MCP继续设计、真实三端预览、原生Puck往返和撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(160000);
  page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 15000 });
  const client = new Client({ name: 'detail-template-ui', version: '1.0.0' }); let tokenId = '';
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const product = original.state.products[1], entry = original.state.contentEntries![1];
  const productModel = original.state.contentModels!.find(item => item.id === product.modelId)!, entryModel = original.state.contentModels!.find(item => item.id === entry.modelId)!;
  const templates: PageTemplate[] = [
    { id: 'ui-ai-product-template', name: 'UI Product Detail Design', kind: 'product', description: 'Isolated native product layout', updated: new Date().toISOString(), detailRule: { enabled: true, priority: 997, modelId: productModel.id, recordIds: [product.id] }, data: withEditorRootDefaults(createContentDesignData({ name: 'UI Product Detail Design', source: 'product', model: productModel, kind: 'detail' })) },
    { id: 'ui-ai-entry-template', name: 'UI Case Detail Design', kind: 'entry', modelId: entryModel.id, description: 'Isolated native entry layout', updated: new Date().toISOString(), detailRule: { enabled: true, priority: 998, recordIds: [entry.id] }, data: withEditorRootDefaults(createContentDesignData({ name: 'UI Case Detail Design', source: 'entry', model: entryModel, kind: 'detail' })) },
  ];
  try {
    const provider = await api<{ enabled: boolean; hasApiKey: boolean }>(control, '/api/ai/provider'); expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
    await api(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { pageTemplates: [...(original.state.pageTemplates || []), ...templates] } });
    const credential = await api<{ credential: { id: string }; token: string }>(control, '/api/external-ai/tokens', 'POST', { name: 'UI detail native reviewer', scopes: ['read', 'propose'], pageIds: [original.state.pages[0].id], templateIds: templates.map(item => item.id), recordIds: { productIds: [product.id], entryIds: [entry.id] } }); tokenId = credential.credential.id;
    await sdk('connect', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', runtime.origin), { requestInit: { headers: { Origin: runtime.origin, Authorization: `Bearer ${credential.token}`, Connection: 'close' } } })));
    const discovered = await sdk('listTools', () => client.listTools()); expect(discovered.tools.map(item => item.name)).toEqual(expect.arrayContaining(['site_template_overview', 'site_template_context', 'site_template_propose', 'site_template_status', 'site_template_review']));
    ui.allowWrite('POST', '/api/ai/detail-designs/apply'); ui.allowWrite('POST', '/api/ai/detail-designs/undo'); ui.allowWrite('PATCH', '/api/studio');
    for (const template of templates) {
      const record = template.kind === 'product' ? product : entry, recordLabel = template.kind === 'product' ? product.name : entry.title;
      const current = await api<StudioEnvelope>(control, '/api/studio'), nodeId = template.data.content[0].props.id;
      const request: AiDetailDesignRequest = { templateId: template.id, expectedRevision: current.revision, recordId: record.id, instruction: '真实详情按原生组件重新排版，电脑留白清楚，手机更紧凑；保持动态内容。', preserveText: true, viewport: 'all' };
      const prepared = await tool<{ request: AiDetailDesignRequest }>(client, 'site_template_context', { request });
      const first = await tool<ExternalPreview>(client, 'site_template_propose', { requestId: `${template.id}-first`, request: prepared.request, proposal: { summary: `Synthetic ${template.kind} detail design`, intent: { goal: '用真实内容展示可编辑的详情设计', decisions: ['保持动态绑定并分别调整三端留白'], preserve: ['现有内容和适用规则'], assumptions: [] }, operations: [{ kind: 'design', id: nodeId, design: { desktop: { paddingTop: 52 }, tablet: { paddingTop: 32 }, mobile: { paddingTop: 20 } } }], warnings: [] } });
      const next = await tool<{ request: AiDetailDesignRequest }>(client, 'site_template_context', { request: { ...prepared.request, baseDesignId: first.designId, viewport: 'mobile', instruction: '保留电脑和平板，仅把手机首屏上方留白缩至14像素。' } });
      const candidate = await tool<ExternalPreview>(client, 'site_template_propose', { requestId: `${template.id}-refined`, request: next.request, proposal: { summary: `Refined ${template.kind} detail design`, operations: [{ kind: 'design', id: nodeId, design: { mobile: { paddingTop: 14 } } }], warnings: [] } });
      expect(candidate.refinement?.baseDesignId).toBe(first.designId); expect(candidate.sample?.matched).toBe(true); expect(candidate.sample?.id).toBe(record.id);
      const review = await tool<{ reviewUrl: string }>(client, 'site_template_review', { designId: candidate.designId, action: 'apply' });
      expect(new URL(review.reviewUrl).searchParams.get('externalTemplate')).toBe(candidate.designId);
      expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(current.revision);
      if (template.kind === 'product') {
        await page.goto('/admin#templates'); await page.getByRole('tab', { name: '我的页面模板', exact: true }).click();
        const row = page.getByRole('row').filter({ hasText: template.name }); await textButton(row, 'AI调整布局').click();
        await page.getByRole('textbox', { name: '详情布局要求', exact: true }).fill('UI pending detail requirement must be retained');
        page.once('dialog', async native => { expect(native.type()).toBe('beforeunload'); await native.accept(); });
      }
      await page.goto(review.reviewUrl); let dialog = page.getByRole('dialog', { name: 'AI详情布局设计', exact: true });
      if (template.kind === 'product') {
        await expect(dialog.getByRole('textbox', { name: '详情布局要求', exact: true })).toHaveValue('UI pending detail requirement must be retained');
        await textButton(dialog, '打开外部方案').click(); const guard = page.getByRole('dialog', { name: '未保存 · AI详情布局要求', exact: true });
        await textButton(guard, '继续编辑').click(); await expect(dialog.getByRole('textbox', { name: '详情布局要求', exact: true })).toHaveValue('UI pending detail requirement must be retained');
        await textButton(dialog, '打开外部方案').click(); await textButton(guard, '放弃修改').click();
      }
      await expect(dialog).toContainText(candidate.summary); await expect(dialog).toContainText(`真实生效样本：${recordLabel}`);
      const frame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
      await waitForDetailPreview(dialog, recordLabel);
      for (const [label, width] of [['电脑', 1280], ['平板', 768], ['手机', 390]] as const) {
        await dialog.locator('.ai-design-preview .ant-segmented-item').filter({ hasText: label }).click();
        await expect.poll(() => frame.locator('main').evaluate(() => innerWidth)).toBe(width);
        await expect(dialog.locator('.ai-design-preview')).toContainText(`${label}基础排版已检查`);
      }
      if (template.kind === 'entry') await expect(frame.getByText(String(entry.customFields['ui-body']), { exact: true })).toBeVisible();
      await expect.poll(() => frame.locator('.editor-site-section').first().evaluate(element => parseFloat(getComputedStyle(element).paddingTop))).toBe(14);
      await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, dialog);
      await testInfo.attach(`${template.kind}-detail-review-mobile`, { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await waitForDetailPreview(dialog, recordLabel);
      await textButton(dialog, '确认保存为模板草稿').click(); await expect(dialog).toContainText('已保存为详情模板草稿');
      const applied = await api<StudioEnvelope>(control, '/api/studio'), appliedTemplate = applied.state.pageTemplates!.find(item => item.id === template.id)!;
      expect(appliedTemplate.detailRule).toEqual(template.detailRule); expect(applied.state.pages).toEqual(current.state.pages); expect(applied.state.editorData).toEqual(current.state.editorData);
      expect(applied.state.products).toEqual(current.state.products); expect(applied.state.contentEntries).toEqual(current.state.contentEntries); expect(applied.activeReleaseId).toBe(original.activeReleaseId);
      await textButton(dialog, '继续拖拽编辑').click(); await expect(page.locator('.editor-topbar')).toContainText('详情模板草稿'); await expect(page.locator('.editor-topbar')).toContainText(template.name);
      await page.getByRole('button', { name: '保存草稿', exact: true }).click();
      await page.getByRole('button', { name: '返回模板资源', exact: true }).click();
      await expect(page.getByRole('tab', { name: '我的页面模板', exact: true })).toHaveAttribute('aria-selected', 'true');
      const visited = await api<StudioEnvelope>(control, '/api/studio'); expect(visited.state.pageTemplates!.find(item => item.id === template.id)!.data, 'Puck无操作往返不得制造撤销冲突或固定样本').toEqual(appliedTemplate.data);
      await page.goto(review.reviewUrl); dialog = page.getByRole('dialog', { name: 'AI详情布局设计', exact: true }); await expect(dialog).toContainText(candidate.summary);
      await waitForDetailPreview(dialog, recordLabel);
      if (template.kind === 'entry') {
        await textButton(dialog, '继续拖拽编辑').click();
        await page.getByRole('textbox', { name: '编辑器中的模板名称', exact: true }).fill('UI native manually edited case layout');
        await page.getByRole('button', { name: '保存草稿', exact: true }).click();
        await expect.poll(async () => (await api<StudioEnvelope>(control, '/api/studio')).state.pageTemplates!.find(item => item.id === template.id)!.data.root.props?.title).toBe('UI native manually edited case layout');
        const manual = await api<StudioEnvelope>(control, '/api/studio'); expect(manual.state.pageTemplates!.find(item => item.id === template.id)!.data.root.props?.title).toBe('UI native manually edited case layout');
        expect(manual.state.editorData).toEqual(current.state.editorData); expect(manual.state.pageTemplates!.find(item => item.id === template.id)!.detailRule).toEqual(template.detailRule);
        // 真正新增一个原生节点再启用动态内容，默认必须跟随当前案例栏目，不能落到产品或固定样本。
        await page.getByRole('searchbox', { name: '查找元素', exact: true }).fill('正文'); await textButton(page.locator('.editor-search-results'), '正文').click();
        await page.locator('.editor-left-panel').getByRole('tab', { name: /图层/ }).click();
        await page.getByRole('treeitem').filter({ hasText: 'Thoughtful design, natural materials' }).click();
        const properties = page.locator('.editor-right-panel'); await textButton(properties, '自动显示产品或资料（高级）').click();
        await properties.locator('.editor-binding-fields .ant-collapse-header').filter({ hasText: '文字内容' }).click();
        await properties.getByRole('combobox', { name: '文字内容方式', exact: true }).click();
        await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '随当前产品或内容自动填写' }).click();
        await expect.poll(() => properties.getByRole('combobox', { name: '文字内容数据来源', exact: true }).evaluate(element => element.closest('.ant-select')?.textContent)).toContain('案例、团队等内容');
        await expect.poll(() => properties.getByRole('combobox', { name: '文字内容内容模型', exact: true }).evaluate(element => element.closest('.ant-select')?.textContent)).toContain(entryModel.name);
        await page.getByRole('button', { name: '保存草稿', exact: true }).click();
        await expect.poll(async () => {
          const value = (await api<StudioEnvelope>(control, '/api/studio')).state.pageTemplates!.find(item => item.id === template.id)!.data;
          return value.content.find(node => node.type === 'Text' && String(node.props.text).startsWith('Thoughtful design'))?.props.bindings?.text;
        }).toEqual({ source: 'entry', mode: 'current', modelId: entryModel.id, field: 'builtin:title', fallback: '' });
        await page.getByRole('button', { name: '返回模板资源', exact: true }).click(); await expect(page.getByRole('tab', { name: '我的页面模板', exact: true })).toHaveAttribute('aria-selected', 'true'); await page.goto(review.reviewUrl);
        dialog = page.getByRole('dialog', { name: 'AI详情布局设计', exact: true }); await expect(dialog).toContainText(candidate.summary); await expect(textButton(dialog, '撤销本次修改')).toBeDisabled();
        await waitForDetailPreview(dialog, recordLabel);
        // 测试明确复原这一个模板的数据，验证精确冲突保护后仍能正常撤销；不回滚整个工作区。
        const restore = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: restore.revision, patch: { pageTemplates: restore.state.pageTemplates!.map(item => item.id === template.id ? { ...item, data: appliedTemplate.data } : item) } });
        await page.goto(review.reviewUrl); dialog = page.getByRole('dialog', { name: 'AI详情布局设计', exact: true }); await expect(dialog).toContainText(candidate.summary);
        await waitForDetailPreview(dialog, recordLabel);
      }
      await expect(textButton(dialog, '撤销本次修改')).toBeEnabled(); await textButton(dialog, '撤销本次修改').click(); await expect(dialog).toContainText('已撤销本次详情布局修改');
      await waitForDetailPreview(dialog, recordLabel);
      const undone = await api<StudioEnvelope>(control, '/api/studio'); expect(undone.state.pageTemplates!.find(item => item.id === template.id)!.data).toEqual(template.data);
      expect((await tool<ExternalPreview>(client, 'site_template_status', { designId: candidate.designId })).status).toBe('undone');
    }
    expect(ui.writes.some(item => item.path === '/api/ai/detail-designs')).toBe(false);
  } finally {
    await ui.closeOwnedPage(); await sdk('close', () => client.close());
    const latest = await api<StudioEnvelope>(control, '/api/studio');
    await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pageTemplates: latest.state.pageTemplates?.filter(item => !templates.some(template => template.id === item.id)) } });
    if (tokenId) await api(control, `/api/external-ai/tokens/${tokenId}`, 'DELETE'); await control.dispose();
  }
});

test('用户自配AI原生生成和继续调整详情，未命中规则清楚提示，确认后可编辑与撤销', async ({ page, ui }, testInfo) => {
  test.setTimeout(110000);
  page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 15000 });
  const original = await api<StudioEnvelope>(control, '/api/studio'), provider = await api<AiProviderSummary>(control, '/api/ai/provider');
  const product = original.state.products[1], model = original.state.contentModels!.find(item => item.id === product.modelId)!;
  const template: PageTemplate = { id: 'ui-native-detail-template', name: 'UI Native Detail Design', kind: 'product', description: 'Synthetic self-configured AI flow', updated: new Date().toISOString(), detailRule: { enabled: false, priority: 996, modelId: model.id }, data: withEditorRootDefaults(createContentDesignData({ name: 'UI Native Detail Design', source: 'product', model, kind: 'detail' })) };
  let configured = false;
  try {
    expect(provider.enabled).toBe(false); expect(provider.hasApiKey).toBe(false);
    const seeded = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { pageTemplates: [...(original.state.pageTemplates || []), template] } });
    await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: provider.revision, enabled: true, baseUrl: `${runtime.modelOrigin}/v1`, model: 'ui-detail-design-model', allowLocal: true, apiKey: 'ui-design-synthetic' }); configured = true;
    for (const [method, path] of [['POST', '/api/ai/detail-designs'], ['POST', '/api/ai/detail-designs/apply'], ['POST', '/api/ai/detail-designs/undo'], ['PATCH', '/api/studio']] as const) ui.allowWrite(method, path);
    await page.goto('/admin#templates'); await page.getByRole('tab', { name: '我的页面模板', exact: true }).click();
    await textButton(page.getByRole('row').filter({ hasText: template.name }), 'AI调整布局').click();
    let dialog = page.getByRole('dialog', { name: 'AI详情布局设计', exact: true });
    const sample = dialog.getByRole('combobox', { name: '详情预览内容', exact: true }); await sample.fill(product.name); await sample.press('Enter');
    await expect.poll(() => sample.evaluate(element => element.closest('.ant-select')?.textContent)).toContain(product.name);
    await dialog.getByRole('textbox', { name: '详情布局要求', exact: true }).fill('UI_AI_DETAIL_FLOW 产品详情更清楚，保留动态内容，分别调整电脑、平板和手机留白。');
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/detail-designs' && response.request().method() === 'POST');
    await textButton(dialog, '生成详情布局预览').click(); const firstHttp = await firstResponse; expect(firstHttp.status()).toBe(201); const first = await firstHttp.json() as AiDetailDesignPreview;
    expect(first.sample?.matched).toBe(false); await expect(dialog).toContainText(`仅模板布局预览：${product.name}`); await expect(dialog).toContainText('采用设计不会启用或修改规则');
    expect((await api<StudioEnvelope>(control, '/api/studio')).revision).toBe(seeded.revision);
    const frame = dialog.frameLocator('iframe[title="AI建议"]').frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(frame.getByRole('heading', { name: product.name, exact: true })).toBeVisible();
    await dialog.locator('.ai-design-preview .ant-segmented-item').filter({ hasText: '手机' }).click(); await expect(dialog.locator('.ai-design-preview')).toContainText('手机基础排版已检查');
    await expect.poll(() => frame.locator('.editor-site-section').first().evaluate(element => parseFloat(getComputedStyle(element).paddingTop))).toBe(20);
    await dialog.getByRole('textbox', { name: '继续调整详情布局', exact: true }).fill('UI_AI_DETAIL_CONTINUE 保留其他效果，手机首屏上下留白再小一些。');
    await expect(textButton(dialog, '确认保存为模板草稿')).toBeDisabled();
    const nextResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/detail-designs' && response.request().method() === 'POST');
    await textButton(dialog, '在这版上继续调整').click(); const nextHttp = await nextResponse; expect(nextHttp.status()).toBe(201); const next = await nextHttp.json() as AiDetailDesignPreview;
    expect(next.refinement?.baseDesignId).toBe(first.designId); expect(next.refinement?.round).toBe(1);
    await dialog.locator('.ai-design-preview .ant-segmented-item').filter({ hasText: '手机' }).click();
    await expect.poll(() => frame.locator('.editor-site-section').first().evaluate(element => parseFloat(getComputedStyle(element).paddingTop))).toBe(12);
    await testInfo.attach('native-ai-detail-real-preview', { body: await dialog.locator('iframe[title="AI建议"]').screenshot(), contentType: 'image/png' });
    await textButton(dialog, '确认保存为模板草稿').click(); await expect(dialog).toContainText('已保存为详情模板草稿');
    const saved = await api<StudioEnvelope>(control, '/api/studio'); expect(saved.state.pageTemplates!.find(item => item.id === template.id)!.detailRule).toEqual(template.detailRule); expect(saved.state.products).toEqual(original.state.products); expect(saved.state.editorData).toEqual(original.state.editorData);
    await textButton(dialog, '继续拖拽编辑').click(); await expect(page.locator('.editor-topbar')).toContainText(template.name); await page.getByRole('button', { name: '返回模板资源', exact: true }).click();
    await textButton(page.getByRole('row').filter({ hasText: template.name }), 'AI调整布局').click(); dialog = page.getByRole('dialog', { name: 'AI详情布局设计', exact: true });
    await dialog.getByRole('tab', { name: '历史方案', exact: true }).click();
    await textButton(dialog.getByRole('listitem').filter({ hasText: next.summary }), '查看方案').click();
    await expect(textButton(dialog, '撤销本次修改')).toBeEnabled(); await textButton(dialog, '撤销本次修改').click(); await expect(dialog).toContainText('已撤销本次详情布局修改');
    expect((await api<StudioEnvelope>(control, '/api/studio')).state.pageTemplates!.find(item => item.id === template.id)!.data).toEqual(template.data);
    expect(ui.writes.filter(item => item.path === '/api/ai/detail-designs')).toHaveLength(2);
  } finally {
    await ui.closeOwnedPage();
    if (configured) { const latestProvider = await api<AiProviderSummary>(control, '/api/ai/provider'); await api(control, '/api/ai/provider', 'PATCH', { expectedRevision: latestProvider.revision, enabled: provider.enabled, baseUrl: provider.baseUrl, model: provider.model, allowLocal: provider.allowLocal, clearApiKey: true }); }
    const latest = await api<StudioEnvelope>(control, '/api/studio'); await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pageTemplates: latest.state.pageTemplates?.filter(item => item.id !== template.id) } }); await control.dispose();
  }
});

test('新内页与动态详情真实层级：保留规划、双产品、完整案例和无封面样本', async ({ page, ui }, testInfo) => {
  test.setTimeout(120000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin, Connection: 'close' }, timeout: 15000 });
  const original = await api<StudioEnvelope>(control, '/api/studio');
  const supplied = (JSON.parse(readFileSync(resolve('tests/fixtures/ai-quality-plans.json'), 'utf8')) as { id: string; fictional: true; brief: AiSiteBrief; plan: AiSitePlan; products: Product[]; media: MediaItem[] }[]).find(item => item.id === 'home-brand')!;
  expect(supplied.fictional).toBe(true);
  const productModel = original.state.contentModels!.find(model => model.target === 'product')!;
  const products = supplied.products.map((product, index) => ({ ...product, id: `ui-inner-product-${index}`, slug: `ui-inner-product-${index}`, locale: 'en', status: 'draft' as const, modelId: productModel.id }));
  const detailText = 'Fictional demonstration. Full supplied product information remains editable; dimensions and ordering terms are unconfirmed.';
  products[0] = { ...products[0], images: ['/images/chair.jpg', '/images/interior.jpg'], detailContent: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: detailText }] }] } };
  // 原产品ID保留给旧固定绑定；仅本次en夹具进入新页面，避免把旧回归产品混入保留规划。
  const source = { ...original.state, settings: { ...original.state.settings, name: supplied.brief.companyName }, products: [...products, ...original.state.products.map(product => ({ ...product, locale: 'de' }))] };
  const ids = new Map(supplied.media.map(media => [media.id, original.state.media.find(item => item.url === media.url)?.id]));
  expect([...ids.values()].every(Boolean)).toBe(true);
  const plan = { ...supplied.plan, pages: supplied.plan.pages.map(item => ({ ...item, sections: item.sections.map(section => section.mediaId ? { ...section, mediaId: ids.get(section.mediaId)! } : section) })) };
  const compiled = compileAiSitePlan(normalizeAiSitePlan(plan, supplied.brief), 'editorial', source, '/ui-inner-037');
  const column = createContentColumn('case', 'ui-inner-037', compiled.patch.pages!);
  const field = (key: string) => column.model.fields.find(item => item.key === key)!.id;
  const paragraphs = ['Fictional project brief: a compact showroom concept for buyer discussion.', 'The complete supplied narrative is retained. This illustrative reference is not a verified client project or a performance claim.'];
  const body: RichNode = { type: 'doc', content: paragraphs.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) };
  const entries: ContentEntry[] = [0, 1].map(index => ({ id: `ui-inner-case-${index}`, modelId: column.model.id, title: index ? 'Fictional case without a cover' : 'Fictional showroom planning case', slug: `ui-inner-case-${index}`, status: 'draft', locale: 'en', customFields: { [field('cover')]: index ? '' : '/images/interior.jpg', [field('gallery')]: index ? [] : ['/images/studio.jpg','/images/sofa.jpg'], [field('summary')]: index ? 'A second real record follows the same dynamic design.' : 'An illustrative showroom brief, with facts kept separate from unconfirmed outcomes.', [field('country')]: 'United States · fictional demonstration', [field('body')]: richTextPlainText(body) }, richTextFields: { [field('body')]: body }, updated: new Date().toISOString() }));
  const productTemplate = compiled.patch.pageTemplates!.find(template => !original.state.pageTemplates?.some(old => old.id === template.id) && template.kind === 'product')!;
  expect(productTemplate).toBeTruthy(); productTemplate.detailRule = { enabled: true, priority: 998, modelId: productModel.id, recordIds: products.map(product => product.id) };
  const productNode = nodeWithType(productTemplate.data, 'ProductDetail')!; expect(productNode).toBeTruthy(); expect(productNode.props.mobileOrder).toBe('overview-first');
  const caseTemplate: PageTemplate = { id: 'ui-inner-case-template', name: 'UI current case design', kind: 'entry', modelId: column.model.id, description: 'Fictional dynamic case regression', updated: new Date().toISOString(), detailRule: { enabled: true, priority: 999, recordIds: entries.map(entry => entry.id) }, data: withEditorRootDefaults(createContentDesignData({ name: 'UI current case design', source: 'entry', model: column.model, kind: 'detail', detailKind: 'case' })) };
  let seeded = false;
  const capture = async (path: string, label: string, width: number) => {
    await page.setViewportSize({ width, height: 960 }); await page.goto(`/preview${path}`);
    const frame = page.frameLocator('iframe[title="网站草稿隔离预览"]');
    await expect(frame.locator('.editor-site')).toBeVisible(); await expect.poll(() => frame.locator('html').evaluate(() => innerWidth)).toBe(width);
    await page.evaluate(() => document.fonts.ready);
    return { frame, facts: await captureHierarchy(frame, page, `${label}-${width}`, testInfo) };
  };
  try {
    // 直接预置整个编译结果，使详情模板和目录引用同一份头尾、导航与卡片资产。
    const saved = await api<StudioEnvelope>(control, '/api/studio', 'PATCH', { expectedRevision: original.revision, patch: { ...compiled.patch, products: source.products, settings: { ...original.state.settings, name: supplied.brief.companyName }, pages: [...compiled.patch.pages!, column.page], editorData: { ...compiled.patch.editorData, [column.page.id]: column.data }, contentModels: [...original.state.contentModels!, column.model], contentEntries: [...original.state.contentEntries!, ...entries], pageTemplates: [...compiled.patch.pageTemplates!, caseTemplate] } }); seeded = true;
    const routes = [getProductPath(saved.state, products[0])!, getProductPath(saved.state, products[1])!, getContentEntryPath(saved.state, entries[0])!, getContentEntryPath(saved.state, entries[1])!]; expect(routes.every(Boolean)).toBe(true);
    for (const width of [1280, 390]) {
      await capture('/ui-inner-037', 'home-reference', width);
      const inner = await capture('/ui-inner-037/our-point-of-view', 'ordinary-inner', width); await expect(inner.frame.getByRole('heading', { level: 1 })).toHaveText('Room for the everyday');
      const product = await capture(routes[0], 'product-overview', width); await expect(product.frame.getByRole('heading', { level: 1 })).toHaveText(products[0].name); await expect(product.frame.locator('.editor-site')).toContainText(detailText); await expect(product.frame.locator('.editor-product-gallery')).toBeVisible();
      await expect(product.frame.locator('.editor-site-detail-identity .editor-site-action')).toHaveAttribute('href', '/preview/ui-inner-037/contact');
      const detail = await capture(routes[2], 'case-complete', width); await expect(detail.frame.getByRole('heading', { level: 1 })).toHaveText(entries[0].title);
      for (const text of [String(entries[0].customFields[field('summary')]), String(entries[0].customFields[field('country')]), ...paragraphs]) await expect(detail.frame.locator('.editor-site')).toContainText(text);
      const title = detail.frame.getByRole('heading', { level: 1 }), cover = detail.frame.getByRole('img', { name: entries[0].title, exact: true }); await expect(cover).toBeVisible();
      const [titleBox, coverBox] = await Promise.all([title.boundingBox(), cover.boundingBox()]); expect(titleBox!.y + titleBox!.height).toBeLessThanOrEqual(coverBox!.y);
      const gallery = detail.frame.locator('.site-gallery figure');
      await expect(gallery).toHaveCount(2);
      await expect(gallery.nth(0).locator('button img')).toHaveAttribute('src', '/images/studio.jpg');
      await expect(gallery.nth(1).locator('button img')).toHaveAttribute('src', '/images/sofa.jpg');
      if (width === 390) {
        expect(Math.abs(titleBox!.x - 20)).toBeLessThanOrEqual(2);
        // 新案例沿用真实全局后备导航；短标签须单行且保持在390px视口内，不以正文无横溢代替导航可读性。
        const navigation = await detail.frame.locator('.editor-site-nav>nav:not(.site-managed-navigation)').evaluate(element => {
          const rect = element.getBoundingClientRect(), links = [...element.querySelectorAll('a')].map(link => { const box = link.getBoundingClientRect(), range = link.ownerDocument.createRange(); range.selectNodeContents(link); const lineCount = new Set([...range.getClientRects()].filter(value => value.width > 0 && value.height > 0).map(value => Math.round(value.y * 2) / 2)).size; return { text: link.textContent || '', x: box.x, right: box.right, lineCount }; });
          const shortLinks = links.filter(link => [...link.text].length <= 24);
          return { boundsFit: rect.x >= -1 && rect.right <= innerWidth + 1, shortLabelsSingleLine: shortLinks.length > 0 && shortLinks.every(link => link.lineCount === 1 && link.x >= -1 && link.right <= innerWidth + 1), links };
        });
        expect({ boundsFit: navigation.boundsFit, shortLabelsSingleLine: navigation.shortLabelsSingleLine }).toEqual({ boundsFit: true, shortLabelsSingleLine: true });
        // 实际操作手机灯箱，然后关闭，避免只测静态节点数量。
        await gallery.first().locator('.site-gallery-open').click();
        const lightbox = detail.frame.locator('.site-lightbox:popover-open');
        await expect(lightbox).toBeVisible();
        await lightbox.getByRole('button').click();
        await expect(lightbox).toHaveCount(0);
        await testInfo.attach('case-fallback-navigation-390', { body: Buffer.from(JSON.stringify(navigation, null, 2)), contentType: 'application/json' });
      }
    }
    const secondProduct = await capture(routes[1], 'product-current-second', 390); await expect(secondProduct.frame.getByRole('heading', { level: 1 })).toHaveText(products[1].name); await expect(secondProduct.frame.locator('.editor-site')).toContainText(products[1].sku);
    const secondCase = await capture(routes[3], 'case-without-cover', 390); await expect(secondCase.frame.getByRole('heading', { level: 1 })).toHaveText(entries[1].title); await expect(secondCase.frame.getByRole('img', { name: entries[1].title, exact: true })).toHaveCount(0); for (const text of paragraphs) await expect(secondCase.frame.locator('.editor-site')).toContainText(text);
    // 同一原生模板换呈现选项仍保留真实记录；该夹具修改不是AI生成/采用，原有MCP用例另验确认与撤销。
    const latest = await api<StudioEnvelope>(control, '/api/studio'), specs = structuredClone(productTemplate); nodeWithType(specs.data, 'ProductDetail')!.props.mobileOrder = 'specifications-first';
    await api(control, '/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pageTemplates: latest.state.pageTemplates!.map(template => template.id === specs.id ? specs : template) } });
    const specification = await capture(routes[0], 'product-specifications', 390); await expect(specification.frame.locator('.editor-site-detail-specifications-first')).toBeVisible(); await expect(specification.frame.getByRole('heading', { level: 1 })).toHaveText(products[0].name); await expect(specification.frame.locator('.editor-site')).toContainText(detailText);
    const after = await api<StudioEnvelope>(control, '/api/studio'); expect(after.state.products).toEqual(saved.state.products); expect(after.state.contentEntries).toEqual(saved.state.contentEntries); expect(after.activeReleaseId).toBe(original.activeReleaseId); expect(ui.writes).toEqual([]);
  } finally {
    await ui.closeOwnedPage();
    if (seeded) {
      const current = await api<StudioEnvelope>(control, '/api/studio');
      const pageIds = new Set([...compiled.pageIds, column.page.id]), templateIds = new Set([productTemplate.id, caseTemplate.id]);
      const editorData = { ...current.state.editorData };
      pageIds.forEach(id => delete editorData[id]);
      // 与临时页面一起撤回其共享资产，否则验证会因菜单仍指向这些页面而拒绝清理。
      await api(control, '/api/studio', 'PATCH', { expectedRevision: current.revision, patch: {
        products: original.state.products, settings: original.state.settings, editorData,
        pages: current.state.pages.filter(page => !pageIds.has(page.id)),
        pageTemplates: current.state.pageTemplates!.filter(template => !templateIds.has(template.id)),
        contentModels: current.state.contentModels!.filter(model => model.id !== column.model.id),
        contentEntries: current.state.contentEntries!.filter(entry => !entries.some(item => item.id === entry.id)),
        forms: original.state.forms || [], sharedBlocks: original.state.sharedBlocks || [],
        siteLayout: original.state.siteLayout || { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: [] },
      } });
    }
    await control.dispose();
  }
});
