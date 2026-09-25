/** §5.3: shared day-bucketing for the Workflows and Cost pages' "day grouping"
 *  requirement. Buckets rows the caller has ALREADY placed in display order,
 *  preserving each row's relative order within its own day - grouping never
 *  re-sorts a day's rows, only decides which day-bucket comes first. */
export interface DayGroup<T> {
  /** "YYYY-MM-DD" (local), or "unknown" for a row with no date at all. */
  day: string;
  rows: T[];
}

/** `dateSortActive`: true when the list's OWN current sort is already date-
 *  ordered (e.g. WorkflowsPage's "When" column) - group order then follows
 *  `sortedRows`' own order verbatim, direction included. False sorts groups
 *  newest-first unconditionally (e.g. the Cost page, which dropped a
 *  separate "Day" sort column in favour of always-newest-first groups with
 *  Project/Branch/Cost/Tokens sorting only WITHIN a day). Either way, an
 *  "unknown" bucket (no date at all) always sorts last - it has no date to
 *  be newest or oldest BY. */
export function groupByDay<T>(sortedRows: T[], dayOf: (row: T) => string, dateSortActive: boolean): DayGroup<T>[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const byDay = new Map<string, T[]>();
  for (const row of sortedRows) {
    const day = dayOf(row);
    if (!seen.has(day)) {
      seen.add(day);
      order.push(day);
    }
    const list = byDay.get(day);
    if (list) list.push(row);
    else byDay.set(day, [row]);
  }
  let dayOrder: string[];
  if (dateSortActive) {
    dayOrder = order;
  } else {
    const known = order.filter((d) => d !== "unknown").sort((a, b) => b.localeCompare(a));
    const unknown = order.filter((d) => d === "unknown");
    dayOrder = [...known, ...unknown];
  }
  return dayOrder.map((day) => ({ day, rows: byDay.get(day)! }));
}
