import type { Database } from 'sql.js';

let db: Database | undefined;

export function setDb(database: Database | undefined): void {
  db = database;
}

export function getDb(): Database {
  if (!db) throw new Error('database not initialized');
  return db;
}
