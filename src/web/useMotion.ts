import { useCallback, useEffect, useState } from "react";

/** Whether UI animations are enabled. Defaults ON (this dashboard is motion-y
 *  on purpose); persisted to localStorage and reflected as an `html.wm-anim`
 *  class that the CSS keys off. Overrides the OS `prefers-reduced-motion`. */
function resolveMotion(): boolean {
  try {
    return localStorage.getItem("wm-motion") !== "off";
  } catch {
    return true;
  }
}

export function useMotion() {
  const [on, setOn] = useState<boolean>(resolveMotion);

  useEffect(() => {
    document.documentElement.classList.toggle("wm-anim", on);
  }, [on]);

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("wm-motion", next ? "on" : "off");
      } catch {}
      return next;
    });
  }, []);

  return { on, toggle };
}
