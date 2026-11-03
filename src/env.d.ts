import type { EngineStatus } from './shared/contracts';
import type { RunEventEnvelope } from './shared/agent';

declare global {
  interface Window {
    lumen: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      getEngineStatus: () => Promise<EngineStatus>;
      onAgentEvent: (callback: (envelope: RunEventEnvelope) => void) => () => void;
    };
  }
}

export {};

declare module '*.geojson' {
  const value: unknown;
  export default value;
}
