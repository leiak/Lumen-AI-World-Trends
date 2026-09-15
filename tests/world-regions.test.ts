import { describe, it, expect } from 'vitest';
import { regionOfCountry, aggregateRegions, type RegionKey } from '../src/world/regions';

describe('world regions 大洲聚合', () => {
  it('常见国家映射到预期大洲', () => {
    expect(regionOfCountry('United States of America')).toBe('north-america');
    expect(regionOfCountry('China')).toBe('asia');
    expect(regionOfCountry('Russia')).toBe('europe');
    expect(regionOfCountry('Brazil')).toBe('latin-america');
    expect(regionOfCountry('Israel')).toBe('middle-east');
    expect(regionOfCountry('Nigeria')).toBe('africa');
    expect(regionOfCountry('Australia')).toBe('oceania');
    expect(regionOfCountry('Kosovo')).toBe('europe');
    expect(regionOfCountry('Solomon Is.')).toBe('oceania');
  });

  it('未收录国家落入 other', () => {
    expect(regionOfCountry('Antarctica')).toBe('other');
  });

  it('聚合先归一别名再按洲求和，丢弃非地图实体，降序且去零', () => {
    const heat = aggregateRegions([
      { name: 'US', count: 3 },
      { name: 'United States', count: 2 },
      { name: '美国', count: 1 },
      { name: 'China', count: 5 },
      { name: '中国', count: 4 },
      { name: '欧盟', count: 9 },
      { name: 'Brazil', count: 2 },
      { name: 'Fiji', count: 1 }
    ]);
    expect(heat).toEqual([
      { key: 'asia', count: 9 },
      { key: 'north-america', count: 6 },
      { key: 'latin-america', count: 2 },
      { key: 'oceania', count: 1 }
    ]);
    const keys = heat.map((h) => h.key) as RegionKey[];
    expect(keys.every((k, i) => i === 0 || heat[i - 1]!.count >= heat[i]!.count)).toBe(true);
  });
});
