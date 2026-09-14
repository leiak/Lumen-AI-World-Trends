import type { NamedEntity } from '../../../shared/entities.js';

export interface GazetteerEntry {
  name: string;
  nameEn?: string;
  type: NamedEntity['type'];
  lang: 'zh' | 'en';
}

export interface Gazetteer {
  match(text: string): NamedEntity[];
}

type IndexedEntry = GazetteerEntry & { lower: string };

export function createGazetteer(entries: GazetteerEntry[]): Gazetteer {
  const index: IndexedEntry[] = entries
    .map((e) => ({ ...e, lower: e.name.toLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length); // 长词优先，避免子串误匹配

  return {
    match(text: string): NamedEntity[] {
      const lower = text.toLowerCase();
      const seen = new Set<string>();
      const out: { entity: NamedEntity; at: number }[] = [];
      for (const entry of index) {
        if (seen.has(entry.lower)) continue;
        const at = lower.indexOf(entry.lower);
        if (at === -1) continue;
        seen.add(entry.lower);
        out.push({
          at,
          entity: {
            name: entry.name,
            nameEn: entry.nameEn,
            type: entry.type,
            lang: entry.lang
          }
        });
      }
      return out.sort((a, b) => a.at - b.at).map((o) => o.entity);
    }
  };
}
