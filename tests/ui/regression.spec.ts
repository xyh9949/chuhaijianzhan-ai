import { test, expect, runtime, go, select, noOverflow, hit, textButton, leave } from './fixtures';
import { installSeoReports } from './seo-fixtures';
import type { Page, Locator } from '@playwright/test';
import type { StudioEnvelope } from '../../src/lib/studio-client';
import { readFileSync } from 'node:fs';

const productTable = (page: Page) => page.locator('.cs-products .cs-table');
const dataRows = (table: Locator) => table.locator('tbody tr[data-row-key]');
const row = (table: Locator, id: string) => table.locator(`tr[data-row-key="${id}"]`);
const guard = (page: Page, title: string) => page.getByRole('dialog', { name: `未保存 · ${title}`, exact: true });
async function reload(page: Page) {
  const accept = async (dialog: import('@playwright/test').Dialog) => { expect(dialog.type()).toBe('beforeunload'); await dialog.accept(); };
  page.on('dialog', accept);
  try { await page.reload(); await expect(page.locator('.shell-layout')).toBeVisible(); } finally { page.off('dialog', accept); }
}
async function nextPage(table: Locator) { await table.locator('.ant-pagination-next button').click(); await expect(table.locator('.ant-pagination-item-active')).toHaveAttribute('title', '2'); }

test('侧栏真实Wave点击、长名称和空值在桌面保持两行', async ({ page, ui }) => {
  for (const name of ['UI 回归测试站', 'VeryLongCompanyName'.repeat(8), '']) {
    ui.studio(state => { state.settings.name = name; state.settings.domain = name ? 'long-company-domain-'.repeat(7) + 'example.invalid' : ''; });
    await go(page, 'overview'); await reload(page);
    const button = page.locator('aside.shell-sidebar .shell-current-site');
    await button.hover(); await expect.poll(() => button.evaluate(el => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
    for (let i = 0; i < 2; i++) {
      await button.click();
      await expect.poll(() => button.evaluate(el => [...el.children].some(child => child.tagName === 'DIV'))).toBe(true);
      const metrics = await button.evaluate(el => { const copy = el.querySelector('.shell-site-copy')!, name = el.querySelector('.shell-site-name')!, domain = el.querySelector('.shell-site-domain')!, arrow = el.querySelector('.shell-site-chevron')!; return { direction: getComputedStyle(copy).flexDirection, display: getComputedStyle(copy).display, nameBottom: name.getBoundingClientRect().bottom, domainTop: domain.getBoundingClientRect().top, copyRight: copy.getBoundingClientRect().right, arrowLeft: arrow.getBoundingClientRect().left, nameOverflow: getComputedStyle(name).textOverflow, domainOverflow: getComputedStyle(domain).textOverflow }; });
      expect(metrics.direction).toBe('column'); expect(metrics.display).toBe('flex'); expect(metrics.domainTop).toBeGreaterThan(metrics.nameBottom); expect(metrics.copyRight).toBeLessThanOrEqual(metrics.arrowLeft); expect(metrics.nameOverflow).toBe('ellipsis'); expect(metrics.domainOverflow).toBe('ellipsis');
      await page.mouse.click(700, 80);
      await expect.poll(() => page.locator('.ant-dropdown:visible').count()).toBe(0);
    }
    if (!name) await expect(button).toContainText('未命名站点');
  }
});

test('手机375与390侧栏实际点击、键盘和弹层保持可用', async ({ page, ui }) => {
  ui.studio(state => { state.settings.name = '很长的国际制造公司'.repeat(10); state.settings.domain = 'international-company-'.repeat(6) + 'example.invalid'; });
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 }); await go(page, 'overview'); await reload(page);
    await page.getByRole('button', { name: '打开主导航', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '工作空间', exact: true }), button = drawer.locator('.shell-current-site');
    await button.click(); await expect.poll(() => button.evaluate(el => [...el.children].some(child => child.tagName === 'DIV'))).toBe(true);
    await expect.poll(() => button.evaluate(el => { const title = el.querySelector('.shell-site-name')!.getBoundingClientRect(), domain = el.querySelector('.shell-site-domain')!.getBoundingClientRect(); return domain.top > title.bottom && domain.right <= el.getBoundingClientRect().right; })).toBe(true);
    await drawer.locator('.ant-drawer-title').click(); await expect.poll(() => page.locator('.ant-dropdown:visible').count()).toBe(0);
    await button.focus(); await page.keyboard.press('Enter'); await expect(page.locator('.ant-dropdown:visible')).toBeVisible();
    await drawer.locator('.ant-drawer-title').click(); await drawer.locator('.ant-drawer-close').click(); await expect(drawer).toBeHidden(); await noOverflow(page);
  }
});

