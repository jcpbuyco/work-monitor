import { useCallback, useState } from "react";

export const FEED_LIMITS = [10, 25, 50] as const;
const DEFAULT = 10;

function resolve(): number {
  try {
    const n = Number(localStorage.getItem("wm-feed-limit"));
    if ((FEED_LIMITS as readonly number[]).includes(n)) return n;
  } catch {}
  return DEFAULT;
}

/** How many recent tool calls the Live Activity feed shows. Persisted. */
export function useFeedLimit() {
  const [limit, setLimitState] = useState<number>(resolve);

  const setLimit = useCallback((n: number) => {
    setLimitState(n);
    try {
      localStorage.setItem("wm-feed-limit", String(n));
    } catch {}
  }, []);

  return { limit, setLimit, options: FEED_LIMITS };
}
