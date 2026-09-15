import { createHash } from 'node:crypto';
import type { Database } from 'sql.js';
import type { CausalChain, CausalLink, CausalNode } from '../../../shared/causal.js';
import { buildCausalChain } from './build.js';

export interface NarrativeOptions {
  maxEntities?: number;
  maxEvents?: number;
}

/** 把多条因果链按共享事件做传递合并，形成更大叙事。 */
export function mergeCausalChains(chains: CausalChain[]): CausalChain[] {
  if (chains.length === 0) return [];
  const parent = chains.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]] ?? parent[x];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const eventOwners = new Map<string, number>();
  chains.forEach((chain, i) => {
    for (const node of chain.nodes) {
      const owner = eventOwners.get(node.eventId);
      if (owner !== undefined) union(owner, i);
      else eventOwners.set(node.eventId, i);
    }
  });
  const groups = new Map<number, CausalChain[]>();
  chains.forEach((chain, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(chain);
    else groups.set(root, [chain]);
  });
  const out: CausalChain[] = [];
  for (const group of groups.values()) out.push(mergeGroup(group));
  return out.sort((a, b) => b.nodes.length - a.nodes.length);
}

function mergeGroup(chains: CausalChain[]): CausalChain {
  const entities = [...new Set(chains.map((c) => c.rootEntity))];
  const primary = [...chains].sort(
    (a, b) => b.nodes.length - a.nodes.length || a.rootEntity.localeCompare(b.rootEntity)
  )[0]!;
  const nodeMap = new Map<string, CausalNode>();
  for (const c of chains) {
    for (const n of c.nodes) if (!nodeMap.has(n.eventId)) nodeMap.set(n.eventId, n);
  }
  const nodes = [...nodeMap.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const seen = new Set<string>();
  const links: CausalLink[] = [];
  for (const c of chains) {
    for (const l of c.links) {
      const key = `${l.fromEventId}->${l.toEventId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(l);
    }
  }
  return {
    id: createHash('sha1').update(`narrative|${nodes.map((n) => n.eventId).join(',')}`).digest('hex'),
    rootEntity: primary.rootEntity,
    entities,
    generatedAt: new Date().toISOString(),
    model: chains.length > 1 ? 'merge' : chains[0]!.model,
    nodes,
    links
  };
}

/** 按热度取 Top 实体的规则链，合并成交叉叙事。 */
export function buildGlobalNarratives(db: Database, opts: NarrativeOptions = {}): CausalChain[] {
  const maxEntities = opts.maxEntities ?? 12;
  const maxEvents = opts.maxEvents ?? 5;
  const stmt = db.prepare(
    `SELECT e.name AS name, COUNT(ae2.article_id) AS cnt
     FROM entity e
     JOIN article_entity ae2 ON ae2.entity_id = e.id
     GROUP BY e.id
     ORDER BY cnt DESC, name ASC
     LIMIT ?`
  );
  stmt.bind([maxEntities]);
  const names: string[] = [];
  const holder = new Set<string>();
  while (stmt.step()) {
    const name = (stmt.getAsObject() as { name: string }).name;
    if (name && !holder.has(name)) {
      holder.add(name);
      names.push(name);
    }
  }
  stmt.free();
  const chains: CausalChain[] = [];
  for (const name of names) {
    const chain = buildCausalChain(db, name, { maxEvents });
    if (chain) chains.push(chain);
  }
  return mergeCausalChains(chains);
}