test('平板768主要入口不产生整页横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  for (const screen of ['overview', 'pages', 'products', 'content-models', 'media', 'inquiries', 'templates', 'theme', 'global-design', 'releases', 'seo', 'settings']) { await go(page, screen); await noOverflow(page); }
});

test('产品语言与标签组合清除后完整恢复列表', async ({ page }) => {
  await go(page, 'products'); await expect(dataRows(productTable(page))).toHaveCount(8);
  await select(page, '内容语言筛选', 'Deutsch'); await select(page, '产品标签筛选', '专项测试标签');
  await expect(dataRows(productTable(page))).toHaveCount(0);
  await textButton(page, '清除筛选').click();
  await expect(dataRows(productTable(page))).toHaveCount(8);
  await expect(page.locator('.cs-toolbar')).toContainText('全部语言'); await expect(page.locator('.cs-toolbar')).toContainText('全部标签');
});

for (const width of [375, 390]) test(`产品手机${width}长内容展开后完整可读`, async ({ page, ui }) => {
  // 单语言布局是明确的GET界面夹具；不改数据库或保存语言设置。
  ui.studio(state => { state.settings.locales = [{ code: 'en', label: 'English' }]; state.settings.language = 'en'; });
  await page.setViewportSize({ width, height: 1000 }); await go(page, 'products');
  await expect.poll(() => page.getByRole('combobox', { name: '产品分类', exact: true }).evaluate(el => el.closest('.ant-select')!.getBoundingClientRect().width)).toBeGreaterThanOrEqual(140);
  const table = productTable(page), record = row(table, 'p1');
  await record.getByRole('button', { name: `查看产品详情：${runtime.fixture.longName}`, exact: true }).click();
  const detail = table.locator('.ant-table-expanded-row').first();
  await expect(detail).toContainText(runtime.fixture.longSku); await expect(detail).toContainText('零值参数'); await expect(detail).toContainText('布尔参数');
  // 共用字段格式器把false显示为No，不能把它当作缺失或未填写。
  await expect(detail.locator('.ant-descriptions-item-content').filter({ hasText: /^0$/ })).toHaveCount(1); await expect(detail.locator('.ant-descriptions-item-content').filter({ hasText: /^No$/ })).toHaveCount(1);
  await noOverflow(page, table);
  await expect.poll(() => detail.locator('.ant-descriptions-item-content').last().evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(180);
});

test('产品桌面第2页切手机再切回仍是同一页', async ({ page }) => {
  await go(page, 'products'); const table = productTable(page); await nextPage(table);
  const ids = await dataRows(table).evaluateAll(rows => rows.map(el => el.getAttribute('data-row-key')));
  await page.setViewportSize({ width: 390, height: 1000 }); await expect(table.locator('.mobile-record-toggle').first()).toBeVisible();
  expect(await dataRows(table).evaluateAll(rows => rows.map(el => el.getAttribute('data-row-key')))).toEqual(ids);
  await page.setViewportSize({ width: 1600, height: 1000 }); await expect(table.getByRole('columnheader', { name: '材质', exact: true })).toBeVisible(); await expect(table.locator('.ant-pagination-item-active')).toHaveAttribute('title', '2');
});

test.describe('真实只读账号', () => {
  test.use({ storageState: runtime.viewerAuth });
  for (const width of [1600, 390]) test(`只读成员${width}可查找资料但不能写入`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    expect((await (await page.request.get('/api/auth/get-session')).json()).user.role).toBe('viewer');
    await go(page, 'products'); const search = page.getByRole('textbox', { name: '搜索产品', exact: true });
    await expect(search).toBeEnabled(); await search.fill('UI Product 19'); await expect(dataRows(productTable(page))).toHaveCount(1); await search.fill('');
    await expect(textButton(page, '新建产品')).toBeDisabled(); for (const checkbox of await productTable(page).getByRole('checkbox').all()) await expect(checkbox).toBeDisabled();
    await select(page, '产品分类', '分类 Beta'); await expect(dataRows(productTable(page)).first()).toContainText('UI Product');
    if (width < 768) { await productTable(page).locator('.mobile-record-toggle').first().click(); await expect(productTable(page).locator('.ant-table-expanded-row')).toBeVisible(); }
    await go(page, 'pages'); const pageSearch = page.getByRole('textbox', { name: '搜索页面', exact: true }); await expect(pageSearch).toBeEnabled(); await pageSearch.fill('UI Page 12'); const pages = page.locator('.pages-records-table'); await expect(dataRows(pages)).toHaveCount(1); await pageSearch.fill('');
    if (width < 768) { await pages.getByRole('button', { name: /^查看页面详情/ }).first().click(); await expect(pages.locator('.ant-table-expanded-row')).toBeVisible(); }
    for (const action of await pages.getByRole('button', { name: /^编辑|更多操作$/ }).all()) await expect(action).toBeDisabled();
    await go(page, 'releases'); await expect(textButton(page, '发布更改')).toBeDisabled();
    // 演练会保留更新的历史版本；分页断言应读取当前公开的合成快照，不依赖列表顺序。
    const currentRelease = page.locator('.sys-release-item').filter({ has: page.getByText('当前公开版本', { exact: true }) }); await expect(currentRelease).toHaveCount(1);
    await textButton(currentRelease, '查看版本内容').click(); const published = page.getByRole('dialog', { name: '已发布的版本内容', exact: true }); await expect(published).toBeVisible(); await nextPage(published.locator('.release-products-table')); await expect(row(published.locator('.release-products-table'), 'p9')).toBeVisible(); await expect(textButton(published, '找回内容并继续编辑')).toHaveCount(0); await published.locator('.ant-drawer-close').click(); await expect(published).toBeHidden();
    await go(page, 'media'); await expect(page.getByRole('textbox', { name: '搜索素材', exact: true })).toBeEnabled(); await expect(textButton(page, '上传素材')).toBeDisabled();
    for (const checkbox of await page.locator('.cs-media-card').getByRole('checkbox').all()) await expect(checkbox).toBeDisabled();
    const before = await (await page.request.get('/api/studio')).json();
    const denied = await page.request.patch('/api/studio', { headers: { Origin: runtime.origin }, data: { expectedRevision: before.revision, patch: { products: [] } } }); expect(denied.status()).toBe(403); expect((await denied.json()).error).toBe('当前账号没有执行此操作的权限');
    expect((await (await page.request.get('/api/studio')).json()).revision).toBe(before.revision);
  });
});

