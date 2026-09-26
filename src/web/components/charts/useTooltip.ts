import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface TooltipState {
  open: boolean;
  x: number;
  y: number;
  content: ReactNode;
}

const CLOSED: TooltipState = { open: false, x: 0, y: 0, content: null };

/** One tooltip per chart instance, positioned from the pointer (hover) or the
 *  focused element's bounding box (keyboard focus) -- opens on focus as well
 *  as hover, closes on Escape (§8's Tooltip.tsx contract). `Tooltip.tsx`
 *  clamps the resulting `{x,y}` to the viewport at render time. */
export function useTooltip() {
  const [state, setState] = useState<TooltipState>(CLOSED);
  const openRef = useRef(false);

  const showAt = useCallback((x: number, y: number, content: ReactNode) => {
    openRef.current = true;
    setState({ open: true, x, y, content });
  }, []);

  const showFromEvent = useCallback((e: { clientX: number; clientY: number }, content: ReactNode) => {
    showAt(e.clientX, e.clientY - 12, content);
  }, [showAt]);

  const showFromElement = useCallback((el: Element, content: ReactNode) => {
    const r = el.getBoundingClientRect();
    showAt(r.left + r.width / 2, r.top, content);
  }, [showAt]);

  const hide = useCallback(() => {
    openRef.current = false;
    setState(CLOSED);
  }, []);

  const onKeyDown = useCallback(
    (e: { key: string }) => {
      if (e.key === "Escape") hide();
    },
    [hide]
  );

  return { state, showAt, showFromEvent, showFromElement, hide, onKeyDown };
}
