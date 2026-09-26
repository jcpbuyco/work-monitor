import { useEffect, useState } from "react";

/** True once `on` has stayed true for `delayMs`, false the moment it clears.
 *  Loading placeholders use this so a fast load (the local server usually
 *  answers in a few ms) goes straight from blank to real content, instead of
 *  flashing a skeleton whose height never matches and then jumping. */
export function useDelayedFlag(on: boolean, delayMs = 300): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) {
      setLate(false);
      return;
    }
    const t = setTimeout(() => setLate(true), delayMs);
    return () => clearTimeout(t);
  }, [on, delayMs]);
  return on && late;
}
