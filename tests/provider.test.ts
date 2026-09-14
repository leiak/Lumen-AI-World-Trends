import { describe, it, expect } from 'vitest';
import { createProvider, arkChatRequest, MockProvider } from '../electron/main/ai/provider.js';
import type { ChatMessage } from '../electron/main/ai/provider.js';

describe('ai provider', () => {
  const msg: ChatMessage[] = [{ role: 'user', content: 'hi' }];

  it('arkChatRequest 构造 ARK 兼容请求', () => {
    const req = arkChatRequest(
      { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k', model: 'm' },
      msg
    );
    expect(req.url).toMatch(/chat\/completions$/);
    expect(req.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(req.body);
    expect(body.model).toBe('m');
    expect(body.messages).toHaveLength(1);
  });

  it('createProvider 按环境变量选型', () => {
    expect(createProvider({}).name).toBe('mock');
    expect(createProvider({ ARK_API_KEY: 'k' }).name).toBe('ark');
  });

  it('MockProvider 返回非空文本', async () => {
    const out = await new MockProvider().generate(msg);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
