import type { Session } from "../types.ts";

const ACCENT: Record<string, string> = {
  working: "border-l-blue-500",
  needs_you: "border-l-amber-500",
  idle: "border-l-slate-500",
  ended: "border-l-slate-700",
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function SessionCard({ s }: { s: Session }) {
  return (
    <div className={`rounded-md border border-slate-800 border-l-4 ${ACCENT[s.status]} bg-slate-900 p-3 mb-2`}>
      <div className="font-semibold text-slate-100">{s.project}</div>
      <div className="text-xs text-slate-400 mt-1">
        {s.current_task ?? s.current_intent ?? "—"}
      </div>
      {s.attention_reason && s.status === "needs_you" && (
        <div className="text-xs text-amber-400 mt-1">⚠ {s.attention_reason}</div>
      )}
      <div className="text-[10px] text-slate-600 mt-2">{ago(s.last_activity_at)}</div>
    </div>
  );
}
