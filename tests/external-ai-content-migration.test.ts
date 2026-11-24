import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { DATABASE_MIGRATIONS, migrateDatabase } from '../src/server/database-migrations';

// 校验已交付SQL12，升级不得改写旧机器凭据或让设计连接获得内容域授权。
test('SQL12有凭据的实例升级当前保留原权限、业务和请求，新增内容范围默认为空且重入幂等', () => {
  assert.equal(createHash('sha256').update(DATABASE_MIGRATIONS[11].sql).digest('hex'), '2a784f558ca815991c1635aa40e8d3fe7e988328c0e50172fb93f34745a09a76');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE cms_schema_migration(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
    for (const migration of DATABASE_MIGRATIONS.slice(0, 12)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO cms_schema_migration VALUES(?,?,?,?)').run(migration.version, migration.name, createHash('sha256').update(migration.sql).digest('hex'), '2026-11-13');
    }
    db.prepare('INSERT INTO cms_external_ai_token VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('old-design', 'owner', 'Original client', 'hash', 'hint', '["read","propose"]', 'null', 'created', '2099-01-01', null, null);
    db.prepare('INSERT INTO cms_external_ai_request VALUES(?,?,?,?,?)').run('old-design','original-request','request-hash','original-design','created');
    const token = db.prepare('SELECT * FROM cms_external_ai_token').get() as Record<string,unknown>;
    const requests = db.prepare('SELECT * FROM cms_external_ai_request').all();
    migrateDatabase(db);
    const { record_ids_json, template_ids_json, ...upgraded } = db.prepare('SELECT * FROM cms_external_ai_token').get() as Record<string,unknown>;
    assert.deepEqual(upgraded, token); assert.deepEqual(JSON.parse(String(template_ids_json)), []);
    assert.deepEqual(JSON.parse(String(record_ids_json)), { productIds: [], entryIds: [] });
    assert.deepEqual(db.prepare('SELECT * FROM cms_external_ai_request').all(), requests);
    for (const name of ['cms_external_ai_writing','cms_external_ai_seo_request']) assert.equal((db.prepare(`SELECT count(*) n FROM ${name}`).get() as {n:number}).n, 0);
    const migrations = db.prepare('SELECT * FROM cms_schema_migration').all(); migrateDatabase(db);
    assert.deepEqual(db.prepare('SELECT * FROM cms_schema_migration').all(), migrations);
    assert.equal(migrations.length, 19); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
});
