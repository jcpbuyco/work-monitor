import type { ReactNode } from "react";
import type { Session } from "../types.ts";
import { StatusGlyph, type GlyphKind } from "./StatusGlyph.tsx";
import { Rail } from "./primitives.tsx";

/** The only place the session-status → glyph/colour mapping lives outside
 *  SessionCard. Transcribed from spec §2.4's session table. */
const GLYPH: Record<Session["status"], GlyphKind> = {
  working: "working",
  needs_you: "needs_you",
  idle: "idle",
  ended: "ended",
};

/** The GROUP HEADER carries the semantic colour once; the rows inside it
 *  recede to ink-4. That is how a 12-session idle backlog stops dominating the
 *  board without adding a new collapse control. */
const HEADER_TONE: Record<Session["status"], string> = {
  working: "text-working",
  needs_you: "text-attention",
  idle: "text-idle",
  ended: "text-idle",
};

export function Column({
  title,
  count,
  dot,
  children,
}: {
  title: string;
  count: number;
  dot: Session["status"];
  children: ReactNode;
}) {
  return (
    <div data-testid={`session-group-${dot}`}>
      {/* opaque, NOT blurred: one blurred layer per page is enough (R6) */}
      <div className="sticky top-12 z-10 -mx-1.5 flex h-7 items-center border-b-hairline border-border-weak bg-surface-0 px-1.5">
        <Rail>
          <StatusGlyph kind={GLYPH[dot] ?? "idle"} animate={false} className={HEADER_TONE[dot] ?? "text-idle"} />
        </Rail>
        <div className="flex items-center gap-2">
          <span className="text-2xs font-semibold uppercase tracking-caps text-ink-3">{title}</span>
          <span className="text-2xs tabular-nums text-ink-4">{count}</span>
        </div>
      </div>
      <div className="pt-1">{children}</div>
    </div>
  );
}

export function Lane({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-2.5">
        <span className="text-2xs font-semibold uppercase tracking-caps text-ink-3">{label}</span>
        <span className="text-2xs text-ink-4">{hint}</span>
      </div>
      {/* was: grid grid-cols-1 sm:grid-cols-3 gap-3 — todos and sessions are
          list-shaped; a single column is what makes them scannable */}
      <div>{children}</div>
    </section>
  );
}
