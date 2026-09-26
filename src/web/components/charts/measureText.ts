let ctx: CanvasRenderingContext2D | null | undefined;

/** Pixel width of `text` set at `sizePx` in the page's own font -- used to
 *  decide whether a direct label fits inside its mark (§6: "measured", not
 *  guessed by character count). jsdom has no working canvas text metrics, so
 *  the fallback (0.6em per character) keeps web-tests deterministic instead of
 *  throwing. */
export function measureText(text: string, sizePx: number, weight: string | number = 400): number {
  if (ctx === undefined) {
    try {
      const canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
  }
  if (ctx) {
    ctx.font = `${weight} ${sizePx}px Inter, sans-serif`;
    const w = ctx.measureText(text).width;
    if (w > 0) return w;
  }
  return text.length * sizePx * 0.6;
}
