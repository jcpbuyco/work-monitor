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
  /** §5.2 finding fix: before the first `/api/state` response, this column's
   *  own count is exactly as UNKNOWN as the AppBar's - "Needs you 0" above a
   *  skeleton row is the same confident-wrong-zero the AppBar already avoids
   *  with "…". Defaults true so every existing caller renders the real count
   *  immediately. */
  ready = true,
}: {
  title: string;
  count: number;
  dot: Session["status"];
  children: ReactNode;
  ready?: boolean;
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
          <span className="text-2xs tabular-nums text-ink-4">{ready ? count : "…"}</span>
        </div>
      </div>
      <div className="pt-1">{children}</div>
    </div>
  );
}

export function Lane({
  label,
  hint,
  right,
  children,
}: {
  label: string;
  hint: string;
  /** §5.1: the Sessions lane's harness filter Segmented lives here - kept
   *  generic (not a "harness filter" prop) so any lane can use the slot. */
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-2.5">
        <span className="text-2xs font-semibold uppercase tracking-caps text-ink-3">{label}</span>
        <span className="text-2xs text-ink-4">{hint}</span>
        {right && <div className="ml-auto flex items-center">{right}</div>}
      </div>
      {/* was: grid grid-cols-1 sm:grid-cols-3 gap-3 - todos and sessions are
          list-shaped; a single column is what makes them scannable */}
      <div>{children}</div>
    </section>
  );
}
