import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AI_SECTION_LAYOUTS, AI_SITE_LAYOUTS, type AiSiteBrief, type AiSiteLayout, type AiSitePagePlan, type AiSitePlan, type AiSiteSection } from '../src/lib/ai-builder-types';
import { compileAiSitePlan } from '../src/lib/ai-site-generator';
import { generateAiSitePlan } from '../src/server/ai-builder';
import { saveAiProvider } from '../src/server/ai-provider';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord } from '../src/server/studio';
import type { Actor } from '../src/server/permissions';

const actor: Actor = { id: 'prompt-admin', name: '提示契约测试', email: 'prompt@example.invalid', role: 'admin' };
type SiteType = NonNullable<AiSitePlan['intent']>['siteType'];
type Wire = { model: string; stream: boolean; max_tokens: number; messages: { role: string; content: string }[] };
let directory: string, previous: NodeJS.ProcessEnv, server: Server | undefined;

beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-builder-prompt-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'synthetic-builder-prompt-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3296';
  getDraftRecord(); getDatabase().prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(createEmptyDraft()));
  getDatabase().exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  getDatabase().prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(async () => {
  server?.closeAllConnections(); if (server?.listening) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done())); server = undefined;
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  // 仅清理由本文件创建的随机临时目录；正式数据和环境文件不参与测试。
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(directory.split(/[\\/]/).at(-1)!.startsWith('studio-builder-prompt-'));
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 当前规范JSON的固定软件夹具，不以本机回复冒称真实模型理解或设计质量。 */
function fixture(siteType: SiteType) {
  const catalog = siteType === 'product-catalog', services = siteType === 'professional-services';
  const companyName = catalog ? 'Fictional Components' : services ? 'Fictional Advisory' : 'Fictional Rooms';
  const brief: AiSiteBrief = { companyName, description: catalog ? 'Two supplied component concepts; buyers can inspect records and request further information.' : services ? 'Two supplied advisory services: market questions and offer clarity. No products or catalogue.' : 'A fictional brand viewpoint about everyday rooms. No product records were supplied.', industry: catalog ? 'Components' : services ? 'Business services' : 'Interior brand', audience: 'B2B buyers', market: 'United States', language: 'en', styleNotes: 'Retain all supplied qualifications. Do not invent outcomes.' };
  const page = (key: string, title: string, path: string, sections: AiSiteSection[]): AiSitePagePlan => ({ key, title, path, purpose: `Help the buyer understand ${title.toLowerCase()} using supplied facts.`, seoTitle: `${title} | ${companyName}`, seoDescription: `Supplied ${title.toLowerCase()} information from ${companyName}.`, sections });
  const hero = (heading: string): AiSiteSection => ({ kind: 'hero', heading, body: 'Fictional demonstration; claims and specifications require confirmation.', cta: { label: 'Discuss your brief', pageKey: 'contact' } });
  const pages = [page('home', 'Home', '/', [hero('Start with your buyer question')])];
  if (catalog) {
    pages.push(page('components', 'Components', '/components', [hero('Supplied component concepts'), { kind: 'products', heading: 'Browse the real records', body: 'Use the supplied concepts without unverified specifications.', cta: { label: 'Request component information', pageKey: 'contact' } }]), page('detail', 'Concept detail', '/products/:slug', [hero('Read the supplied concept'), { kind: 'text', heading: 'Record information', body: 'Unconfirmed details remain unconfirmed.' }]));
  } else if (services) {
    pages.push(page('services', 'Services', '/services', [hero('Choose the relevant question'), { kind: 'features', heading: 'Supplied service scopes', body: 'These are service choices, not invented sequential project stages.', items: [{ title: 'Market questions', body: 'Organise the provided questions for discussion.' }, { title: 'Offer clarity', body: 'Describe the provided offer more clearly.' }] }]));
  } else pages.push(page('story', 'Our viewpoint', '/our-viewpoint', [hero('Everyday rooms'), { kind: 'text', heading: 'The supplied viewpoint', body: 'A fictional narrative about everyday spaces; no product range or verified projects are implied.' }]));
  pages.push(page('contact', 'Contact', '/contact', [{ kind: 'hero', heading: 'Discuss your brief', body: 'Use the enquiry form without unprovided response-time promises.' }, { kind: 'contact', heading: 'Tell us your question', body: 'Describe your requirements for review.' }]));
  const layouts: AiSiteLayout[] = catalog ? ['catalog', 'split', 'minimal'] : services ? ['editorial', 'bento', 'minimal'] : ['showcase', 'editorial', 'bento'];
  const plan: AiSitePlan = { summary: 'Only supplied facts; confirm missing specifications and contact channels.', intent: { siteType, primaryGoal: 'Understand the supplied offer and decide whether to enquire.', audienceTasks: ['Read supplied information', 'Discuss a relevant question'], constraints: ['Preserve factual qualifications'], missingFacts: ['Verified contact channels'] }, pages, directions: layouts.map(layout => ({ id: layout, name: `${layout} presentation`, rationale: 'A native presentation of the same supplied content; confirm its actual preview.', primary: '#173443', background: '#ffffff', text: '#172033', headingFont: 'sans', layout })) };
  const source = createEmptyDraft(); source.products = catalog ? [1, 2].map(index => ({ id: `p${index}`, name: `Supplied concept ${index}`, sku: `CONCEPT-${index}`, category: 'Concepts', description: 'Original complete record with an unconfirmed material qualification.', material: 'Unconfirmed', image: '', status: 'draft' as const })) : [];
  return { brief, plan, source };
}

