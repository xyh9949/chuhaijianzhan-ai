import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope, createInquiry, patchStudio } from '../src/server/studio';
import { createExternalAiToken, requireExternalAiGrant, revokeExternalAiToken, type ExternalAiGrant } from '../src/server/external-ai-tokens';
import { externalAiOverview, externalAiCapabilities, externalAiContext, submitExternalAiDesign, readExternalAiDesign, requestExternalAiReview } from '../src/server/external-ai-design';
import { createExternalSiteDesignCandidate, applyAiSiteDesign, undoAiSiteDesign } from '../src/server/ai-site-design';
import { getAiProviderSummary } from '../src/server/ai-provider';
import { readAiWritingProfile, saveAiWritingProfile } from '../src/server/ai-writing';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';
import type { AiSiteDesignRequest } from '../src/lib/ai-site-design-types';

const actor: Actor = { id: 'machine-owner', name: 'Private administrator', email: 'private-admin@example.invalid', role: 'admin' };
const other: Actor = { id: 'other-owner', name: 'Other', email: 'other@example.invalid', role: 'admin' };
const status = (number: number) => (error: unknown) => error instanceof ApiError && error.status === number;
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-external-design-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3296'; process.env.BETTER_AUTH_SECRET = 'external-design-private-secret-'.repeat(3);
  getDraftRecord(); const draft = createEmptyDraft(); draft.settings.name = 'Actual factory'; draft.settings.description = 'Saved real company description';
  draft.pages.push({ ...draft.pages[0], id: 'secret', title: 'UNAUTHORIZED_PAGE_TITLE', slug: '/secret' });
  draft.editorData = { home: { root: { props: { title: 'Home', showChrome: 'yes', brand: '' } }, zones: {}, content: [
    { type: 'Heading', props: { id: 'home-heading', text: 'Saved home title', level: 'h1' } },
    { type: 'Image', props: { id: 'home-image', src: '/images/chair.jpg', alt: 'Current product', height: 300, fit: 'cover', radius: 0 } },
  ] }, secret: { root: { props: { title: 'Secret', showChrome: 'no' } }, zones: {}, content: [{ type: 'Text', props: { id: 'secret-copy', text: 'UNAUTHORIZED_PAGE_TEXT' } }] } };
  draft.media = [
    { id: 'used-image', name: 'Actual chair', url: '/images/chair.jpg', kind: 'image', alt: 'Real image', folder: 'Products', size: '1KB' },
    { id: 'unused-image', name: 'UNAUTHORIZED_UNUSED_MEDIA', url: '/images/interior.jpg', kind: 'image', alt: 'Other material', folder: 'Products', size: '1KB' },
  ];
  draft.products = Array.from({ length: 9 }, (_, index) => ({ id: `product-${index}`, name: index === 8 ? 'Matching cabinet product' : `Actual chair ${index}`, category: index === 8 ? 'Cabinets' : 'Seating', material: 'Saved wood material', description: `Saved product detail ${index}`, image: '/images/chair.jpg', sku: `P${index}`, status: 'draft' as const }));
  getDatabase().prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(draft));
  getDatabase().exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const member of [actor, other]) getDatabase().prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(member.id, member.name, member.email, member.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  const absolute = resolve(directory); if (absolute.startsWith(`${resolve(tmpdir())}${sep}studio-external-design-`)) rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function grant(pages: string[] | null = null, scopes = ['read', 'propose'], owner = actor): ExternalAiGrant {
  const created = createExternalAiToken({ name: 'Test external client', scopes, pageIds: pages, expiresInDays: 1 }, owner);
  return requireExternalAiGrant(new Request('http://127.0.0.1:3296/api/mcp', { headers: { Authorization: `Bearer ${created.token}` } }));
}
function request(pages = ['home', 'secret'], global = true): AiSiteDesignRequest { return { expectedRevision: getDraftRecord().revision, instruction: 'Make cabinet products and business hierarchy easier to understand.', targets: { pageIds: pages, header: global, footer: global, navigation: global, style: global }, preserveText: false }; }
function proposal(text = 'A clearer saved home title') { return { summary: 'Improve the actual native home heading.', intent: { goal: 'Make the page useful for buyers', decisions: ['Clarify the first heading'], preserve: ['Actual product facts'], assumptions: [] }, operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'text', id: 'home-heading', text }] }], warnings: [] }; }
function submit(connection: ExternalAiGrant, key = 'first-request', req = request(), output: unknown = proposal()) { return submitExternalAiDesign(connection, { requestId: key, request: req, proposal: output }); }
function count(table: string) { return (getDatabase().prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n; }

test('外部上下文按范围分页和投影；不泄露私有资料、其它页面或无限产品库', () => {
  createInquiry({ name: 'Private buyer', email: 'buyer@example.invalid', message: 'PRIVATE_INQUIRY_NOT_EXPOSED' }); const limited = grant(['home']);
  const overview = externalAiOverview(limited); assert.equal(overview.total, 1); assert.equal(overview.pages[0].id, 'home'); assert.equal(overview.permissions.wholeSite, false);
  const context = externalAiContext(limited, request(['home'], false));
  const json = JSON.stringify({ overview, context });
  assert.doesNotMatch(json, /UNAUTHORIZED_PAGE_TITLE|UNAUTHORIZED_PAGE_TEXT|UNAUTHORIZED_UNUSED_MEDIA|PRIVATE_INQUIRY_NOT_EXPOSED|private-admin@example|external-design-private-secret/);
  assert.deepEqual(context.context.imageLibrary.map(item => item.id), ['used-image']); assert.deepEqual(context.context.productSamples, []); assert.equal(context.context.globalOperationsAllowed, false);
  const whole = grant(), wholeContext = externalAiContext(whole, request());
  assert.equal(wholeContext.context.productSamples.length, 6); assert.equal(wholeContext.context.productSamples[0].id, 'product-8');
  const first = externalAiOverview(whole, { offset: 0, limit: 1 }), second = externalAiOverview(whole, { offset: first.nextOffset, limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1); assert.equal(second.nextOffset, null); assert.notEqual(first.pages[0].id, second.pages[0].id);
  assert.throws(() => externalAiOverview(whole, { limit: 1000 }), status(422));
});

test('能力发现准确声明原生编辑、用户浏览器确认及未做视觉检查', () => {
  const capabilities = externalAiCapabilities(grant(['home'], ['read'])); assert.equal(capabilities.wholeSiteAllowed, false); assert.equal(capabilities.siteModelCalls, false);
  assert.match(capabilities.nativePageOperations, /productCard/); assert.match(capabilities.wholeSiteOperations, /navigationMode/); assert.ok(capabilities.unsupported.includes('automatic-publication'));
  assert.throws(() => externalAiContext(grant(), { ...request(), previewFeedback: [] }), status(422));
});

test('外部上下文不外发私有写作指引，全站仅共享已确认公司事实', () => {
  const previousProfile = readAiWritingProfile(actor);
  saveAiWritingProfile({ expectedRevision: previousProfile.revision, brandName: 'Actual factory', audience: 'PRIVATE_WRITING_GUIDANCE audience', market: 'PRIVATE_WRITING_GUIDANCE market', tone: 'PRIVATE_WRITING_GUIDANCE tone', terminology: 'PRIVATE_WRITING_GUIDANCE terminology', avoidedClaims: 'PRIVATE_WRITING_GUIDANCE avoided claims', facts: [
    { id: 'public-company-fact', label: 'Saved public company fact', text: 'PUBLIC_CONFIRMED_COMPANY_FACT', source: 'Owner confirmed source', confirmed: true, scope: 'company' },
    { id: 'unconfirmed-company-fact', label: 'Unconfirmed company fact', text: 'UNCONFIRMED_COMPANY_FACT', source: 'Unverified source', confirmed: false, scope: 'company' },
  ] }, actor);
  const whole = externalAiContext(grant(), request()), limited = externalAiContext(grant(['home']), request(['home'], false));
  assert.doesNotMatch(JSON.stringify([whole, limited]), /PRIVATE_WRITING_GUIDANCE|UNCONFIRMED_COMPANY_FACT/);
  assert.match(JSON.stringify(whole.context.website.confirmedFacts), /PUBLIC_CONFIRMED_COMPANY_FACT/);
  assert.doesNotMatch(JSON.stringify(limited), /PUBLIC_CONFIRMED_COMPANY_FACT/);
  for (const key of ['audience', 'market', 'tone', 'avoidedClaims']) { assert.equal(Object.hasOwn(whole.context.website, key), false); assert.equal(Object.hasOwn(limited.context.website, key), false); }
  assert.match(readAiWritingProfile(actor).avoidedClaims, /PRIVATE_WRITING_GUIDANCE/);
});

test('按需单页细节读取真实图片、按钮及三端原生样式，续调读取累计候选', () => {
  const content = getDraftRecord().content, home = content.editorData.home as { content: { type: string; props: Record<string, unknown> }[] };
  home.content.push({ type: 'ActionButton', props: { id: 'home-cta', text: 'Read company', href: '', linkTarget: { kind: 'page', id: 'home' }, kind: 'theme', align: 'left', design: { tablet: { fontSize: 21 }, mobile: { fontSize: 18 } } } });
  home.content.push({ type: 'Image', props: { id: 'bound-image', src: '/images/interior.jpg', alt: '', bindings: { src: { source: 'product', mode: 'current', field: 'builtin:image' } } } });
  (content.editorData.home as { root: { props: Record<string, unknown> } }).root.props.bindingContext = { source: 'product', recordId: 'product-0' };
  home.content.push({ type: 'ActionButton', props: { id: 'secret-url', text: 'Existing reference', href: 'https://example.invalid/path?PRIVATE_URL_CREDENTIAL=hidden#fragment' } });
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const connection = grant(), detail = externalAiContext(connection, { ...request(), detailPageId: 'home' }).pageDetail!;
  const image = detail.context.nodes.find(node => node.id === 'home-image')!, button = detail.context.nodes.find(node => node.id === 'home-cta')!;
  assert.equal(image.currentImage?.mediaId, 'used-image'); assert.equal(image.currentImage?.src, '/images/chair.jpg'); assert.deepEqual(button.currentLink?.target, { kind: 'page', id: 'home' });
  assert.equal(button.effectiveNativeStyle.tablet.fontSize, 21); assert.equal(button.effectiveNativeStyle.mobile.fontSize, 18); assert.ok(button.effectiveNativeStyle.desktop);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_URL_CREDENTIAL|\/images\/interior.jpg/); assert.equal(detail.context.styleSource, 'native-values-not-browser-measurement');
  const first = submit(connection), continued = externalAiContext(connection, { ...request(), baseDesignId: first.designId, detailPageId: 'home' });
  assert.equal(continued.pageDetail!.context.nodes.find(node => node.id === 'home-heading')?.text, 'A clearer saved home title');
  assert.equal((getDraftRecord().content.editorData.home as { content: { props: { text: string } }[] }).content[0].props.text, 'Saved home title');
});

test('详细页拒绝越界，授权图片在全库第24项以后仍可被读取，限定全页ID不升级全局权限', () => {
  const content = getDraftRecord().content;
  content.media.unshift(...Array.from({ length: 30 }, (_, index) => ({ id: `unrelated-${index}`, name: 'UNAUTHORIZED_EXTRA_IMAGE', kind: 'image' as const, url: `/images/unrelated-${index}.jpg`, alt: '', folder: '', size: '1KB' })));
  const home = content.editorData.home as { content: { type: string; props: Record<string, unknown> }[] };
  home.content.push({ type: 'ActionButton', props: { id: 'outside-link', text: 'Existing link', href: '/secret', linkTarget: { kind: 'page', id: 'secret' } } });
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const connection = grant(['home']), context = externalAiContext(connection, { ...request(['home'], false), detailPageId: 'home' });
  assert.deepEqual(context.context.imageLibrary.map(item => item.id), ['used-image']); assert.deepEqual(context.pageDetail!.context.imageLibrary.map(item => item.id), ['used-image']);
  assert.doesNotMatch(JSON.stringify(context), /UNAUTHORIZED_EXTRA_IMAGE|UNAUTHORIZED_PAGE_TITLE|\/secret|"target":/);
  assert.throws(() => externalAiContext(connection, { ...request(['home'], false), detailPageId: 'secret' }), status(403));
  const explicitAllPages = grant(['home', 'secret']); assert.equal(externalAiContext(explicitAllPages, request(['home', 'secret'], false)).context.globalOperationsAllowed, false);
});

test('外部AI无需配置站内模型，创建同格式原生候选且不写草稿', () => {
  const connection = grant(); assert.equal(getAiProviderSummary().enabled, false); const before = getStudioEnvelope();
  const view = submit(connection); assert.equal(view.status, 'pending'); assert.equal(view.source, 'external-ai'); assert.equal(view.generatedContentEditable, true);
  assert.equal(view.validation.visualInspection, 'not-performed'); assert.equal(view.validation.layoutMeasurements, 'not-collected');
  assert.equal(count('cms_external_ai_request'), 1); assert.equal(count('cms_ai_site_design'), 1); assert.deepEqual(getStudioEnvelope(), before);
  assert.match(view.reviewUrl, /\/admin\?externalDesign=aisd-[a-f0-9-]+#global-design$/); assert.doesNotMatch(view.reviewUrl, /token|fsai_/i);
  assert.match(view.afterUrl!, /\/preview\/~site-design\//);
});

test('请求幂等同体复用，异体409；采用后失联重试不重复创建', () => {
  const connection = grant(), req = request(), output = proposal();
  const view = submit(connection, 'stable-key', req, output), repeat = submit(connection, 'stable-key', req, JSON.parse(JSON.stringify(output)));
  assert.equal(view.designId, repeat.designId); assert.equal(count('cms_external_ai_request'), 1); assert.equal(count('cms_ai_site_design'), 1);
  assert.throws(() => submit(connection, 'stable-key', req, proposal('Different text')), status(409));
  applyAiSiteDesign({ designId: view.designId, expectedRevision: view.baseRevision }, actor);
  assert.equal(submit(connection, 'stable-key', req, output).status, 'applied'); assert.equal(count('cms_ai_site_design'), 1);
});

test('同一账号的不同连接及其它账号不能查看或续调对方候选', () => {
  const first = grant(), second = grant(), otherOwner = grant(null, ['read', 'propose'], other), view = submit(first);
  for (const unauthorized of [second, otherOwner]) {
    assert.throws(() => readExternalAiDesign(unauthorized, view.designId), status(404));
    assert.throws(() => externalAiContext(unauthorized, { ...request(), baseDesignId: view.designId }), status(404));
    assert.throws(() => submit(unauthorized, 'foreign-parent', { ...request(), baseDesignId: view.designId }), status(404));
  }
  assert.equal(count('cms_ai_site_design'), 1);
});

test('续调读取累计候选，保留最初基准，采用撤销只经共享后台执行', () => {
  const connection = grant(), before = getStudioEnvelope(), first = submit(connection);
  const next = submit(connection, 'continue-key', { ...request(), baseDesignId: first.designId }, { ...proposal(), operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'design', id: 'home-heading', design: { mobile: { fontSize: 28 } } }] }] });
  assert.equal(next.refinement?.round, 1); assert.equal(next.refinement?.baseDesignId, first.designId); assert.deepEqual(getStudioEnvelope(), before);
  requestExternalAiReview(connection, { designId: next.designId, action: 'apply' }); assert.deepEqual(getStudioEnvelope(), before);
  const applied = applyAiSiteDesign({ designId: next.designId, expectedRevision: before.revision }, actor); assert.match(JSON.stringify(applied.state.editorData.home), /A clearer saved home title/);
  assert.equal(readExternalAiDesign(connection, next.designId).status, 'applied');
  requestExternalAiReview(connection, { designId: next.designId, action: 'undo' }); assert.equal(getStudioEnvelope().revision, applied.revision);
  const undone = undoAiSiteDesign({ designId: next.designId, expectedRevision: applied.revision }, actor); assert.equal(readExternalAiDesign(connection, next.designId).status, 'undone');
  assert.deepEqual(undone.state.editorData, before.state.editorData); assert.equal(undone.activeReleaseId, before.activeReleaseId);
});