test('主题未保存确认支持继续、保留恢复和放弃', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 }); await go(page, 'theme');
  const radius = page.getByRole('spinbutton').first(), original = await radius.inputValue(); await radius.fill(original === '18' ? '16' : '18'); const changed = await radius.inputValue();
  await leave(page, 'products', '产品管理'); const confirm = guard(page, '网站外观'); await expect(confirm).toBeVisible();
  await textButton(confirm, '继续编辑').click(); await expect(radius).toHaveValue(changed);
  await leave(page, 'products', '产品管理'); await textButton(confirm, '保留输入并离开').click(); await expect(page).toHaveURL(/#products$/);
  await go(page, 'theme'); await reload(page); await expect(radius).toHaveValue(changed);
  await leave(page, 'products', '产品管理'); await textButton(confirm, '放弃修改').click(); await expect(page).toHaveURL(/#products$/);
  await go(page, 'theme'); await expect(radius).toHaveValue(original);
});

test('网站资料真实保存并刷新后保持，成功不误报未保存', async ({ page, ui }) => {
  ui.allowWrite('PATCH', '/api/studio'); await go(page, 'settings'); const name = page.getByRole('textbox', { name: /网站名称$/ });
  const original = await name.inputValue(), changed = 'UI 已核对的网站名称'; await name.fill(changed); await textButton(page.locator('main'), '保存资料').click();
  await expect(page.getByText('网站资料草稿已保存', { exact: true })).toBeVisible(); await leave(page, 'products', '产品管理'); await expect(page).toHaveURL(/#products$/);
  await go(page, 'settings'); await reload(page); await expect(name).toHaveValue(changed);
  await name.fill(original); await textButton(page.locator('main'), '保存资料').click(); await expect.poll(async () => (await (await page.request.get('/api/studio')).json()).state.settings.name).toBe(original);
  expect(ui.writes).toHaveLength(2);
});

test('素材未保存确认保留恢复及真实保存刷新', async ({ page, ui }) => {
  ui.allowWrite('PATCH', '/api/studio'); await page.setViewportSize({ width: 390, height: 1000 }); await go(page, 'media');
  await page.locator('.cs-media-card').first().click(); const drawer = page.getByRole('dialog', { name: '素材详情', exact: true }); const name = drawer.getByRole('textbox', { name: /文件名称$/ });
  const original = await name.inputValue(), changed = 'UI 已核对的素材说明'; await name.fill(changed); await drawer.locator('.ant-drawer-close').click();
  const confirm = page.getByRole('dialog').filter({ hasText: '输入尚未提交' }); await textButton(confirm, '继续编辑').click(); await expect(name).toHaveValue(changed);
  await drawer.locator('.ant-drawer-close').click(); await textButton(confirm, '保留输入并离开').click(); await expect(drawer).toBeHidden();
  await reload(page); await expect(drawer).toBeVisible(); await expect(name).toHaveValue(changed);
  await textButton(drawer, '保存修改').click(); await expect(drawer).toBeHidden(); await reload(page);
  await page.locator('.cs-media-card').first().click(); await expect(name).toHaveValue(changed);
  await name.fill(original); await textButton(drawer, '保存修改').click(); await expect(drawer).toBeHidden(); expect(ui.writes).toHaveLength(2);
});

test('保存503不丢输入，错误条不遮挡搜索和离开确认', async ({ page, ui }) => {
  ui.failOnce('PATCH', '/api/studio', 503, 'UI synthetic save failure'); await page.setViewportSize({ width: 390, height: 1000 }); await go(page, 'theme');
  const radius = page.getByRole('spinbutton').first(); await radius.fill('20'); await textButton(page, '保存外观').click(); await expect(page.getByText('工作区同步未完成', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+k'); const search = page.getByRole('dialog', { name: '搜索工作空间', exact: true }); await expect(search).toBeVisible(); await hit(search.locator('.ant-modal-close')); await search.locator('.ant-modal-close').click();
  await leave(page, 'products', '产品管理'); const confirm = guard(page, '网站外观'); await expect(confirm).toBeVisible(); await hit(textButton(confirm, '保存并继续')); await textButton(confirm, '保存并继续').click(); await expect(confirm).toContainText('保存未完成'); await expect(page).toHaveURL(/#theme$/); await textButton(confirm, '继续编辑').click(); await expect(radius).toHaveValue('20'); expect(ui.writes).toEqual([]);
});

for (const remoteAction of ['修改', '删除', '无关修改']) test(`产品保存失败后读取最新工作区：${remoteAction === '无关修改' ? '其他产品变化仍可保存原表单' : `保留已${remoteAction}产品的服务器结果`}`, async ({ page, ui }) => {
  test.setTimeout(60000);
  const origin = new URL(runtime.origin); expect(origin.hostname).toBe('127.0.0.1'); expect(origin.port).not.toBe('3200');
  const read = async () => { const response = await page.request.get('/api/studio'); expect(response.ok()).toBe(true); return await response.json() as StudioEnvelope; };
  const initial = await read(), original = initial.state.products.find(item => item.id === 'p2')!; expect(original).toBeTruthy();
  ui.allowWrite('PATCH', '/api/studio'); ui.failOnce('PATCH', '/api/studio', 503, 'UI synthetic product save failure');
  try {
    await go(page, 'products'); await row(productTable(page), original.id).getByRole('button', { name: `编辑${original.name}`, exact: true }).click();
    const name = page.getByRole('textbox', { name: '产品名称', exact: true }), localName = 'Product kept in unsaved editor';
    await name.fill(localName); await textButton(page, '保存产品').click(); await expect(page.getByText('工作区同步未完成', { exact: true })).toBeVisible();
    // 第二个已认证请求真实修改数据库；重新加载只更新工作区，不应把旧表单当作最新产品。
    const current = await read(), remoteMaterial = 'Other window supplied material';
    const remoteId = remoteAction === '无关修改' ? 'p3' : original.id;
    const products = remoteAction === '删除' ? current.state.products.filter(item => item.id !== original.id) : current.state.products.map(item => item.id === remoteId ? { ...item, material: remoteMaterial } : item);
    const changed = await page.request.patch('/api/studio', { headers: { Origin: runtime.origin }, data: { expectedRevision: current.revision, patch: { products } } }); expect(changed.ok()).toBe(true);
    await textButton(page, '重新加载').click(); await page.getByRole('dialog').filter({ hasText: '重新加载服务器版本？' }).getByRole('button', { name: '确 定', exact: true }).click();
    await expect(page.getByText('工作区同步未完成', { exact: true })).toBeHidden(); await expect(name).toHaveValue(localName);
    await textButton(page, '保存产品').click();
    if (remoteAction === '无关修改') {
      await expect(name).toBeHidden(); const latest = await read();
      expect(latest.state.products.find(item => item.id === original.id)?.name).toBe(localName); expect(latest.state.products.find(item => item.id === remoteId)?.material).toBe(remoteMaterial);
      expect(ui.writes).toEqual([{ method: 'PATCH', path: '/api/studio' }]);
    } else {
      await expect(page.locator('.shell-sync-error').getByText('这条产品已在别处更新或删除，当前输入已保留，请返回列表核对最新产品。', { exact: true })).toBeVisible(); await expect(name).toHaveValue(localName);
      const latest = await read(), remote = latest.state.products.find(item => item.id === original.id);
      if (remoteAction === '删除') expect(remote).toBeUndefined();
      else { expect(remote?.material).toBe(remoteMaterial); expect(remote?.name).toBe(original.name); }
      expect(ui.writes).toEqual([]);
    }
  } finally {
    await ui.closeOwnedPage();
    const current = await read(), restored = await page.request.patch('/api/studio', { headers: { Origin: runtime.origin }, data: { expectedRevision: current.revision, patch: { products: initial.state.products } } }); expect(restored.ok()).toBe(true);
  }
});

test.describe('产品恢复输入', () => {
  // 仅这些用例允许下载本站合成恢复稿，其他浏览器用例仍默认禁止下载。
  test.use({ acceptDownloads: true });
for (const recoveryKind of ['原来源', '旧格式', '已删除']) test(`产品会话恢复：${recoveryKind}输入不会未经核对覆盖服务器`, async ({ page, ui }, testInfo) => {
  test.setTimeout(60000); expect(new URL(runtime.origin).port).not.toBe('3200');
  const read = async () => { const response = await page.request.get('/api/studio'); expect(response.ok()).toBe(true); return await response.json() as StudioEnvelope; };
  const initial = await read(), original = initial.state.products.find(item => item.id === 'p2')!, session = await (await page.request.get('/api/auth/get-session')).json(), key = `form-studio:product-recovery:${session.user.id}`;
  ui.allowWrite('PATCH', '/api/studio');
  try {
    await go(page, 'products'); await row(productTable(page), original.id).getByRole('button', { name: `编辑${original.name}`, exact: true }).click();
    const localName = 'Local product input retained across session'; await page.getByRole('textbox', { name: '产品名称', exact: true }).fill(localName);
    // 触发真实组件的会话过期保留事件；仅用于隔离测试，不读取或改变正式认证。
    await page.evaluate(() => window.dispatchEvent(new Event('form-studio:session-expired')));
    const retained = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || 'null'), key); expect(retained.fields.name).toBe(localName); expect(retained.source.id).toBe(original.id); expect(retained.source.material).toBe(original.material);
    if (recoveryKind === '旧格式') { await page.evaluate(key => { const value = JSON.parse(sessionStorage.getItem(key)!); delete value.source; sessionStorage.setItem(key, JSON.stringify(value)); }, key); await page.setViewportSize({ width: 390, height: 1000 }); }
    const current = await read(), remoteMaterial = 'Current server material after prior session';
    const products = recoveryKind === '已删除' ? current.state.products.filter(item => item.id !== original.id) : current.state.products.map(item => item.id === original.id ? { ...item, material: remoteMaterial } : item);
    const changed = await page.request.patch('/api/studio', { headers: { Origin: runtime.origin }, data: { expectedRevision: current.revision, patch: { products } } }); expect(changed.ok()).toBe(true);
    await page.reload(); await expect(page.locator('.shell-layout')).toBeVisible();
    if (recoveryKind === '已删除') {
      await expect(page.getByText('有一份已删除产品的恢复输入', { exact: true })).toBeVisible();
      const downloaded = page.waitForEvent('download'); await textButton(page, '下载恢复输入').click(); const download = await downloaded; expect(download.suggestedFilename()).toBe('product-recovery.json');
      expect(JSON.parse(readFileSync((await download.path())!, 'utf8')).fields.name).toBe(localName); expect((await read()).state.products.some(item => item.id === original.id)).toBe(false);
      expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).fields.name, key)).toBe(localName); expect(ui.writes).toEqual([]);
    } else {
      const name = page.getByRole('textbox', { name: '产品名称', exact: true }); await expect(name).toHaveValue(localName); await textButton(page, '保存产品').click();
      if (recoveryKind === '原来源') {
        await expect(page.locator('.shell-sync-error').getByText('这条产品已在别处更新或删除，当前输入已保留，请返回列表核对最新产品。', { exact: true })).toBeVisible(); await expect(name).toHaveValue(localName); expect((await read()).state.products.find(item => item.id === original.id)?.material).toBe(remoteMaterial); expect(ui.writes).toEqual([]);
      } else {
        const review = page.getByRole('dialog', { name: '核对旧恢复稿与当前产品', exact: true }); await expect(review).toContainText(remoteMaterial); await expect(review).toContainText(localName);
        await testInfo.attach('legacy-recovery-mobile', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
        await testInfo.attach('legacy-recovery-layout', { body: Buffer.from(JSON.stringify(await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll('body *')].flatMap(element => { const rect=element.getBoundingClientRect(); return rect.right>innerWidth+2&&rect.width>0?[{tag:element.tagName,classes:String(element.className),x:rect.x,width:rect.width,scroll:element.scrollWidth,client:element.clientWidth}]:[]; }).slice(0,30) })))), contentType: 'application/json' });
        await noOverflow(page);
        await textButton(review, '返回编辑，保留输入').click(); await expect(name).toHaveValue(localName); expect((await read()).state.products.find(item => item.id === original.id)?.material).toBe(remoteMaterial); expect(ui.writes).toEqual([]);
        await textButton(page, '保存产品').click(); await textButton(review, '已核对，用恢复输入保存').click(); await expect(name).toBeHidden();
        const saved = (await read()).state.products.find(item => item.id === original.id)!; expect(saved.name).toBe(localName); expect(saved.material).toBe(original.material); expect(ui.writes).toEqual([{ method: 'PATCH', path: '/api/studio' }]);
      }
    }
  } finally {
    await ui.closeOwnedPage(); const current = await read(), restored = await page.request.patch('/api/studio', { headers: { Origin: runtime.origin }, data: { expectedRevision: current.revision, patch: { products: initial.state.products } } }); expect(restored.ok()).toBe(true);
  }
});

});

