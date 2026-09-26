import { useEffect, useState } from "react";

const DEFAULT_ROOT_PX = 16;

function readRootPx(): number {
  if (typeof document === "undefined") return DEFAULT_ROOT_PX;
  const inline = parseFloat(document.documentElement.style.fontSize);
  if (Number.isFinite(inline) && inline > 0) return inline;
  if (typeof getComputedStyle === "function") {
    const computed = parseFloat(getComputedStyle(document.documentElement).fontSize);
    if (Number.isFinite(computed) && computed > 0) return computed;
  }
  return DEFAULT_ROOT_PX;
}

/** Reactive root font-size in px -- the A-/A+ text-size setting
 *  (`useTextSize.ts` sets `document.documentElement.style.fontSize` directly;
 *  there is no React context for it). Every rem-based HTML element already
 *  scales with this for free; an SVG chart's hand-computed pixel geometry
 *  (axis gutters, label offsets, measured text widths) does not, unless it
 *  reads this value and scales alongside it (finding: chart text stuck at a
 *  fixed 9/10/11px while every surrounding HTML label followed the setting).
 *
 *  Watches the root element's `style` attribute via MutationObserver instead
 *  of re-deriving from `useTextSize`'s own state, so every consumer across
 *  the chart tree updates together without threading a value (or a context
 *  provider) through every chart primitive. jsdom supports MutationObserver,
 *  so this also updates correctly in web-tests when a test sets the inline
 *  style directly. */
export function useRootPx(): number {
  const [px, setPx] = useState(readRootPx);
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    const el = document.documentElement;
    const mo = new MutationObserver(() => setPx(readRootPx()));
    mo.observe(el, { attributes: true, attributeFilter: ["style"] });
    return () => mo.disconnect();
  }, []);
  return px;
}
