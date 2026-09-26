import { useEffect, useRef, useState } from "react";

/** Whole-pixel width of a chart's card body, tracked via ResizeObserver.
 *  jsdom (web-tests) has no ResizeObserver -- falls back to a fixed 600px so
 *  every chart still renders (and can be asserted on) under vitest. */
export function useChartWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width) || 600);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}
