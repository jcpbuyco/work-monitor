import type { Family } from "./modelFamily.ts";

/** `null` means every contributing usage row is unpriced (an unknown model, or
 *  a row awaiting the next reprice pass) -- never a fabricated `0` (matches
 *  the store's existing `costUsd: number | null` convention). */
export type Usd = number | null;

export type Kind = "main" | "subagent" | "workflow";

export interface InsightsMeta {
  generatedAt: number;
  computeMs: number;
  stale: boolean;
  /** `Intl.DateTimeFormat().resolvedOptions().timeZone` on the server. */
  tz: string;
  firstAt: number | null;
  lastAt: number | null;
  usageRows: number;
  unpricedRows: number;
  unpricedTokens: number;
}

export interface InsightsKpi {
  lifetimeUsd: Usd;
  lifetimeTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messages: number;
  sessions: number;
  projects: number;
  activeDays: number;
  workflowRuns: number;
  workflowAgents: number;
  byHarness: { harness: string; costUsd: Usd; tokens: number }[];
  mtdUsd: Usd;
  prevMonthUsd: Usd;
  prevMonthSamePointUsd: Usd;
  trailing7dUsd: Usd;
  /** `null` on days 1-2 of a month (the projection would be noise). */
  projectedMonthEndUsd: Usd;
  cacheHitRate: number;
  cacheSavingsUsdEst: number;
}

export interface InsightsRecords {
  biggestDay: { day: string; costUsd: number; messages: number } | null;
  longestStreak: { from: string; to: string; days: number } | null;
  currentStreakDays: number;
  peakAgents: { at: number; agents: number; runId: string | null; runName: string | null } | null;
  priciestRun: { runId: string; name: string | null; costUsd: number; agentCount: number | null; startedAt: number | null } | null;
  longestSession: { sessionId: string; project: string | null; activeMs: number; wallMs: number; startedAt: number } | null;
}

export interface ByMonthModel {
  month: string;
  model: string;
  family: Family;
  costUsd: Usd;
  tokens: number;
  outputTokens: number;
  unpricedTokens: number;
}

export interface ByMonthTokenClass {
  month: string;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  unpricedTokens: number;
}

export interface ByMonthKind {
  month: string;
  kind: Kind;
  costUsd: Usd;
  outputTokens: number;
}

export interface InsightsDay {
  day: string;
  costUsd: Usd;
  messages: number;
  sessions: number;
  topProject: string | null;
  peakAgents: number;
}

export interface WeekHourCell {
  /** Monday = 0. */
  weekday: number;
  hour: number;
  activeDays: number;
  costUsd: Usd;
}

export interface InsightsActivity {
  month: string;
  activeMs: number;
}

export interface InsightsWorkflowRun {
  runId: string;
  name: string | null;
  status: string | null;
  startedAt: number | null;
  month: string | null;
  agentCount: number | null;
  durationMs: number | null;
  costUsd: Usd;
  outputTokens: number;
}

export interface InsightsModel {
  model: string;
  family: Family;
  costUsd: Usd;
  outputTokens: number;
  cacheUsd: number;
  listOutputRate: number | null;
  costUsd30d: Usd;
  outputTokens30d: number;
}

export interface InsightsProject {
  project: string;
  kind: "project" | "other" | "none";
  lifetimeUsd: Usd;
  sessions: number;
  activeDays: number;
  byMonth: Record<string, { costUsd: Usd; sessions: number }>;
}

export interface InsightsResponse {
  meta: InsightsMeta;
  months: string[];
  currentMonth: string;
  kpi: InsightsKpi;
  records: InsightsRecords;
  byMonthModel: ByMonthModel[];
  byMonthTokenClass: ByMonthTokenClass[];
  byMonthKind: ByMonthKind[];
  days: InsightsDay[];
  weekHour: WeekHourCell[];
  weekdayCounts: number[];
  activity: InsightsActivity[];
  workflowRuns: InsightsWorkflowRun[];
  models: InsightsModel[];
  projects: InsightsProject[];
  truncated?: boolean;
}
