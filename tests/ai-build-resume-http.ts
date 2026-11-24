import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { StudioState } from '../src/lib/types';
import type { AiSiteBrief } from '../src/lib/ai-builder-types';
import type { AiBuildPlanRun, AiBuildPreviewRun, AiBuildRunsResponse } from '../src/lib/ai-build-resume-types';
import { aiBuilderHttpPlan } from './ai-builder-http';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };

/** 仅在既有隔离HTTP实例内种合成短期记录；恢复GET不重新调用模型或变更站点。 */
export async function runAiBuildResumeHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }, state: Envelope, options: { dataDirectory: string; password?: string }): Promise<Envelope> {
  const { admin, editor, viewer, anonymous } = clients, missing = `aip-${randomUUID()}`;
  for (const [client, code] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) {
    await client.api('/api/ai/build/runs', 'GET', undefined, code);
    await client.api(`/api/ai/build/runs/${missing}`, 'GET', undefined, code);
  }
  await admin.api('/api/ai/build/runs/not-valid', 'GET', undefined, 422);
  const db = new Database(join(options.dataDirectory, 'studio.sqlite')), ids: string[] = [];
  const members = await admin.api<{ members: { id: string; email: string }[] }>('/api/members');
  const adminId = members.members.find(item => item.email === 'http-admin@example.com')?.id;
  const foreignId = members.members.find(item => item.email === 'http-viewer@example.com')?.id;
  assert.ok(adminId && foreignId);
  const brief: AiSiteBrief = { companyName: 'HTTP resume private company', description: 'PRIVATE_RESUME_HTTP_BRIEF: supplied synthetic furniture details.', industry: 'Furniture', audience: 'Project buyers', market: 'Global', language: state.state.settings.language, styleNotes: '' };
  const insert = (actorId: string, payload: unknown, base = state.revision) => {
    const id = `aip-${randomUUID()}`; ids.push(id);
    db.prepare('INSERT INTO cms_ai_build(id,actor_id,kind,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id, actorId, 'plan', base, JSON.stringify(payload), new Date().toISOString(), new Date(Date.now() + 120_000).toISOString()); return id;
  };
  try {
    const planId = insert(adminId, { brief, plan: aiBuilderHttpPlan() });
    const foreign = insert(foreignId, { brief: { ...brief, description: 'FOREIGN_RESUME_HTTP_BRIEF' }, plan: aiBuilderHttpPlan() });
    const pending = insert(adminId, { pending: true });
    const preview = await admin.api<{ previewId: string; baseRevision: number; pages: { id: string; title: string; slug: string }[]; warnings: string[]; seoIssues: unknown[] }>('/api/ai/build/preview', 'POST', { planId, directionId: 'catalog', prefix: `/http-resume-${randomUUID().slice(0, 8)}` }); ids.push(preview.previewId);
    const expired = insert(adminId, { brief, plan: aiBuilderHttpPlan() });
    db.prepare("UPDATE cms_ai_build SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired);
    const before = await admin.api<Envelope>('/api/studio'), providerBefore = await admin.api('/api/ai/provider');
    const rowsBefore = db.prepare('SELECT * FROM cms_ai_build ORDER BY id').all();
    const list = await admin.api<AiBuildRunsResponse>('/api/ai/build/runs');
    assert.equal(list.currentRevision, state.revision); assert.ok(list.items.some(item => item.id === planId)); assert.ok(list.items.some(item => item.id === preview.previewId));
    for (const hidden of [foreign, pending, expired]) assert.equal(list.items.some(item => item.id === hidden), false);
    assert.doesNotMatch(JSON.stringify(list), /PRIVATE_RESUME_HTTP_BRIEF|FOREIGN_RESUME_HTTP_BRIEF|"brief"|"snapshot"|"patch"|"sections"/);
    const plan = await admin.api<AiBuildPlanRun>(`/api/ai/build/runs/${planId}`); assert.equal(plan.kind, 'plan'); assert.deepEqual(plan.brief, brief); assert.deepEqual(plan.plan, aiBuilderHttpPlan());
    const restored = await admin.api<AiBuildPreviewRun>(`/api/ai/build/runs/${preview.previewId}`); assert.equal(restored.kind, 'preview'); assert.deepEqual(restored.pages, preview.pages); assert.deepEqual(restored.warnings, preview.warnings); assert.equal(restored.plan?.planId, planId);
    assert.equal(restored.baseRevision, state.revision); assert.equal(restored.currentRevision, state.revision);
    assert.doesNotMatch(JSON.stringify(restored), /"snapshot"|"patch"|secret_cipher|apiKey|FOREIGN_RESUME_HTTP_BRIEF/);
    await admin.api(`/api/ai/build/runs/${foreign}`, 'GET', undefined, 404); await admin.api(`/api/ai/build/runs/${pending}`, 'GET', undefined, 409); await admin.api(`/api/ai/build/runs/${expired}`, 'GET', undefined, 410);
    assert.deepEqual(db.prepare('SELECT * FROM cms_ai_build ORDER BY id').all(), rowsBefore, '恢复GET不清理过期行、修改回执或延长期限');
    assert.deepEqual(await admin.api('/api/ai/provider'), providerBefore); assert.deepEqual(await admin.api('/api/studio'), before);
    db.prepare("UPDATE cms_ai_build SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(planId);
    const withoutParent = await admin.api<AiBuildPreviewRun>(`/api/ai/build/runs/${preview.previewId}`); assert.equal(Object.hasOwn(withoutParent, 'plan'), false); assert.doesNotMatch(JSON.stringify(withoutParent), /PRIVATE_RESUME_HTTP_BRIEF/);
    db.prepare('UPDATE cms_ai_build SET base_revision=? WHERE id=?').run(Math.max(0, state.revision - 1), preview.previewId);
    const stale = await admin.api<AiBuildPreviewRun>(`/api/ai/build/runs/${preview.previewId}`); assert.equal(stale.baseRevision, Math.max(0, state.revision - 1)); assert.equal(stale.currentRevision, state.revision);
    assert.deepEqual(await admin.api('/api/studio'), before, '读取历史基准只提示，不重建/采用或发布');

    // 真实权限和存储路径，长期保存仍不写网站草稿。
    const durable = insert(adminId, { brief, plan: aiBuilderHttpPlan() });
    const keep = { planId: durable, keep: true, directionId: 'catalog', prefix: `/long-plan-${randomUUID().slice(0, 8)}` };
    for (const [client, code] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) await client.api('/api/ai/build/plan/retention', 'POST', keep, code);
    await admin.api('/api/ai/build/plan/retention', 'POST', { ...keep, planId: foreign }, 404);
    const kept = await admin.api<AiBuildPlanRun>('/api/ai/build/plan/retention', 'POST', keep);
    assert.equal(kept.savedPlan?.prefix, keep.prefix);
    db.prepare('UPDATE cms_ai_build SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', durable);
    assert.deepEqual(await admin.api<AiBuildPlanRun>(`/api/ai/build/runs/${durable}`), kept);
    const newPreview = await admin.api<AiBuildPreviewRun>('/api/ai/build/preview', 'POST', { planId: durable, directionId: keep.directionId, prefix: keep.prefix }); ids.push(newPreview.previewId);
    assert.ok(newPreview.pages.some(page => page.slug === keep.prefix));
    const dropped = await admin.api<AiBuildPlanRun>('/api/ai/build/plan/retention', 'POST', { planId: durable, keep: false });
    assert.equal(dropped.savedPlan, undefined);
    assert.deepEqual(await admin.api('/api/studio'), before);
    return { state: state.state, revision: state.revision, activeReleaseId: state.activeReleaseId };
  } finally { for (const id of ids) db.prepare('DELETE FROM cms_ai_build WHERE id=?').run(id); db.close(); }
}
