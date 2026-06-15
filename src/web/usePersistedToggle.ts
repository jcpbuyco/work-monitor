import { useCallback, useState } from "react";

/** A localStorage-backed boolean toggle. Reads the stored value in the
 *  useState initializer so the first render already reflects it (no flicker). */
export function usePersistedToggle(key: string, initial = false): [boolean, () => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      if (v === "true") return true;
      if (v === "false") return false;
    } catch {}
    return initial;
  });

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, String(next));
      } catch {}
      return next;
    });
  }, [key]);

  return [on, toggle];
}
