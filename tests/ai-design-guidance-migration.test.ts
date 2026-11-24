import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { DATABASE_MIGRATIONS, migrateDatabase } from '../src/server/database-migrations';
import protocol from '../src/lib/protocol.json';
// SQL1–16摘要独立提取自原0.27交付ZIP，不能用当前迁移自身重算来掩盖历史改动。
const schema16 = [
  "91f7b630328a00a69e243ee0c9c9ffa0d476820b99a8f492e15375f51bca529a",
  "6069bf1db193ac8a186aca800eb241e53d33ae30478cb6efb5bfffaf622bb7f0",
  "556369b8c45aec27e9bc3ee9d8759f75674dba741f199d9c98c93630108c021c",
  "6da3c4fe9d60bddfb3233632ae1b2a8300664ffb2350055fe2b172a6e578e756",
  "123bc4204a315da66d8eacbcf5c92c9190e5746ba88ae0af84f1a984bf4edb3b",
  "296510468fabd266b848d3122dc137f2adfc1743ee0e03e6dfca9d29a4dfef72",
  "604bfc66162cdc526ca9c1fac6f6a77c1aaeb87d8c7bb2da23a211eecfda1291",
  "048c6eadf413c5463fe89fa518d7b96e1c67d091fab520cbec9ecbd32d703910",
  "7240044b3ae37a7350be44769ac7a85d1b41f8e3f64f69b2747e74fbb70bc40e",
  "cfede512deedb151317023816c94a11c0fdb12805fb7cb2b0d7936cc8bbe4c9b",
  "be818a92eb12795d179854f377ac50691a2606a8204a661b4e3efb9a2d62156e",
  "2a784f558ca815991c1635aa40e8d3fe7e988328c0e50172fb93f34745a09a76",
  "e28047bac78594756529ae376686f5284aec6601e40c36cebe3c390da5aab9fe",
  "ee15cddc2de94cab8fa78696b8187573f93160eb21e180fa436cfeb63a106bd0",
  "f4082d3d6bd077dc93264b1fbd8c0b465b764552301a418ba0aa9fd1d7d8394a",
  "84fce2436e7bd9d3cb098fc55c6752c9982e0495f918b5248daab0fb8275ea79"
];
const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');
const names = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
const snapshot = (db: Database.Database) => Object.fromEntries(names(db).map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
function originalDatabase() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec('CREATE TABLE cms_schema_migration(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of DATABASE_MIGRATIONS.slice(0, 16)) { db.exec(migration.sql); db.prepare('INSERT INTO cms_schema_migration VALUES(?,?,?,?)').run(migration.version,migration.name,schema16[migration.version-1],'before'); }
  // 这里只验证迁移不改认证/凭据数据，原生SDK与旧源码兼容另走独立验证脚本。
  db.exec("CREATE TABLE auth_user(id TEXT PRIMARY KEY,email TEXT,role TEXT); CREATE TABLE auth_session(id TEXT PRIMARY KEY,token TEXT); CREATE TABLE auth_verification(id TEXT PRIMARY KEY,value TEXT); INSERT INTO auth_user VALUES('owner','owner@example.invalid','admin'); INSERT INTO auth_session VALUES('session','synthetic-private-token'); INSERT INTO auth_verification VALUES('verification','synthetic-private-recovery');");
  db.prepare('INSERT INTO cms_draft VALUES(1,81,20,?,?)').run('{"keep":"latest-business"}','before');
  db.prepare('INSERT INTO cms_mail_settings VALUES(1,4,?,?,?)').run('{"enabled":false}','synthetic-existing-cipher','before');
  db.prepare('INSERT INTO cms_launch_check VALUES(?,?,?,?,?,?,?,?)').run('check-1','owner',81,null,'','{}','before','2099');
  db.prepare('INSERT INTO cms_service_test_receipt VALUES(?,?,?,?,?,?,?,?,?,?)').run('receipt-1','ai','owner',0,'database','synthetic-fingerprint','ai','passed','','before');
  return db;
}
test('SQL16升级当前保持旧SQL/业务/认证/服务证据，新增设计与AI私表保持空且幂等', () => {
  assert.deepEqual(DATABASE_MIGRATIONS.slice(0,16).map(item=>checksum(item.sql)),schema16); assert.equal(DATABASE_MIGRATIONS.length,19); assert.deepEqual(protocol,{snapshot: 28,renderer: 28,minReadable:1,database:19});
  const db=originalDatabase();try { const before=snapshot(db);migrateDatabase(db);
    for(const [name,rows] of Object.entries(before)) {
      const upgraded=(name==='cms_schema_migration'?db.prepare('SELECT * FROM cms_schema_migration WHERE version<=16 ORDER BY version').all():db.prepare(`SELECT * FROM "${name}"`).all()) as Record<string,unknown>[];
      // SQL18只允许明确新增的空视觉模型列；原连接、密文和其他所有业务列仍逐项比较。
      assert.deepEqual(name==='cms_ai_provider'?upgraded.map(({vision_model,...rest})=>{assert.equal(vision_model,'');return rest;}):upgraded,rows,name);
    }
    const added=['cms_ai_design_guidance','cms_ai_translation','cms_ai_visual_capture','cms_ai_visual_review'];
    added.push(...['cms_ai_site_translation', 'cms_ai_translation_glossary', 'cms_ai_site_translation_binding', 'cms_seo_content_proposal', 'cms_ai_usage', 'cms_ai_pricing', 'cms_ai_batch_job', 'cms_ai_batch_item', 'cms_mcp_oauth_client', 'cms_mcp_oauth_request', 'cms_mcp_oauth_code', 'cms_mcp_oauth_refresh', 'cms_mcp_oauth_access']);added.sort();
    assert.deepEqual(names(db).filter(name=>!Object.hasOwn(before,name)),added);for(const name of added)assert.equal((db.prepare(`SELECT count(*) n FROM ${name}`).get() as {n:number}).n,0,name);
    db.prepare('INSERT INTO cms_ai_design_guidance VALUES(1,3,?,?)').run('{"enabled":false,"preferredStyle":"keep private","preserveNotes":"","avoidStyles":"","feedback":[]}','saved');const upgraded=snapshot(db);migrateDatabase(db);assert.deepEqual(snapshot(db),upgraded);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  }finally{db.close();}
});
test('SQL17表名冲突整次回滚，旧迁移/认证/设计前资料和schema保持', () => {
  const db=originalDatabase();try{db.exec('CREATE TABLE cms_ai_design_guidance(id TEXT PRIMARY KEY,keep TEXT)');db.prepare('INSERT INTO cms_ai_design_guidance VALUES(?,?)').run('foreign','keep');const before=snapshot(db),schema=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();assert.throws(()=>migrateDatabase(db),/already exists/);assert.deepEqual(snapshot(db),before);assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),schema);assert.equal((db.prepare('SELECT max(version) n FROM cms_schema_migration').get() as {n:number}).n,16);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');}finally{db.close();}
});
