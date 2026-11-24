import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { DATABASE_MIGRATIONS, migrateDatabase } from '../src/server/database-migrations';

// 固定升级前0.25的运行时SQL摘要；新增邮件私表不能重写既有客户迁移历史。
const schema14 = [
  '91f7b630328a00a69e243ee0c9c9ffa0d476820b99a8f492e15375f51bca529a', '6069bf1db193ac8a186aca800eb241e53d33ae30478cb6efb5bfffaf622bb7f0',
  '556369b8c45aec27e9bc3ee9d8759f75674dba741f199d9c98c93630108c021c', '6da3c4fe9d60bddfb3233632ae1b2a8300664ffb2350055fe2b172a6e578e756',
  '123bc4204a315da66d8eacbcf5c92c9190e5746ba88ae0af84f1a984bf4edb3b', '296510468fabd266b848d3122dc137f2adfc1743ee0e03e6dfca9d29a4dfef72',
  '604bfc66162cdc526ca9c1fac6f6a77c1aaeb87d8c7bb2da23a211eecfda1291', '048c6eadf413c5463fe89fa518d7b96e1c67d091fab520cbec9ecbd32d703910',
  '7240044b3ae37a7350be44769ac7a85d1b41f8e3f64f69b2747e74fbb70bc40e', 'cfede512deedb151317023816c94a11c0fdb12805fb7cb2b0d7936cc8bbe4c9b',
  'be818a92eb12795d179854f377ac50691a2606a8204a661b4e3efb9a2d62156e', '2a784f558ca815991c1635aa40e8d3fe7e988328c0e50172fb93f34745a09a76',
  'e28047bac78594756529ae376686f5284aec6601e40c36cebe3c390da5aab9fe', 'ee15cddc2de94cab8fa78696b8187573f93160eb21e180fa436cfeb63a106bd0',
];
function originalDatabase() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec('CREATE TABLE cms_schema_migration(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of DATABASE_MIGRATIONS.slice(0, 14)) {
    db.exec(migration.sql); db.prepare('INSERT INTO cms_schema_migration VALUES(?,?,?,?)').run(migration.version, migration.name, schema14[migration.version - 1], '2026-11-13');
  }
  return db;
}

test('SQL14升级当前新增空邮件私表，旧迁移、客户业务、通知任务和其他加密配置逐字保持', () => {
  assert.deepEqual(DATABASE_MIGRATIONS.slice(0, 14).map(migration => createHash('sha256').update(migration.sql).digest('hex')), schema14);
  const db = originalDatabase();
  try {
    db.prepare('INSERT INTO cms_draft VALUES(1,76,20,?,?)').run('{"keep":"latest-site-business"}', '2026-11-13');
    db.prepare('INSERT INTO cms_release VALUES(?,?,?,?,?,?,?,?,?,?)').run('current-release', 'Current site', '{}', 'hash', 20, 20, 'owner', 'Owner', '2026-11-13', '{}');
    db.prepare('UPDATE cms_runtime SET active_release_id=?').run('current-release');
    db.prepare('INSERT INTO cms_inquiry VALUES(?,3,?,?,?)').run('current-inquiry', '{"message":"Preserve customer inquiry"}', '2026-11-13', '2026-11-13');
    db.prepare('INSERT INTO cms_notification_job(id,inquiry_id,status,attempts,next_attempt,error_code,provider_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('current-notification', 'current-inquiry', 'pending', 2, 2000000000000, 'ETIMEDOUT', '', 'created', 'updated');
    db.prepare('UPDATE cms_ai_provider SET revision=4,secret_cipher=? WHERE id=1').run('synthetic-existing-ai-cipher');
    db.prepare('INSERT INTO cms_ai_template_design(id,actor_id,template_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run('aitd-existing', 'owner', 'template', 76, '{"keep":"existing-detail"}', 'created', '2099-01-01');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const before = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    migrateDatabase(db);
    for (const name of tables) {
      const rows=(name === 'cms_schema_migration' ? db.prepare('SELECT * FROM cms_schema_migration WHERE version<=14 ORDER BY version').all() : db.prepare(`SELECT * FROM "${name}"`).all()) as Record<string,unknown>[];
      // 新可选视觉模型必须为空，原AI密文和其他连接配置不能随升级变化。
      assert.deepEqual(name==='cms_ai_provider'?rows.map(({vision_model,...rest})=>{assert.equal(vision_model,'');return rest;}):rows,before[name],name);
    }
    assert.equal((db.prepare('SELECT count(*) n FROM cms_mail_settings').get() as { n: number }).n, 0, '无默认行，升级不会覆盖服务器环境或自动启用邮件');
    // 用户后续保存的私有配置经重启不得被迁移清空；密文是合成标记，不使用真实口令。
    db.prepare('INSERT INTO cms_mail_settings VALUES(1,1,?,?,?)').run('{"enabled":false,"host":"smtp.example.invalid"}', 'synthetic-encrypted-mail-cipher', '2026-11-13');
    const upgraded = db.prepare('SELECT * FROM cms_mail_settings').get(); const migrations = db.prepare('SELECT * FROM cms_schema_migration ORDER BY version').all();
    migrateDatabase(db); assert.deepEqual(db.prepare('SELECT * FROM cms_mail_settings').get(), upgraded); assert.deepEqual(db.prepare('SELECT * FROM cms_schema_migration ORDER BY version').all(), migrations);
    assert.equal((db.prepare('SELECT max(version) n FROM cms_schema_migration').get() as { n: number }).n, 19); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
});

test('SQL15建表冲突时整次迁移回滚，旧数据和SQL14登记保持', () => {
  const db = originalDatabase();
  try {
    db.exec('CREATE TABLE cms_mail_settings(id TEXT PRIMARY KEY,keep TEXT)'); db.prepare('INSERT INTO cms_mail_settings VALUES(?,?)').run('foreign-table', 'preserve-me');
    const before = db.prepare('SELECT * FROM cms_schema_migration ORDER BY version').all();
    assert.throws(() => migrateDatabase(db), /already exists/); assert.deepEqual(db.prepare('SELECT * FROM cms_schema_migration ORDER BY version').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM cms_mail_settings').all(), [{ id: 'foreign-table', keep: 'preserve-me' }]); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
});
