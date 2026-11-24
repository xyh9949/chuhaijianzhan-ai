import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { chromium } from 'playwright-core';
import type { Data } from '@puckeditor/core';
import { createInitialDraft } from '../src/server/seed';
import { createSiteConfig } from '../src/lib/site-render-config';
import { createSandboxDocument } from '../src/lib/site-code-render';
import { visualFullNativePatch } from './fixtures/visual-full-native';
import { observePreviewImages } from './ui/visual-preview-images';

/** 独立本机SSR探针不读取数据库/模型；保留真实lazy和溢出裁剪，验证测试可见性判定。 */
async function main() {
  const original = createInitialDraft(), home = original.pages.find(page => page.slug === '/')!, draft = { ...original, ...visualFullNativePatch(original, home.id) }, stylesheet = readFileSync('src/lib/site.css', 'utf8'), picture = readFileSync('public/images/chair.jpg');
  let origin = '', imageReads = 0; const badRequests: string[] = [];
  const markup = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...draft, pageId: home.id, previewPrefix: '/preview/probe', products: draft.products.map(product => ({ ...product, status: 'published' as const })) }), data: draft.editorData[home.id] as Data }));
  const server = createServer((request, response) => {
    if (request.method !== 'GET') { badRequests.push('write'); response.writeHead(405); response.end(); return; }
    if (request.url === '/images/chair.jpg') { imageReads++; response.writeHead(200, { 'Content-Type': 'image/jpeg' }); response.end(picture); return; }
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url !== '/probe') { badRequests.push('unknown-path'); response.writeHead(404); response.end(); return; }
    const sandbox = createSandboxDocument({ markup, styles: [stylesheet], css: [], scripts: [], baseUrl: origin + '/probe', language: 'en', inspect: false });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><div style="height:20000px">Synthetic modal content above the preview</div><iframe title="Native preview" sandbox="allow-scripts" style="width:1280px;height:900px;border:0" srcdoc="${sandbox.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></body></html>`);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: process.env.UI_TEST_CHANNEL || 'chrome', headless: true }); const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort()); await page.goto(origin + '/probe');
    const parent = page.locator('iframe[title="Native preview"]'), frame = page.frameLocator('iframe[title="Native preview"]'); await frame.getByRole('heading', { name: 'Original full page heading', exact: true }).waitFor();
    const geometric = await frame.locator('img').evaluateAll(images => images.map(image => { const rect = image.getBoundingClientRect(); return { insideOwnViewport: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth, complete: (image as HTMLImageElement).complete, naturalWidth: (image as HTMLImageElement).naturalWidth }; }));
    const before = await observePreviewImages(frame.locator('img')); assert.ok(geometric.some(image => image.insideOwnViewport && !image.complete)); assert.equal(before.some(image => image.intersecting), false); assert.equal(imageReads, 0);
    await parent.scrollIntoViewIfNeeded(); const first = frame.locator('.site-carousel-track img').first(); await first.scrollIntoViewIfNeeded();
    await first.evaluate(image => (image as HTMLImageElement).complete ? Promise.resolve() : new Promise<void>((resolve, reject) => { image.addEventListener('load', () => resolve(), { once: true }); image.addEventListener('error', () => reject(Error('Native image failed')), { once: true }); }));
    assert.ok(await first.evaluate(image => (image as HTMLImageElement).naturalWidth > 0)); const after = await observePreviewImages(frame.locator('img')); assert.ok(after.some(image => image.intersecting && image.complete && image.naturalWidth > 0)); assert.ok(after.every(image => image.observed && (!image.intersecting || image.complete && image.naturalWidth > 0))); assert.deepEqual(badRequests, []);
    process.stdout.write(JSON.stringify({ passed: true, before, geometric, after, imageReads, modelCalls: 0, usedFormalInstance: false }) + '\n');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}
main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Native readiness probe failed') + '\n'); process.exitCode = 1; });
