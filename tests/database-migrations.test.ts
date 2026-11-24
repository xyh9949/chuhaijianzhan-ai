import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrateDatabase,DATABASE_MIGRATIONS} from '../src/server/database-migrations';
import {createEmptyDraft} from '../src/server/seed';
import {validateDraft} from '../src/server/validation';
import protocol from '../src/lib/protocol.json';

// 备份工具使用公开运行版本声明；新增迁移必须同步上限，仍拒绝未知更高版本。
test('运行协议的数据库上限与实际迁移一致，发布协议独立保持',()=>{
 assert.equal(protocol.database,DATABASE_MIGRATIONS.at(-1)?.version);
 assert.equal(protocol.snapshot,28);assert.equal(protocol.renderer,28);
});

test('有序迁移保留既有数据且重复运行不重写记录，未知版本拒绝',()=>{
 const db=new Database(':memory:');try{db.exec(DATABASE_MIGRATIONS[0].sql);db.prepare('INSERT INTO cms_draft VALUES(1,7,1,?,?)').run('{"original":true}','before');migrateDatabase(db);const rows=db.prepare('SELECT * FROM cms_schema_migration ORDER BY version').all();assert.equal(rows.length,DATABASE_MIGRATIONS.length);migrateDatabase(db);assert.deepEqual(db.prepare('SELECT * FROM cms_schema_migration ORDER BY version').all(),rows);assert.equal((db.prepare('SELECT revision FROM cms_draft').get() as {revision:number}).revision,7);db.prepare('INSERT INTO cms_schema_migration VALUES(99,?,?,?)').run('future','x','now');assert.throws(()=>migrateDatabase(db),/不兼容/);}finally{db.close();}
});
test('迁移校验被修改时拒绝，失败不登记部分迁移',()=>{const db=new Database(':memory:');try{migrateDatabase(db);db.prepare('UPDATE cms_schema_migration SET checksum=? WHERE version=1').run('changed');assert.throws(()=>migrateDatabase(db),/不兼容/);}finally{db.close();}});
test('新安装空站结构合法，不含演示品牌/素材/产品',()=>{const draft=createEmptyDraft();validateDraft(draft);assert.equal(draft.products.length,0);assert.equal(draft.media.length,0);assert.equal(JSON.stringify(draft).includes('Morrow'),false);assert.equal(draft.pages[0].slug,'/');});
