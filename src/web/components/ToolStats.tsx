import type { ToolStat } from "../types.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { prettyTool, toolDot, formatDur } from "../tools.ts";

const TOP = 8;

export function ToolStats({ stats }: { stats: ToolStat[] }) {
  const [collapsed, toggle] = usePersistedToggle("wm-stats-collapsed");
  const total = stats.reduce((n, s) => n + s.calls, 0);
  if (total === 0) return null;

  const rows = stats.slice(0, TOP);
  const max = rows[0]?.calls ?? 1;

  return (
    <section className="mt-7">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="mb-3 inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
      >
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        <span aria-hidden="true">Σ</span> Tool usage ({total})
      </button>

      {!collapsed && (
        <ul className="space-y-1">
          {rows.map((s) => (
            <li
              key={s.tool}
              className="relative isolate flex items-center gap-2 overflow-hidden rounded-md px-2 py-1 font-mono text-2xs"
            >
              {/* faint proportional bar */}
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 -z-10 rounded-md bg-primary/10"
                style={{ width: `${Math.max(6, Math.round((s.calls / max) * 100))}%` }}
              />
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toolDot(s.tool)}`} />
              <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{prettyTool(s.tool)}</span>
              <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{s.calls}</span>
              <span className="w-16 shrink-0 whitespace-nowrap text-right tabular-nums text-muted-foreground/50">
                {s.avgMs != null ? `avg ${formatDur(s.avgMs)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
