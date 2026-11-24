import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { getDatabase } from '../src/server/database';
import { captureServiceTestConfiguration, recordServiceTestEvidence, readServiceTestEvidence } from '../src/server/service-test-evidence';
import type { Actor } from '../src/server/permissions';
const actor: Actor = { id: 'evidence-owner', name: 'Synthetic owner', email: 'owner@example.invalid', role: 'admin' };
let directory = '', previous: NodeJS.ProcessEnv;
beforeEach(() => { previous = { ...process.env }; directory = mkdtempSync(join(tmpdir(), 'studio-service-evidence-')); process.env.FORM_STUDIO_DATA_DIR = join(directory, 'data'); process.env.BETTER_AUTH_SECRET = 'synthetic-service-evidence-key-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3293'; for (const key of Object.keys(process.env)) if (key.startsWith('FORM_STUDIO_SMTP_') || key.startsWith('FORM_STUDIO_NOTIFY_')) delete process.env[key]; getDatabase(); });
afterEach(() => { getDatabase().close(); for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-service-evidence-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('只记录测试事实；未测试为空，最后失败覆盖旧成功，不外露配置指纹/口令', () => {
  assert.equal(readServiceTestEvidence('mail'), null); const configuration = captureServiceTestConfiguration('mail');
  recordServiceTestEvidence(configuration, actor, { mode: 'smtp', status: 'sent' }); assert.equal(readServiceTestEvidence('mail')?.status, 'sent');
  recordServiceTestEvidence(configuration, actor, { mode: 'smtp', status: 'failed', errorCode: 'EAUTH' });
  const result = readServiceTestEvidence('mail')!; assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'EAUTH'); assert.doesNotMatch(JSON.stringify(result), /fingerprint|secret_cipher|synthetic-service/);
});
test('环境修订号同为0也不能复用换账号或口令前的邮件成功证据', () => {
  process.env.FORM_STUDIO_SMTP_HOST = 'smtp.example.invalid'; process.env.FORM_STUDIO_SMTP_PASSWORD = 'synthetic-original-password';
  const initial = captureServiceTestConfiguration('mail'); recordServiceTestEvidence(initial, actor, { mode: 'smtp', status: 'sent' }); assert.ok(readServiceTestEvidence('mail'));
  process.env.FORM_STUDIO_SMTP_PASSWORD = 'synthetic-replaced-password'; assert.equal(captureServiceTestConfiguration('mail').revision, 0); assert.equal(readServiceTestEvidence('mail'), null);
  assert.doesNotMatch(JSON.stringify(getDatabase().prepare('SELECT * FROM cms_service_test_receipt').all()), /synthetic-original-password|synthetic-replaced-password/);
});
test('数据库覆盖、固定密钥与AI模型来源变化均失效，SMTP与AI证据不串用', () => {
  recordServiceTestEvidence(captureServiceTestConfiguration('mail'), actor, { mode: 'mock', status: 'mock_sent' });
  assert.equal(readServiceTestEvidence('mail')?.mode, 'mock'); assert.equal(readServiceTestEvidence('ai'), null);
  getDatabase().prepare('INSERT INTO cms_mail_settings VALUES(1,1,?,?,?)').run('{"enabled":false}', 'synthetic-mail-cipher', 'created'); assert.equal(readServiceTestEvidence('mail'), null);
  recordServiceTestEvidence(captureServiceTestConfiguration('ai'), actor, { mode: 'ai', status: 'passed' }); assert.equal(readServiceTestEvidence('ai')?.status, 'passed');
  getDatabase().prepare('UPDATE cms_ai_provider SET model=? WHERE id=1').run('new-model-with-same-revision'); assert.equal(readServiceTestEvidence('ai'), null);
  recordServiceTestEvidence(captureServiceTestConfiguration('ai'), actor, { mode: 'ai', status: 'passed' }); process.env.BETTER_AUTH_SECRET = 'different-synthetic-fixed-key-'.repeat(3); assert.equal(readServiceTestEvidence('ai'), null);
});
