import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { visualFullNativePatch } from './fixtures/visual-full-native';
import { createInitialDraft } from '../src/server/seed';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, patchStudio } from '../src/server/studio';
import { validateDraft } from '../src/server/validation';
import { ApiError } from '../src/server/http';
import { createExternalSiteDesignCandidate } from '../src/server/ai-site-design';
import type { Actor } from '../src/server/permissions';

test('完整视觉UI夹具通过生产整站校验、真实保存与Known原生候选编译', () => {
  const previous = { ...process.env }, directory = mkdtempSync(join(tmpdir(), 'studio-visual-full-fixture-'));
  process.env.FORM_STUDIO_DATA_DIR = directory; process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3291'; process.env.BETTER_AUTH_SECRET = 'synthetic-full-fixture-secret-'.repeat(3);
  const actor: Actor = { id: 'full-fixture-admin', name: 'Fixture administrator', email: 'fixture@example.invalid', role: 'admin' };
  try {
    getDraftRecord(); const original = createInitialDraft(), db = getDatabase(); db.prepare('UPDATE cms_draft SET revision=0,content_json=? WHERE id=1').run(JSON.stringify(original));
    db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
    const home = original.pages.find(page => page.slug === '/')!, patch = visualFullNativePatch(original, home.id);
    // 首次独立运行没有siteLayout；旧夹具的非空断言只影响TS，运行时会拼出缺少header/footer的menus对象。
    assert.equal(original.siteLayout, undefined);
    assert.throws(() => validateDraft({ ...original, ...patch, siteLayout: { menus: patch.siteLayout?.menus || [] } }), error => error instanceof ApiError && error.status === 422 && error.message.includes('页眉'));
    assert.doesNotThrow(() => validateDraft({ ...original, ...patch }));
    const saved = patchStudio({ expectedRevision: 0, patch }, actor); assert.equal(saved.revision, 1);
    const candidate = createExternalSiteDesignCandidate({ expectedRevision: saved.revision, instruction: 'Only update the existing heading; preserve all native components and supplied data.', targets: { pageIds: [home.id], header: false, footer: false, navigation: false, style: false }, preserveText: false }, { summary: 'Actual native full-page candidate', warnings: [], operations: [{ kind: 'page', pageId: home.id, operations: [{ kind: 'text', id: 'ui-full-heading', text: 'Candidate full page heading' }] }] }, actor, () => {});
    assert.equal(candidate.appliedRevision, null); assert.equal(getDraftRecord().revision, saved.revision); assert.ok(candidate.designId);
  } finally {
    getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous);
    if (resolve(directory).startsWith(resolve(tmpdir()) + sep + 'studio-visual-full-fixture-')) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
