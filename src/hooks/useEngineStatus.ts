import { useEffect, useState } from 'react';
import type { EngineStatus } from '../../shared/contracts';

export function useEngineStatus(): {
  status?: EngineStatus;
  error?: string;
} {
  const [status, setStatus] = useState<EngineStatus>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    window.lumen
      .getEngineStatus()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);

  return { status, error };
}
