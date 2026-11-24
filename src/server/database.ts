import { migrateDatabase } from './database-migrations';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const connections = globalThis as typeof globalThis & { formStudioDatabases?: Map<string, Database.Database> };

export function getDataDirectory() {
  // 持久文件在运行时挂载，不让构建器将客户数据库或媒体追踪进服务端包。
  return resolve(/* turbopackIgnore: true */ process.env.FORM_STUDIO_DATA_DIR || join(process.cwd(), 'data'));
}

// 每个独立客户实例使用自己的持久目录；开发热更新复用连接，测试可切换独立临时目录。
export function getDatabase(): Database.Database {
  const directory = getDataDirectory();
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'studio.sqlite');
  const registry = connections.formStudioDatabases ??= new Map();
  const cached = registry.get(path);
  if (cached?.open) return cached;
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try { migrateDatabase(db); } catch(error) { db.close(); throw error; }
  registry.set(path, db);
  return db;
}
