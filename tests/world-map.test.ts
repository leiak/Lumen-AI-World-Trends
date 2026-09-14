import { describe, it, expect } from 'vitest';
import { normalizeCountry, countriesToMapData } from '../src/world/geo';

describe('world geo 归一化', () => {
  it('别名映射到 GeoJSON 名称', () => {
    expect(normalizeCountry('US')).toBe('United States of America');
    expect(normalizeCountry('United States')).toBe('United States of America');
    expect(normalizeCountry('美国')).toBe('United States of America');
    expect(normalizeCountry('中国')).toBe('China');
    expect(normalizeCountry('China')).toBe('China');
    expect(normalizeCountry('俄罗斯')).toBe('Russia');
    expect(normalizeCountry('乌克兰')).toBe('Ukraine');
  });

  it('未收录名称返回 null（如欧盟/虚拟国家）', () => {
    expect(normalizeCountry('欧盟')).toBeNull();
    expect(normalizeCountry('Atlantis')).toBeNull();
  });

  it('countriesToMapData 合并别名并丢弃无法映射项', () => {
    const data = countriesToMapData([
      { name: 'US', count: 3 },
      { name: 'United States', count: 2 },
      { name: 'US', count: 1 },
      { name: '中国', count: 5 },
      { name: '欧盟', count: 9 }
    ]);
    expect(data).toEqual([
      { name: 'United States of America', value: 6 },
      { name: 'China', value: 5 }
    ]);
  });
});