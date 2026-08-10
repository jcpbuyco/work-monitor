import type { ReactNode } from "react";
import type { Session } from "../types.ts";

/** Maps the status to the dot class this column used to be handed directly.
 *  The narrowing (string → Session["status"]) is what lets the wrapper carry a
 *  status-keyed test id without adding a 5th prop (K16). */
const DOT_CLASS: Record<Session["status"], string> = {
  working: "bg-working",
  needs_you: "bg-attention",
  idle: "bg-idle",
  ended: "bg-idle",
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
    <div data-testid={`session-group-${dot}`} className="rounded-xl border border-border bg-card/50 p-2.5">
      <div className="mb-2 flex items-center justify-between px-1 py-0.5">
        <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${DOT_CLASS[dot] ?? "bg-idle"}`} />
          {title}
        </span>
        <span className="rounded-full bg-chip px-2 py-0.5 text-2xs text-muted-foreground">{count}</span>
      </div>
      {children}
    </div>
  );
}

export function Lane({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-2xs text-muted-foreground">{hint}</span>
      </div>
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">{children}</div>
    </section>
  );
}