test('页面限定连接不能越权全站、页面、图片和链接，候选索引也不漏出范围', () => {
  const connection = grant(['home']), req = request(['home'], false);
  assert.throws(() => externalAiContext(connection, request()), status(403));
  assert.throws(() => submit(connection, 'outside-page', request(['secret'], false)), status(403));
  assert.throws(() => submit(connection, 'bad-global', req, { ...proposal(), operations: [{ kind: 'theme', theme: { primary: '#112233' } }] }), status(422));
  assert.throws(() => submit(connection, 'bad-media', req, { ...proposal(), operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'image', id: 'home-image', mediaId: 'unused-image' }] }] }), status(403));
  assert.throws(() => submit(connection, 'bad-link', req, { ...proposal(), operations: [{ kind: 'page', pageId: 'home', operations: [{ kind: 'insert', parentId: '$page', index: 0, node: { tempId: 'button', type: 'ActionButton', text: 'Secret page', linkTarget: { kind: 'page', id: 'secret' } } }] }] }), status(403));
  const view = submit(connection, 'allowed', req); assert.deepEqual(view.previewPages.map(page => page.pageId), ['home']);
  assert.doesNotMatch(JSON.stringify(view), /UNAUTHORIZED_PAGE_TITLE|UNAUTHORIZED_PAGE_TEXT|\/secret/); assert.equal(view.scope.selectedPageIds.length, 1);
});

