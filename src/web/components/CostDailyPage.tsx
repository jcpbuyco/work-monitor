import { useEffect, useMemo, useState } from "react";
import { formatUsd, formatTokens, formatDay, costDailyRange, type CostWindow } from "../cost.ts";

interface Row {
  project: string;
  branch: string | null;
  day: string;
  costUsd: number;
  tokens: number;
}
type SortKey = "project" | "branch" | "day" | "costUsd" | "tokens";

const WINDOWS: CostWindow[] = [7, 14, 30, "all"];
const COLS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "project", label: "Project", numeric: false },
  { key: "branch", label: "Branch", numeric: false },
  { key: "day", label: "Day", numeric: false },
  { key: "costUsd", label: "Cost", numeric: true },
  { key: "tokens", label: "Tokens", numeric: true },
];

export function CostDailyPage() {
  const [window, setWindow] = useState<CostWindow>(14);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "day", dir: "desc" });

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const { since } = costDailyRange(window, Date.now());
    const qs = since != null ? `?since=${since}` : "";
    fetch(`/api/cost/daily${qs}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setRows(Array.isArray(body?.rows) ? (body.rows as Row[]) : []);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [window]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    const { key, dir } = sort;
    copy.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      let c: number;
      if (typeof av === "number" && typeof bv === "number") c = av - bv;
      else c = String(av ?? "").localeCompare(String(bv ?? ""));
      return dir === "asc" ? c : -c;
    });
    return copy;
  }, [rows, sort]);

  const toggleSort = (col: { key: SortKey; numeric: boolean }) =>
    setSort((s) =>
      s.key === col.key
        ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: col.key, dir: col.numeric ? "desc" : "asc" }
    );

  return (
    <div className="mx-auto max-w-5xl px-4 pb-12">
      <header className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur">
        <a href="#/" className="text-sm text-muted-foreground transition hover:text-foreground">
          ← Dashboard
        </a>
        <span className="font-semibold tracking-tight text-foreground">Cost by day</span>
        <div className="ml-auto inline-flex h-9 items-center overflow-hidden rounded-lg border border-border bg-muted text-sm text-muted-foreground">
          {WINDOWS.map((w) => (
            <button
              key={String(w)}
              type="button"
              onClick={() => setWindow(w)}
              className={`flex h-full items-center px-3 leading-none transition hover:text-foreground ${
                window === w ? "bg-chip text-foreground" : ""
              }`}
            >
              {w === "all" ? "All" : `${w}d`}
            </button>
          ))}
        </div>
      </header>

      {status === "error" ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">Couldn't load cost data.</p>
      ) : status === "ok" && sorted.length === 0 ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">No usage in this window.</p>
      ) : (
        <table className="w-full border-collapse font-mono text-2xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              {COLS.map((c) => (
                <th
                  key={c.key}
                  aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={`px-2 py-1.5 font-semibold ${c.numeric ? "text-right" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c)}
                    className="inline-flex items-center gap-1 uppercase tracking-wider transition hover:text-foreground"
                  >
                    {c.label}
                    {sort.key === c.key && <span aria-hidden="true">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.project}/${r.branch}/${r.day}/${i}`} className="border-b border-border/50">
                <td className="px-2 py-1 font-semibold text-foreground">{r.project}</td>
                <td className="px-2 py-1 text-muted-foreground">{r.branch ?? "—"}</td>
                <td className="px-2 py-1 text-muted-foreground">{formatDay(r.day)}</td>
                <td className="px-2 py-1 text-right tabular-nums text-foreground">{formatUsd(r.costUsd)}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted-foreground/70">{formatTokens(r.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
