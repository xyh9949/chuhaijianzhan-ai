import assert from 'node:assert/strict';
import type { Inquiry, InquiryFollowUp } from '../src/lib/types';
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };

/** 在既有独立生产HTTP实例内验证权限、投影与原子跟进；只写合成询盘，不发布或发送通知。 */
export async function runLeadHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }) {
  const { admin, editor, viewer, anonymous } = clients;
  await anonymous.api('/api/inquiries/assignees', 'GET', undefined, 401);
  const directory = await editor.api<{ items: { id: string; name: string; role: string }[] }>('/api/inquiries/assignees');
  assert.ok(directory.items.length >= 2, '可用负责人目录应包含管理员和编辑员');
  assert.ok(directory.items.every(item => Object.keys(item).every(key => ['id', 'name', 'role'].includes(key))), '目录不得泄漏邮箱、会话或管理字段');
  assert.equal((await viewer.api<{ items: unknown[] }>('/api/inquiries/assignees')).items.length, directory.items.length);
  const assignee = directory.items.find(item => item.role === 'editor')!;
  const created = await admin.api<{ item: Inquiry }>('/api/inquiries', 'POST', { name: 'HTTP Lead workflow', email: 'lead-workflow@example.invalid', company: 'Synthetic QA', country: '', product: '', message: 'Synthetic lead: never send external messages.' }, 201);
  let item = created.item; assert.equal(item.origin, 'manual');
  await viewer.api(`/api/inquiries/${item.id}`, 'PATCH', { expectedRevision: item.revision, priority: 'urgent' }, 403);
  const changed = await editor.api<{ item: Inquiry }>(`/api/inquiries/${item.id}`, 'PATCH', { expectedRevision: item.revision, assigneeId: assignee.id, priority: 'high', qualification: 'qualified', nextFollowUpAt: new Date(Date.now() - 60000).toISOString(), followUpNote: 'Synthetic internal follow-up; no email or chat was sent.' });
  item = changed.item; assert.equal(item.assignee?.id, assignee.id); assert.equal(item.priority, 'high'); assert.equal(item.qualification, 'qualified'); assert.equal(item.followUpCount, 1); assert.ok(!Object.hasOwn(item, 'followUps'));
  const history = await viewer.api<{ items: InquiryFollowUp[]; revision: number }>(`/api/inquiries/${item.id}/follow-ups`);
  assert.equal(history.items.length, 1); assert.equal(history.revision, item.revision); assert.ok(history.items[0].actorId); assert.ok(history.items[0].actorName); assert.ok(Number.isFinite(Date.parse(history.items[0].createdAt)));
  await anonymous.api(`/api/inquiries/${item.id}/follow-ups`, 'GET', undefined, 401);
  await editor.api(`/api/inquiries/${item.id}`, 'PATCH', { expectedRevision: created.item.revision, followUpNote: 'stale note' }, 409);
  for (const patch of [{ followUps: [] }, { attribution: { utmSource: 'forged' } }, { assigneeId: 'missing-member' }, { qualification: 'invented' }, { nextFollowUpAt: '11/10/2026' }]) await editor.api(`/api/inquiries/${item.id}`, 'PATCH', { expectedRevision: item.revision, ...patch }, 422);
  const legacy = await editor.api<{ item: Inquiry }>(`/api/inquiries/${item.id}`, 'PATCH', { expectedRevision: item.revision, notes: 'Legacy note compatibility' });
  assert.equal(legacy.item.followUpCount, 1); assert.equal(legacy.item.assignee?.id, assignee.id);
  const listed = await admin.api<{ items: Inquiry[] }>('/api/inquiries'); assert.ok(listed.items.every(record => !Object.hasOwn(record, 'followUps')));
  const jobs = await admin.api<{ jobs: unknown[] }>(`/api/notifications?inquiryId=${item.id}`); assert.equal(jobs.jobs.length, 0, '内部跟进不得触发外发任务');
  const csv = await editor.fetch('/api/inquiries/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ followUpFilter: 'priority' }) }); assert.equal(csv.status, 200); assert.ok((await csv.text()).includes('HTTP Lead workflow'));
  const publicHome = await anonymous.fetch('/'); assert.ok(!(await publicHome.text()).includes('HTTP Lead workflow'), '询盘运行资料不得进入公开页面');
}