for (const width of [375, 390]) test(`SEO手机${width}诊断与报告详情保留0、缺失和来源`, async ({ page, ui }) => {
  const reports = installSeoReports(ui); await page.setViewportSize({ width, height: 1000 }); await go(page, 'seo');
  const diagnostics = page.locator('.seo-diagnostics-table'); await expect(dataRows(diagnostics).first()).toBeVisible(); await dataRows(diagnostics).first().getByRole('button', { name: '查看详情', exact: true }).click(); await expect(diagnostics.locator('.ant-table-expanded-row')).toContainText('检查结果'); await noOverflow(page, diagnostics);
  await page.getByRole('tab', { name: 'Google搜索表现', exact: true }).click(); const search = page.locator('.seo-search-table'); await expect(dataRows(search)).toHaveCount(15); await nextPage(search);
  const searchRow = row(search, '16'); await searchRow.getByRole('button', { name: '查看详情', exact: true }).click(); const searchDetails = search.locator('.ant-table-expanded-row'); await expect(searchDetails).toContainText(reports.search.source.name); await expect(searchDetails).toContainText('0.00%'); await expect(searchDetails).toContainText('2025-12-01'); await noOverflow(page, search);
  await page.getByRole('tab', { name: '关键词研究', exact: true }).click(); const keywords = page.locator('.seo-keyword-table'); await nextPage(keywords); await row(keywords, '16').getByRole('button', { name: '查看详情', exact: true }).click();
  const keywordDetails = keywords.locator('.ant-table-expanded-row'); await expect(keywordDetails).toContainText('CPC（USD）'); await expect(keywordDetails).toContainText(reports.keyword.source.name); await expect(keywordDetails.locator('.ant-descriptions-item-content').filter({ hasText: /^0$/ })).toHaveCount(3); await expect(keywordDetails).toContainText('2025'); await noOverflow(page, keywords);
  await row(keywords, '17').getByRole('button', { name: '查看详情', exact: true }).click(); const missingDetails = keywords.locator('.ant-table-expanded-row').filter({ hasText: reports.keyword.rows[16].keyword }); await expect(missingDetails.locator('.ant-descriptions-item-content').filter({ hasText: /^未提供$/ })).toHaveCount(4);
  await page.setViewportSize({ width: 768, height: 1000 }); await expect(keywords.locator('.ant-pagination-item-active')).toHaveAttribute('title', '2'); await page.setViewportSize({ width, height: 1000 }); await expect(row(keywords, '16').getByRole('button', { name: '收起详情', exact: true })).toHaveAttribute('aria-expanded', 'true');
});