test('只读、吊销、过期和负责人降权即时阻止服务，不信任已缓存grant', () => {
  const readOnly = grant(null, ['read']); assert.throws(() => submit(readOnly), status(403));
  const revoked = grant(), revokedView = submit(revoked); revokeExternalAiToken(revoked.tokenId, actor);
  assert.throws(() => readExternalAiDesign(revoked, revokedView.designId), status(401)); assert.throws(() => submit(revoked, 'revoked'), status(401));
  const expired = grant(); getDatabase().prepare('UPDATE cms_external_ai_token SET expires_at=? WHERE id=?').run('2000-01-01', expired.tokenId); assert.throws(() => externalAiOverview(expired), status(401));
  const downgraded = grant(); getDatabase().prepare("UPDATE auth_user SET role='viewer' WHERE id=?").run(actor.id); assert.throws(() => externalAiCapabilities(downgraded), status(403));
});

test('旧版本、锁定及任意patch拒绝，不留下幂等记录或孤立候选', () => {
  const connection = grant(), before = getStudioEnvelope();
  assert.throws(() => submit(connection, 'stale', { ...request(), expectedRevision: 99 }), status(409));
  assert.throws(() => submit(connection, 'arbitrary', request(), { ...proposal(), operations: [{ kind: 'settings', settings: { name: 'Injected' } }] }), status(422));
  const state = getDraftRecord().content; (state.editorData.home as { content: { props: { locked?: boolean } }[] }).content[0].props.locked = true;
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(state)); assert.throws(() => submit(connection, 'locked'), status(422));
  assert.equal(count('cms_external_ai_request'), 0); assert.equal(count('cms_ai_site_design'), 0); assert.equal(getStudioEnvelope().revision, before.revision);
});

