import { useCallback, useState } from 'react';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function useInvoke<T>(channel: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const run = useCallback(
    async (payload?: unknown) => {
      setLoading(true);
      setError(undefined);
      try {
        const res = (await window.lumen.invoke(channel, payload)) as Envelope<T> | undefined;
        if (res && res.ok) setData(res.data);
        else setError(res?.error ?? `${channel} 调用失败`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [channel]
  );

  return { data, error, loading, run };
}
