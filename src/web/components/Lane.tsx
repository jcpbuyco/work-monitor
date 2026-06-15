import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";

export function Column({
  id,
  title,
  count,
  dot,
  droppable,
  children,
}: {
  id: string;
  title: string;
  count: number;
  dot: string;
  droppable?: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  return (
    <div
      ref={droppable ? setNodeRef : undefined}
      className={`rounded-xl border border-border bg-card/50 p-2.5 transition ${isOver ? "ring-2 ring-primary" : ""}`}
    >
      <div className="mb-2 flex items-center justify-between px-1 py-0.5">
        <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
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
