import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { saveCausalChain, listCausalChains, getCausalChain } from '../electron/main/causal/repository.js';
import type { CausalChain } from '../shared/causal.js';

const chain = (id: string, root: string, at: string): CausalChain => ({
  id,
  rootEntity: root,
  generatedAt: at,
  model: 'rule',
  nodes: [
    { eventId: 'ev1', title: 'A', occurredAt: at, articleCount: 1 },
    { eventId: 'ev2', title: 'B', occurredAt: at, articleCount: 1 }
  ],
  links: [{ fromEventId: 'ev1', toEventId: 'ev2', anchor: 'Oil', kind: 'rule' }]
});

describe('causal 仓储', () => {
  it('保存并按时间倒序列出，可按 id 取回', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    saveCausalChain(db, chain('c1', 'China', '2026-01-01T00:00:00Z'));
    saveCausalChain(db, chain('c2', 'Oil', '2026-01-03T00:00:00Z'));

    const rows = listCausalChains(db);
    expect(rows.map((r) => r.id)).toEqual(['c2', 'c1']);
    expect(rows[0]?.rootEntity).toBe('Oil');

    const got = getCausalChain(db, 'c1');
    expect(got?.rootEntity).toBe('China');
    expect(got?.links[0]?.anchor).toBe('Oil');

    expect(getCausalChain(db, 'missing')).toBeNull();
    db.close();
  });
});