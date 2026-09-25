import { useCallback, useState } from "react";

/** A localStorage-backed value of any JSON-serializable type, validated on
 *  read so a stale or foreign value in storage can never crash the app or
 *  leak in as an invalid state - it just falls back to `initial`, exactly
 *  like `usePersistedToggle`'s bool-only cousin. Reads in the `useState`
 *  initializer so the first render already reflects it (no flicker). */
export function usePersistedValue<T>(key: string, initial: T, isValid: (v: unknown) => v is T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) {
        const parsed = JSON.parse(raw);
        if (isValid(parsed)) return parsed;
      }
    } catch {}
    return initial;
  });

  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {}
    },
    [key]
  );

  return [value, set];
}
