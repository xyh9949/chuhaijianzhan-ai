import assert from 'node:assert/strict';
import type { StudioState } from '../src/lib/types';
import type { LaunchCheckReport, LaunchCheckRequest } from '../src/lib/launch-check-types';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };

/** 生产构建的HTTP验收只使用隔离实例和本机网址，绝不把公网、真实AI或真实邮件当测试依赖。 */
export async function runLaunchCheckHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }, state: Envelope): Promise<Envelope> {
  const { admin, editor, viewer, anonymous } = clients, before = await admin.api<Envelope>('/api/studio');
  const endpoint = '/api/launch-check', inspect = `${endpoint}/check`;
  for (const [client, code] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) { await client.api(endpoint, 'GET', undefined, code); await client.api(inspect, 'POST', {}, code); }
  assert.equal((await admin.fetch(inspect, { method: 'POST', headers: { Origin: 'https://untrusted.example.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const response = await admin.fetch(endpoint); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') || '', /no-store/); const initial = await response.json() as LaunchCheckReport;
  assert.equal(initial.revision, before.revision); assert.equal(initial.releaseId, before.activeReleaseId); assert.equal(initial.summary.total, initial.items.length); assert.equal(initial.items.length, new Set(initial.items.map(item => item.id)).size);
  assert.ok(initial.items.some(item => item.id === 'ai-config')); assert.ok(initial.items.some(item => item.id === 'mail-test')); assert.equal(initial.items.find(item => item.id === 'backup-recoverability')?.status, 'unverified');
  assert.doesNotMatch(JSON.stringify(initial), /secret_cipher|configuration_fingerprint|synthetic-http-mail-password|SYNTHETIC_PRIVATE/);
  const input: LaunchCheckRequest = { expectedRevision: before.revision, expectedReleaseId: before.activeReleaseId, checks: ['local'] };
  await admin.api(inspect, 'POST', { ...input, url: 'https://arbitrary.example.invalid/' }, 422); await admin.api(inspect, 'POST', { ...input, checks: ['mail'] }, 422); await admin.api(inspect, 'POST', { ...input, expectedRevision: before.revision + 1 }, 409); await admin.api(inspect, 'POST', { ...input, expectedReleaseId: 'outdated-release' }, 409);
  const local = await admin.api<LaunchCheckReport>(inspect, 'POST', input); assert.deepEqual(local.lastCheck?.checks, ['local']); assert.equal(local.revision, before.revision); assert.equal(local.releaseId, before.activeReleaseId);
  assert.deepEqual(await admin.api('/api/studio'), before, '检查不改网站、通知或公开指针');
  const known = await admin.api<LaunchCheckReport>(endpoint); assert.equal(known.lastCheck?.id, local.lastCheck?.id); assert.equal(known.lastCheck?.expiresAt, local.lastCheck?.expiresAt, '只读刷新不续期');
  // 仅在服务端当前目标确认为本机/空时调用公开检查；合成公网行为由受控单元依赖验证，HTTP不连外网。
  if (known.publicUrl) { const url = new URL(known.publicUrl); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'HTTP测试须使用隔离本机正式地址'); }
  const publicResult = await admin.api<LaunchCheckReport>(inspect, 'POST', { ...input, checks: ['public-website'] });
  for (const id of ['public-home', 'public-robots', 'public-sitemap', 'public-indexing', 'public-canonical']) assert.equal(publicResult.items.find(item => item.id === id)?.status, 'unverified', '本机演示不冒充公网验证');
  assert.deepEqual(await admin.api('/api/studio'), before); assert.equal(before.revision, state.revision); assert.equal(before.activeReleaseId, state.activeReleaseId);
  return before;
}
