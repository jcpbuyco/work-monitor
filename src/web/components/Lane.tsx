import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";

export function Column({
  id,
  title,
  count,
  accent,
  droppable,
  children,
}: {
  id: string;
  title: string;
  count: number;
  accent: string;
  droppable?: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  return (
    <div
      ref={droppable ? setNodeRef : undefined}
      className={`flex-1 min-w-0 rounded-lg border border-slate-800 bg-slate-950 p-2 ${isOver ? "ring-1 ring-amber-500" : ""}`}
    >
      <div className={`text-[10px] uppercase tracking-wide mb-2 flex justify-between ${accent}`}>
        <span>{title}</span>
        <span className="text-slate-600">{count}</span>
      </div>
      {children}
    </div>
  );
}

export function Lane({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2 flex gap-2 items-center">
        {label}
        <span className="normal-case tracking-normal text-[9px] bg-slate-800 text-slate-400 rounded-full px-2 py-0.5">{hint}</span>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-start">{children}</div>
    </section>
  );
}
