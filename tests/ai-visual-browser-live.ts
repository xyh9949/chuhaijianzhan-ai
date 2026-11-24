import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createSandboxDocument } from '../src/lib/site-code-render';
import { captureVisualScreens } from '../src/server/ai-visual-browser';

/** 独立真实Chrome探针：仅合成HTTP站／Cookie，运行产物不接触正式数据库或模型。 */
async function main() {
  const previous = { ...process.env }, reads: string[] = [], writes: string[] = [];
  const markup = `<main class="editor-site" data-site-node-id="live-root" style="min-height:3300px;padding:24px;box-sizing:border-box">
    <h1 data-site-node-id="live-heading">Real segmented page</h1>
    <nav class="site-managed-navigation"><details><summary>Factory menu</summary><ul><li><a href="#live-tail">Tail</a></li><li><a href="https://external.example.invalid/">External</a></li></ul></details></nav>
    <div class="site-accordion" data-site-node-id="live-accordion"><details><summary>Packaging</summary><div>Actual unfolded content</div></details></div>
    <div class="site-tabs" data-site-node-id="live-tabs"><div class="site-tab"><input type="radio" id="live-tab-1" name="live-tabs" checked><label for="live-tab-1" style="grid-column:1">Overview</label><section>Overview content</section></div><div class="site-tab"><input type="radio" id="live-tab-2" name="live-tabs"><label for="live-tab-2" style="grid-column:2">Specifications</label><section>Second panel content</section></div></div>
    <div class="site-carousel" data-site-node-id="live-carousel"><div class="site-carousel-track"><figure id="live-slide-1"><p>First slide</p><nav><a href="#live-slide-2" aria-label="Next slide">Next</a></nav></figure><figure id="live-slide-2"><p>Second slide</p><nav><a href="#live-slide-1" aria-label="Next slide">Next</a></nav></figure></div></div>
    <form class="site-contact-form site-contact-form-native" data-form-demo="true"><label for="live-email">Email</label><input id="live-email" type="email" required><input id="unlabeled-field" type="text"><input type="hidden" value="SHOULD_NOT_BE_READ"><button type="submit" formaction="/api/public/forms/must-not-submit">Send</button></form>
    <a href="#missing-anchor">Broken local target</a><a class="editor-site-action" href="#live-tail">Go to supplied tail</a><div style="height:2300px"></div><h2 id="live-tail" data-site-node-id="live-tail">Actual bottom section</h2>
  </main>`;
  let origin = '';
  const server = createServer((incoming, response) => {
    if (incoming.method !== 'GET') { writes.push(`${incoming.method} ${incoming.url}`); response.writeHead(500); response.end(); return; }
    reads.push(incoming.url || '');
    if (incoming.headers.cookie !== 'visual-probe=synthetic-private') { response.writeHead(401); response.end('Unauthenticated'); return; }
    if (!['/preview/~site-design/live-probe/after', '/preview/~site-design/live-nested/after'].includes(incoming.url || '')) { response.writeHead(404); response.end(); return; }
    const actualMarkup = incoming.url?.includes('live-nested') ? markup.replace('<div style="height:2300px"></div>', '<div style="max-height:160px;overflow-y:auto"><div style="height:700px">Nested scroll content</div></div><div style="height:1700px"></div>') : markup;
    const sandbox = createSandboxDocument({ markup: actualMarkup, styles: [readFileSync('src/lib/site.css', 'utf8')], css: [], scripts: [], baseUrl: origin + incoming.url, language: 'en', inspect: false });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'must-not-reach-browser=synthetic; Path=/' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><iframe title="网站草稿隔离预览" sandbox="allow-scripts" style="width:100%;height:640px;border:0" srcdoc="${sandbox.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></body></html>`);
  });
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
    process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-visual-full-probe-secret-'.repeat(3); process.env.FORM_STUDIO_VISUAL_ORIGIN = origin; process.env.FORM_STUDIO_VISUAL_BROWSER_CHANNEL = process.env.FORM_STUDIO_VISUAL_BROWSER_CHANNEL || 'chrome'; delete process.env.FORM_STUDIO_VISUAL_DISABLED;
    const partial = await captureVisualScreens('/preview/~site-design/live-probe/after', ['mobile'], 'visual-probe=synthetic-private', AbortSignal.timeout(90000), { mode: 'page', startSection: 1, maxSections: 2, inspectInteractions: false });
    assert.equal(partial.images.length, 2); assert.deepEqual(partial.images.map(image => image.id), ['mobile-section-1', 'mobile-section-2']); assert.equal(partial.pageCoverage[0].complete, false); assert.equal(partial.pageCoverage[0].nextStartSection, 3); assert.ok(partial.images[1].section!.from > 0);
    const continuation = await captureVisualScreens('/preview/~site-design/live-probe/after', ['mobile'], 'visual-probe=synthetic-private', AbortSignal.timeout(90000), { mode: 'page', startSection: 3, maxSections: 6, inspectInteractions: false });
    assert.equal(continuation.images[0].id, 'mobile-section-3'); assert.equal(continuation.pageCoverage[0].complete, false); assert.equal(continuation.pageCoverage[0].nextStartSection, undefined); assert.match(continuation.pageCoverage[0].reason!, /前面的页段未包含/);
    const full = await captureVisualScreens('/preview/~site-design/live-probe/after', ['mobile'], 'visual-probe=synthetic-private', AbortSignal.timeout(90000), { mode: 'page', startSection: 1, maxSections: 6, inspectInteractions: true });
    assert.equal(full.pageCoverage[0].complete, true); assert.equal(full.pageCoverage[0].nextStartSection, undefined); assert.ok(full.images.some(image => image.nodes.some(node => node.id === 'live-tail')));
    for (const kind of ['menu', 'accordion', 'tabs', 'carousel']) assert.ok(full.observations.some(item => item.kind === kind && item.status === 'checked'), `${kind}必须在真实浏览器中操作成功`);
    assert.ok(full.observations.some(item => item.kind === 'form' && item.status === 'warning' && item.detail.includes('1个缺少关联标签')));
    assert.ok(full.observations.some(item => item.kind === 'anchor' && item.status === 'warning'));
    assert.ok(full.observations.some(item => item.kind === 'anchor' && item.status === 'checked' && item.title === '同页按钮实际点击'));
    const nested = await captureVisualScreens('/preview/~site-design/live-nested/after', ['mobile'], 'visual-probe=synthetic-private', AbortSignal.timeout(90000), { mode: 'page', startSection: 1, maxSections: 6, inspectInteractions: false });
    assert.equal(nested.pageCoverage[0].complete, false); assert.match(nested.pageCoverage[0].reason!, /独立纵向滚动/); assert.ok(nested.observations.some(item => item.kind === 'coverage' && item.status === 'skipped'));
    assert.doesNotMatch(JSON.stringify(full.observations), /SHOULD_NOT_BE_READ/); assert.equal(writes.length, 0); assert.ok(reads.every(path => ['/preview/~site-design/live-probe/after', '/preview/~site-design/live-nested/after'].includes(path)));
    for (const image of full.images) { assert.equal(image.bytes[0], 255); assert.equal(image.bytes[1], 216); assert.ok(image.bytes.length > 1000); assert.ok(image.bytes.length <= 1024 * 1024); }
    console.log(JSON.stringify({ passed: true, browser: process.env.FORM_STUDIO_VISUAL_BROWSER_CHANNEL, partialImages: partial.images.length, fullImages: full.images.length, coverage: full.pageCoverage, checkedNativeKinds: ['menu', 'accordion', 'tabs', 'carousel'], actualObservedKinds: full.observations.map(item => ({ kind: item.kind, status: item.status })), capturedImageIds: full.images.map(image => image.id), networkWrites: writes.length, fixedCandidateReads: reads.length, realAiRequests: 0, formalInstanceUsed: false }));
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'visual browser probe failed'); process.exitCode = 1; });
