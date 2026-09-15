import type { Database } from 'sql.js';
import type { CausalChain } from '../../../shared/causal.js';

export function saveCausalChain(db: Database, chain: CausalChain): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO causal_chain (id, root_entity, generated_at, model, chain_json)
     VALUES (?, ?, ?, ?, ?)`
  );
  stmt.run([chain.id, chain.rootEntity, chain.generatedAt, chain.model, JSON.stringify(chain)]);
  stmt.free();
}

export function listCausalChains(db: Database, limit = 50): CausalChain[] {
  const stmt = db.prepare(
    `SELECT chain_json FROM causal_chain ORDER BY generated_at DESC LIMIT ?`
  );
  stmt.bind([limit]);
  const out: CausalChain[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as unknown as { chain_json: string };
    if (!r.chain_json) continue;
    try {
      out.push(JSON.parse(r.chain_json) as CausalChain);
    } catch {
      // 跳过损坏记录
    }
  }
  stmt.free();
  return out;
}

export function getCausalChain(db: Database, id: string): CausalChain | null {
  const stmt = db.prepare(`SELECT chain_json FROM causal_chain WHERE id = ?`);
  stmt.bind([id]);
  let chain: CausalChain | null = null;
  if (stmt.step()) {
    const r = stmt.getAsObject() as unknown as { chain_json: string };
    if (r.chain_json) {
      try {
        chain = JSON.parse(r.chain_json) as CausalChain;
      } catch {
        chain = null;
      }
    }
  }
  stmt.free();
  return chain;
}