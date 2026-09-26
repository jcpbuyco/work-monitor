import { useEffect, useRef, useState } from "react";

/** Whole-pixel size of a chart's card body, tracked via ResizeObserver.
 *  jsdom (web-tests) has no ResizeObserver -- falls back to a fixed 600x240
 *  so every chart still renders (and can be asserted on) under vitest.
 *  Returns `[ref, width, height]`: most charts only destructure `width` (the
 *  SVG's own height is usually a fixed per-card budget), but a card whose
 *  body can grow taller than that budget -- a flex-1 `ChartCard` body next to
 *  a taller sibling, or rem text pushing past a px floor -- reads `height` too
 *  so its content can grow to fill the space instead of leaving it blank. */
export function useChartWidth<T extends HTMLElement>(): [React.RefObject<T>, number, number] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 600, height: 240 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) });
      }
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setSize({ width: Math.round(rect.width) || 600, height: Math.round(rect.height) || 240 });
    return () => ro.disconnect();
  }, []);

  return [ref, size.width, size.height];
}
