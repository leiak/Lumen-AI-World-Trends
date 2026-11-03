import type { RunEvent, RunEventEnvelope } from '../../../shared/agent.js';

export interface RunEventBusDeps {
  runId: string;
  /** 续跑时从已有最大 seq 继续；P0 默认 1 */
  startSeq?: number;
  write: (envelope: RunEventEnvelope) => void;
  send?: (envelope: RunEventEnvelope) => void;
  now?: () => string;
}

/** 单 run 的事件总线：seq 在本实例内唯一递增，先落库再推送。 */
export class RunEventBus {
  readonly runId: string;
  private seq: number;
  private readonly write: (e: RunEventEnvelope) => void;
  private readonly send?: (e: RunEventEnvelope) => void;
  private readonly now: () => string;

  constructor(deps: RunEventBusDeps) {
    this.runId = deps.runId;
    this.seq = deps.startSeq ?? 0;
    this.write = deps.write;
    this.send = deps.send;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  get lastSeq(): number {
    return this.seq;
  }

  emit(event: RunEvent): RunEventEnvelope {
    this.seq += 1;
    const envelope: RunEventEnvelope = {
      v: 1,
      runId: this.runId,
      seq: this.seq,
      ts: this.now(),
      event
    };
    this.write(envelope);
    this.send?.(envelope);
    return envelope;
  }
}
