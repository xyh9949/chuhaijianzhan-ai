import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { StudioState } from '../src/lib/types';
import type { AccountRecoveryAccepted, AccountRecoveryCompleted } from '../src/lib/account-recovery-types';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
/** 唯有隔离测试持有自己的临时数据库；生产接口从不提供查看恢复令牌的能力。 */
export async function runAccountRecoveryHttp(clients: { admin: Client; anonymous: Client; origin: string; dataDirectory: string; signIn: (email: string, password: string) => Promise<Response> }, state: Envelope): Promise<Envelope> {
  const { admin, anonymous, origin, dataDirectory, signIn } = clients, before = await admin.api<Envelope>('/api/studio');
  const email = 'synthetic-recovery-http@example.invalid', password = 'Synthetic-http-original-123', replacement = 'Synthetic-http-replacement-456';
  const created = await admin.api<{ member: { id: string } }>('/api/members', 'POST', { name: 'Synthetic recovery member', email, password, role: 'viewer' }, 201);
  const oldLogin = await signIn(email, password); assert.equal(oldLogin.status, 200); const oldCookie = oldLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  for (const path of ['/api/account-recovery/request','/api/account-recovery/reset']) {
    assert.equal((await anonymous.fetch(path, { method: 'POST', headers: { Origin: 'https://untrusted.example.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await anonymous.fetch(path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  }
  await anonymous.api('/api/auth/request-password-reset', 'POST', { email }, 404);
  await anonymous.api('/api/account-recovery/request', 'POST', { email, redirectTo: 'https://untrusted.example.invalid' }, 422);
  const known = await anonymous.api<AccountRecoveryAccepted>('/api/account-recovery/request', 'POST', { email }), unknown = await anonymous.api<AccountRecoveryAccepted>('/api/account-recovery/request', 'POST', { email: 'missing-recovery-http@example.invalid' }); assert.deepEqual(known, unknown);
  const readOnly = new Database(join(dataDirectory, 'studio.sqlite'), { readonly: true, fileMustExist: true }); let token = '';
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = readOnly.prepare("SELECT identifier FROM auth_verification WHERE value=? AND identifier LIKE 'reset-password:%' ORDER BY createdAt DESC").all(created.member.id) as { identifier: string }[];
      for (const row of rows) { const candidate = row.identifier.slice('reset-password:'.length), meta = `studio-recovery:${createHash('sha256').update(candidate).digest('hex')}`; if (readOnly.prepare('SELECT 1 FROM auth_verification WHERE identifier=?').get(meta)) { token = candidate; break; } }
      if (token) break; await new Promise(done => setTimeout(done, 50));
    }
    assert.equal(!!token, true, 'after真实调度应产生本机模拟恢复记录，不回传令牌');
    await anonymous.api('/api/account-recovery/reset', 'POST', { token, newPassword: 'short' }, 422);
    const reset = await anonymous.api<AccountRecoveryCompleted>('/api/account-recovery/reset', 'POST', { token, newPassword: replacement }); assert.equal(reset.reset, true);
    await anonymous.api('/api/account-recovery/reset', 'POST', { token, newPassword: replacement }, 400);
    const expiredSession = await fetch(`${origin}/api/members/me`, { headers: { Cookie: oldCookie } }); assert.equal(expiredSession.status, 401);
    assert.equal((await signIn(email, password)).status, 401);
    assert.equal((await signIn(email, replacement)).status, 200);
  } finally { token = ''; readOnly.close(); }
  // 任意账号恢复不改变网站草稿、产品、发布指针，也没有创建询盘或通知job。
  assert.deepEqual(await admin.api('/api/studio'), before); assert.equal(before.revision, state.revision); return before;
}
