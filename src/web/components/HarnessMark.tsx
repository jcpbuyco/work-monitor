import type { Harness } from "../../shared/harness.ts";
import { harnessLabel } from "../../shared/harness.ts";

/** Three simple, distinct outline shapes - deliberately NOT brand marks (no
 *  Anthropic/OpenAI/Cursor logos): a hexagon, a diamond and a triangle, drawn
 *  the same way as `StatusGlyph` (currentColor stroke, 16x16 viewBox) so a
 *  harness mark sits comfortably next to a status glyph on the same row. */
const PATHS: Record<Harness, string> = {
  claude: "M8 2L13.2 5V11L8 14L2.8 11V5Z",
  codex: "M8 2L14 8L8 14L2 8Z",
  cursor: "M8 2L14 13H2Z",
};

/** A session/activity row's harness indicator (§5.1/§5.2): the shape carries
 *  no meaning on its own - `title` (hover) and the `sr-only` label (screen
 *  readers) are the actual accessible name, exactly like `StatusGlyph`'s glyph
 *  is never the accessible name for status. */
export function HarnessMark({
  harness,
  version,
  className = "",
}: {
  harness: Harness;
  /** The harness's own CLI/build version, appended to the tooltip when known. */
  version?: string | null;
  className?: string;
}) {
  const label = harnessLabel(harness);
  const title = version ? `${label} ${version}` : label;
  return (
    <span title={title} className={`inline-flex shrink-0 items-center ${className}`}>
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        aria-hidden="true"
        focusable="false"
        data-harness={harness}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3 w-3 shrink-0"
      >
        <path d={PATHS[harness]} fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
