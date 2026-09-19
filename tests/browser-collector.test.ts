import { describe, it, expect, vi } from 'vitest';
import { createBrowserCollector } from '../electron/main/collectors/browser.js';
import type { BrowserSourceConfig } from '../electron/main/collectors/types.js';

const config: BrowserSourceConfig = {
  id: 'demo',
  name: 'Demo',
  lang: 'zh',
  kind: 'browser',
  url: '',
  browserUrl: 'http://example.test/',
  browserExtractScript: 'return [{title:"A",url:"http://x/1",num:100}];',
  fieldsMap: { title: 'title', url: 'url', hotScore: 'num' }
};

describe('browser 适配器', () => {
  it('正常提取数组 → 字段映射 + normalize', async () => {
    const navigate = vi.fn(async () => [
      { title: 'A', url: 'http://x/1', num: 100 },
      { title: 'B', url: 'http://x/2', num: 200 }
    ]);
    const c = createBrowserCollector(config, navigate);
    const arts = await c.collect();
    expect(arts).toHaveLength(2);
    expect(arts[0].title).toBe('A');
    expect(arts[0].hotScore).toBe(100);
    expect(arts[0].source).toBe('demo');
    expect(navigate).toHaveBeenCalledWith('http://example.test/', {
      waitSel: undefined,
      waitMs: undefined,
      extractScript: config.browserExtractScript
    });
  });

  it('navigate 抛错 → 返回空数组', async () => {
    const navigate = vi.fn(async () => {
      throw new Error('load fail');
    });
    const c = createBrowserCollector(config, navigate);
    const arts = await c.collect();
    expect(arts).toEqual([]);
  });

  it('navigate 返回非数组 → 返回空数组', async () => {
    const navigate = vi.fn(async () => ({ not: 'array' }));
    const c = createBrowserCollector(config, navigate);
    const arts = await c.collect();
    expect(arts).toEqual([]);
  });

  it('多源共用 navigate，一源错不污染下一源', async () => {
    let call = 0;
    const navigate = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('first source boom');
      return [{ title: 'OK', url: 'http://x/1' }];
    });
    const c1 = createBrowserCollector(config, navigate);
    const c2 = createBrowserCollector(config, navigate);
    const a1 = await c1.collect();
    const a2 = await c2.collect();
    expect(a1).toEqual([]);
    expect(a2).toHaveLength(1);
  });

  it('缺 browserExtractScript 抛错', async () => {
    const c = createBrowserCollector(
      { ...config, browserExtractScript: '' },
      async () => []
    );
    await expect(c.collect()).rejects.toThrow('browserExtractScript required');
  });
});