test('SEO桌面保留完整指标列与报告分页', async ({ page, ui }) => {
  installSeoReports(ui); await go(page, 'seo'); await page.getByRole('tab', { name: 'Google搜索表现', exact: true }).click(); const search = page.locator('.seo-search-table'); await expect(search.getByRole('columnheader', { name: '点击率', exact: true })).toBeVisible(); await expect(search.getByRole('columnheader', { name: '平均位置', exact: true })).toBeVisible(); await nextPage(search); await expect(row(search, '16')).toContainText('0.00%');
  await page.getByRole('tab', { name: '关键词研究', exact: true }).click(); const keywords = page.locator('.seo-keyword-table'); await expect(keywords.getByRole('columnheader').filter({ hasText: 'CPC' })).toBeVisible(); await expect(keywords.getByRole('columnheader').filter({ hasText: '竞争' }).first()).toBeVisible();
});

for (const width of [375, 390]) test(`版本详情手机${width}完整路径、参数和分页可读`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); await go(page, 'releases');
  const currentRelease = page.locator('.sys-release-item').filter({ has: page.getByText('当前公开版本', { exact: true }) }); await expect(currentRelease).toHaveCount(1);
  await textButton(currentRelease, '查看版本内容').click(); const drawer = page.getByRole('dialog', { name: '已发布的版本内容', exact: true }); await expect(drawer).toBeVisible();
  const pages = drawer.locator('.release-pages-table'); const longPage = row(pages, 'ui-page-1'); await longPage.getByRole('button', { name: /^查看页面详情/ }).click(); await expect(pages.locator('.ant-table-expanded-row')).toContainText(runtime.fixture.longPagePath); await noOverflow(page, pages);
  const products = drawer.locator('.release-products-table'); await row(products, 'p1').getByRole('button', { name: `查看产品详情：${runtime.fixture.longName}`, exact: true }).click(); const detail = products.locator('.ant-table-expanded-row'); await expect(detail).toContainText(runtime.fixture.longSku); await expect(detail).toContainText('零值参数'); await expect(detail).toContainText('布尔参数'); await expect.poll(() => detail.locator('.ant-descriptions-item-content').last().evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(180); await noOverflow(page, products);
  await nextPage(products); await expect(row(products, 'p9')).toBeVisible(); await page.setViewportSize({ width: 1600, height: 1000 }); await expect(products.getByRole('columnheader', { name: '型号', exact: true })).toBeVisible(); await expect(products.locator('.ant-pagination-item-active')).toHaveAttribute('title', '2'); await page.setViewportSize({ width, height: 1000 }); await expect(row(products, 'p9')).toBeVisible();
  const entries = drawer.locator('.release-entries-table'); await nextPage(entries); await row(entries, 'ui-entry-9').getByRole('button', { name: /^查看内容详情/ }).click(); await expect(entries.locator('.ant-table-expanded-row')).toContainText('/stories/story-'); await noOverflow(page, entries);
});

