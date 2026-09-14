import { describe, it, expect } from 'vitest';
import { articleId, normalizeArticle } from '../electron/main/collectors/ids.js';

describe('normalizeArticle', () => {
  it('生成稳定 id 与 rawHash', () => {
    const a = normalizeArticle(
      { id: 'bbc', lang: 'en' },
      { title: 'Hello', url: 'http://x/1' }
    );
    expect(a.id).toBe(articleId('bbc', 'http://x/1', 'Hello'));
    expect(a.rawHash).toBe(a.id);
    expect(a.lang).toBe('en');
    expect(a.publishedAt).toBeNull();
  });

  it('相同输入两次 id 相同', () => {
    const mk = () =>
      normalizeArticle(
        { id: 'bbc', lang: 'en' },
        { title: 'T', url: 'http://x/u' }
      );
    expect(mk().id).toBe(mk().id);
  });
});

