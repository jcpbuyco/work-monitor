import { useCallback, useEffect, useState } from "react";

const SIZES = [14, 16, 18, 20, 22];
const DEFAULT = 16;

function resolveSize(): number {
  try {
    const s = Number(localStorage.getItem("wm-text-size"));
    if (SIZES.includes(s)) return s;
  } catch {}
  return DEFAULT;
}

export function useTextSize() {
  const [size, setSize] = useState<number>(resolveSize);

  useEffect(() => {
    document.documentElement.style.fontSize = `${size}px`;
  }, [size]);

  const step = useCallback((dir: 1 | -1) => {
    setSize((prev) => {
      const i = SIZES.indexOf(prev);
      const from = i < 0 ? SIZES.indexOf(DEFAULT) : i;
      const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, from + dir))];
      try {
        localStorage.setItem("wm-text-size", String(next));
      } catch {}
      return next;
    });
  }, []);

  const inc = useCallback(() => step(1), [step]);
  const dec = useCallback(() => step(-1), [step]);
  return { size, inc, dec, canInc: size < SIZES[SIZES.length - 1], canDec: size > SIZES[0] };
}
