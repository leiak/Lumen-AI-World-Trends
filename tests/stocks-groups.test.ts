import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import {
  DEFAULT_GROUP_NAME,
  createGroup,
  getDefaultGroup,
  listGroups,
  removeGroup,
  renameGroup,
  seedDefaultGroup,
  setWatchGroup
} from '../electron/main/db/stocksGroups.js';
import { addWatch, loadWatch, seedDefaultWatch } from '../electron/main/db/stocks.js';
import { DEFAULT_WATCHLIST } from '../electron/main/stocks/watchlist.js';

describe('stock groups', () => {
  let db: Database;

  beforeAll(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    migrate(db);
  });

  it('seedDefaultGroup 创建「默认」组', () => {
    const id = seedDefaultGroup(db);
    expect(id).toBeGreaterThan(0);
    expect(getDefaultGroup(db).name).toBe(DEFAULT_GROUP_NAME);
  });

  it('createGroup 去重并自动排序', () => {
    seedDefaultGroup(db);
    const a = createGroup(db, 'A股');
    const b = createGroup(db, '港股');
    expect(a.name).toBe('A股');
    expect(b.name).toBe('港股');
    expect(b.sort).toBeGreaterThan(a.sort);
    expect(listGroups(db).length).toBeGreaterThanOrEqual(3);
  });

  it('createGroup 同名抛错', () => {
    seedDefaultGroup(db);
    createGroup(db, '美股');
    expect(() => createGroup(db, '美股')).toThrow(/exists/i);
  });

  it('createGroup 空名抛错', () => {
    expect(() => createGroup(db, '   ')).toThrow(/required/i);
  });

  it('renameGroup 修改名称', () => {
    const g = createGroup(db, 'temp');
    const renamed = renameGroup(db, g.id, '观察池');
    expect(renamed.name).toBe('观察池');
    expect(listGroups(db).find((x) => x.id === g.id)?.name).toBe('观察池');
  });

  it('renameGroup 冲突名抛错', () => {
    seedDefaultGroup(db);
    const a = createGroup(db, 'a组');
    const b = createGroup(db, 'b组');
    expect(() => renameGroup(db, b.id, a.name)).toThrow(/exists/i);
  });

  it('removeGroup 把 watch 移回默认组', () => {
    seedDefaultGroup(db);
    const defId = getDefaultGroup(db).id;
    const g = createGroup(db, '待删组');
    seedDefaultWatch(db, [DEFAULT_WATCHLIST[16]!], g.id); // 贵州茅台
    expect(loadWatch(db)[0]?.groupId).toBe(g.id);
    removeGroup(db, g.id);
    expect(loadWatch(db)[0]?.groupId).toBe(defId);
    expect(listGroups(db).find((x) => x.id === g.id)).toBeUndefined();
  });

  it('removeGroup 默认组不可删', () => {
    seedDefaultGroup(db);
    const defId = getDefaultGroup(db).id;
    expect(() => removeGroup(db, defId)).toThrow(/default/i);
  });

  it('removeGroup 最后剩 1 组时不可删', () => {
    // 用一个空 DB 测
    const SQL = initSqlJs;
    return SQL().then((s) => {
      const db2 = new s.Database();
      migrate(db2);
      const id = seedDefaultGroup(db2);
      expect(() => removeGroup(db2, id)).toThrow(/last group/i);
      db2.close();
    });
  });

  it('setWatchGroup 切组生效', () => {
    seedDefaultGroup(db);
    const target = createGroup(db, 'switch-target');
    // 用一个不与既有自选重复的代码
    addWatch(db, { symbol: 'sh999999', name: '测试股', market: 'cn' });
    const sym = 'sh999999';
    setWatchGroup(db, sym, target.id);
    expect(loadWatch(db).find((w) => w.symbol === sym)?.groupId).toBe(target.id);
    setWatchGroup(db, sym, null);
    expect(loadWatch(db).find((w) => w.symbol === sym)?.groupId).toBeNull();
  });

  it('addWatch 默认归入 null 组（用户显式不指定）', () => {
    seedDefaultGroup(db);
    const defId = getDefaultGroup(db).id;
    addWatch(db, { symbol: 'sh999999', name: '测试股', market: 'cn' });
    expect(loadWatch(db).find((w) => w.symbol === 'sh999999')?.groupId).toBeNull();
    // setWatchGroup 到默认组
    setWatchGroup(db, 'sh999999', defId);
    expect(loadWatch(db).find((w) => w.symbol === 'sh999999')?.groupId).toBe(defId);
  });
});