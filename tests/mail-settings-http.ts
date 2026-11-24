import assert from 'node:assert/strict';
import type { StudioState } from '../src/lib/types';
import type { MailSettingsInput, MailSettingsSummary, MailSettingsTestResult } from '../src/lib/mail-settings-types';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
const endpoint = '/api/notifications/settings';
const payload = (revision: number, extra: Partial<MailSettingsInput> = {}): MailSettingsInput => ({ expectedRevision: revision, enabled: false, host: 'smtp.example.invalid', port: 587, security: 'starttls', username: 'synthetic-mail-account', from: 'website@example.invalid', to: ['sales@example.invalid'], password: 'synthetic-http-mail-password', allowLocal: false, ...extra });

/** 排在原通知业务用例之后：只模拟发送固定测试信，随后保存关闭的私有配置，不触达外部邮件服务。 */
export async function runMailSettingsHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }, state: Envelope): Promise<Envelope> {
  const { admin, editor, viewer, anonymous } = clients, before = await admin.api<Envelope>('/api/studio');
  for (const [client, expected] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) {
    await client.api(endpoint, 'GET', undefined, expected); await client.api(endpoint, 'PATCH', {}, expected); await client.api(`${endpoint}/test`, 'POST', {}, expected);
  }
  for (const [path, method] of [[endpoint, 'PATCH'], [`${endpoint}/test`, 'POST']] as const) assert.equal((await admin.fetch(path, { method, headers: { Origin: 'https://untrusted.example.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const original = await admin.api<MailSettingsSummary>(endpoint); assert.equal(original.source, 'environment'); assert.equal(original.mode, 'mock'); assert.equal(original.revision, 0); assert.equal(original.hasPassword, false);
  const jobsBefore = await admin.api<{ jobs: { id: string }[]; total: number }>('/api/notifications');
  const sent = await admin.api<MailSettingsTestResult>(`${endpoint}/test`, 'POST', { expectedRevision: original.revision, recipient: 'synthetic-mail-check@example.invalid' }); assert.equal(sent.mode, 'mock'); assert.equal(sent.status, 'mock_sent'); assert.match(sent.message, /模拟|真实/);
  await admin.api(`${endpoint}/test`, 'POST', { expectedRevision: original.revision, recipient: 'synthetic-mail-check@example.invalid' }, 429);
  const jobsAfter = await admin.api<{ jobs: { id: string }[]; total: number }>('/api/notifications'); assert.equal(jobsAfter.total, jobsBefore.total); assert.deepEqual(jobsAfter.jobs.map(job => job.id), jobsBefore.jobs.map(job => job.id), '测试邮件不创建询盘或通知任务；旧队列自身可继续处理');
  const saved = await admin.api<MailSettingsSummary>(endpoint, 'PATCH', payload(original.revision)); assert.equal(saved.source, 'database'); assert.equal(saved.revision, 1); assert.equal(saved.mode, 'none'); assert.equal(saved.enabled, false); assert.equal(saved.hasPassword, true);
  const read = await admin.api<MailSettingsSummary>(endpoint); assert.deepEqual(read, saved); assert.equal(Object.hasOwn(read, 'password'), false); assert.equal(Object.hasOwn(read, 'secret_cipher'), false); assert.doesNotMatch(JSON.stringify(read), /synthetic-http-mail-password/);
  const notifications = await admin.api<{ configuration: { mode: string; configured: boolean } }>('/api/notifications'); assert.equal(notifications.configuration.mode, 'none'); assert.equal(notifications.configuration.configured, false, '关闭配置无需重启就让通知队列停用');
  await admin.api(endpoint, 'PATCH', payload(original.revision), 409);
  await admin.api(endpoint, 'PATCH', payload(saved.revision, { host: 'another.example.invalid', password: '' }), 422); assert.equal((await admin.api<MailSettingsSummary>(endpoint)).revision, saved.revision);
  const retained = await admin.api<MailSettingsSummary>(endpoint, 'PATCH', payload(saved.revision, { password: '' })); assert.equal(retained.hasPassword, true); assert.equal(retained.revision, saved.revision + 1);
  const cleared = await admin.api<MailSettingsSummary>(endpoint, 'PATCH', payload(retained.revision, { password: '', clearPassword: true })); assert.equal(cleared.hasPassword, false); assert.equal(cleared.enabled, false);
  // 私有配置保存不属于网站内容；不改内容修订、发布指针或公开展示邮箱。
  assert.deepEqual(await admin.api('/api/studio'), before); assert.equal(before.revision, state.revision); assert.equal(before.activeReleaseId, state.activeReleaseId);
  return before;
}
