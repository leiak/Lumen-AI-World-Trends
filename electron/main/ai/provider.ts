import axios from 'axios';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiProvider {
  readonly name: string;
  generate(messages: ChatMessage[]): Promise<string>;
  /** P5：可选流式；onDelta 收到增量分片，返回完整文本。非流式实现可不提供。 */
  generateStream?(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<string>;
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
  messages: ChatMessage[],
  stream = false
): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({ model: cfg.model, messages, stream })
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

  /** P5：ARK / OpenAI 兼容 SSE。按 \n 切行累积，只解析 data: 行；[DONE] 结束。 */
  async generateStream(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<string> {
    const req = arkChatRequest(this.cfg, messages, true);
    const res = await axios.post(req.url, req.body, {
      headers: { ...req.headers, Accept: 'text/event-stream' },
      responseType: 'stream'
    });
    const stream = res.data as NodeJS.ReadableStream;
    return new Promise<string>((resolve, reject) => {
      let full = '';
      let buf = '';
      const consume = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          // 忽略不完整/非 JSON 的 SSE 行（例如心跳注释）。
        }
      };
      stream.on('data', (chunk: Buffer | string) => {
        buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) consume(line);
      });
      stream.on('end', () => {
        if (buf) consume(buf);
        resolve(full);
      });
      stream.on('error', (err: Error) => reject(err));
    });
  }
}

export class MockProvider implements AiProvider {
  readonly name = 'mock';

