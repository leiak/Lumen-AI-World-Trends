import type { Database } from 'sql.js';
import type { StockGroup } from '../../../shared/stocks.js';

export const DEFAULT_GROUP_NAME = '默认';

function toGroup(r: Record<string, unknown>): StockGroup {
  return {
    id: Number(r.id),
    name: String(r.name),
    sort: Number(r.sort) || 0
  };
}

export function listGroups(db: Database): StockGroup[] {
  const stmt = db.prepare('SELECT id, name, sort FROM stock_group ORDER BY sort, id');
  const out: StockGroup[] = [];
  while (stmt.step()) out.push(toGroup(stmt.getAsObject() as unknown as Record<string, unknown>));
  stmt.free();
  return out;
}

export function getGroupByName(db: Database, name: string): StockGroup | null {
  const stmt = db.prepare('SELECT id, name, sort FROM stock_group WHERE name = ?');
  stmt.bind([name]);
  const found = stmt.step() ? toGroup(stmt.getAsObject() as unknown as Record<string, unknown>) : null;
  stmt.free();
  return found;
}

export function getDefaultGroup(db: Database): StockGroup {
  const found = getGroupByName(db, DEFAULT_GROUP_NAME);
  if (found) return found;
  return createGroup(db, DEFAULT_GROUP_NAME);
}

export function createGroup(db: Database, name: string): StockGroup {
  const clean = name.trim();
  if (!clean) throw new Error('group name required');
  if (getGroupByName(db, clean)) throw new Error(`group name exists: ${clean}`);
  const sortStmt = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM stock_group');
  sortStmt.step();
  const sort = Number((sortStmt.getAsObject() as unknown as { s: number }).s) || 0;
  sortStmt.free();
  const now = new Date().toISOString();
  try {
    const stmt = db.prepare(
      'INSERT INTO stock_group (name, sort, created_at) VALUES (?, ?, ?)'
    );
    stmt.run([clean, sort, now]);
    stmt.free();
  } catch (e) {
    throw new Error(`group name exists: ${clean}`);
  }
  const found = getGroupByName(db, clean);
  if (!found) throw new Error(`createGroup failed: ${clean}`);
  return found;
}

export function renameGroup(db: Database, id: number, name: string): StockGroup {
  const clean = name.trim();
  if (!clean) throw new Error('group name required');
  if (id <= 0) throw new Error('invalid group id');
  // 同名校验
  const existing = getGroupByName(db, clean);
  if (existing && existing.id !== id) {
    throw new Error(`group name exists: ${clean}`);
  }
  db.run('UPDATE stock_group SET name = ? WHERE id = ?', [clean, id]);
  const refreshed = listGroups(db).find((g) => g.id === id);
  if (!refreshed) throw new Error(`group not found: ${id}`);
  return refreshed;
}

export function removeGroup(db: Database, id: number): void {
  if (id <= 0) throw new Error('invalid group id');
  const groups = listGroups(db);
  if (groups.length <= 1) throw new Error('cannot remove the last group');
  // 不允许删「默认」组
  const target = groups.find((g) => g.id === id);
  if (target && target.name === DEFAULT_GROUP_NAME) {
    throw new Error('cannot remove default group');
  }
  const fallback = groups.find((g) => g.id !== id)!;
  db.run('UPDATE stock_watch SET group_id = ? WHERE group_id = ?', [fallback.id, id]);
  db.run('DELETE FROM stock_group WHERE id = ?', [id]);
}

export function setWatchGroup(db: Database, symbol: string, groupId: number | null): void {
  db.run('UPDATE stock_watch SET group_id = ? WHERE symbol = ?', [groupId, symbol]);
}

/** 启动时确保「默认」组存在；返回默认组 id。 */
export function seedDefaultGroup(db: Database): number {
  return getDefaultGroup(db).id;
}