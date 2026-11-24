import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { DATABASE_MIGRATIONS, migrateDatabase } from '../src/server/database-migrations';

// 从已交付0.21源码清单核对的校验值；旧迁移不能因新功能被改写后仍自称兼容。
const schema11 = [
  '91f7b630328a00a69e243ee0c9c9ffa0d476820b99a8f492e15375f51bca529a', '6069bf1db193ac8a186aca800eb241e53d33ae30478cb6efb5bfffaf622bb7f0',
  '556369b8c45aec27e9bc3ee9d8759f75674dba741f199d9c98c93630108c021c', '6da3c4fe9d60bddfb3233632ae1b2a8300664ffb2350055fe2b172a6e578e756',
  '123bc4204a315da66d8eacbcf5c92c9190e5746ba88ae0af84f1a984bf4edb3b', '296510468fabd266b848d3122dc137f2adfc1743ee0e03e6dfca9d29a4dfef72',
  '604bfc66162cdc526ca9c1fac6f6a77c1aaeb87d8c7bb2da23a211eecfda1291', '048c6eadf413c5463fe89fa518d7b96e1c67d091fab520cbec9ecbd32d703910',
  '7240044b3ae37a7350be44769ac7a85d1b41f8e3f64f69b2747e74fbb70bc40e', 'cfede512deedb151317023816c94a11c0fdb12805fb7cb2b0d7936cc8bbe4c9b',
  'be818a92eb12795d179854f377ac50691a2606a8204a661b4e3efb9a2d62156e',
];

test('SQL11实际业务库升级当前保留业务，追加私有运行资料，保留草稿/线上指针/询盘/旧提案且重入幂等', () => {
  assert.deepEqual(DATABASE_MIGRATIONS.slice(0, 11).map(m => createHash('sha256').update(m.sql).digest('hex')), schema11);
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE cms_schema_migration(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
    for (const migration of DATABASE_MIGRATIONS.slice(0, 11)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO cms_schema_migration VALUES(?,?,?,?)').run(migration.version, migration.name, schema11[migration.version - 1], '2026-11-11');
    }
    db.prepare('INSERT INTO cms_draft VALUES(1,26,19,?,?)').run('{"keep":"draft-and-current-business"}', '2026-11-11');
    db.prepare('INSERT INTO cms_release VALUES(?,?,?,?,?,?,?,?,?,?)').run('keep-release', 'Original site', '{}', 'hash', 19, 19, 'owner', 'Owner', '2026-11-11', '{}');
    db.prepare('UPDATE cms_runtime SET active_release_id=?').run('keep-release');
    db.prepare('INSERT INTO cms_inquiry VALUES(?,3,?,?,?)').run('keep-inquiry', '{"message":"Keep customer message"}', '2026-11-11', '2026-11-11');
    db.prepare('INSERT INTO cms_media_file VALUES(?,?,?,?,?,?)').run('keep-media', 'factory.jpg', 'image/jpeg', 10, 'hash', '2026-11-11');
    db.prepare('INSERT INTO cms_ai_edit(id,actor_id,page_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run('keep-old-proposal', 'owner', 'home', 26, '{}', '2026-11-11', '2026-12-11');
    db.prepare('INSERT INTO cms_ai_site_design(id,actor_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?)').run('keep-site-design', 'owner', 26, '{}', '2026-11-11', '2026-12-11');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='cms_schema_migration'").all() as { name: string }[]).map(row => row.name);
    const before = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    migrateDatabase(db);
    for (const name of tables) {
      const rows=db.prepare(`SELECT * FROM "${name}"`).all() as Record<string,unknown>[];
      // 视觉模型为明确新增的空配置；不忽略其他未知列或任何原有连接数据。
      assert.deepEqual(name==='cms_ai_provider'?rows.map(({vision_model,...rest})=>{assert.equal(vision_model,'');return rest;}):rows,before[name],name);
    }
    assert.equal((db.prepare('SELECT count(*) n FROM cms_external_ai_token').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM cms_external_ai_request').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM cms_schema_migration').get() as { n: number }).n, 19);
    const recorded = db.prepare('SELECT * FROM cms_schema_migration').all();
    migrateDatabase(db);
    assert.deepEqual(db.prepare('SELECT * FROM cms_schema_migration').all(), recorded);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
});