test('最终鉴权失败会回滚候选与请求索引，用户人工修改仍受原撤销冲突保护', () => {
  let checked = 0; assert.throws(() => createExternalSiteDesignCandidate(request(), proposal(), actor, () => { if (++checked === 2) throw new ApiError(401, 'Revoked before commit'); }), status(401)); assert.equal(checked, 2); assert.equal(count('cms_ai_site_design'), 0);
  const connection = grant();
  // 用同事务触发器模拟末次索引写入时授权变化，确保候选、审计和幂等索引一起回滚。
  getDatabase().exec(`CREATE TRIGGER remove_external_propose BEFORE INSERT ON cms_external_ai_request BEGIN UPDATE cms_external_ai_token SET scopes_json='["read"]' WHERE id=NEW.token_id; END`);
  assert.throws(() => submit(connection, 'commit-permission-change'), status(403)); assert.equal(count('cms_ai_site_design'), 0); assert.equal(count('cms_external_ai_request'), 0);
  getDatabase().exec('DROP TRIGGER remove_external_propose');
  const view = submit(connection), applied = applyAiSiteDesign({ designId: view.designId, expectedRevision: view.baseRevision }, actor);
  const data = structuredClone(applied.state.editorData); (data.home as { content: { props: { text: string } }[] }).content[0].props.text = 'Manual user edit';
  patchStudio({ expectedRevision: applied.revision, patch: { editorData: data } }, actor);
  assert.throws(() => undoAiSiteDesign({ designId: view.designId, expectedRevision: getDraftRecord().revision }, actor), status(409)); assert.match(JSON.stringify(getDraftRecord().content.editorData.home), /Manual user edit/);
});
