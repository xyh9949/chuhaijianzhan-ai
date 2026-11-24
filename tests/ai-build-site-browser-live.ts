import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSandboxDocument, safePreviewNavigation } from '../src/lib/site-code-render';
import { inspectAiBuildSite, type BuildBrowserTarget } from '../src/server/ai-build-site-browser';

/** 随机端口的真实浏览器回归，复用私有预览的原生隔离脚本，且不启动网站或模型服务。 */
async function main() {
  const prefix = '/preview/~ai/synthetic', writes: string[] = [], reads: string[] = [];
  const form = '<form class="site-contact-form" data-form-demo="true" method="post" action="/api/public/forms/must-not-submit"><label>Name<input name="name" value="DO_NOT_READ_FIELD_VALUE"></label><label>Question<textarea name="question"></textarea></label><button type="submit">Send</button></form>';
  const distantForm = `<div style="min-height:940px">Product information</div><section id="request-fixture">${form}</section>`;
  const markup = new Map([
    ['/home', `<h1>Independent business catalog</h1><a class="editor-site-action" href="${prefix}/products">Browse products</a>`],
    ['/products', '<h1>Products</h1>'],
    ['/products/fixture', `<h1>Fixture detail</h1><a class="editor-site-action" href="${prefix}/contact">Request details</a>`],
    ['/contact', `<h1>Contact</h1>${form}`],
    ['/missing-anchor', `<h1>Missing anchor</h1><a class="editor-site-action" href="#missing-form">Request details</a>${distantForm}`],
    ['/same-anchor', `<h1>Same page anchor</h1><a class="editor-site-action" href="#request-fixture">Request details</a>${distantForm}`],
    ['/cross-anchor', `<h1>Separate contact</h1><a class="editor-site-action" href="${prefix}/query-contact?topic=seating#request-fixture">Contact the project team</a>`],
    ['/query-contact', '<h1>Choose topic</h1>'],
    ['/form-only', `<h1>Embedded inquiry</h1>${form}`],
    ['/broken', `<h1 class="split" data-site-node-id="split-heading">Longwordsss</h1><div style="width:440px" data-site-node-id="oversized">Content overflows</div><div data-shared-block-content="true" data-shared-block-id="shared-fixture"><a class="editor-site-action" style="height:21px" href="${prefix}/unknown" data-site-node-id="shared-fixture--1" data-site-source-node-id="source-cta">Unverified path</a></div><img data-site-node-id="broken-picture" width="60" height="60" src="/images/broken.png">`],
  ]);
  const navigation = `<header><nav class="site-managed-navigation"><details class="site-menu-mobile"><summary>Menu</summary><a href="${prefix}/contact">Contact</a></details></nav></header>`;
  let origin = '';
  const server = createServer((incoming, response) => {
    if (incoming.method !== 'GET') { writes.push(`${incoming.method} ${incoming.url}`); response.writeHead(500).end(); return; }
    reads.push(incoming.url || '');
    if (incoming.headers.cookie !== 'build-check=synthetic-private') { response.writeHead(401).end(); return; }
    const address = new URL(incoming.url || '/', origin), route = address.pathname.slice(prefix.length);
    const page = route === '/query-contact' && address.searchParams.get('topic') === 'seating' ? `<h1>Seating inquiry</h1>${distantForm}` : markup.get(route);
    if (!page) { response.writeHead(404).end(); return; }
    const sandbox = createSandboxDocument({ markup: `<div class="editor-site">${navigation}<main>${page}</main></div>`, styles: ['body{font:16px system-ui}a.editor-site-action{display:inline-flex;min-width:80px;height:44px;align-items:center}.split{width:70px;word-break:break-all}'], css: [], scripts: [], baseUrl: `${origin}${incoming.url}#fixture-runtime-anchor`, language: 'en' });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><iframe title="网站草稿隔离预览" sandbox="allow-scripts" style="width:100%;height:640px;border:0"></iframe><script>
      const navigate = ${safePreviewNavigation.toString()};
      addEventListener('message', event => { if (event.source !== document.querySelector('iframe').contentWindow || event.data?.source !== 'form-site-sandbox' || event.data.type !== 'navigate') return; const href = navigate(event.data.href, location.origin, ${JSON.stringify(prefix)}); if (href) location.assign(href); });
      document.querySelector('iframe').srcdoc = ${JSON.stringify(sandbox).replaceAll('<', '\\u003c')}.replace('#fixture-runtime-anchor', /^#[a-z0-9-]+$/i.test(location.hash) ? location.hash : '');
    </script></body></html>`);
  });
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
    process.env.BETTER_AUTH_URL = origin; process.env.BETTER_AUTH_SECRET = 'synthetic-build-check-secret-'.repeat(3); process.env.FORM_STUDIO_VISUAL_ORIGIN = origin; process.env.FORM_STUDIO_VISUAL_BROWSER_CHANNEL ||= 'chrome'; delete process.env.FORM_STUDIO_VISUAL_DISABLED;
    const targets: BuildBrowserTarget[] = [
      { pageId: 'home', title: 'Home', path: '/home', dynamic: false, entry: 'home' },
      { pageId: 'products', title: 'Products', path: '/products', dynamic: false },
      { pageId: 'product-detail', title: 'Product', path: '/products/fixture', dynamic: true, entry: 'product' },
      { pageId: 'contact', title: 'Contact', path: '/contact', dynamic: false },
      { pageId: 'broken', title: 'Broken sample', path: '/broken', dynamic: false, editableNode: node => node.blockId && node.sourceId ? { kind: 'block', id: node.blockId, nodeId: node.sourceId } : { kind: 'page', id: 'broken', nodeId: node.renderedId } },
      { pageId: 'missing-sample', title: 'Missing dynamic content', dynamic: true },
    ];
    const result = await inspectAiBuildSite(targets, prefix, 'build-check=synthetic-private', AbortSignal.timeout(60_000));
    assert.deepEqual(result.pages.map(page => page.status), ['checked', 'checked', 'checked', 'checked', 'warning', 'skipped']);
    assert.deepEqual(result.pages[0].mobile.map(device => device.width), [390, 375]);
    assert.ok(result.pages[4].mobile.every(device => device.overflow > 2 && device.splitWords > 0 && device.smallActions > 0 && device.brokenImages > 0));
    const broken = result.pages[4];
    assert.equal(broken.previewPath, `${prefix}/broken`);
    assert.deepEqual(broken.issues.map(issue => [issue.code, issue.location?.nodeId, issue.widths]), [
      ['split-heading', 'split-heading', [390, 375]], ['overflow', 'oversized', [390, 375]], ['small-button', 'shared-fixture--1', [390, 375]], ['broken-image', 'broken-picture', [390, 375]], ['unvisited-link', 'shared-fixture--1', [390]],
    ]);
    assert.deepEqual(broken.issues.find(issue => issue.code === 'small-button')?.location?.target, { kind: 'block', id: 'shared-fixture', nodeId: 'source-cta' });
    assert.deepEqual(broken.issues.find(issue => issue.code === 'split-heading')?.location?.target, { kind: 'page', id: 'broken', nodeId: 'split-heading' });
    assert.deepEqual(result.journeys.map(journey => [journey.entry, journey.status, journey.steps.map(step => step.label), journey.form]), [
      ['home', 'checked', ['Browse products', 'Contact'], { path: '/contact', fields: 2, unlabelled: 0 }],
      ['product', 'checked', ['Request details'], { path: '/contact', fields: 2, unlabelled: 0 }],
    ]);
    assert.equal(writes.length, 0); assert.equal(reads.filter(path => path === `${prefix}/contact`).length, 3);
    assert.ok(reads.every(path => path === '/images/broken.png' || path.startsWith(prefix) && markup.has(path.slice(prefix.length))));
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_READ_FIELD_VALUE/);
    const anchorTargets: BuildBrowserTarget[] = [
      { pageId: 'missing-anchor', title: 'Missing anchor', path: '/missing-anchor', dynamic: false, entry: 'home' },
      { pageId: 'same-anchor', title: 'Same anchor', path: '/same-anchor', dynamic: true, entry: 'product' },
    ];
    const crossTargets: BuildBrowserTarget[] = [
      { pageId: 'cross-anchor', title: 'Cross page anchor', path: '/cross-anchor', dynamic: false, entry: 'home' },
      { pageId: 'query-contact', title: 'Query contact', path: '/query-contact', dynamic: false },
      { pageId: 'form-only', title: 'Form only', path: '/form-only', dynamic: true, entry: 'product' },
    ];
    const readJourneys = async (scope: BuildBrowserTarget[]) => (await inspectAiBuildSite(scope, prefix, 'build-check=synthetic-private', AbortSignal.timeout(60_000))).journeys;
    const anchorJourneys = await readJourneys(anchorTargets), crossJourneys = await readJourneys(crossTargets);
    assert.deepEqual(anchorJourneys.map(journey => [journey.status, journey.steps.length, journey.form?.path]), [['warning', 1, undefined], ['checked', 1, '/same-anchor']]);
    assert.match(anchorJourneys[0].note, /没有到达指定锚点/);
    assert.deepEqual(crossJourneys.map(journey => [journey.status, journey.steps.length, journey.form?.path]), [['checked', 1, '/query-contact'], ['form-only', 0, '/form-only']]);
    assert.ok(reads.includes(`${prefix}/query-contact?topic=seating`));
    assert.equal(writes.length, 0);
    console.log(JSON.stringify({ passed: true, browser: process.env.FORM_STUDIO_VISUAL_BROWSER_CHANNEL, pages: result.pages.length + anchorTargets.length + crossTargets.length, journeys: [...result.journeys, ...anchorJourneys, ...crossJourneys], networkWrites: writes.length, actualAiRequests: 0 }));
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
