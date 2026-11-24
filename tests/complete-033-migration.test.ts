import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { DATABASE_MIGRATIONS, migrateDatabase } from '../src/server/database-migrations';
import protocol from '../src/lib/protocol.json';

// 从0.32.0原版source-before.zip独立执行导出的LF运行时SQL摘要；不从当前SQL自证历史兼容。
const schema18 = [
  '91f7b630328a00a69e243ee0c9c9ffa0d476820b99a8f492e15375f51bca529a',
  '6069bf1db193ac8a186aca800eb241e53d33ae30478cb6efb5bfffaf622bb7f0',
  '556369b8c45aec27e9bc3ee9d8759f75674dba741f199d9c98c93630108c021c',
  '6da3c4fe9d60bddfb3233632ae1b2a8300664ffb2350055fe2b172a6e578e756',
  '123bc4204a315da66d8eacbcf5c92c9190e5746ba88ae0af84f1a984bf4edb3b',
  '296510468fabd266b848d3122dc137f2adfc1743ee0e03e6dfca9d29a4dfef72',
  '604bfc66162cdc526ca9c1fac6f6a77c1aaeb87d8c7bb2da23a211eecfda1291',
  '048c6eadf413c5463fe89fa518d7b96e1c67d091fab520cbec9ecbd32d703910',
  '7240044b3ae37a7350be44769ac7a85d1b41f8e3f64f69b2747e74fbb70bc40e',
  'cfede512deedb151317023816c94a11c0fdb12805fb7cb2b0d7936cc8bbe4c9b',
  'be818a92eb12795d179854f377ac50691a2606a8204a661b4e3efb9a2d62156e',
  '2a784f558ca815991c1635aa40e8d3fe7e988328c0e50172fb93f34745a09a76',
  'e28047bac78594756529ae376686f5284aec6601e40c36cebe3c390da5aab9fe',
  'ee15cddc2de94cab8fa78696b8187573f93160eb21e180fa436cfeb63a106bd0',
  'f4082d3d6bd077dc93264b1fbd8c0b465b764552301a418ba0aa9fd1d7d8394a',
  '84fce2436e7bd9d3cb098fc55c6752c9982e0495f918b5248daab0fb8275ea79',
  '587703de027cf88532523d32b1895b9861a164622a24d1d6cbd88cd7ffa5c550',
  '3f4bc8c618e7a32c5e16ba046729d5b0730708f4fc95b279cac8832b2e69440d',
];
const added = ['cms_ai_site_translation', 'cms_ai_translation_glossary', 'cms_ai_site_translation_binding', 'cms_seo_content_proposal', 'cms_ai_usage', 'cms_ai_pricing', 'cms_ai_batch_job', 'cms_ai_batch_item', 'cms_mcp_oauth_client', 'cms_mcp_oauth_request', 'cms_mcp_oauth_code', 'cms_mcp_oauth_refresh', 'cms_mcp_oauth_access'].sort();
const checksum = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// 仅比较摘要，不让断言失败输出宿主机环境变量或凭据。
const environmentDigest = () => checksum(JSON.stringify(Object.entries(process.env).sort(([left],[right])=>left.localeCompare(right))));
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const names = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
type Column = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
const columns = (db: Database.Database, name: string) => db.prepare(`PRAGMA table_info(${quoted(name)})`).all() as Column[];
const snapshot = (db: Database.Database) => Object.fromEntries(names(db).map(name => [name, db.prepare(`SELECT * FROM ${quoted(name)}`).all() as Record<string, unknown>[]]));
const schema = (db: Database.Database) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const manifest = '{\n  "schemaVersion": 21, "rendererVersion": 21, "keep": "published bytes \u4e2d\u6587"\n}\n';
const draft = '{ "keep": "old product and native design", "products": [{"id":"p1","description":"Original short introduction"}], "schemaVersion":21 }';