test('版本详情桌面保留全部列和可展开字段', async ({ page }) => {
  await go(page, 'releases');
  const currentRelease = page.locator('.sys-release-item').filter({ has: page.getByText('当前公开版本', { exact: true }) }); await expect(currentRelease).toHaveCount(1);
  await textButton(currentRelease, '查看版本内容').click(); const drawer = page.getByRole('dialog', { name: '已发布的版本内容', exact: true });
  await expect(drawer.locator('.release-pages-table').getByRole('columnheader', { name: '路径', exact: true })).toBeVisible(); const products = drawer.locator('.release-products-table'); await expect(products.getByRole('columnheader', { name: '型号', exact: true })).toBeVisible(); await nextPage(products); await expect(row(products, 'p9')).toContainText('UI-SKU-9');
  await expect(drawer.locator('.release-entries-table').getByRole('columnheader', { name: '历史详情路径', exact: true })).toBeVisible();
});

for (const remoteAction of ['修改', '删除', '无关修改']) test(`栏目保存失败后读取最新工作区：${remoteAction === '无关修改' ? '其他栏目变化仍可保存原表单' : `保留已${remoteAction}栏目的服务器结果`}`, async ({ page, ui }) => {
  test.setTimeout(60000); expect(new URL(runtime.origin).port).not.toBe('3200');
  const read = async () => { const response=await page.request.get('/api/studio');expect(response.ok()).toBe(true);return await response.json() as StudioEnvelope; };
  const initial=await read(),id=`ui-column-conflict-${remoteAction==='修改'?'update':remoteAction==='删除'?'delete':'unrelated'}`,name=`并发栏目${remoteAction}`;
  const created=await page.request.patch('/api/studio',{headers:{Origin:runtime.origin},data:{expectedRevision:initial.revision,patch:{contentModels:[...(initial.state.contentModels||[]),{id,name,description:'Synthetic local review only',target:'content',fields:[],updated:''}]}}});expect(created.ok()).toBe(true);
  ui.allowWrite('PATCH','/api/studio');ui.failOnce('PATCH','/api/studio',503,'UI synthetic column save failure');
  try {
    await go(page,'content-models');await page.getByRole('menuitem').filter({hasText:name}).click();await textButton(page,'栏目设置').click();await page.getByRole('menuitem',{name:'编辑填写项目',exact:true}).click();
    const drawer=page.getByRole('dialog').filter({has:page.getByRole('textbox',{name:'栏目名称',exact:true})}),input=drawer.getByRole('textbox',{name:'栏目名称',exact:true}),localName='Unsaved column name';
    await input.fill(localName);await textButton(drawer,'保存栏目').click();await expect(page.getByText('工作区同步未完成',{exact:true})).toBeVisible();
    // 真实独立请求修改/删除目标，再刷新runtime；未保存的栏目表单必须保留自身来源版本。
    const current=await read(),remoteId=remoteAction==='无关修改'?'ui-story-model':id,remoteDescription='Other window column description';
    const models=remoteAction==='删除'?current.state.contentModels!.filter(m=>m.id!==id):current.state.contentModels!.map(m=>m.id===remoteId?{...m,description:remoteDescription}:m);
    const changed=await page.request.patch('/api/studio',{headers:{Origin:runtime.origin},data:{expectedRevision:current.revision,patch:{contentModels:models}}});expect(changed.ok()).toBe(true);
    // 栏目编辑在模态Drawer中；先触发已有会话保留入口，再真实重载恢复输入，不穿透遮罩。
    await page.evaluate(()=>window.dispatchEvent(new Event('form-studio:session-expired')));await reload(page);
    await expect(page.getByText('工作区同步未完成',{exact:true})).toBeHidden();await expect(input).toHaveValue(localName);
    if(remoteAction==='删除'){
      // 目标删除后缓存会缺existingId；恢复仍须用原服务端日期识别旧栏目，禁止当新栏目重建。
      await page.evaluate(()=>window.dispatchEvent(new Event('form-studio:session-expired')));await page.reload();await expect(input).toHaveValue(localName);
    }
    await textButton(drawer,'保存栏目').click();
    const latest=await read();
    if(remoteAction==='无关修改'){
      await expect(drawer).toBeHidden();const confirmed=await read();expect(confirmed.state.contentModels!.find(m=>m.id===id)?.name).toBe(localName);expect(confirmed.state.contentModels!.find(m=>m.id===remoteId)?.description).toBe(remoteDescription);expect(ui.writes).toEqual([{method:'PATCH',path:'/api/studio'}]);
    }else{
      await expect(drawer.getByText('这个栏目已在别处更新或删除，当前输入已保留，请返回列表核对最新栏目。',{exact:true})).toBeVisible();await expect(input).toHaveValue(localName);
      const remote=latest.state.contentModels!.find(m=>m.id===id);if(remoteAction==='删除')expect(remote).toBeUndefined();else{expect(remote?.name).toBe(name);expect(remote?.description).toBe(remoteDescription);}
      await expect(page.getByText(/外部操作结果尚未确认/)).toBeHidden();expect(ui.writes).toEqual([]);
    }
  }finally{await ui.closeOwnedPage();const current=await read(),restored=await page.request.patch('/api/studio',{headers:{Origin:runtime.origin},data:{expectedRevision:current.revision,patch:{contentModels:initial.state.contentModels}}});expect(restored.ok()).toBe(true);}
});

