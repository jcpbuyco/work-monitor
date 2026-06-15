import { useEffect, useState } from "react";

/** Forces a re-render on a fixed interval so relative timestamps (e.g. `ago()`)
 *  tick live without needing new data. Returns the current epoch-ms. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
