import type { InsightsDay } from "../shared/insights.ts";

/** Days in a "YYYY-MM" month. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** "YYYY-MM-DD" from a local Date, matching the server's own bucket format. */
export function ymd(d: Date): string {
  const p2 = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Per-day-of-month cumulative spend for one month, built from the sparse
 *  `days[]` list -- a day with no usage simply adds 0, which IS the
 *  carry-forward step C4 wants (never an interpolated slope between two real
 *  points). Entries past `capAtDay` (0-based; the current month's "today") are
 *  `null` so the chart can't draw a line into the future. */
export function cumulativeWithCarry(days: InsightsDay[], month: string, monthLength: number, capAtDay?: number): (number | null)[] {
  const perDay = new Array<number>(monthLength).fill(0);
  for (const d of days) {
    if (!d.day.startsWith(month)) continue;
    const dayNum = Number(d.day.slice(8, 10));
    if (dayNum >= 1 && dayNum <= monthLength) perDay[dayNum - 1] += d.costUsd ?? 0;
  }
  let cum = 0;
  const out: (number | null)[] = [];
  for (let i = 0; i < monthLength; i++) {
    if (capAtDay != null && i > capAtDay) {
      out.push(null);
      continue;
    }
    cum += perDay[i];
    out.push(cum);
  }
  return out;
}

/** Percentage change vs. the previous value, `null` when either side is
 *  missing/zero (nothing to compare against). Purely numeric -- string
 *  formatting (with the neutral arrow glyph) lives in charts/format.ts. */
export function pctDelta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export interface CalendarCell {
  day: string;
  week: number;
  weekday: number; // Monday = 0
}

/** Monday-first calendar layout: one cell per day from `firstDay` through
 *  `lastDay` inclusive, each placed in the week (column) containing it,
 *  counted from the Monday on/before `firstDay`. Used by both the lifetime
 *  calendar (C9, weeks as columns) and its table view (newest first). */
export function calendarLayout(firstDay: string, lastDay: string): CalendarCell[] {
  const parse = (s: string): Date => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const mondayFirst = (d: Date) => (d.getDay() + 6) % 7;
  const first = parse(firstDay);
  const last = parse(lastDay);
  const firstMonday = new Date(first);
  firstMonday.setDate(first.getDate() - mondayFirst(first));

  const out: CalendarCell[] = [];
  const cursor = new Date(first);
  while (cursor.getTime() <= last.getTime()) {
    const diffDays = Math.round((cursor.getTime() - firstMonday.getTime()) / 86_400_000);
    out.push({ day: ymd(cursor), week: Math.floor(diffDays / 7), weekday: mondayFirst(cursor) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** C1's sparklines only plot the months from the first one with more than $1
 *  onward, so an early $3 month doesn't flatten the whole line (§6, C1). */
export function sparklineFrom<T extends { value: number }>(monthly: T[]): T[] {
  const idx = monthly.findIndex((m) => m.value > 1);
  return idx === -1 ? [] : monthly.slice(idx);
}