test('文章读取最新工作区后阻止旧表单覆盖，并把本地冲突作为确定性拒绝',async({page,ui})=>{
  test.setTimeout(60000);expect(new URL(runtime.origin).port).not.toBe('3200');
  const read=async()=>{const response=await page.request.get('/api/studio');expect(response.ok()).toBe(true);return await response.json() as StudioEnvelope;};
  const initial=await read(),original=initial.state.contentEntries!.find(e=>e.id==='ui-entry-2')!;expect(original).toBeTruthy();
  ui.allowWrite('PATCH','/api/studio');ui.failOnce('PATCH','/api/studio',503,'UI synthetic entry save failure');
  try{
    await go(page,'content-models');await row(page.locator('.cm-table-card .ant-table'),original.id).getByRole('button',{name:/^编\s*辑$/}).click();
    const title=page.locator('.content-entry-title input'),localTitle='Unsaved article input';await title.fill(localTitle);await textButton(page,'保存草稿').click();await expect(page.getByText('工作区同步未完成',{exact:true})).toBeVisible();
    const current=await read(),remoteTitle='Remote article update';const changed=await page.request.patch('/api/studio',{headers:{Origin:runtime.origin},data:{expectedRevision:current.revision,patch:{contentEntries:current.state.contentEntries!.map(e=>e.id===original.id?{...e,title:remoteTitle}:e)}}});expect(changed.ok()).toBe(true);
    await textButton(page,'重新加载').click();await page.getByRole('dialog').filter({hasText:'重新加载服务器版本？'}).getByRole('button',{name:'确 定',exact:true}).click();await expect(page.getByText('工作区同步未完成',{exact:true})).toBeHidden();
    await expect(title).toHaveValue(localTitle);await textButton(page,'保存草稿').click();await expect(page.locator('.content-entry-alert').getByText('这条内容已在别处更新，当前输入已保留，请先核对最新内容。',{exact:true})).toBeVisible();
    await expect(page.getByText(/外部操作结果尚未确认/)).toBeHidden();await expect(title).toHaveValue(localTitle);expect((await read()).state.contentEntries!.find(e=>e.id===original.id)?.title).toBe(remoteTitle);expect(ui.writes).toEqual([]);
  }finally{await ui.closeOwnedPage();const current=await read(),restored=await page.request.patch('/api/studio',{headers:{Origin:runtime.origin},data:{expectedRevision:current.revision,patch:{contentEntries:initial.state.contentEntries}}});expect(restored.ok()).toBe(true);}
});
