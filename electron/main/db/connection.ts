import * as fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from './migrate.js';

let sqlPromise: ReturnType<typeof initSqlJs> | undefined;

function getSql(): ReturnType<typeof initSqlJs> {
  sqlPromise ??= initSqlJs();
  return sqlPromise;
}

export async function openDatabase(dbPath: string): Promise<Database> {
  const SQL = await getSql();
  let db: Database;
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function saveDatabase(db: Database, dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}
