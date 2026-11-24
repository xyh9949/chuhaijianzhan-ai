// 仅由隔离测试子进程执行；本机CA只通过该进程环境信任，不读取正式实例配置。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getDatabase } from '../../../src/server/database';
import { getDraftRecord, createInquiry } from '../../../src/server/studio';
import { saveMailSettings, testMailSettings } from '../../../src/server/mail-settings';
import type { Actor } from '../../../src/server/permissions';
const directory = process.argv[2], port = Number(process.argv[3]);
assert.ok(directory && Number.isInteger(port) && port > 0);
process.env.FORM_STUDIO_DATA_DIR = join(directory, 'tls-client'); process.env.FORM_STUDIO_NOTIFY_TRANSPORT = 'none'; process.env.BETTER_AUTH_SECRET = 'synthetic-local-smtp-child-secret-'.repeat(3); process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3299';
const actor: Actor = { id: 'smtp-client-admin', name: 'Synthetic test admin', email: 'test@example.invalid', role: 'admin' };
async function main() { try {
  getDraftRecord(); const db = getDatabase(); db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)'); db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(actor.id, actor.name, actor.email, actor.role);
  createInquiry({ name: 'Private synthetic client', email: 'private@example.invalid', message: 'PRIVATE_INQUIRY_MUST_NOT_APPEAR_IN_TEST_MAIL' });
  const config = saveMailSettings({ expectedRevision: 0, enabled: false, host: 'localhost', port, security: 'tls', username: 'fixture-smtp-user', password: 'fixture-smtp-password', from: 'sender@example.invalid', to: ['configured-sales@example.invalid'], allowLocal: true }, actor);
  const result = await testMailSettings({ expectedRevision: config.revision, recipient: 'explicit-test@example.invalid' }, actor);
  assert.equal(result.status, 'sent'); assert.equal(result.mode, 'smtp'); console.log(JSON.stringify({ passed: true, status: result.status, automaticNotificationsEnabled: config.enabled }));
} finally { getDatabase().close(); } }
void main().catch(() => { console.error('Synthetic SMTP client verification failed'); process.exitCode = 1; });
