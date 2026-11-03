import type { AgentErrorCode } from '../../../shared/agent.js';

export class AgentRuntimeError extends Error {
  readonly code: AgentErrorCode;
  readonly details?: unknown;
  constructor(code: AgentErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
    this.details = details;
  }
}

export class AgentCanceledError extends AgentRuntimeError {
  constructor(message = '运行已取消') {
    super('E_CANCELED', message);
    this.name = 'AgentCanceledError';
  }
}

export class AgentTimeoutError extends AgentRuntimeError {
  constructor(message = '节点执行超时') {
    super('E_TIMEOUT', message);
    this.name = 'AgentTimeoutError';
  }
}

/** 兼容 LangGraph 可能包装的 cause 链。 */
export function extractAgentError(err: unknown): { code: AgentErrorCode; message: string } {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof AgentRuntimeError) {
      return { code: cur.code, message: cur.message };
    }
    if (cur instanceof Error) {
      const msg = cur.message;
      if (/recursion limit/i.test(msg)) {
        return { code: 'E_RECURSION_LIMIT', message: msg };
      }
      if (/abort|cancel/i.test(msg) && /signal/i.test(msg)) {
        return { code: 'E_CANCELED', message: msg };
      }
      cur = (cur as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return { code: 'E_INTERNAL', message: err instanceof Error ? err.message : String(err) };
}

export function isCanceled(err: unknown): boolean {
  return extractAgentError(err).code === 'E_CANCELED';
}
