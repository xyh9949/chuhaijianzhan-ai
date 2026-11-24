import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { DATABASE_MIGRATIONS, migrateDatabase } from '../src/server/database-migrations';

// 来源为升级前0.24源码ZIP运行时SQL；追加14时不能重写已交付的1–13迁移。
const schema13 = [
  '91f7b630328a00a69e243ee0c9c9ffa0d476820b99a8f492e15375f51bca529a', '6069bf1db193ac8a186aca800eb241e53d33ae30478cb6efb5bfffaf622bb7f0',
  '556369b8c45aec27e9bc3ee9d8759f75674dba741f199d9c98c93630108c021c', '6da3c4fe9d60bddfb3233632ae1b2a8300664ffb2350055fe2b172a6e578e756',
  '123bc4204a315da66d8eacbcf5c92c9190e5746ba88ae0af84f1a984bf4edb3b', '296510468fabd266b848d3122dc137f2adfc1743ee0e03e6dfca9d29a4dfef72',
  '604bfc66162cdc526ca9c1fac6f6a77c1aaeb87d8c7bb2da23a211eecfda1291', '048c6eadf413c5463fe89fa518d7b96e1c67d091fab520cbec9ecbd32d703910',
  '7240044b3ae37a7350be44769ac7a85d1b41f8e3f64f69b2747e74fbb70bc40e', 'cfede512deedb151317023816c94a11c0fdb12805fb7cb2b0d7936cc8bbe4c9b',
  'be818a92eb12795d179854f377ac50691a2606a8204a661b4e3efb9a2d62156e', '2a784f558ca815991c1635aa40e8d3fe7e988328c0e50172fb93f34745a09a76',
  'e28047bac78594756529ae376686f5284aec6601e40c36cebe3c390da5aab9fe',
];
function originalDatabase() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE cms_schema_migration(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of DATABASE_MIGRATIONS.slice(0, 13)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO cms_schema_migration VALUES(?,?,?,?)').run(migration.version, migration.name, schema13[migration.version - 1], '2026-11-13');
  }
  return db;
}

test('SQL13升级当前追加独立详情私表和空模板授权，旧业务、旧凭据与所有旧候选逐字保留', () => {
  assert.deepEqual(DATABASE_MIGRATIONS.slice(0, 13).map(migration => createHash('sha256').update(migration.sql).digest('hex')), schema13);
  const db = originalDatabase();
  try {
    db.prepare('INSERT INTO cms_draft VALUES(1,34,20,?,?)').run('{"keep":"latest-business"}', '2026-11-13');
    db.prepare('INSERT INTO cms_release VALUES(?,?,?,?,?,?,?,?,?,?)').run('latest-release', 'Current site', '{}', 'hash', 20, 20, 'owner', 'Owner', '2026-11-13', '{}');
    db.prepare('UPDATE cms_runtime SET active_release_id=?').run('latest-release');
    db.prepare('INSERT INTO cms_inquiry VALUES(?,2,?,?,?)').run('latest-inquiry', '{"message":"Keep recent inquiry"}', '2026-11-13', '2026-11-13');
    db.prepare('INSERT INTO cms_ai_site_design(id,actor_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?)').run('legacy-site-candidate', 'owner', 34, '{"changes":{"pageIds":["home"]}}', 'created', '2099-01-01');
    db.prepare('INSERT INTO cms_external_ai_token(id,actor_id,name,token_hash,token_hint,scopes_json,page_ids_json,created_at,expires_at,record_ids_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run('legacy-token', 'owner', 'Client', 'hash', 'hint', '["read","propose","content:read"]', '["home"]', 'created', '2099-01-01', '{"productIds":["p1"],"entryIds":[]}');
    db.prepare('INSERT INTO cms_external_ai_request VALUES(?,?,?,?,?)').run('legacy-token', 'site-request', 'site-hash', 'legacy-site-candidate', 'created');
    db.prepare('INSERT INTO cms_external_ai_writing(id,token_id,actor_id,request_id,request_hash,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run('legacy-writing', 'legacy-token', 'owner', 'writing-request', 'writing-hash', '{"keep":"writing"}', 'created', '2099-01-01');
    db.prepare('INSERT INTO cms_external_ai_seo_request(token_id,request_id,request_hash,proposal_id,payload_json,created_at) VALUES(?,?,?,?,?,?)').run('legacy-token', 'seo-request', 'seo-hash', 'legacy-seo', '{"keep":"seo"}', 'created');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='cms_schema_migration'").all() as { name: string }[]).map(row => row.name);
    const before = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    const previousMigrations = db.prepare('SELECT * FROM cms_schema_migration ORDER BY version').all();
    migrateDatabase(db);
    for (const name of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
      // 只剥离已声明新增的两列并单独核对默认值，原有列仍完整比较。
      const legacy=name==='cms_ai_provider'?rows.map(({vision_model,...rest})=>{assert.equal(vision_model,'');return rest;}):name === 'cms_external_ai_token' ? rows.map(({ template_ids_json, ...rest }) => { assert.deepEqual(JSON.parse(String(template_ids_json)), []); return rest; }) : rows;
      assert.deepEqual(legacy, before[name], name);
    }
    assert.deepEqual(db.prepare('SELECT * FROM cms_schema_migration WHERE version<=13 ORDER BY version').all(), previousMigrations);
    for (const name of ['cms_ai_template_design', 'cms_external_ai_template_request']) assert.equal((db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
    // 后续私有详情回执仍与旧site表隔离；重复启动不得清空它们或重写时间戳。
    db.prepare('INSERT INTO cms_ai_template_design(id,actor_id,template_id,base_revision,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run('aitd-new', 'owner', 'detail-template', 34, '{"keep":"private-detail"}', 'created', '2099-01-01');
    db.prepare('INSERT INTO cms_external_ai_template_request VALUES(?,?,?,?,?)').run('legacy-token', 'detail-request', 'detail-hash', 'aitd-new', 'created');
    const allTables = [...tables, 'cms_ai_template_design', 'cms_external_ai_template_request', 'cms_schema_migration'];
    const upgraded = Object.fromEntries(allTables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    migrateDatabase(db);
    for (const name of allTables) assert.deepEqual(db.prepare(`SELECT * FROM "${name}"`).all(), upgraded[name], name);
    assert.equal((db.prepare('SELECT max(version) n FROM cms_schema_migration').get() as { n: number }).n, 19);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
});

test('迁移14失败会回滚新增列和登记，不把半次升级误当成功', () => {
  const db = originalDatabase();
  try {
    db.exec('CREATE TABLE cms_ai_template_design(id TEXT PRIMARY KEY)');
    assert.throws(() => migrateDatabase(db), /already exists/);
    assert.equal((db.pragma('table_info(cms_external_ai_token)') as { name: string }[]).some(column => column.name === 'template_ids_json'), false);
    assert.equal((db.prepare('SELECT max(version) n FROM cms_schema_migration').get() as { n: number }).n, 13);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='cms_external_ai_template_request'").get(), undefined);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
});
