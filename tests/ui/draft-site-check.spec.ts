import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { AiBuildSiteCheckReport } from '../../src/lib/ai-build-site-check-types';
import { withEditorRootDefaults } from '../../src/lib/editor-root-defaults';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import { expect, noOverflow, runtime, select, test, textButton } from './fixtures';

async function studio(client: APIRequestContext, envelope?: StudioEnvelope, patch?: Partial<StudioEnvelope['state']>) {
  const response = await client.fetch(`${runtime.origin}/api/studio`, envelope ? {
    method: 'PATCH', data: { expectedRevision: envelope.revision, patch },
  } : { method: 'GET' });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<StudioEnvelope>;
}

test('草稿手机检查定位到对应标题，编辑后在最新草稿复检', async ({ page, ui }) => {
  test.setTimeout(145000);
  page.setDefaultTimeout(10000);
  const control = await playwrightRequest.newContext({ storageState: runtime.adminAuth, extraHTTPHeaders: { Origin: runtime.origin }, timeout: 18000 });
  const before = await studio(control);
  const id = 'ui-draft-heading-check', slug = '/ui-draft-heading-check', nodeId = 'ui-extra-h1';
  let seeded = false;
  const checkPath = '/api/ai/build/check';
  const check = async () => {
    await textButton(page, '整站检查').click();
    const dialog = page.getByRole('dialog', { name: '草稿整站检查', exact: true });
    await expect(dialog).toBeVisible();
    const [response] = await Promise.all([
      page.waitForResponse(result => new URL(result.url()).pathname === checkPath && result.request().method() === 'POST', { timeout: 105000 }),
      dialog.getByRole('button').filter({ hasText: /^(重新)?检查整站$/ }).click(),
    ]);
    expect(response.ok(), await response.text()).toBe(true);
    return { report: await response.json() as AiBuildSiteCheckReport, dialog };
  };
  try {
    // 故意添加真实的第二个 H1；测试需跨页面定位到原编辑器，再用原生属性修复。
    await studio(control, before, {
      // 把人工测试页放在检查优先范围内；既有完整站夹具可能超过单轮的页面上限。
      pages: [{ id, slug, title: 'Draft inspection fixture', status: 'draft', type: '页面', updated: '合成回归' }, ...before.state.pages],
      editorData: { ...before.state.editorData, [id]: withEditorRootDefaults({ root: { props: { title: 'Draft inspection fixture' } }, content: [
        { type: 'Heading', props: { id: 'ui-normal-h1', level: 'h1', text: 'Catalogue overview' } },
        { type: 'Heading', props: { id: nodeId, level: 'h1', text: 'Material options', nodeLabel: '待修标题' } },
      ] }) },
    });
    seeded = true;
    ui.allowWrite('POST', checkPath);
    ui.allowWrite('PATCH', '/api/studio');
    await page.goto('/admin#editor');
    await expect(page.locator('.editor-screen')).toBeVisible();
    const { report, dialog } = await check();
    expect(report.source).toBe('draft');
    // 打开画布可能保存 Puck 的标准默认值；核对实际已保存修订，避免把初次画布归一化误当成检查写入。
    const checkedRevision = (await studio(control)).revision;
    expect(report.baseRevision).toBe(checkedRevision);
    const row = report.pages.find(item => item.pageId === id)!;
    expect(row.path, row.notes.join(' ')).toBe(slug);
    expect(row.issues.find(issue => issue.code === 'heading-count')?.location?.target).toEqual({ kind: 'page', id, nodeId });
    await dialog.getByText('逐页手机检查', { exact: true }).click();
    const pageRow = dialog.getByRole('listitem').filter({ has: page.getByText(slug, { exact: true }) });
    const headingIssue = pageRow.getByText(/页面应有且只有一个可见的一级标题/);
    await textButton(headingIssue.locator('..'), '定位区块').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.editor-selection-title strong')).toHaveText('待修标题');
    expect((await studio(control)).revision).toBe(checkedRevision);
    await select(page, '标题级别（不影响文字大小）', '二级标题 · 章节标题');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect.poll(async () => (await studio(control)).revision).toBeGreaterThan(checkedRevision);
    await page.setViewportSize({ width: 390, height: 940 });
    await noOverflow(page);
    const second = await check();
    expect(second.report.baseRevision).toBeGreaterThan(checkedRevision);
    const fixed = second.report.pages.find(item => item.pageId === id)!;
    expect(fixed.mobile.map(metric => metric.headings)).toEqual([1, 1]);
    expect(fixed.issues.some(issue => issue.code === 'heading-count')).toBe(false);
    expect((await studio(control)).activeReleaseId).toBe(before.activeReleaseId);
  } finally {
    await ui.closeOwnedPage();
    if (seeded) await studio(control, await studio(control), { pages: before.state.pages, editorData: before.state.editorData });
    await control.dispose();
  }
});
