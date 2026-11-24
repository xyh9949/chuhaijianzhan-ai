import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import type { Data } from '@puckeditor/core';
import { checkAiBuildSite, readBuildCheckTarget, readDraftCheckTarget, resolveBuildVisualPage, resolveDraftBuildCheckPreview } from '../src/server/ai-build-site-check';
import { createSiteConfig } from '../src/lib/site-render-config';
import { applyAiSite, previewAiSite } from '../src/server/ai-builder';
import { getDatabase } from '../src/server/database';
import { ApiError } from '../src/server/http';
import type { Actor } from '../src/server/permissions';
import { createEmptyDraft } from '../src/server/seed';
import { getDraftRecord, getStudioEnvelope, patchStudio } from '../src/server/studio';
import { aiBuilderHttpPlan } from './ai-builder-http';

test('整站检查限定本人冻结候选或实时匹配的草稿版本，精确归属节点且不修改数据', async () => {
  const previous = { ...process.env }, directory = mkdtempSync(join(tmpdir(), 'studio-build-check-'));
  process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3297';
  process.env.BETTER_AUTH_SECRET = 'isolated-first-build-check-'.repeat(4); process.env.FORM_STUDIO_VISUAL_DISABLED = '1';
  const admin: Actor = { id: 'check-admin', name: 'Admin', email: 'check-admin@example.invalid', role: 'admin' };
  const other: Actor = { id: 'check-other', name: 'Other', email: 'check-other@example.invalid', role: 'admin' };
  const editor: Actor = { id: 'check-editor', name: 'Editor', email: 'check-editor@example.invalid', role: 'editor' };
  const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;
  try {
    getDraftRecord(); const db = getDatabase();
    const draft = createEmptyDraft();
    const originalHome = draft.pages.find(page => page.slug === '/')!;
    draft.customCode = { global: { cssEnabled: true, css: 'h1 { min-width: 600px; }', jsEnabled: true, js: 'throw Error("must-not-run");' }, pages: { [originalHome.id]: { cssEnabled: true, css: 'h2 { color: red; }', jsEnabled: true, js: 'throw Error("page-script");' } } };
    db.prepare('UPDATE cms_draft SET content_json=?,revision=0 WHERE id=1').run(JSON.stringify(draft));
    db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');
    for (const actor of [admin, other, editor]) db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
    const id = `aip-${randomUUID()}`;
    const brief = { companyName: 'Synthetic catalog', description: 'Private source content for the whole-site regression.', industry: 'Furniture', audience: 'Project buyers', market: 'Global', language: 'en', styleNotes: '' };
    db.prepare('INSERT INTO cms_ai_build(id,actor_id,kind,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id, admin.id, 'plan', 0, JSON.stringify({ brief, plan: aiBuilderHttpPlan(), selectedProductIds: [] }), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
    const preview = previewAiSite({ planId: id, directionId: 'editorial', prefix: '/first-check' }, admin), previewId = preview.previewId;
    const frozen = readBuildCheckTarget(previewId, admin), home = frozen.targets.find(target => target.entry === 'home')!;
    assert.equal(home.path, '/first-check');
    assert.ok(frozen.targets.some(page => page.path === '/first-check/contact'));
    assert.ok(frozen.targets.every(page => preview.pages.some(candidate => candidate.id === page.pageId) || page.entry === 'product'));
    assert.equal(resolveBuildVisualPage(previewId, home.pageId, admin).path, `/preview/~ai/${previewId}/first-check`);
    assert.deepEqual(frozen.snapshot.customCode?.global, { cssEnabled: true, css: 'h1 { min-width: 600px; }', jsEnabled: false, js: '' });
    assert.equal(frozen.snapshot.customCode?.pages[originalHome.id].css, 'h2 { color: red; }');
    assert.equal(frozen.snapshot.customCode?.pages[home.pageId], undefined, '新建目录不能继承另一个页面的专属 CSS');
    assert.throws(() => resolveBuildVisualPage(previewId, 'other-site-page', admin), status(422));
    assert.throws(() => readBuildCheckTarget(previewId, other), status(404));
    assert.throws(() => readBuildCheckTarget(previewId, editor), status(403));
    const revision = patchStudio({ expectedRevision: 0, patch: { theme: { ...draft.theme, primary: '#123456' } } }, admin).revision;
    assert.equal(revision, 1); assert.equal(readBuildCheckTarget(previewId, admin).run.baseRevision, 0);
    const latest = getDraftRecord().content, homepage = latest.pages.find(page => page.slug === '/')!;
    // 隔离夹具同时保留碰巧同名的页面和同步区块节点，检查器只能按真实 DOM 所属资产定位。
    (latest.editorData[homepage.id] as Data).content.push(
      { type: 'Heading', props: { id: 'same-title', text: 'Page title', level: 'h1' } },
      { type: 'SharedBlock', props: { id: 'shared-reference', blockId: 'check-block' } },
    );
    latest.sharedBlocks = [{ id: 'check-block', name: 'A reusable block', data: { root: { props: {} }, content: [{ type: 'Heading', props: { id: 'same-title', text: 'Shared title', level: 'h1' } }] }, updated: new Date().toISOString() }];
    latest.customCode = { global: { cssEnabled: true, css: 'p { color: red; }', jsEnabled: true, js: 'throw Error("must-not-run");' }, pages: {} };
    for (let index = 0; index < 14; index++) {
      const page = { ...homepage, id: `check-page-${index}`, slug: `/check-page-${index}`, title: `Page ${index}` };
      latest.pages.push(page); latest.editorData[page.id] = { root: { props: {} }, content: [] };
    }
    db.prepare('UPDATE cms_draft SET content_json=? WHERE id=1').run(JSON.stringify(latest));
    const draftCheck = readDraftCheckTarget(1, 'check-page-13'), pageTarget = draftCheck.targets.find(page => page.pageId === homepage.id)!;
    assert.equal(draftCheck.previewPrefix, '/preview/~draft-check/1'); assert.equal(draftCheck.targets[0].path, '/check-page-13');
    assert.equal(draftCheck.targets.filter(page => page.path).length, 12);
    assert.match(draftCheck.targets.find(page => page.pageId === 'check-page-12')!.skipReason || '', /上限/);
    assert.deepEqual(pageTarget.editableNode?.({ renderedId: 'same-title' }), { kind: 'page', id: homepage.id, nodeId: 'same-title' });
    assert.deepEqual(pageTarget.editableNode?.({ renderedId: 'shared-instance--1', blockId: 'check-block', sourceId: 'same-title' }), { kind: 'block', id: 'check-block', nodeId: 'same-title' });
    assert.equal(pageTarget.editableNode?.({ renderedId: 'same-title', blockId: 'wrong-block' }), undefined);
    assert.equal(pageTarget.editableNode?.({ renderedId: 'missing' }), undefined);
    assert.throws(() => readDraftCheckTarget(0), status(409));
    assert.throws(() => resolveDraftBuildCheckPreview('0', [], admin), status(409));
    assert.throws(() => resolveDraftBuildCheckPreview('1', [], editor), status(403));
    assert.equal(resolveDraftBuildCheckPreview('01', [], admin), null);
    assert.equal(resolveDraftBuildCheckPreview('1', ['unknown'], admin), null);
    const latestPreview = resolveDraftBuildCheckPreview('1', [], admin)!;
    assert.equal(latestPreview.resolved.page.id, homepage.id);
    assert.equal(latestPreview.snapshot.customCode?.global?.cssEnabled, true);
    assert.equal(latestPreview.snapshot.customCode?.global?.jsEnabled, false);
    assert.equal(getDraftRecord().content.customCode?.global?.jsEnabled, true);
    const markup = (previewPrefix?: string) => renderToStaticMarkup(createElement(Render, {
      config: createSiteConfig({ ...latestPreview.snapshot, pageId: homepage.id, previewPrefix }), data: latestPreview.resolved.data,
    }));
    assert.match(markup(latestPreview.previewPrefix), /data-site-node-id="shared-shared-reference--1" data-site-source-node-id="same-title"/);
    assert.doesNotMatch(markup(), /data-site-source-node-id/);
    assert.equal(readBuildCheckTarget(previewId, admin).snapshot.customCode?.global.css, 'h1 { min-width: 600px; }', '旧冻结记录不因后改 CSS 被重写');
    const before = getStudioEnvelope(), rows = db.prepare('SELECT * FROM cms_ai_build ORDER BY id').all();
    await assert.rejects(checkAiBuildSite({ previewId, url: 'https://off-site.invalid' }, admin, 'synthetic-session=private'), status(422));
    await assert.rejects(checkAiBuildSite({ previewId }, admin, 'synthetic-session=private'), status(422));
    await assert.rejects(checkAiBuildSite({ draftRevision: 0 }, admin, 'synthetic-session=private'), status(409));
    await assert.rejects(checkAiBuildSite({ draftRevision: 1, previewId }, admin, 'synthetic-session=private'), status(422));
    await assert.rejects(checkAiBuildSite({ draftRevision: 1 }, editor, 'synthetic-session=private'), status(403));
    await assert.rejects(checkAiBuildSite({ draftRevision: 1 }, admin, 'synthetic-session=private'), status(422));
    assert.deepEqual(getStudioEnvelope(), before); assert.deepEqual(db.prepare('SELECT * FROM cms_ai_build ORDER BY id').all(), rows);
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_ai_visual_capture').get() as { n: number }).n, 0);
    const newPreview = previewAiSite({ planId: id, directionId: 'editorial', prefix: '/first-check' }, admin);
    const newFrozen = readBuildCheckTarget(newPreview.previewId, admin);
    applyAiSite({ previewId: newPreview.previewId, expectedRevision: 1 }, admin);
    assert.equal(newFrozen.snapshot.customCode?.global.css, getDraftRecord().content.customCode?.global.css);
    assert.equal(getDraftRecord().content.customCode?.global.jsEnabled, true, '采用结果不修改现站配置');
  } finally {
    getDatabase().close();
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
    Object.assign(process.env, previous);
    if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-build-check-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
