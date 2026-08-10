import type { ToolStat } from "../types.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { prettyTool, toolDot, formatDur } from "../tools.ts";
import { SectionHeader, MeterRow } from "./primitives.tsx";

const TOP = 8;

export function ToolStats({ stats }: { stats: ToolStat[] }) {
  const [collapsed, toggle] = usePersistedToggle("am-stats-collapsed");
  const total = stats.reduce((n, s) => n + s.calls, 0);
  if (total === 0) return null;

  const rows = stats.slice(0, TOP);
  const max = rows[0]?.calls ?? 1;

  return (
    <section className="mt-6">
      <SectionHeader
        label={`Tool usage (${total})`}
        collapsed={collapsed}
        onToggle={toggle}
        leading={<span aria-hidden="true" className="text-ink-4">Σ</span>}
      />
      {!collapsed && (
        <ul>
          {rows.map((s) => (
            <MeterRow
              key={s.tool}
              frac={s.calls / max}
              /* tool dots encode a CATEGORY, not a state — they stay 6px dots
                 and must not read as status (K17) */
              leading={<span className={`h-1.5 w-1.5 rounded-full ${toolDot(s.tool)}`} />}
              label={prettyTool(s.tool)}
              a={<>{s.calls}</>}
              b={<>{s.avgMs != null ? `avg ${formatDur(s.avgMs)}` : ""}</>}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
