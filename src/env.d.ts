import type { EngineStatus } from './shared/contracts';

declare global {
  interface Window {
    lumen: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      getEngineStatus: () => Promise<EngineStatus>;
    };
  }
}

export {};

declare module '*.geojson' {
  const value: unknown;
  export default value;
}
