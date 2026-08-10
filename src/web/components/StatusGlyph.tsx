export type GlyphKind = "working" | "needs_you" | "idle" | "ended" | "todo" | "danger";

/** Knockout paint for the filled glyphs. A hovered row is --surface-2 rather
 *  than --surface-0, but the delta is ~4% L in both themes on a ≤1.7px stroke —
 *  verified imperceptible, and using the literal surface token keeps this
 *  primitive to one file and zero new tokens. */
const KO = "hsl(var(--surface-0))";

const CHECK = "M5 8.2l2.1 2.1L11.2 6";

/** The signature primitive: five shapes, four semantic colours, one file.
 *  Replaces the border/dot/label/shimmer redundancy that announced a session's
 *  status up to four times per card.
 *
 *  Colourless by design — every stroke and fill is `currentColor`, so colour
 *  comes from the wrapper class (`text-working`, `text-attention`, …).
 *  `aria-hidden` throughout: the glyph is NEVER the accessible name. Textual
 *  status lives in the group header, the workflow status label, or an sr-only
 *  span on the row.
 *
 *  `needs_you` deliberately breaks the circle family — a filled rounded square
 *  with a `!`, Linear's Urgent-priority move. That break is what lets the row
 *  tint stay as faint as 5%. */
export function StatusGlyph({
  kind,
  animate = true,
  className = "",
}: {
  kind: GlyphKind;
  /** AppBar passes false — a spinning glyph in the chrome is too much. */
  animate?: boolean;
  className?: string;
}) {
  // `am-spin` goes on the <svg> ROOT, not an inner <g>: the track ring is
  // rotationally symmetric so only the arc appears to move, and a replaced
  // element needs no `transform-box: fill-box` workaround.
  const spin = animate && kind === "working" ? " am-spin" : "";
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
      data-glyph={kind}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 shrink-0 ${className}${spin}`}
    >
      {kind === "idle" && <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />}

      {kind === "working" && (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".35" />
          {/* a 90° arc, 12 → 3 o'clock. With motion off it sits still at 1–2
              o'clock and still reads "in progress" — a designed fallback. */}
          <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}

      {kind === "ended" && (
        <>
          <circle cx="8" cy="8" r="6.75" fill="currentColor" />
          <path d={CHECK} fill="none" stroke={KO} strokeWidth="1.6" />
        </>
      )}

      {kind === "needs_you" && (
        <>
          <rect x="2" y="2" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M8 4.6v4.2" fill="none" stroke={KO} strokeWidth="1.7" />
          <circle cx="8" cy="11.4" r="1" fill={KO} />
        </>
      )}

      {kind === "todo" && (
        <>
          <rect x="2" y="2" width="12" height="12" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          {/* revealed by `.am-check:hover` in styles.css — no per-component plumbing */}
          <path data-glyph-check="true" d={CHECK} fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0" />
        </>
      )}

      {kind === "danger" && (
        <>
          <rect x="2" y="2" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke={KO} strokeWidth="1.7" />
        </>
      )}
    </svg>
  );
}
