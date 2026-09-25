import type { Cost } from "../types.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { formatUsd, formatTokens } from "../cost.ts";
import { SectionHeader, MeterRow } from "./primitives.tsx";

const TOP = 6;

function Group({
  label,
  rows,
  total,
}: {
  label: string;
  rows: { key: string; label: string; costUsd: number | null; tokens: number }[];
  total: number;
}) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, TOP);
  const max = (shown[0]?.costUsd ?? 0) || 1; // rows arrive sorted by cost desc; null (unpriced) sorts like 0
  return (
    <>
      <div className="mt-3 flex h-5 items-center text-3xs uppercase tracking-caps text-ink-4">{label}</div>
      <ul>
        {shown.map((r) => (
          <MeterRow
            key={r.key}
            frac={(r.costUsd ?? 0) / max}
            label={r.label}
            a={<>{formatUsd(r.costUsd)}</>}
            b={<>{formatTokens(r.tokens)}</>}
          />
        ))}
        {total > TOP && <li className="px-1.5 py-0.5 text-3xs text-ink-4">+{total - TOP} more</li>}
      </ul>
    </>
  );
}

export function CostBreakdown({ cost }: { cost: Cost }) {
  const [collapsed, toggle] = usePersistedToggle("am-cost-breakdown-collapsed");
  // Tolerate a state payload from an older server that predates these fields:
  // a missing array must not crash the whole dashboard.
  const byProject = cost.byProject ?? [];
  const byBranch = cost.byBranch ?? [];
  if (byProject.length === 0) return null;

  const projectRows = byProject.map((p) => ({ key: p.project, label: p.project, costUsd: p.costUsd, tokens: p.tokens }));
  const branchRows = byBranch.map((b) => ({
    // Swapped from the old file's literal \x00 separator (§10.5, D7) to a
    // printable, collision-proof one: U+241F SYMBOL FOR UNIT SEPARATOR.
    // Still guarantees no collision with a literal "␟" in a project or
    // branch name, same as the NUL did, but no longer makes `file`/`grep`
    // classify this file as binary.
    key: `${b.project}␟${b.branch ?? ""}`,
    label: `${b.project} · ${b.branch ?? "—"}`,
    costUsd: b.costUsd,
    tokens: b.tokens,
  }));

  return (
    <section className="mt-6">
      <SectionHeader
        label="Cost breakdown · all-time"
        collapsed={collapsed}
        onToggle={toggle}
        leading={<span aria-hidden="true" className="text-ink-4">≣</span>}
      />
      {!collapsed && (
        <>
          <Group label="by project" rows={projectRows} total={byProject.length} />
          <Group label="by branch" rows={branchRows} total={byBranch.length} />
        </>
      )}
    </section>
  );
}