function assertPromptContract(system: string) {
  const schemaLine = system.match(/Required schema:\s*\n([^\n]+)/)?.[1]; assert.ok(schemaLine);
  const schema = JSON.parse(schemaLine);
  assert.deepEqual(Object.keys(schema), ['summary', 'intent', 'pages', 'directions']);
  assert.deepEqual(Object.keys(schema.pages[0].sections[0]), ['kind', 'heading', 'body', 'items', 'mediaId', 'layout', 'cta']);
  assert.deepEqual(schema.directions[0].layout.split('|'), [...AI_SITE_LAYOUTS]);
  assert.deepEqual(schema.pages[0].sections[0].layout.replace('optional ', '').split('|'), [...AI_SECTION_LAYOUTS]);
  assert.match(system, /NATIVE LAYOUT CONTRACT/);
  assert.match(system, /pages and sections are shared by all three directions/i);
  assert.match(system, /rationale[^\n]*must not[^\n]*(?:reorder|invent|add)/i);
  assert.match(system, /(?:numbered rail|index rail)/i);
  assert.match(system, /(?:do not|never)[^\n]*(?:truncate|shorten)[^\n]*existing[^\n]*(?:copy|facts|records)/i);
  assert.match(system, /required caveats and image qualifications must remain next to the claims or visuals they qualify/i);
  assert.match(system, /professional-services[^\n]*must not include products/i);
}

for (const siteType of ['product-catalog', 'professional-services', 'brand-showcase'] as const) test(`真实发送提示契约与现有JSON兼容：${siteType}，每次单请求且原生内容不变`, async () => {
  const data = fixture(siteType), calls: Wire[] = [];
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(data.source));
  server = createServer((incoming, response) => { const chunks: Buffer[] = []; incoming.on('data', value => chunks.push(Buffer.from(value))); incoming.on('end', () => { calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data.plan) } }] })); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  saveAiProvider({ expectedRevision: 0, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-prompt-contract', apiKey: 'synthetic-prompt-only-key', allowLocal: true }, actor);
  const before = getDraftRecord(), generated = await generateAiSitePlan({ brief: data.brief, expectedRevision: before.revision }, actor);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].messages.map(message => message.role), ['system', 'user']); assert.equal(calls[0].stream, false); assert.equal(calls[0].max_tokens, 8192);
  const context = JSON.parse(calls[0].messages[1].content); assert.deepEqual(context.brief, data.brief); assert.equal(context.products.length, data.source.products.length); assert.doesNotMatch(calls[0].messages[1].content, /synthetic-prompt-only-key/);
  assert.deepEqual(generated.plan.intent, data.plan.intent); assert.deepEqual(getDraftRecord(), before, '规划只存私有候选，不重写已有正文和产品');
  for (const direction of generated.plan.directions) {
    const compiled = compileAiSitePlan(generated.plan, direction.id, before.content, '/prompt-test'), encoded = JSON.stringify(compiled.patch);
    assert.ok(compiled.pageIds.length >= 3); assert.deepEqual(compiled.patch.products, undefined, '布局不重写原产品字段');
    if (siteType === 'product-catalog') { assert.match(encoded, /"type":"ContentLoop"/); assert.match(encoded, /Request component information/); assert.match(encoded, /\/prompt-test\/contact/); }
    else { assert.doesNotMatch(encoded, /"type":"ProductDetail"|"source":"product"/); assert.ok(!generated.plan.pages.some(page => page.path.startsWith('/products'))); }
  }
  assertPromptContract(calls[0].messages[0].content);
});
