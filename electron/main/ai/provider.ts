import axios from 'axios';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiProvider {
  readonly name: string;
  generate(messages: ChatMessage[]): Promise<string>;
}

export interface ArkConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const ARK_DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
export const ARK_DEFAULT_MODEL = 'doubao-seed-1-6-250615';

export function arkChatRequest(
  cfg: ArkConfig,
  messages: ChatMessage[]
): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({ model: cfg.model, messages, stream: false })
  };
}

export class ArkProvider implements AiProvider {
  readonly name = 'ark';
  constructor(private cfg: ArkConfig) {}

  async generate(messages: ChatMessage[]): Promise<string> {
    const req = arkChatRequest(this.cfg, messages);
    const res = await axios.post<{ choices?: { message?: { content?: string } }[] }>(req.url, req.body, {
      headers: req.headers
    });
    const content = res.data.choices?.[0]?.message?.content;
    if (!content) throw new Error('ARK response missing choices[0].message.content');
    return content;
  }
}

export class MockProvider implements AiProvider {
  readonly name = 'mock';
  async generate(_messages: ChatMessage[]): Promise<string> {
    return '（离线兜底解读）根据当前热度数据，China 相关话题频次最高且呈上升动量，提示地缘与小报动向值得关注；建议结合事件图谱核实因果关系。';
  }
}

export function createProvider(env: NodeJS.ProcessEnv): AiProvider {
  if (env.ARK_API_KEY) {
    return new ArkProvider({
      baseUrl: env.ARK_BASE_URL || ARK_DEFAULT_BASE,
      apiKey: env.ARK_API_KEY,
      model: env.ARK_MODEL || ARK_DEFAULT_MODEL
    });
  }
  return new MockProvider();
}
