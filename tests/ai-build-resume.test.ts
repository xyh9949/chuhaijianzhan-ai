import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../src/server/database';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { listAiBuildRuns, readAiBuildRun, previewAiSite, applyAiSite, reviseAiSitePlan, resolveAiSitePreview, setAiSitePlanRetention, undoAiSite } from '../src/server/ai-builder';
import type { AiSiteBrief } from '../src/lib/ai-builder-types';
import type { Actor } from '../src/server/permissions';
import { ApiError } from '../src/server/http';
import { aiBuilderHttpPlan } from './ai-builder-http';
import type { Data } from '@puckeditor/core';

const admin: Actor = { id: 'resume-admin', name: '恢复管理员', email: 'resume-admin@example.invalid', role: 'admin' };
const other: Actor = { id: 'resume-other', name: '其他管理员', email: 'resume-other@example.invalid', role: 'admin' };
const editor: Actor = { id: 'resume-editor', name: '编辑者', email: 'resume-editor@example.invalid', role: 'editor' };
const brief: AiSiteBrief = { companyName: 'Resume synthetic company', description: 'Private supplied company brief for synthetic project buyers.', industry: 'Furniture', audience: 'Project buyers', market: 'Global', language: 'en', styleNotes: '' };
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-ai-resume-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'resume-unit-tests-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3297';
  getDraftRecord(); const db = getDatabase(); db.prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(createEmptyDraft()));
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
  for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
});
afterEach(() => {
  getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
  if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-ai-resume-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
function seedPlan(actor = admin, payload: unknown = { brief, plan: aiBuilderHttpPlan(), selectedProductIds: ['old-product-id'] }) {
  const id = `aip-${randomUUID()}`;
  getDatabase().prepare('INSERT INTO cms_ai_build(id,actor_id,kind,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id, actor.id, 'plan', 0, JSON.stringify(payload), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  return id;
}
function databaseRows() { return getDatabase().prepare('SELECT * FROM cms_ai_build ORDER BY id').all(); }

test('列表只列本人有效完成摘要，不返回brief/plan/冻结快照，也不清理过期记录', () => {
  const id = seedPlan(), preview = previewAiSite({ planId: id, directionId: 'editorial', prefix: '' }, admin);
  seedPlan(other); seedPlan(admin, { pending: true }); const expired = seedPlan();
  getDatabase().prepare("UPDATE cms_ai_build SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired);
  const before = getStudioEnvelope(), rows = databaseRows(), list = listAiBuildRuns(admin);
  assert.equal(list.currentRevision, 0); assert.equal(list.items.length, 2); assert.ok(list.items.some(item => item.id === id));
  assert.deepEqual(list.items.find(item => item.id === preview.previewId)?.pages, preview.pages);
  assert.doesNotMatch(JSON.stringify(list), /Private supplied|description|snapshot|patch|selectedProductIds|sections/);
  assert.equal(listAiBuildRuns(other).items.length, 1); assert.deepEqual(databaseRows(), rows); assert.deepEqual(getStudioEnvelope(), before);
});

test('读取方案恢复原brief和产品ID，不因当前产品已删除而外发或更改资料', () => {
  const id = seedPlan(), before = getStudioEnvelope(), restored = readAiBuildRun(id, admin);
  assert.equal(restored.kind, 'plan'); if (restored.kind !== 'plan') return;
  assert.deepEqual(restored.brief, brief); assert.deepEqual(restored.plan, aiBuilderHttpPlan()); assert.deepEqual(restored.selectedProductIds, ['old-product-id']);
  assert.equal(restored.baseRevision, 0); assert.equal(restored.currentRevision, 0); assert.equal(restored.appliedRevision, null);
  assert.deepEqual(getStudioEnvelope(), before); assert.equal((getDatabase().prepare('SELECT enabled FROM cms_ai_provider WHERE id=1').get() as { enabled: number }).enabled, 0);
});

test('预览恢复仅返回页面和检查及有效父方案，私有patch/snapshot不返回', () => {
  const content = getDraftRecord().content; content.settings.email = 'PRIVATE_RESUME_EMAIL@example.invalid';
  content.customCode = { global: { css: '', cssEnabled: false, js: 'PRIVATE_RESUME_SCRIPT', jsEnabled: true }, pages: {} };
  getDatabase().prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(content));
  const id = seedPlan(), preview = previewAiSite({ planId: id, directionId: 'catalog', prefix: '/resume' }, admin), before = getStudioEnvelope();
  const restored = readAiBuildRun(preview.previewId, admin); assert.equal(restored.kind, 'preview'); if (restored.kind !== 'preview') return;
  assert.deepEqual(restored.pages, preview.pages); assert.deepEqual(restored.warnings, preview.warnings); assert.deepEqual(restored.seoIssues, preview.seoIssues);
  assert.equal(restored.prefix, '/resume'); assert.equal(restored.directionId, 'catalog'); assert.equal(restored.plan?.planId, id);
  assert.doesNotMatch(JSON.stringify(restored), /PRIVATE_RESUME|"snapshot"|"patch"|secret_cipher|apiKey/); assert.deepEqual(getStudioEnvelope(), before);
});

test('草稿变化时保留原基准并明确currentRevision，恢复不会自动重建或绕过旧采用409', () => {
  const id = seedPlan(), preview = previewAiSite({ planId: id, directionId: 'editorial', prefix: '/resume' }, admin);
  patchStudio({ expectedRevision: 0, patch: { theme: { ...getDraftRecord().content.theme, primary: '#123456' } } }, admin);
  const before = getStudioEnvelope(), rows = databaseRows(), restored = readAiBuildRun(preview.previewId, admin);
  assert.equal(restored.baseRevision, 0); assert.equal(restored.currentRevision, 1); assert.equal(listAiBuildRuns(admin).currentRevision, 1);
  assert.throws(() => applyAiSite({ previewId: preview.previewId, expectedRevision: 0 }, admin), status(409));
  assert.deepEqual(databaseRows(), rows); assert.deepEqual(getStudioEnvelope(), before);
});

test('父规划过期或属于其他人时不带回其资料，未过期预览仍独立可读', () => {
  const id = seedPlan(), preview = previewAiSite({ planId: id, directionId: 'editorial', prefix: '' }, admin);
  getDatabase().prepare("UPDATE cms_ai_build SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
  const expired = readAiBuildRun(preview.previewId, admin); assert.equal(expired.kind, 'preview'); assert.equal(Object.hasOwn(expired, 'plan'), false);
  assert.doesNotMatch(JSON.stringify(expired), /Private supplied/); assert.throws(() => readAiBuildRun(id, admin), status(410));
  const foreign = seedPlan(other), row = getDatabase().prepare('SELECT payload_json FROM cms_ai_build WHERE id=?').get(preview.previewId) as { payload_json: string };
  getDatabase().prepare('UPDATE cms_ai_build SET payload_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.payload_json), planId: foreign }), preview.previewId);
  assert.equal(Object.hasOwn(readAiBuildRun(preview.previewId, admin), 'plan'), false);
});

test('pending/过期/owner/角色和当前账号降权停用均受保护', () => {
  const id = seedPlan(), pending = seedPlan(admin, { pending: true });
  assert.throws(() => readAiBuildRun(pending, admin), status(409)); assert.throws(() => readAiBuildRun(id, other), status(404));
  assert.throws(() => readAiBuildRun(id, editor), status(403)); assert.throws(() => listAiBuildRuns(editor), status(403)); assert.throws(() => readAiBuildRun('bad-id', admin), status(422));
  getDatabase().prepare("UPDATE auth_user SET role='editor' WHERE id=?").run(admin.id); assert.throws(() => readAiBuildRun(id, admin), status(403));
  getDatabase().prepare("UPDATE auth_user SET role='admin',banned=1 WHERE id=?").run(admin.id); assert.throws(() => listAiBuildRuns(admin), status(401));
});

test('已采用预览的恢复回执保留，不重复采用、不恢复旧草稿或延长期限', () => {
  const id = seedPlan(), preview = previewAiSite({ planId: id, directionId: 'editorial', prefix: '' }, admin);
  const saved = applyAiSite({ previewId: preview.previewId, expectedRevision: 0 }, admin), rows = databaseRows();
  const restored = readAiBuildRun(preview.previewId, admin); assert.equal(restored.appliedRevision, saved.revision);
  assert.equal(listAiBuildRuns(admin).items.find(item => item.id === preview.previewId)?.appliedRevision, saved.revision);
  const {buildUndo,...envelope}=saved;assert.equal(buildUndo.canUndo,true);
  assert.deepEqual(getStudioEnvelope(), envelope); assert.deepEqual(databaseRows(), rows);
});

test('手改页面、文案与按钮生成私有新版本，冻结旧预览并可原生采用撤销', () => {
  const planId = seedPlan(), original = aiBuilderHttpPlan(), before = getStudioEnvelope();
  const frozen = previewAiSite({ planId, directionId: 'editorial', prefix: '/compare' }, admin);
  const oldHome = resolveAiSitePreview(frozen.previewId, ['compare'], admin)!.resolved.data;
  const pages = structuredClone(original.pages), home = pages[0];
  home.title = 'Reviewed company website';
  home.sections[0].heading = 'Reviewed starting point';
  home.sections[0].body = 'Contact us to check your requirements.';
  home.sections[0].cta = { label: 'Review our process', pageKey: 'quality' };
  pages.splice(1, 0, { key: 'quality', path: '/quality', title: 'Quality', purpose: 'Explain process', seoTitle: 'Process and quality', seoDescription: 'Find the review process.', sections: [{ kind: 'hero', heading: 'Quality review', body: 'Review the supplied process.' }] });
  const edited = reviseAiSitePlan({ planId, pages }, admin);
  assert.notEqual(edited.planId, planId);
  assert.equal(edited.manuallyEdited, true);
  assert.deepEqual(edited.plan.directions, original.directions);
  assert.deepEqual(edited.brief, brief);
  assert.deepEqual(edited.plan.pages, pages);
  assert.deepEqual(edited.selectedProductIds, ['old-product-id']);
  assert.equal(reviseAiSitePlan({ planId: edited.planId, pages }, admin).planId, edited.planId);
  assert.deepEqual(getStudioEnvelope(), before);

  const oldRecord = readAiBuildRun(frozen.previewId, admin);
  assert.equal(oldRecord.kind, 'preview');
  assert.equal(oldRecord.kind === 'preview' && oldRecord.plan?.planId, planId);
  assert.deepEqual(resolveAiSitePreview(frozen.previewId, ['compare'], admin)!.resolved.data, oldHome);
  assert.deepEqual(readAiBuildRun(edited.planId, admin), edited);
  assert.equal(listAiBuildRuns(admin).items.find(item => item.id === edited.planId)?.manuallyEdited, true);

  const preview = previewAiSite({ planId: edited.planId, directionId: 'editorial', prefix: '' }, admin);
  const projected = resolveAiSitePreview(preview.previewId, [], admin)!;
  const quality = preview.pages.find(page => page.slug === '/quality')!;
  const homeData = JSON.stringify(projected.resolved.data);
  assert.match(homeData, /Reviewed starting point/);
  assert.match(homeData, /Review our process/);
  assert.ok(homeData.includes(`"linkTarget":{"kind":"page","id":"${quality.id}"}`));
  assert.deepEqual(projected.snapshot.siteLayout?.menus?.at(-1)?.items.map(item => item.label), ['Reviewed company website', 'Quality', 'Products', 'Contact']);
  assert.deepEqual(getStudioEnvelope(), before);
  assert.equal((getDatabase().prepare('SELECT COUNT(*) n FROM cms_ai_usage').get() as { n: number }).n, 0);

  const applied = applyAiSite({ previewId: preview.previewId, expectedRevision: 0 }, admin);
  assert.equal(applied.state.pages.find(page => page.slug === '/quality')?.seoTitle, 'Process and quality');
  assert.equal(applied.activeReleaseId, before.activeReleaseId);
  const undone = undoAiSite({ previewId: preview.previewId, expectedRevision: applied.revision }, admin);
  assert.equal(undone.buildUndo.canUndo, false);
  assert.deepEqual(undone.state.editorData, before.state.editorData);
  assert.ok(!undone.state.pages.some(page => page.slug === '/quality'));
});

test('显式隐藏保留到真实原生编译，必要页面、外部按钮与越权提交受保护', () => {
  const planId = seedPlan(), plan = aiBuilderHttpPlan();
  plan.pages[0].sections[0].cta = null;
  const edited = reviseAiSitePlan({ planId, pages: plan.pages }, admin);
  const preview = previewAiSite({ planId: edited.planId, directionId: 'editorial', prefix: '' }, admin);
  const home = resolveAiSitePreview(preview.previewId, [], admin)!.resolved.data as Data;
  assert.match(JSON.stringify(home.content[0]), /Synthetic AI HTTP factory/);
  assert.doesNotMatch(JSON.stringify(home.content[0]), /ActionButton/);
  assert.equal(edited.plan.pages[0].sections[0].cta, null);

  assert.throws(() => reviseAiSitePlan({ planId, pages: plan.pages }, editor), status(403));
  assert.throws(() => reviseAiSitePlan({ planId, pages: plan.pages }, other), status(404));
  const rows = databaseRows(), before = getStudioEnvelope();
  const missingContact = [...plan.pages.slice(0, 3), { ...plan.pages[3], path: '/wrong' }];
  assert.throws(() => reviseAiSitePlan({ planId, pages: missingContact }, admin), status(422));
  for (const target of ['https://example.invalid', 'detail', 'deleted']) {
    const pages = structuredClone(plan.pages);
    pages[0].sections[0].cta = { label: 'Open offer', pageKey: target };
    assert.throws(() => reviseAiSitePlan({ planId, pages }, admin), status(422));
  }
  const injected = structuredClone(plan.pages);
  injected[0].sections[0].body = '<script>invalid</script>';
  assert.throws(() => reviseAiSitePlan({ planId, pages: injected }, admin), status(422));
  assert.throws(() => reviseAiSitePlan({ planId, pages: plan.pages, directions: [] }, admin), status(422));
  assert.deepEqual(databaseRows(), rows);
  assert.deepEqual(getStudioEnvelope(), before);
});

test('隔夜并重新连接数据库后，可继续编辑长期方案和基于最新草稿重新编译，无模型调用', () => {
  const planId = seedPlan(admin, { brief, plan: aiBuilderHttpPlan() });
  const first = previewAiSite({ planId, directionId: 'catalog', prefix: '/continued' }, admin);
  const firstExpiry = readAiBuildRun(first.previewId, admin).expiresAt;
  const saved = setAiSitePlanRetention({ planId, keep: true, directionId: 'catalog', prefix: '/continued' }, admin);
  assert.equal(saved.planId, planId);
  assert.equal(saved.savedPlan?.prefix, '/continued');
  assert.deepEqual(setAiSitePlanRetention({ planId, keep: true, directionId: 'catalog', prefix: '/continued' }, admin), saved);
  assert.equal(readAiBuildRun(first.previewId, admin).expiresAt, firstExpiry);
  const yesterday = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  getDatabase().prepare('UPDATE cms_ai_build SET created_at=? WHERE id=?').run(yesterday, planId);
  getDatabase().prepare('UPDATE cms_ai_build SET expires_at=? WHERE id=?').run(yesterday, first.previewId);
  getDatabase().close();

  const restored = readAiBuildRun(planId, admin);
  assert.deepEqual(restored, saved);
  assert.throws(() => applyAiSite({ previewId: first.previewId, expectedRevision: 0 }, admin), status(410));
  patchStudio({ expectedRevision: 0, patch: { theme: { ...getDraftRecord().content.theme, primary: '#123456' } } }, admin);
  const pages = structuredClone(saved.plan.pages);
  pages[0].sections[0].heading = 'An updated plan after the weekend';
  const revised = reviseAiSitePlan({ planId, pages }, admin);
  assert.notEqual(revised.planId, planId);
  assert.equal(revised.savedPlan?.prefix, '/continued');
  const next = previewAiSite({ planId: revised.planId, directionId: revised.savedPlan!.directionId, prefix: revised.savedPlan!.prefix }, admin);
  assert.equal(next.baseRevision, 1);
  assert.match(JSON.stringify(resolveAiSitePreview(next.previewId, ['continued'], admin)!.resolved.data), /An updated plan after the weekend/);
  assert.equal(listAiBuildRuns(admin).items.find(item => item.savedPlan)?.id, revised.planId);
  assert.throws(() => readAiBuildRun(first.previewId, admin), status(404), '新预览只清理到期的短期候选');
  const before = getStudioEnvelope();
  const applied = applyAiSite({ previewId: next.previewId, expectedRevision: 1 }, admin);
  assert.equal(applied.activeReleaseId, before.activeReleaseId);
  assert.deepEqual(undoAiSite({ previewId: next.previewId, expectedRevision: applied.revision }, admin).state.editorData, before.state.editorData);
  assert.equal((getDatabase().prepare('SELECT COUNT(*) n FROM cms_ai_usage').get() as { n: number }).n, 0);
});

test('长期方案修订保留旧冻结预览，旧窗口不能覆盖新方案，且名额可主动腾出', () => {
  const planId = seedPlan(admin, { brief, plan: aiBuilderHttpPlan() });
  const keep = (id: string, actor = admin) => setAiSitePlanRetention({ planId: id, keep: true, directionId: 'editorial', prefix: '/retained' }, actor);
  const saved = keep(planId), frozen = previewAiSite({ planId, directionId: 'editorial', prefix: '/retained' }, admin);
  const rendering = resolveAiSitePreview(frozen.previewId, ['retained'], admin)!.resolved.data;
  assert.throws(() => keep(planId, other), status(404));
  assert.throws(() => keep(planId, editor), status(403));
  assert.throws(() => setAiSitePlanRetention({ planId, keep: true, directionId: 'editorial', prefix: '/admin' }, admin), status(422));
  assert.throws(() => keep(frozen.previewId), status(404));

  const pages = structuredClone(saved.plan.pages);
  pages[0].title = 'Current offline edition';
  const revised = reviseAiSitePlan({ planId, pages }, admin);
  assert.throws(() => reviseAiSitePlan({ planId, pages }, admin), status(409));
  assert.throws(() => keep(planId), status(409));
  assert.throws(() => previewAiSite({ planId, directionId: 'editorial', prefix: '/retained' }, admin), status(409));
  const old = readAiBuildRun(frozen.previewId, admin);
  assert.equal(old.kind, 'preview');
  assert.equal(old.kind === 'preview' && old.plan?.superseded, true);
  assert.equal(old.kind === 'preview' && old.plan?.plan.pages[0].title, saved.plan.pages[0].title);
  assert.deepEqual(resolveAiSitePreview(frozen.previewId, ['retained'], admin)!.resolved.data, rendering);

  const remaining = Array.from({ length: 9 }, () => keep(seedPlan(admin, { brief, plan: aiBuilderHttpPlan() })));
  const another = seedPlan(admin, { brief, plan: aiBuilderHttpPlan() });
  assert.throws(() => keep(another), status(429));
  assert.equal(listAiBuildRuns(admin).items.filter(item => item.savedPlan).length, 10);
  const demoted = setAiSitePlanRetention({ planId: remaining[0].planId, keep: false }, admin);
  assert.equal(demoted.savedPlan, undefined);
  assert.ok(Date.parse(demoted.expiresAt) - Date.now() <= 40 * 60_000);
  assert.ok(keep(another).savedPlan);
  assert.equal(readAiBuildRun(revised.planId, admin).kind, 'plan');
});

test('长期方案引用失效素材时保留内容，手工移除这条引用后可重新编译', () => {
  const plan = aiBuilderHttpPlan();
  plan.pages[0].sections[0].mediaId = 'removed-photo';
  const planId = seedPlan(admin, { brief, plan });
  const saved = setAiSitePlanRetention({ planId, keep: true, directionId: 'editorial', prefix: '/photos' }, admin);
  assert.throws(() => previewAiSite({ planId, directionId: 'editorial', prefix: '/photos' }, admin), /引用的图片素材不存在/);
  assert.deepEqual(readAiBuildRun(planId, admin), saved);
  const pages = structuredClone(saved.plan.pages);
  delete pages[0].sections[0].mediaId;
  const repaired = reviseAiSitePlan({ planId, pages }, admin);
  assert.ok(repaired.savedPlan);
  assert.equal(previewAiSite({ planId: repaired.planId, directionId: 'editorial', prefix: '/photos' }, admin).baseRevision, 0);
});