  /** P5 E2E：仅测试环境注入；默认 0，避免拖慢单元测试。 */
  private delayMs(): number {
    const raw = Number(process.env.LUMEN_MOCK_DELAY_MS);
    return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 2000) : 0;
  }

  async generate(messages: ChatMessage[]): Promise<string> {
    const wait = this.delayMs();
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const roundMatch = user.match(/当前为第\s*(\d+)\s*轮/);
    const round = roundMatch ? Number(roundMatch[1]) : 1;
    const nextCheck = new Date(Date.now() + 7 * 86400000).toISOString();
    // 智能体节点在 system prompt 中自报角色；Mock 依此返回符合 schema 的 JSON，
    // 保证无 Key 环境也能完整跑通四节点垂直切片。
    if (system.includes('取证分析师')) {
      return JSON.stringify({
        dimension: 'heat',
        summary: '离线 Mock：本地热度样本显示话题集中度较高，动量温和向上，但样本量有限。',
        signals: [
          { claim: '核心话题热度连续三个窗口上升', direction: 'up', strength: 2, sourceIds: [] },
          { claim: '跨源覆盖不足，存在样本偏差', direction: 'flat', strength: 1, sourceIds: [] }
        ],
        dataGaps: ['离线模式未接入实时源', '国家维度样本偏少'],
        confidence: 0.55
      });
    }
    if (system.includes('多头研究员') || system.includes('涨因研究员')) {
      return JSON.stringify({
        stance: 'bull',
        argument: `[Mock 第${round}轮] 恒温与持续性指标同步抬升，热度扩散到多个来源，短期动量具备延续性。`,
        rebuttals: [{ target: '样本偏差', point: '多源交叉后方向仍一致，偏差不足以否定趋势。' }],
        evidenceRefs: [],
        confidence: 0.6
      });
    }
    if (system.includes('空头研究员') || system.includes('跌因研究员')) {
      return JSON.stringify({
        stance: 'bear',
        argument: `[Mock 第${round}轮] 热度上升主要由单一事件脉冲驱动，缺乏持续性证据，回撤风险偏高。`,
        rebuttals: [{ target: '动量延续', point: '窗口内已出现边际衰减，延续性存疑。' }],
        evidenceRefs: [],
        confidence: 0.5
      });
    }
    if (system.includes('裁决者') && (system.includes('股票') || system.includes('归因分解'))) {
      // M26：股票裁决 Mock —— 只引用取证报告里真实出现过的 [fact:id] 与数字，
      // 保证离线环境也能通过数字闸门；没有可引用事实时降级为 review。
      const cites = [...user.matchAll(/([-+]?\d+(?:\.\d+)?)[^\[]{0,30}\[fact:([^\]]+)\]/g)]
        .slice(0, 4)
        .map((m) => ({ num: m[1], factId: m[2] }));
      const missingLayers = (['market', 'fundamentals', 'disclosures', 'news'] as const).filter((l) =>
        new RegExp(`\\[${l}\\] 该维度缺失`).test(user)
      );
      const layerOf = (factId: string): 'market' | 'fundamentals' | 'disclosures' | 'news' => {
        if (factId.includes('_fundamentals_')) return 'fundamentals';
        if (factId.includes('_disclosures_')) return 'disclosures';
        if (factId.includes('_news_')) return 'news';
        return 'market';
      };
      const factorIdOf = (layer: string): string =>
        layer === 'fundamentals'
          ? 'earnings_surprise'
          : layer === 'disclosures'
            ? 'event_driven'
            : layer === 'news'
              ? 'liquidity_sentiment'
              : 'sector_market_beta';
      if (cites.length === 0) {
        return JSON.stringify({
          rating: 'review',
          confidence: 0.2,
          horizonDays: 5,
          thesis: '本地事实表没有可在 asOf 之前引用的数据，无法给出方向性结论。',
          keyRisks: ['缺少可核验的事实数据'],
          nextCheckAt: nextCheck,
          reviewRequired: true,
          reviewReason: 'insufficient_facts',
          stock: {
            factors: [
              {
                id: 'sector_market_beta',
                label: '板块/市场 Beta',
                layer: 'market',
                contribution: 'neutral',
                weight: 1,
                mechanism: '行情事实缺失',
                factIds: []
              }
            ],
            missingLayers: ['market', 'fundamentals', 'disclosures', 'news'],
            assumptions: ['需要先导入本地事实数据'],
            magnitude: 'small',
            benchmarkSymbol: 'sh000300',
            referencedFactIds: []
          }
        });
      }
      const factors = cites.map((c) => {
        const layer = layerOf(c.factId);
        return {
          id: factorIdOf(layer),
          label: layer === 'market' ? '板块/市场 Beta' : layer === 'fundamentals' ? '业绩超预期' : layer === 'disclosures' ? '事件驱动' : '流动性/情绪',
          layer,
          contribution: 'positive',
          weight: 1 / cites.length,
          mechanism: `${c.num} 来自本地事实 [fact:${c.factId}]`,
          factIds: [c.factId]
        };
      });
      const cited = cites.map((c) => `${c.num} [fact:${c.factId}]`).join('，');
      return JSON.stringify({
        rating: 'up',
        confidence: 0.58,
        horizonDays: 5,
        thesis: `综合四维取证与多空辩论，方向偏多：本地事实显示 ${cited}；缺失维度已显式标注，未做外推。`,
        keyRisks: ['样本窗口有限', '缺失维度可能影响归因完整性'],
        nextCheckAt: nextCheck,
        reviewRequired: false,
        stock: {
          factors,
          missingLayers,
          assumptions: ['仅使用 asOf 之前的本地事实', '未接入财报/公告爬虫时以显式缺失处理'],
          magnitude: 'medium',
          benchmarkSymbol: 'sh000300',
          referencedFactIds: cites.map((c) => c.factId)
        }
      });
    }
    if (system.includes('裁决者')) {
      return JSON.stringify({
        rating: 'up',
        confidence: 0.58,
        horizonDays: 7,
        thesis: '多空论据中多头占优：动量抬升且跨源方向一致，空头的脉冲解释不足以覆盖全部样本。',
        keyRisks: ['样本覆盖偏差', '单一事件反转'],
        nextCheckAt: nextCheck,
        reviewRequired: false
      });
    }
    const riskStance = system.includes('激进风控')
      ? 'aggressive'
      : system.includes('保守风控')
        ? 'conservative'
        : system.includes('中性风控')
          ? 'neutral'
          : null;
    if (riskStance) {
      return JSON.stringify({
        stance: riskStance,
        challenge: `[Mock 第${round}轮] ${riskStance === 'aggressive' ? '过度保守会错失动量机会，当前证据不足以要求等待更多确认。' : riskStance === 'conservative' ? '样本缺口与单一事件驱动仍可能造成误判，需要设置硬性观察触发条件。' : '双方都放大了自身立场，建议以跨源一致性作为唯一放行条件。'}`,
        mitigations:
          riskStance === 'aggressive'
            ? ['设置滚动回撤阈值', '扩大跨源样本']
            : riskStance === 'conservative'
              ? ['等待第二个独立来源确认', '设置结论复核日']
              : ['统一数据缺口口径', '缩短复核周期'],
        residualRisks: ['数据覆盖不足', '事件反转风险'],
        confidence: riskStance === 'aggressive' ? 0.6 : riskStance === 'conservative' ? 0.55 : 0.5
      });
    }
    if (system.includes('观察方案规划者')) {
      return JSON.stringify({
        action: 'watch',
        summary: '维持观察：热度动量向上但样本覆盖不足，等待跨源确认后再升级预警。',
        triggers: ['连续 3 日热度回落', '跨源覆盖低于 50%'],
        invalidations: ['出现反向政策信号', '核心事件热度骤降'],
        reviewInDays: 7
      });
    }
    if (system.includes('最终结论签署者')) {
      return JSON.stringify({
        rating: 'up',
        confidence: 0.56,
        horizonDays: 7,
        thesis: '综合取证、多空辩论与三方风控后，趋势仍偏向上；风控残余风险作为观察触发条件保留。',
        keyRisks: ['样本覆盖偏差', '单一事件反转', '风控指出的数据缺口'],
        nextCheckAt: nextCheck,
        reviewRequired: false
      });
    }
    return '（离线兜底解读）根据当前热度数据，China 相关话题频次最高且呈上升动量，提示地缘与小报动向值得关注；建议结合事件图谱核实因果关系。';
  }

  /** P5：把确定性文本切成小块，模拟真实 SSE 的增量输出；默认无延迟，E2E 可注入间隔。 */
  async generateStream(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<string> {
    const full = await this.generate(messages);
    const size = 24;
    const base = this.delayMs();
    // 让分块间隔与节点延迟同量级，E2E 才有稳定的“运行中增量”观察窗口。
    const wait = base > 0 ? Math.min(40, Math.max(4, Math.round(base / 8))) : 0;
    for (let i = 0; i < full.length; i += size) {
      onDelta(full.slice(i, i + size));
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    return full;
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
