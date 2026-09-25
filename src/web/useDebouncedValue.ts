import { useEffect, useState } from "react";

/** Returns `value`, but delayed by `delayMs` after it last changed - so a
 *  fast-typed search box (§5.3's workflows search) refetches once, after the
 *  user pauses, instead of once per keystroke. The very first render returns
 *  `value` immediately, with no initial delay. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
