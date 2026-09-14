import worldGeoJson from '../../resources/world.geojson';

export interface WorldGeoFeature {
  properties: { name: string };
  [k: string]: unknown;
}

export interface WorldGeo {
  type: string;
  features: WorldGeoFeature[];
}

export const worldGeo = worldGeoJson as unknown as WorldGeo;

const FEATURE_NAMES = new Set<string>();
for (const f of worldGeo.features) FEATURE_NAMES.add(f.properties.name);

const ALIASES: Record<string, string> = {
  US: 'United States of America',
  'United States': 'United States of America',
  美国: 'United States of America',
  中国: 'China',
  俄罗斯: 'Russia',
  乌克兰: 'Ukraine'
};

export function normalizeCountry(name: string): string | null {
  const alias = ALIASES[name];
  if (alias) return alias;
  return FEATURE_NAMES.has(name) ? name : null;
}

export interface MapDatum {
  name: string;
  value: number;
}

export function countriesToMapData(items: { name: string; count: number }[]): MapDatum[] {
  const byName = new Map<string, number>();
  for (const c of items) {
    const n = normalizeCountry(c.name);
    if (!n) continue;
    byName.set(n, (byName.get(n) ?? 0) + c.count);
  }
  return Array.from(byName, ([name, value]) => ({ name, value }));
}