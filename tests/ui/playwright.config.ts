import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 只能由隔离包装器提供随机实例；直接运行playwright不能回落到正式3200。
const configPath = process.env.UI_TEST_RUN_CONFIG;
if (!configPath || !process.env.UI_TEST_RUN_DIR) throw new Error('请通过 npm run test:ui 创建独立测试实例');
const runtime = JSON.parse(readFileSync(configPath, 'utf8')) as { origin: string; adminAuth: string };
const origin = new URL(runtime.origin);
if (origin.hostname !== '127.0.0.1' || origin.port === '3200' || !origin.port) throw new Error('UI测试来源不是独立随机端口');
const output = resolve(process.env.UI_TEST_RUN_DIR);

export default defineConfig({
  testDir: __dirname,
  testMatch: ['trade-components.spec.ts','multi-product-inquiry.spec.ts','editor-conflict-recovery.spec.ts','media-preview-recheck-repair.spec.ts','product-publish-race.spec.ts','publication-concurrency-recheck.spec.ts','editor-navigation-audit.spec.ts','product-audit-repair.spec.ts','localized-site-regression.spec.ts','content-draft-audit-repair.spec.ts','ai-design-quality.spec.ts','ai-industry-builder.spec.ts','ai-build-site-check.spec.ts','draft-site-check.spec.ts','editor-preview-context.spec.ts','shared-block-mobile.spec.ts','publication-preview.spec.ts','ai-build-chrome-migration.spec.ts','ai-batch.spec.ts','mcp-oauth.spec.ts','ai-design-asset-details.spec.ts','ai-source-materials.spec.ts','ai-source-merge-race.spec.ts','visual-full-review.spec.ts','ai-site-translation.spec.ts','seo-content.spec.ts','visual-review.spec.ts', 'product-detail.spec.ts', 'ai-translation.spec.ts', 'design-guidance.spec.ts', 'regression.spec.ts', 'ai-design.spec.ts', 'ai-site-design.spec.ts', 'ai-site-design-selection.spec.ts', 'ai-design-sections.spec.ts', 'ai-design-details.spec.ts', 'external-ai.spec.ts', 'external-content.spec.ts', 'ai-detail-design.spec.ts', 'mail-settings.spec.ts', 'account-recovery.spec.ts', 'launch-check.spec.ts', 'zz-fictional-pilot.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60000,
  // 新增离线OCR、整站翻译和授权闭环；保留原单用例超时与正式限流静默。
  globalTimeout: 20 * 60 * 1000,
  expect: { timeout: 8000 },
  outputDir: resolve(output, 'results'),
  reporter: [['list'], ['html', { outputFolder: resolve(output, 'report'), open: 'never' }], ['json', { outputFile: resolve(output, 'results.json') }]],
  use: {
    baseURL: runtime.origin,
    storageState: runtime.adminAuth,
    browserName: 'chromium',
    ...(process.env.UI_TEST_CHANNEL ? { channel: process.env.UI_TEST_CHANNEL } : {}),
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    serviceWorkers: 'block',
    acceptDownloads: false,
    screenshot: 'only-on-failure',
    video: 'off',
    // 原始trace可能包含临时Cookie，只有显式开启才写入独立private输出目录。
    trace: process.env.UI_TEST_TRACE === '1' ? 'retain-on-failure' : 'off',
  },
});
