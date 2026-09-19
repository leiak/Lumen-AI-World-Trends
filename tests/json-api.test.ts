import { describe, it, expect } from 'vitest';
import { createJsonApiCollector } from '../electron/main/collectors/jsonApi.js';
import type { JsonApiSourceConfig } from '../electron/main/collectors/types.js';

const cfg: JsonApiSourceConfig = {
  id: 'demo',
  name: 'Demo',
  lang: 'zh',
  kind: 'json-api',
  url: '',
  apiUrl: 'http://example.test/api',
  fieldsMap: { title: 'title', url: 'url', hotScore: 'num' }
};

describe('json-api 适配器', () => {
  it('基础字段抽取：title / url / hotScore', async () => {
    const c = createJsonApiCollector(cfg, async () => [
      { title: 'A', url: 'http://x/1', num: 1234 },
      { title: 'B', url: 'http://x/2', num: 5678 }
    ]);
    const arts = await c.collect();
    expect(arts).toHaveLength(2);
    expect(arts[0].title).toBe('A');
    expect(arts[0].url).toBe('http://x/1');
    expect(arts[0].hotScore).toBe(1234);
    expect(arts[0].source).toBe('demo');
  });

  it('dataPath 嵌套数组', async () => {
    const c = createJsonApiCollector(
      { ...cfg, dataPath: 'data.items', fieldsMap: { title: 'name', url: 'link' } },
      async () => ({ data: { items: [{ name: 'X', link: 'http://y/1' }] } })
    );
    const arts = await c.collect();
    expect(arts).toHaveLength(1);
    expect(arts[0].title).toBe('X');
  });

  it('缺 apiUrl 抛错', async () => {
    const c = createJsonApiCollector({ ...cfg, apiUrl: '' }, async () => []);
    await expect(c.collect()).rejects.toThrow('apiUrl required');
  });

  it('缺 fieldsMap.title 抛错', async () => {
    const c = createJsonApiCollector(
      { ...cfg, fieldsMap: { url: 'url' } },
      async () => []
    );
    await expect(c.collect()).rejects.toThrow('title and url required');
  });

  it('缺 fieldsMap.url 抛错', async () => {
    const c = createJsonApiCollector(
      { ...cfg, fieldsMap: { title: 'title' } },
      async () => []
    );
    await expect(c.collect()).rejects.toThrow('title and url required');
  });

  it('字段取值为 undefined 跳过该条', async () => {
    const c = createJsonApiCollector(cfg, async () => [
      { title: 'OK', url: 'http://x/1', num: 1 },
      { title: '', url: 'http://x/2', num: 2 },
      { title: 'NoUrl', num: 3 }
    ]);
    const arts = await c.collect();
    expect(arts).toHaveLength(1);
    expect(arts[0].title).toBe('OK');
  });

  it('hotScore 非数 → null', async () => {
    const c = createJsonApiCollector(cfg, async () => [
      { title: 'A', url: 'http://x/1', num: 'abc' },
      { title: 'B', url: 'http://x/2' /* no num */}
    ]);
    const arts = await c.collect();
    expect(arts[0].hotScore).toBeNull();
    expect(arts[1].hotScore).toBeNull();
  });

  it('JSON 解析失败抛错', async () => {
    const c = createJsonApiCollector(cfg, async () => {
      throw new Error('parse error');
    });
    await expect(c.collect()).rejects.toThrow('parse error');
  });

  it('headers 透传', async () => {
    let captured: Record<string, string> | undefined;
    const c = createJsonApiCollector(
      { ...cfg, headers: { 'X-Test': '1' } },
      async (_url, headers) => {
        captured = headers;
        return [];
      }
    );
    await c.collect();
    expect(captured).toEqual({ 'X-Test': '1' });
  });

  it('content / description / publishedAt 透传', async () => {
    const c = createJsonApiCollector(
      {
        ...cfg,
        fieldsMap: {
          title: 't',
          url: 'u',
          content: 'body',
          description: 'desc',
          publishedAt: 'time'
        }
      },
      async () => [{ t: 'X', u: 'http://x/1', body: 'B', desc: 'D', time: '2026-09-19' }]
    );
    const arts = await c.collect();
    expect(arts[0].content).toBe('B');
    expect(arts[0].publishedAt).toBe('2026-09-19');
  });
});