/** 每张旧业务表均植入非空合成行；所有列都参与升级前后对比，避免空表让数据保护测试失效。 */
function oldDatabase(path = ':memory:') {
  const db = new Database(path);
  // 仅合成fixture按表名植入时暂缓外键顺序；填完后必须开启并通过完整外键检查。
  db.pragma('foreign_keys=OFF');
  db.exec('CREATE TABLE cms_schema_migration(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of DATABASE_MIGRATIONS.slice(0, 18)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO cms_schema_migration VALUES(?,?,?,?)').run(migration.version, migration.name, schema18[migration.version - 1], 'old-migration-timestamp');
  }
  // 合成认证结构验证迁移不会改第三方认证表；不使用或输出真实账号、会话与密文。
  db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,email TEXT,role TEXT,banned INTEGER); CREATE TABLE auth_account(id TEXT PRIMARY KEY,userId TEXT,password TEXT); CREATE TABLE auth_session(id TEXT PRIMARY KEY,userId TEXT,token TEXT); CREATE TABLE auth_verification(id TEXT PRIMARY KEY,identifier TEXT,value TEXT)');
  const override: Record<string, Record<string, unknown>> = {
    cms_release: { id: 'old-release', manifest_json: manifest, manifest_hash: checksum(manifest), schema_version: 21, renderer_version: 21 },
    cms_runtime: { active_release_id: 'old-release' },
    cms_draft: { content_json: draft, schema_version: 21 },
    cms_inquiry: { id: 'old-inquiry' },
    cms_ai_build: { kind: 'preview' }, cms_ai_source: { kind: 'source' }, cms_ai_translation:{kind:'product'},
    cms_ai_provider: { base_url: 'https://synthetic-ai.invalid/v1', model: 'old-model', enabled: 1, allow_local: 0 },
    cms_audit: { result: 'success' }, cms_notification_job: { status: 'pending' },
    cms_service_test_receipt: { service: 'ai', status: 'passed' },
    cms_seo_connection: { provider: 'gsc' }, cms_seo_report: { provider: 'gsc' },
    cms_external_ai_token: { id: 'old-token', scopes_json: '["read","propose"]', page_ids_json: '["home"]', record_ids_json: '{"productIds":["p1"],"entryIds":[]}', template_ids_json: '["old-template"]' },
    auth_user: { id: 'old-user', role: 'admin', banned: 0 },
  };
  for (const name of names(db).filter(name => name !== 'cms_schema_migration')) {
    const fields = columns(db, name), values = fields.map(column => {
      if (Object.hasOwn(override[name] || {}, column.name)) return override[name][column.name];
      if (column.name === 'release_id') return 'old-release';
      if (column.name === 'inquiry_id') return 'old-inquiry';
      if (column.name === 'token_id') return 'old-token';
      if (column.name === 'actor_id' || column.name === 'userId') return 'old-user';
      if (/INT/i.test(column.type)) return column.name === 'id' ? 1 : column.name === 'expires_at' ? 4102444800000 : 7;
      if (column.name.endsWith('_json')) return JSON.stringify({ keep: name, column: column.name });
      if (column.name === 'target_kind') return 'product';
      if (column.name === 'secret_cipher' || column.name === 'verifier_cipher' || column.name === 'password' || column.name === 'token') return `synthetic-private-${name}`;
      if (column.name === 'expires_at') return '2099-01-01T00:00:00.000Z';
      return `old-${name}-${column.name}`;
    });
    const existing = db.prepare(`SELECT count(*) n FROM ${quoted(name)}`).get() as { n: number };
    if (existing.n) db.prepare(`UPDATE ${quoted(name)} SET ${fields.map(field => `${quoted(field.name)}=?`).join(',')}`).run(...values);
    else db.prepare(`INSERT INTO ${quoted(name)} (${fields.map(field => quoted(field.name)).join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...values);
  }
  db.pragma('foreign_keys=ON'); assert.deepEqual(db.pragma('foreign_key_check'), []);
  return db;
}

test('当前SQL19/协议23独立上限与已交付SQL1–18摘要一致，历史快照仍为21', () => {
  assert.equal(DATABASE_MIGRATIONS.length, 19);
  assert.deepEqual(protocol, { snapshot: 28, renderer: 28, minReadable: 1, database: 19 });
  assert.deepEqual(DATABASE_MIGRATIONS.slice(0, 18).map(item => checksum(item.sql)), schema18);
});

test('SQL18真实文件库升级19保留全部旧表旧列、认证、草稿、公开原字节及环境，仅追加13私表', () => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-complete033-migration-'));
  const files = new Map([[join(directory, '.env.local'), Buffer.from('SYNTHETIC_PRIVATE_SETTING=keep-existing\r\n')], [join(directory, 'public', 'release.json'), Buffer.from(manifest)], [join(directory, 'public', 'style.css'), Buffer.from('/* old generated public artifact */\nbody { color: #123456; }\n')]]);
  mkdirSync(join(directory, 'public')); for (const [path, bytes] of files) writeFileSync(path, bytes);
  const environment = environmentDigest(), db = oldDatabase(join(directory, 'studio.sqlite'));
  try {
    const before = snapshot(db), oldColumns = Object.fromEntries(names(db).map(name => [name, columns(db, name)])), oldSchema=schema(db) as {type:string;name:string;tbl_name:string;sql:string}[];
    for (const [name, rows] of Object.entries(before)) assert.ok(rows.length > 0, `${name}必须有真实合成行`);
    migrateDatabase(db);
    for (const [name, rows] of Object.entries(before)) {
      const current = name === 'cms_schema_migration' ? db.prepare('SELECT * FROM cms_schema_migration WHERE version<=18 ORDER BY version').all() as Record<string, unknown>[] : db.prepare(`SELECT * FROM ${quoted(name)}`).all() as Record<string, unknown>[];
      // SQL19不改变旧表列；已有视觉模型和所有私有记录必须原样保留。
      assert.deepEqual(current,rows,name);
      const info = columns(db, name); assert.deepEqual(info,oldColumns[name],`${name}原列定义`);
    }
    assert.deepEqual(names(db).filter(name=>!Object.hasOwn(before,name)),added);
    const newSchema=schema(db);for(const object of oldSchema)assert.ok(newSchema.some(current=>JSON.stringify(current)===JSON.stringify(object)),`${object.name}旧索引/触发器/表定义保留`);
    for (const name of added) assert.equal((db.prepare(`SELECT count(*) n FROM ${quoted(name)}`).get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT content_json FROM cms_draft').get() as { content_json: string }).content_json, draft);
    assert.equal((db.prepare('SELECT manifest_json FROM cms_release').get() as { manifest_json: string }).manifest_json, manifest);
    for (const [path, bytes] of files) assert.deepEqual(readFileSync(path), bytes, path);
    assert.equal(environmentDigest(), environment);
    const upgraded = snapshot(db), upgradedSchema = schema(db); migrateDatabase(db);
    assert.deepEqual(snapshot(db), upgraded); assert.deepEqual(schema(db), upgradedSchema);
    assert.equal((db.prepare('SELECT max(version) n FROM cms_schema_migration').get() as { n: number }).n, 19);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close(); if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-complete033-migration-`)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('SQL19任一新表冲突均回滚整次DDL、数据与迁移登记，不留下半次升级', () => {
  for (const conflict of added) {
    const db = oldDatabase();
    try {
      { db.exec(`CREATE TABLE ${quoted(conflict)}(id TEXT PRIMARY KEY,keep TEXT)`); db.prepare(`INSERT INTO ${quoted(conflict)} VALUES(?,?)`).run('foreign-row', 'preserve-conflicting-table'); }
      const before = snapshot(db), originalSchema = schema(db);
      assert.throws(() => migrateDatabase(db), /already exists|duplicate column/);
      assert.deepEqual(snapshot(db), before, conflict); assert.deepEqual(schema(db), originalSchema, conflict);
      assert.equal((db.prepare('SELECT max(version) n FROM cms_schema_migration').get() as { n: number }).n, 18);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally { db.close(); }
  }
});
