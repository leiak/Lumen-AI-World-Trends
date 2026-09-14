import { describe, it, expect } from 'vitest';
import { translate, ZH_DICT, EN_DICT } from '../src/i18n/dict';

describe('i18n dict', () => {
  it('中英文 key 集合完全一致', () => {
    expect(Object.keys(EN_DICT).sort()).toEqual(Object.keys(ZH_DICT).sort());
  });

  it('translate 返回对应语言文案', () => {
    expect(translate('zh', 'nav.dashboard')).toBe('总览');
    expect(translate('en', 'nav.dashboard')).toBe('Overview');
    expect(translate('zh', 'dash.crawl')).toBe('手动采集');
    expect(translate('en', 'world.loading')).toBe('Loading world hotspots…');
  });

  it('支持 {x} 变量插值', () => {
    expect(translate('zh', 'dash.crawlOk', { a: 3, b: 1 })).toContain('3');
    expect(translate('zh', 'dash.crawlOk', { a: 3, b: 1 })).toContain('新增 1');
    expect(translate('en', 'graph.nodeEdge', { a: 4, b: 9 })).toBe('4 nodes / 9 edges');
  });

  it('未提供变量时保留占位符', () => {
    expect(translate('zh', 'dash.autoInterval')).toContain('{m}');
  });
});