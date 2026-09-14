import { describe, it, expect } from 'vitest';
import { createGazetteer } from '../electron/main/extract/gazetteer.js';

describe('gazetteer', () => {
  it('大小写不敏感抽取并去重', () => {
    const g = createGazetteer([
      { name: 'China', type: 'country', lang: 'en' },
      { name: 'United States', type: 'country', lang: 'en' }
    ]);
    const hits = g.match('CHINA and the united states visited China');
    expect(hits.map((h) => h.name)).toEqual(['China', 'United States']);
  });

  it('长词优先', () => {
    const g = createGazetteer([
      { name: 'US', type: 'country', lang: 'en' },
      { name: 'United States', type: 'country', lang: 'en' }
    ]);
    const hits = g.match('The United States agreed');
    expect(hits.map((h) => h.name)).toEqual(['United States']);
  });
});
