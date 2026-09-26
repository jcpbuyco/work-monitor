# Insights page - design spec

Date: 2026-09-26.
Status: final build spec, chosen by judging two proposals ("Spend and Efficiency" and "Activity and Behaviour") against the live data.
Every number quoted below was re-computed read-only on a `.backup` copy of `~/.local/share/agent-monitor/agent-monitor.sqlite` taken 2026-09-26 03:23 CEST (76,842 usage rows, 0 unpriced, $10,800.21 lifetime).
Numbers are examples for sanity checks during implementation, not fixtures.

## 1. Purpose

The page answers four questions the app cannot answer today: what have I spent and burned in total, how is that changing month on month, where does the money go, and how has the way I work changed.
It leads with lifetime totals and records (the user asked for lifetime stats), then month-on-month cost and tokens, then efficiency, then rhythm and projects.
It is read-only, pull-based, and never streams.

## 2. Route and navigation

- Route `#/insights`, matched in `App.tsx` with `route === "#/insights" || route.startsWith("#/insights?")`, rendering `<InsightsPage state workflows ready connected lastMessageAt />` like the other two pages.
- `AppBar` gains a `NavLink href="#/insights" icon="◔"` labelled "Insights", placed between Cost and Workflows, with `aria-current="page"` when active.
- The link appears in both the desktop cluster and the phone overflow panel, because both render the shared `controls` fragment.
- The page mounts the shared `AppBar` with `route="#/insights"` and a slim sticky toolbar under it, copied from `CostDailyPage` (`sticky top-12 z-10 ... backdrop-blur-[20px]`).
- Toolbar content: "Insights" title (text-sm semibold), then a text-2xs text-ink-3 scope line "Lifetime since 20 Feb 2026 · local time (Europe/Berlin)", then at the right a quiet "Updated 2 min ago" label and a Refresh ghost button.

## 3. Scope and filters

- The whole page has one scope: lifetime, bucketed in the server's local time zone.
- There is no filter row in v1.
- Reason: every chart is either lifetime or month-on-month, per-project questions are answered by the project heat table, and a project filter would multiply the server aggregates and the memo key for little gain.
- In-card controls are view toggles only (metric or share), never scope filters, so every number on the page always agrees with every other.
- Every card has a Chart | Table toggle (Segmented primitive) in its header.

## 4. Layout

Container: `mx-auto max-w-board px-4 pb-16 sm:px-6` (86rem max, 16px gutter on phones, no horizontal page scroll at any width).
Rows are separated by 24px; cards inside a row by 16px.
Section labels ("Spend", "Where it goes", "Efficiency", "Rhythm", "Projects") use the `SectionHeader` caps idiom above their row.

| Row | Content | 1600 px (1376 container) | 1280 px (1232 content) | 390 px (358 content) |
|---|---|---|---|---|
| 1 | Hero + KPI tiles (C1) | hero left 1/3, 4 tiles in one row right 2/3 | hero left 1/3, 4 tiles 2x2 right | hero full width, tiles 2 columns |
| 2 | Records strip (C2) | 5 tiles in one row | 5 tiles in one row | 2 columns, fifth tile full width |
| 3 | Monthly spend by model (C3) and Month pace (C4) | 2 columns | 2 columns | stacked |
| 4 | Cost by token class (C5) and Who does the work (C6) | 2 columns | 2 columns | stacked |
| 5 | Workflow run costs (C7) and Price of output by model (C8) | 2 columns | 2 columns | stacked |
| 6 | Lifetime calendar (C9) | full width, grid left, summary column right | full width, grid left, summary right | full width, grid scrolls inside its card, anchored to the latest week |
| 7 | Weekly rhythm (C10) and Active hours and leverage (C11) | 2 columns | 2 columns | stacked, rhythm switches to 3-hour columns |
| 8 | Projects by month (C12) | full width | full width | table scrolls inside its card with a sticky project column |

- Two-column rows use `grid gap-4 lg:grid-cols-2` (1024 px and up); below `lg` everything is one column.
- Cards: `rounded-lg border-hairline border-border bg-surface-1 p-4`, no shadow.
- Card header: title as a plain-language headline (text-sm semibold text-ink), subtitle with the exact metric (text-2xs text-ink-3), Chart | Table toggle right-aligned, legend under the header left-aligned.
- Card footer: an optional one-line source note (text-3xs text-ink-4), for example "Workflow agents = usage rows with a run_id".
- Every chart container's height includes its x-axis band, so no card ever gets a nested vertical scroll.
- Plot heights: C3, C5, C6 = 220 px plot + 32 px axis band; C4 = 240 + 24; C7 = 240 + 24; C8 = 6 bars x 28 px + 24; C11 = 2 panels x 96 + 24.

## 5. Visual tokens for charts

Chart colors are CSS custom properties added to `src/web/styles.css`, defined as raw hex under `:root` (light) and `html.dark` (dark), because the app switches theme with the `dark` class on `<html>` (see `useTheme.ts`).
Dark values are selected steps from the same ramps, not a flip.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--viz-s1` | categorical slot 1, blue; also every single-series chart | `#2a78d6` | `#3987e5` |
| `--viz-s2` | categorical slot 2, orange | `#eb6834` | `#d95926` |
| `--viz-s3` | categorical slot 3, aqua | `#1baf7a` | `#199e70` |
| `--viz-other` | "Other" and de-emphasised fills | `#c5cad4` (= border-strong) | `#3a3f47` (= border-strong) |
| `--viz-context` | context lines in emphasis charts | `#727a86` (= text-4) | `#626873` (= text-4) |
| `--viz-s1-soft` | second step of the delegation ramp | `#86b6ef` (blue 250) | `#184f95` (blue 600) |
| `--viz-seq-1..5` | sequential ramp, low to high | `#86b6ef #5598e7 #2a78d6 #1c5cab #104281` | `#184f95 #256abf #3987e5 #6da7ec #9ec5f4` |
| `--viz-empty` | zero / no-data heat cell | `#e9ecf2` (= surface-3) | `#1d2026` (= surface-3) |
| grid / axis | hairline gridlines and baseline | `border-weak` / `border-1` tokens | same tokens |

Rules applied everywhere:
- Categorical slots are assigned in fixed order per chart and never cycled; no chart uses more than 3 hues plus the neutral "Other".
- Color follows the entity: legend isolation dims the others but never repaints the survivors.
- Text never wears a series color; labels, values and legends use text-1..4; identity comes from a swatch or line key beside the text.
- A label inside a filled mark picks text-1 of the light theme (`#131826`) or `#ffffff`, whichever has higher contrast against that fill.
- Status colors (working, attention, done, danger) are never used for series.
- Month-on-month deltas are neutral (text-3 plus an up or down arrow glyph), because spend growth is not a good or bad status.
- Large standalone numbers (hero, tile values, record values) use proportional figures; axis ticks and table cells use `tabular-nums slashed-zero`.
- Texture fills are not used (they are opt-in accessibility only, not in scope for v1).

### Validator results

Run from the dataviz skill's `scripts/` directory with `node validate_palette.js`.
The chart card sits on surface-1 and the page on surface-0, so both were checked.

1. `"#2a78d6,#eb6834,#1baf7a" --mode light --surface "#ffffff" --pairs all`: PASS band, PASS chroma, PASS CVD (worst all-pairs aqua vs orange dE 9.2 deutan, tritan 9.6), PASS normal-vision (worst 24.0), WARN contrast (aqua 2.82:1). ALL CHECKS PASS.
2. Same with `--surface "#fbfcfe"`: identical, WARN contrast aqua 2.74:1. ALL CHECKS PASS.
3. `"#3987e5,#d95926,#199e70" --mode dark --surface "#08090b" --pairs all`: PASS on all five (CVD worst 9.4, normal-vision worst 20.9, all at least 3:1). ALL CHECKS PASS.
4. Same with `--surface "#0e1013"`: PASS on all five. ALL CHECKS PASS.
5. `"#86b6ef,#5598e7,#2a78d6,#1c5cab,#104281" --ordinal --mode light` on `#ffffff` (light end 2.11:1) and on `#fbfcfe` (2.06:1): PASS monotone, adjacent dL at least 0.06, single hue (3 degree spread).
6. `"#184f95,#256abf,#3987e5,#6da7ec,#9ec5f4" --ordinal --mode dark` on `#08090b` (2.46:1) and `#0e1013` (2.35:1): PASS on all four checks.
7. Delegation pair `"#86b6ef,#2a78d6" --ordinal --mode light --surface "#fbfcfe"` and `"#184f95,#3987e5" --ordinal --mode dark --surface "#0e1013"`: PASS on all four checks.

Consequences:
- Only the first three categorical slots are used, which validate all-pairs in both modes, so any 3-series chart is safe in any form.
- The light-mode aqua contrast WARN obligates relief: every chart that uses slot 3 (C3, C5) ships a legend, selective direct labels, and the table view.
- The 6-step ramp starting at blue 100 (`#cde2fb`) fails the light-end check (1.32:1), so the ramp starts at step 250 and zero cells use the neutral `--viz-empty`.

## 6. Charts

Notation used in SQL below:
- `LM(at)` = `strftime('%Y-%m', at/1000, 'unixepoch', 'localtime')`, `LD(at)` = `strftime('%Y-%m-%d', ...)`, `LH(at)` = `strftime('%Y-%m-%d %H', ...)`.
- `TOK` = `input_tokens + output_tokens + cache_read_tokens + cache_create_5m_tokens + cache_create_1h_tokens` (the store's existing `TOKEN_SUM`).
- Cost sums use `SUM(cost_usd)`, which skips NULL rows and returns NULL only when every row in the group is unpriced; the server never coalesces that to 0.
- Every cost group also carries `unpricedTokens` (the store's existing `UNPRICED_TOKEN_SUM`); the UI renders `$x+` with the title "some usage from unpriced models" when it is above 0, exactly like `CostDailyPage`'s `costCell`.
- Model family (`src/shared/modelFamily.ts`): `claude-fable-*` and `claude-mythos-*` = Fable, `claude-opus-*` = Opus, `claude-sonnet-*` = Sonnet, everything else (haiku, gpt, grok, composer, gemini) = Other.
- Agent kind per usage row: `run_id IS NOT NULL` = workflow, else `agent_id IS NOT NULL` = subagent, else main. (Verified: no row has a run_id without an agent_id.)
- Month axis: continuous from the month of the first usage row to the current month, empty months included (currently Feb to Sep, with Mar and Apr empty), so growth is never overstated by skipping gaps.
- The current month is always labelled "Sep MTD" style on axes and in tables.

### C1. Hero and KPI tiles

- Question: what have I spent and burned in total, and where is this month heading?
- Form: one hero figure plus four stat tiles; not a chart.
- Hero: lifetime spend `SUM(cost_usd)` over all usage, 48 px semibold, proportional figures, for example "$10,800".
  Sub-line (text-xs text-ink-3): "since 20 Feb 2026 · 93 active days · 76,842 messages".
  Footnote (text-2xs text-ink-4): "259 sessions · 213 workflow runs · 1,198 workflow agents · 40 projects · Claude $10,786 · Codex $14 · Cursor $0.08 (capture since 25 Sep)".
- Tile "This month": MTD spend (`at >= local start of month`), for example $4,957.
  Deltas under it: "vs Aug at this point +117%" (prior month from its start through the same day-of-month and time of day, clamped to its end; $2,287) and "vs all of Aug +66%" ($2,982).
  Sparkline: monthly spend.
- Tile "Projected month end": `MTD + (spend in the trailing 7x24 h / 7) x (local month end - now) / 1 day`, for example $4,957 + $225.1/day x 4.86 days = about $6.05k.
  Label "at the trailing 7-day rate ($225/day)"; an info tooltip states the formula.
  Hidden on the first 2 days of a month, when it would be noise; shows "-" with "too early to project".
- Tile "Lifetime tokens": `SUM(TOK)`, for example 14.79B, sub-line "69.9M output · 4.0M uncached input".
  Sparkline: monthly total tokens.
- Tile "Cache hit rate": `SUM(cache_read) / SUM(input + cache_read + cache_create_5m + cache_create_1h)`, for example 97.5%.
  Rendered with a meter: track `--viz-s1-soft` at 35% opacity, fill `--viz-s1`.
  Sub-line "about $72k saved vs uncached input (est.)" = `SUM over rows of cache_read_tokens x (rate.input - rate.cacheRead) / 1e6`, computed with the pricing module; rows with no rate are skipped.
- Sparklines: 1.5 px `--viz-s1` stroke, no axes, 4 px end dot, 64 x 20 px, current month as the end dot; they plot only the months since the first month with more than $1 (so a $3 May does not flatten the line).
- Interaction: hovering or focusing a sparkline point shows "Aug 2026 · $2,982"; tiles are otherwise static.
- Table view: not needed for C1 (the numbers are the content); the sparkline series are in the C3 table.

### C2. Records strip

- Question: what are my bests?
- Form: five record tiles (value, date, one context line), text only, no color coding.
- Biggest day: max of daily `SUM(cost_usd)` by `LD(at)`; for example "$590 · Fri 25 Sep · 9,108 messages".
- Longest streak: gaps-and-islands over distinct `LD(at)` (`julianday(d) - ROW_NUMBER() OVER (ORDER BY d)`); for example "21 days · 30 Aug to 19 Sep", context "current streak N days" (current = the island that contains today or yesterday, else 0).
- Peak parallel agents: max over 15-minute buckets (`at/900000`) of `COUNT(DISTINCT COALESCE(agent_id, session_id))`; for example "79 agents · Mon 7 Sep 15:15"; context names the workflow run with the most usage rows in that bucket ("review-treatment-plan-spa").
- Priciest workflow run: max per-run `SUM(cost_usd)` joined to `workflow_runs`; for example "$116.82 · review-treatment-plan-spa · 144 agents · 7 Sep".
- Longest session: per main session (`agent_id IS NULL`), the sum of gaps between consecutive messages that are under 30 minutes; for example "29.0 active h over 59.4 h · lunatic · from 25 Aug".
- Interaction: hovering or focusing a tile with a date rings the matching C9 calendar cell (2 px text-1 outline); clicking scrolls C9 into view.
  Clicking the workflow record opens `#/workflows?run=<id>`.
- Empty: a record with no data shows "-".

### C3. Monthly spend by model family

- Question: how fast is monthly spend growing, and which models make up each month?
- Form: stacked columns per month (part-to-whole over time), 4 segments.
- View toggle: Cost | Tokens | Output (metric only, same scope).
- Data: `SELECT LH(at) hb, model, COALESCE(harness,'claude') h, ... FROM usage GROUP BY hb, model, h` (rollup R1, section 7), summed per month and family in TS.
- Encoding: Fable `--viz-s1`, Opus `--viz-s2`, Sonnet `--viz-s3`, Other `--viz-other`, stacked in that fixed order from the baseline.
  Columns at most 24 px wide, 4 px rounded top on the topmost visible segment only, square at the baseline, 2 px surface gap between segments.
  Column total on the cap (text-2xs text-ink-2, tabular); the MoM delta ("+66%" with arrow, text-3xs text-ink-3) under each month tick.
  One y axis, hairline gridlines, clean ticks ($0 / $1,000 / ...).
  Direct segment labels only when the segment is at least 18 px tall and the label fits with 4 px padding (measured); otherwise the value lives in the tooltip and table.
  Current month (Cost view only): a projection ghost above the column from MTD to the projected month end, drawn as an unfilled rect with a 1 px dashed `--viz-context` outline, labelled "proj. ~$6.1k" (dashing here means projection, which is its honest meaning; gridlines stay solid).
- Legend: always shown (4 series), top-left, rect swatches, click to isolate a family (others drop to 15% opacity; colors never change), Escape or a second click restores.
- Tooltip (per column hover and focus): month, total, then one row per family with a line key, and indented version rows (for example Sep: fable-5-1 $2,011, opus-5 $1,6xx, opus-5-5 $7xx, sonnet-5 $572), plus unpriced tokens when above 0.
- Table view: rows = months, columns = Fable, Opus, Sonnet, Other, Total, MoM %, for the active metric.
- Sample (Cost): Feb $11, Mar -, Apr -, May $3, Jun $960 (Opus 959), Jul $1,887 (Fable 1,525 / Opus 291 / Sonnet 71), Aug $2,982 (1,499 / 843 / 640), Sep MTD $4,957 (Fable 2,042 / Opus 2,343 / Sonnet 572).
- Sample (Tokens): Jun 1.0B, Jul 1.40B, Aug 4.45B, Sep 7.91B; (Output) 7.7M / 6.2M / 15.9M / 39.9M.

### C4. Month pace

- Question: am I ahead of or behind earlier months at this point in the month?
- Form: emphasis multi-line (current month in the accent, earlier months as context), cumulative spend by day of month.
- Data: from rollup R1 summed to local days, the current month plus up to 3 previous months that have usage; cumulative running sum per month; a day with no usage carries the previous value forward, drawn as a step (`curveStepAfter`), never an interpolated slope.
- Encoding: current month 2 px `--viz-s1` line with a 4 px end dot at today; earlier months 1.5 px `--viz-context`.
  Direct labels at each line end ("Aug $2,982", text-2xs text-ink-3); if two end labels would sit within 12 px, the lower-priority one (older month) drops to the tooltip and table instead of being nudged.
  No legend box (labels are direct and the emphasis is explained in the subtitle: "Blue = September, gray = earlier months").
  Projection: a dashed 1.5 px `--viz-s1` segment from today's point to the last day of the month at the trailing 7-day rate, ending in a hollow 8 px dot labelled "~$6.1k".
  x = day 1 to 31 (ticks 1, 8, 15, 22, 29), y = $ (one axis).
- Interaction: crosshair snaps to the nearest day; the tooltip lists every shown month's cumulative $ at that day plus "Sep vs Aug +$X (+Y%)"; hovering a gray line raises it to text-2 ink.
- Table view: rows = day 1..31, columns = months, cells = cumulative $ (blank beyond a month's length or beyond today).
- Sample cumulative (Jun / Jul / Aug / Sep): day 10 - / $644 / $1,191 / $1,306; day 15 $124 / $891 / $1,788 / $2,905; day 20 $464 / $1,052 / $1,804 / $3,549; day 25 $803 / $1,396 / $2,235 / $4,921; month ends $960 / $1,887 / $2,982.

### C5. Cost by token class

- Question: am I paying for generated output or for re-reading context?
- Form: stacked columns per month, with an Absolute | Share (100%) toggle.
- Data: rollup R1 carries per (hour, model) sums of each token column; TS multiplies each by `rateFor(model)` from `src/server/pricing.ts`: input x rate.input, output x rate.output, cache_read x rate.cacheRead, cache_create_5m x rate.cacheWrite5m + cache_create_1h x rate.cacheWrite1h, all / 1e6.
  Rows whose model has no rate add to `unpricedTokens` and to no class, mirroring `cost_usd IS NULL`.
  This reconstructs `SUM(cost_usd)` exactly because stored costs are repriced whenever `RATES_VERSION` changes (verified per month: Jun 959.6, Jul 1,886.8, Aug 2,981.9, Sep 4,957 both ways).
- Encoding: Cache read `--viz-s1`, Cache write `--viz-s2`, Output `--viz-s3`, Uncached input `--viz-other` (usually sub-pixel, drawn only when at least 1 px, so column totals always equal the month's spend).
  Share view: in-segment share labels ("51%") where they fit; Absolute view: total on the cap.
- Legend: always shown, top-left, click to isolate.
- Tooltip: month, then per class $ / tokens / share; the cache write row adds the 1 h vs 5 m split by tokens (1 h share Jun 100%, Jul 89%, Aug 31%, Sep 32%).
- Table view: months x (cache read $, cache write $, output $, input $, total, cache-write 1 h token share).
- Sample: cache read / cache write / output: Jun $480 / $283 / $192; Jul $956 / $670 / $257; Aug $1,945 / $671 / $365; Sep $2,131 / $1,843 / $980; lifetime about 51% / 32% / 17%, uncached input $18.
- Headline suggestion: "83% of spend is context, not output".

### C6. Who does the work

- Question: how much of monthly spend comes from orchestration rather than the main session?
- Form: stacked columns per month with an Absolute | Share toggle.
  The three kinds are ordinal (no delegation, one level of delegation, orchestrated), so they are encoded as an ordinal ramp that ends in the accent: Main session `--viz-other`, Task subagents `--viz-s1-soft`, Workflow agents `--viz-s1`, stacked in that order from the baseline.
- Data: rollup R1's kind column summed per month (cost and output tokens); workflow runs per month from R7 by local month of `started_at`.
- Encoding: workflow share % direct-labelled above each column that has workflow spend ("9%", "26%", "48%"); a second tick line under the month labels reads "7 runs / 46 runs / 160 runs" (text-3xs text-ink-4).
- Legend: always shown (3 series).
- Tooltip: month, per kind $ and output tokens and % of month, plus workflow runs that month.
- Click: the workflow segment navigates to `#/workflows`.
- Table view: months x (main $, subagent $, workflow $, workflow share, runs, output tokens by kind).
- Sample: Jun main $960; Jul main $1,719, workflow $168; Aug main $1,745, subagent $475, workflow $761; Sep main $2,274, subagent $317, workflow $2,366 (48%); workflow output tokens 0.9M / 6.7M / 28.3M.

### C7. Workflow run costs

- Question: what does a typical workflow run cost, and which runs are outliers?
- Form: jittered dot strip per month (distribution plus outliers), one series, log $ axis.
- Data: R7 (`workflow_runs LEFT JOIN (SELECT run_id, SUM(cost_usd), SUM(output_tokens) FROM usage WHERE run_id IS NOT NULL GROUP BY run_id)`), bucketed by `LM(started_at)`; median per month computed in TS.
  Runs with NULL cost (no usage recorded yet, currently 1) are not plotted and are counted in the footer ("1 run without recorded usage not shown").
- Encoding: 8 px `--viz-s1` dots at 60% opacity with a 2 px surface ring; x jitter within the month band is deterministic (hash of run_id), never random, so renders are stable.
  Median: a 16 px wide 2 px text-1 tick with its $ label.
  Top 3 runs by cost direct-labelled with their name (truncated to 24 chars).
  Log axis ticks $0.10 / $1 / $10 / $100; the title carries the counts ("7 / 46 / 160 runs").
- Tooltip: run name, date, status, agents, duration, cost, $ per agent; hit area 24 px minimum via a nearest-point search within the month band.
- Click: opens `#/workflows?run=<id>`.
- Table view: all runs sorted by cost desc (name, date, status, agents, duration, cost).
- Sample: Jul 7 runs median $32.2 total $208; Aug 46 runs median $11.9 total $722; Sep 160 runs median about $9 total $2,366; top runs review-treatment-plan-spa $116.8 (144 agents), harness-and-ui-impl $110.5 (9), server-core-impl $61.8 (9).

### C8. Price of output by model

- Question: per unit of output, which model is expensive once context costs are included?
- Form: sorted horizontal bars (magnitude comparison with long category names), one series.
- Data: from R1, per model `SUM(cost_usd) / (SUM(output_tokens) / 1e6)` for models with at least 1M lifetime output tokens (drops haiku, gpt, grok, which have negligible output); list output rate from `rateFor(model).output`.
- Encoding: bars `--viz-s1`, at most 20 px thick, sorted descending, 4 px rounded end; a 2 px tall-by-bar-height `--viz-context` tick at each model's list output rate on the same $ axis, with a legend entry "list output price" (line key) beside "all-in $ per 1M output" (rect key).
  Direct label at each bar end: "$416 · 8.3x list" (text-2xs text-ink-2).
- Tooltip: lifetime $, output tokens, multiple of list, share of that model's $ spent on cache read plus cache write, and the same figure over the last 30 days (from R1 hours within the window) for context.
- Table view: model, all-in $/M, list $/M, multiple, lifetime $, output tokens, last-30-day all-in $/M.
- Sample: claude-fable-5 about $416/M (list $50), claude-fable-5-1 $293 ($50), claude-opus-4-8 $130 ($25), claude-opus-5 $120 ($25), claude-opus-5-5 $97 ($20), claude-sonnet-5 $72 ($10).

### C9. Lifetime calendar

- Question: when have I been working, and how intense was each day, across the whole lifetime?
- Form: calendar heatmap, weeks as columns (Monday first), 7 rows, from the week containing the first usage day to the current week (currently 33 weeks).
- Data: R1 summed to local days (cost, messages); R2 gives distinct sessions and the top project per day.
- Encoding: 5 quantile bins over active days, `--viz-seq-1..5` (more = darker in light, more = lighter in dark); zero days `--viz-empty`; days after today not drawn.
  Cell 14 px square with a 2 px gap at 1280 and 1600 (16 px pitch), 12 px at 390; month labels on top, Mon / Wed / Fri row labels.
  Scale legend "Less [5 swatches] More" with bin edges in $ on hover.
  Metric toggle: Spend | Messages (re-bins on the chosen metric).
- Summary column (right of the grid at 1024 px and up, under it below): active days per month as a tiny text list, mean $ per active day, longest and current streak.
- Tooltip (hover and focus; cells are a roving-tabindex grid with arrow-key navigation): date, $ spend, messages, sessions, top project.
- Table view: one row per active day (date, spend, messages, sessions, top project), newest first.
- Sample: 93 active days, top days 25 Sep $590, 13 Sep $552, 14 Sep $482, 10 Aug $478, 27 Aug $462; active days per month Feb 3, May 1, Jun 16, Jul 28, Aug 20, Sep 25.

### C10. Weekly rhythm

- Question: which hours and weekdays are busy?
- Form: 7 x 24 heatmap (rows Monday to Sunday, columns 00 to 23 local).
- Data: from R1 hour buckets, `activeDays` = number of distinct local dates with any usage in that weekday-hour, and `costUsd` = spend in that weekday-hour; `weekdayCounts` = how many of each weekday have elapsed since the first usage day (for "active in 16 of 32 Tuesdays").
  Counting distinct day-hours, not messages, stops a single 144-agent burst from dominating.
- Encoding: the same 5-step ramp and empty cell as C9 (one sequential language on the page), quantile bins over non-empty cells, 2 px gaps, hour ticks every 3 h.
  Right margin: per-weekday total spend as thin `--viz-s1` sparkbars with values in text-3xs.
  Metric toggle: Active hours | Spend.
  Below 640 px: 8 columns of 3-hour bins.
- Tooltip: "Tue 10:00 · active on 16 of 32 Tuesdays · $X spend".
- Table view: weekday rows x hour columns with the active-day counts, plus a spend column per weekday.
- Sample: weekday spend Sun $707, Mon $2,379, Tue $1,835, Wed $1,513, Thu $1,585, Fri $1,461, Sat $1,310.

### C11. Active hours and leverage

- Question: am I working more hours, or getting more done per hour?
- Form: two aligned single-series column panels (small multiples) sharing the month x axis; never a dual axis.
  Top panel: main-session active hours per month.
  Bottom panel: spend per active hour (all spend that month, including agents, divided by main-session active hours).
- Data: R5 = `WITH g AS (SELECT session_id, at, LAG(at) OVER (ORDER BY at) p, LAG(at) OVER (PARTITION BY session_id ORDER BY at) sp FROM usage WHERE agent_id IS NULL) SELECT LM(at) m, session_id, SUM(CASE WHEN at - p < 1800000 THEN at - p ELSE 0 END) union_ms, SUM(CASE WHEN at - sp < 1800000 THEN at - sp ELSE 0 END) session_ms FROM g GROUP BY m, session_id`.
  Active hours per month = sum of `union_ms` (a global timeline, so two parallel sessions never double count); `session_ms` summed per session feeds the C2 longest-session record.
  Months with fewer than 10 active hours are drawn as empty slots with "-" in the table (Feb 5 h and May 0 h would give meaningless $/h).
- Encoding: `--viz-s1` columns at most 24 px, value direct-labelled on each cap (only 4 to 6 columns, so it does not clutter), hairline grid, current month labelled MTD.
- Subtitle must say "active = main-session messages less than 30 min apart", because this measures session activity, not keyboard presence.
- Tooltip: month, active hours, total $, $ per active hour.
- Table view: months x (active hours, spend, $ per active hour).
- Sample: active hours Jun 80, Jul 96, Aug 76, Sep 150 (MTD); $/active hour Jun $12.0, Jul $19.7, Aug $39.2, Sep $33.0.

### C12. Projects by month

- Question: which projects consumed the budget, and when did each heat up and cool off?
- Form: heat-shaded table (40 projects is far past the categorical cap, so no project stack).
- Data: R2 = `SELECT LD(at) d, COALESCE(project,'(no project)') p, session_id, SUM(cost_usd), SUM(CASE WHEN cost_usd IS NULL THEN TOK ELSE 0 END) FROM usage GROUP BY d, p, session_id`, folded in TS to project x month (cost, distinct sessions, active days).
  Rows: top 10 projects by lifetime spend, then "Other N projects", then "(no project)" when present (currently $135 over 855 rows).
  Columns: every month that has any usage (months with no usage at all are omitted in a table), then Lifetime, Sessions, Active days.
- Encoding: month cells shaded with the 5-step ramp by quantile bins over all non-empty project-month cells; value printed in each cell (tabular), ink chosen by contrast against the fill; empty cells show "-" in text-4 on the plain surface.
  Lifetime column: an inline `--viz-s1` bar (relative to the top project) with the $ label after it.
  Scale legend above the table.
  Headers sortable by click (`aria-sort`), default Lifetime desc.
- Tooltip on a cell: project, month, $, sessions, share of that month's spend.
- This card is already a table; its Table toggle switches shading off (plain values) for print and screen readers.
- Sample: oxygenrx-malta-scoping - / 482 / 1,266 / 1,458 (Jun to Sep); quickshell - / - / 572 / 1,394; oxygenrx-billing 471 / 694 / - / 1; monarch-commerce 139 / 556 / 40 / -; agent-monitor 22 / - / 255 / 218; lyv-commerce - / 83 / 28 / 384.

### States shared by every card

- First load: each card renders its header and a skeleton block of the card's final height (`Skeleton` primitive, pulse gated by the Motion toggle), so nothing jumps when data lands.
- Refetch (Refresh button, window refocus, or the 5-minute interval while visible): the previous render stays, dimmed to 60% opacity, until the new payload arrives; no skeleton flash.
- Error: the page shows "Couldn't load insights." with a Retry button in place of the grid; a failed refetch keeps the old data and shows a small "Refresh failed" note in the toolbar.
- Empty database (`meta.usageRows === 0`): one centered empty state "No usage recorded yet. Insights appear once agents start spending tokens." and no cards.
- A card whose own data is empty (for example C7 with no workflow runs) keeps its frame and shows a one-line empty message in the plot area.

## 7. API: `GET /api/insights`

Single endpoint, pull only, never pushed over SSE, never part of `buildState()`.
Implemented as a pure `computeInsights(db, now)` in `src/server/insights.ts`, called through a memoizing `store.insights(now)`.

### Queries (one pass each over `usage`)

| Id | Query | Rows today | Time on copy |
|---|---|---|---|
| R1 | `SELECT LH(at) hb, model, COALESCE(project,'(no project)') p, COALESCE(harness,'claude') h, CASE WHEN run_id IS NOT NULL THEN 2 WHEN agent_id IS NOT NULL THEN 1 ELSE 0 END k, SUM(cost_usd), SUM(cost_usd IS NULL), SUM(CASE WHEN cost_usd IS NULL THEN TOK ELSE 0 END), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_create_5m_tokens), SUM(cache_create_1h_tokens), COUNT(*) FROM usage GROUP BY hb, model, p, h, k` | 1,822 | 50 ms |
| R2 | day x project x session (C12, C9 sessions and top project, KPI sessions and projects) | 537 | 33 ms |
| R4 | `SELECT at/900000 k, COUNT(DISTINCT COALESCE(agent_id, session_id)) a FROM usage GROUP BY k` plus, for the peak bucket only, the dominant run_id | 2,166 | 13 ms |
| R5 | main-session active time (C11, C2 longest session) | 265 | 37 ms |
| R7 | workflow runs with per-run cost (C6 runs, C7, C2) | 213 | 6 ms |
| R8 | `SELECT COUNT(*) FROM workflow_agents` | 1 | under 1 ms |

- Measured with the sqlite3 CLI `.timer` on the 76,842-row backup copy, three runs: 140 to 160 ms total SQL.
  The earlier per-chart query set (12 separate scans) measured 285 to 295 ms, which is why everything derivable is folded into R1.
- Everything else (months, families, token classes via `rateFor`, kinds, days, weekday-hours, trailing 7 days, MTD, prior-month same point, projections, streaks, records, quantile edges are client-side) is derived in TS from these rows.
- Hour buckets are local (`'localtime'`), so DST and half-hour zones are handled by SQLite, and trailing-window sums (7 days, 30 days) are exact to the hour, which is enough for a projection.
- The implementer re-measures inside bun with `scripts/bench-insights.ts <db-path>` (opens the DB with `{ readonly: true }`, runs `computeInsights` 5 times, prints min/median ms) and records the result in `meta.computeMs`; target under 200 ms on this copy.

### Memoization

- Key: `(usageVersion, workflowFingerprint, localDayKey)`, where `workflowFingerprint` = `SELECT COUNT(*), MAX(last_seen_at) FROM workflow_runs` (under 1 ms) and `localDayKey` = the local `YYYY-MM-DD` of `now`.
- Floor: while agents are running `usageVersion` changes every few seconds, so a cached payload younger than 60 s is served even if the key changed, with `meta.stale = true`; this bounds the 150 ms synchronous computation to at most once a minute and only while someone has the page open.
- A day change always recomputes, regardless of the floor.
- `usageVersion` stays private; the store method owns the cache exactly like `costByProject`.

### Response type (`src/shared/insights.ts`, imported by server and web)

```ts
type Usd = number | null; // null = every contributing row unpriced; never a fabricated 0
type Family = "Fable" | "Opus" | "Sonnet" | "Other";
type Kind = "main" | "subagent" | "workflow";

interface InsightsResponse {
  meta: {
    generatedAt: number; computeMs: number; stale: boolean;
    tz: string;                      // Intl.DateTimeFormat().resolvedOptions().timeZone on the server
    firstAt: number | null; lastAt: number | null;
    usageRows: number; unpricedRows: number; unpricedTokens: number;
  };
  months: string[];                  // "YYYY-MM", continuous, first usage month .. current month
  currentMonth: string;
  kpi: {
    lifetimeUsd: Usd; lifetimeTokens: number; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number; messages: number;
    sessions: number; projects: number; activeDays: number;
    workflowRuns: number; workflowAgents: number;
    byHarness: { harness: string; costUsd: Usd; tokens: number }[];
    mtdUsd: Usd; prevMonthUsd: Usd; prevMonthSamePointUsd: Usd;
    trailing7dUsd: Usd; projectedMonthEndUsd: Usd;   // null on day 1-2 of a month
    cacheHitRate: number; cacheSavingsUsdEst: number;
  };
  records: {
    biggestDay: { day: string; costUsd: number; messages: number } | null;
    longestStreak: { from: string; to: string; days: number } | null;
    currentStreakDays: number;
    peakAgents: { at: number; agents: number; runId: string | null; runName: string | null } | null;
    priciestRun: { runId: string; name: string | null; costUsd: number; agentCount: number | null; startedAt: number | null } | null;
    longestSession: { sessionId: string; project: string | null; activeMs: number; wallMs: number; startedAt: number } | null;
  };
  byMonthModel: { month: string; model: string; family: Family; costUsd: Usd; tokens: number; outputTokens: number; unpricedTokens: number }[];
  byMonthTokenClass: {
    month: string; inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number;
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number;
    unpricedTokens: number;
  }[];
  byMonthKind: { month: string; kind: Kind; costUsd: Usd; outputTokens: number }[];
  days: { day: string; costUsd: Usd; messages: number; sessions: number; topProject: string | null; peakAgents: number }[];
  weekHour: { weekday: number; hour: number; activeDays: number; costUsd: Usd }[]; // weekday 0 = Monday
  weekdayCounts: number[];                                                           // length 7, Monday first
  activity: { month: string; activeMs: number }[];
  workflowRuns: { runId: string; name: string | null; status: string | null; startedAt: number | null; month: string | null; agentCount: number | null; durationMs: number | null; costUsd: Usd; outputTokens: number }[];
  models: { model: string; family: Family; costUsd: Usd; outputTokens: number; cacheUsd: number; listOutputRate: number | null; costUsd30d: Usd; outputTokens30d: number }[];
  projects: { project: string; kind: "project" | "other" | "none"; lifetimeUsd: Usd; sessions: number; activeDays: number; byMonth: Record<string, { costUsd: Usd; sessions: number }> }[];
}
```

- Payload size today is about 60 KB uncompressed (dominated by `workflowRuns` and `days`), acceptable for a pull endpoint; if runs pass 2,000, `workflowRuns` is capped to the most recent 2,000 plus the all-time top 10 by cost, with a `truncated` flag.
- HTTP: `GET` only, `200` with JSON; any error inside compute returns `500 { error }` and logs once; no query parameters in v1.

### Server changes

- `src/server/pricing.ts`: export `type Rate` and `rateFor(model: string): Rate | null` (the existing `RATES[canonicalModel(model)]` lookup, no warning side effect); `costOf` reuses it.
- `src/server/insights.ts`: the queries above plus pure derivation helpers, each exported for tests (`familyOf`, `kindOf`, `tokenClassUsd`, `continuousMonths`, `streaks`, `projection`, `samePointPrevMonth`).
- `src/server/store.ts`: `insights(now: number): InsightsResponse` with the memo in section 7.
- `src/server/http.ts`: route next to `/api/cost/daily`.
- `src/shared/modelFamily.ts`, `src/shared/insights.ts`: shared types and the family function.

## 8. Chart primitives (`src/web/components/charts/`)

Hand-rolled SVG plus HTML, reusing the Tailwind tokens and the `--viz-*` variables; no new chart dependency.
Justification: the app ships no chart library, the forms here are few and simple, every mark spec (24 px cap, 2 px gaps, rounded data-end only, measured labels, rings) is easier to guarantee by hand than to override in Recharts, and bundle size stays flat.

| File | Responsibility |
|---|---|
| `scales.ts` | `linear`, `log10`, `band` scales; `niceTicks(max, count)`; `logTicks(min, max)`; `quantileEdges(values, 5)` and `binOf` |
| `format.ts` | compact USD (`$10.8k`), tokens (`14.8B`), percent, month labels ("Sep", "Sep MTD", "Sep 2026" when the axis spans years), all via existing `formatUsd`/`formatTokens` where they fit |
| `useChartWidth.ts` | ResizeObserver width of the card body, rounded to whole px, SSR/jsdom safe fallback width 600 |
| `measureText.ts` | canvas `measureText` with the page font at a given size; jsdom fallback of 0.6 em per char |
| `ChartCard.tsx` | `<figure>` with title, subtitle, legend slot, Chart / Table Segmented toggle, footer note, loading skeleton of fixed height, dim-on-refetch, empty message; `aria-labelledby` wiring |
| `Legend.tsx` | rect or line keys, click (and Enter / Space) to isolate, `aria-pressed`, colors fixed per entity |
| `Tooltip.tsx` + `useTooltip.ts` | one portal tooltip per page, positioned from pointer or focused element, clamped to the viewport; value first (text-1 semibold), label second (text-3), line keys; opens on focus as well as hover; Escape closes |
| `Axis.tsx` | band x axis with optional second tick line, value y axis with hairline grid (`border-weak`) and baseline (`border-1`), tabular tick labels in text-4 |
| `StackedColumns.tsx` | columns of ordered segments, 24 px cap, 2 px surface gaps, 4 px rounded top on the top visible segment, square baseline, measured in-segment labels, cap labels, optional ghost projection rect, per-column hit area spanning the band, isolate support |
| `StepLines.tsx` | cumulative step lines, emphasis styling, end labels with collision drop, dashed projection segment, crosshair snapping to the nearest x |
| `HBars.tsx` | sorted horizontal bars with end labels and an optional reference tick per bar |
| `DotStrip.tsx` | log-scale jittered dots per band, deterministic jitter, median tick, top-N labels, nearest-point hit testing |
| `HeatGrid.tsx` | generic cell grid (used by the calendar and the weekly rhythm), roving tabindex with arrow keys, ring highlight API for C2 |
| `ScaleLegend.tsx` | 5 swatches "Less .. More" with bin-edge titles |
| `HeatTable.tsx` | HTML table with shaded cells, contrast-picked ink, sticky first column, sortable headers, inline lifetime bar |
| `StatTile.tsx`, `HeroFigure.tsx`, `Sparkline.tsx`, `Meter.tsx` | the figure contract: label, value (proportional figures), neutral delta with arrow, sparkline, same-ramp meter |
| `DataTable.tsx` | the table-view twin for every chart: caption, tabular numbers, `$x+` unpriced convention |
| `palette.ts` | series ids to `--viz-*` variable names, `FAMILY_SLOT`, `KIND_FILL`, `TOKEN_CLASS_SLOT` |

- The page itself is `src/web/components/InsightsPage.tsx`, with per-card components in `src/web/components/insights/` (`KpiRow.tsx`, `RecordsStrip.tsx`, `MonthlyByModel.tsx`, `MonthPace.tsx`, `TokenClass.tsx`, `WhoDoesTheWork.tsx`, `WorkflowRunCosts.tsx`, `PriceOfOutput.tsx`, `LifetimeCalendar.tsx`, `WeeklyRhythm.tsx`, `Leverage.tsx`, `ProjectsByMonth.tsx`) and client-side shaping in `src/web/insights.ts` (pure functions: cumulative-with-carry, quantile bins, MoM deltas, calendar week layout).
- All labels come from data (project and run names) and are rendered as React text nodes, never `dangerouslySetInnerHTML`.
- Motion: entering bars and lines fade in over `duration-base` only when the Motion toggle is on (`html.am-anim`); no animation on refetch.

## 9. What was cut and why

- Harness share per month (both proposals agreed): Codex is $14 lifetime and Cursor $0.08, so a stack would be one solid color; harness lives in the KPI footnote.
- Token volume mix by class: cache reads are 97% of 14.79B tokens, so the other classes would be sub-pixel; C5 shows cost by class instead.
- Session cost dumbbell (median / p90 / max per month): the claimed "median flat at about $10" is not true (Aug median $2.8), sessions are bucketed by first message although long sessions span months, and session cost already includes the workflows it spawned, so it repeats C6 less clearly.
- Daily peak concurrency chart: one 79 outlier forces a clipped axis; the peak lives in C2 and the per-day peak in the C9 tooltip.
- Workflow size histogram and outcome chart: 205 of 213 runs completed and size is secondary to cost; sizes appear in the C7 tooltip and table.
- Tool-level trends: `tool_stats` has no timestamps and `events` keeps only 30 days, so no month-on-month is possible.
- Sessions per month from the `sessions` table: 346 zero-usage Cursor hook sessions inflate it; every session count on this page comes from `usage.session_id`.
- `subagents` table per month: rows start in August while `usage.agent_id` shows subagent spend from July; C6 uses usage.
- Page-level scope and project filter, and C8's "last 30 days" toggle: per-chart filters are an anti-pattern and a page filter is not worth its cost for a lifetime page; C8's tooltip carries the 30-day figure instead.
- Hatched projection caps: texture is opt-in accessibility only; the projection is a dashed outline ghost instead.
- Success/critical colored deltas: spend growth is not a status, so deltas are neutral with an arrow.

## 10. Test plan

Fix every lint, type or flaky failure met along the way, even if unrelated.

### Server (`bun test tests/`)

- `tests/insights.test.ts`, in-memory DB built with `openDb(":memory:")` and hand-inserted usage rows:
  - TZ: the test sets `process.env.TZ = "Europe/Berlin"` before any Date or DB use; first write a failing test proving whether bun:sqlite's `'localtime'` honours it; if it does not, add `TZ=Europe/Berlin` to the `test` script instead.
  - Month bucketing across a local midnight: a row at 2026-08-31 23:30 CEST lands in August, a row at 2026-09-01 00:10 CEST in September.
  - `months` is continuous and includes empty months between the first usage and `now`.
  - NULL cost: a month whose only rows are unpriced yields `costUsd: null` and correct `unpricedTokens`; a mixed month yields the priced sum plus `unpricedTokens > 0`; nothing is coalesced to 0.
  - Token classes: for every month, `inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd` equals `SUM(cost_usd)` of the priced rows within 1e-6.
  - Kind: run_id row = workflow, agent_id-only row = subagent, bare row = main.
  - Families: fable, mythos, opus, sonnet, haiku, gpt, grok, cursor ids map as specified.
  - Projection with a fixed `now`, MTD, trailing 7 days, prior-month same point clamped to a shorter month (31 Mar vs 28 Feb).
  - Projection is null on days 1 and 2.
  - Streaks: longest island and current streak (today active, yesterday only, neither).
  - Peak agents picks the 15-minute bucket with the most distinct agents and names its dominant run.
  - Longest session uses 30-minute gap splitting; active hours use the global timeline so two overlapping sessions count once.
  - Workflow run with no usage has `costUsd: null`.
  - Projects fold: top 10, "Other N projects", "(no project)".
  - Weekday mapping is Monday = 0.
- Memo tests in `tests/store.test.ts`: identical object returned while the key is unchanged; a usage insert younger than the floor returns the cached object with `stale: true`; after the floor (injected clock) it recomputes; a local day change recomputes immediately; a workflow run upsert changes the fingerprint.
- `tests/pricing.test.ts`: `rateFor` resolves aliases, date suffixes and cursor ids exactly like `costOf`, returns null for unknown models without warning.
- `tests/http.test.ts`: `GET /api/insights` returns 200 and the documented top-level keys; empty DB returns `usageRows: 0` and empty arrays.
- `scripts/bench-insights.ts` is run by hand on a `.backup` copy (never the live DB) and its numbers go into the PR description; no timing assertions in CI (they flake).

### Web (`bun run web:test`)

- `web-tests/insights.test.ts`: cumulative carry-forward, quantile bins with ties, MoM deltas with null and zero previous months, calendar week layout from a Wednesday start, `niceTicks`, `logTicks`, label-fit decision (fits, does not fit, zero-height segment).
- `web-tests/InsightsPage.test.tsx` with mocked `fetch`: renders hero "$10,800"-style value; each card's Table toggle renders a table containing a known value; legend isolate dims others and leaves their fill variable unchanged; empty-DB state; error state with Retry; refetch keeps the old render (no skeleton) while pending; `$x+` appears when `unpricedTokens > 0`.
- `web-tests/charts/*.test.tsx`: StackedColumns draws 2 px gaps and rounds only the top segment; Tooltip opens on focus and closes on Escape; HeatGrid arrow-key navigation; HeatTable sorting and `aria-sort`.
- `web-tests/AppBar.test.tsx`: Insights link present in both layouts, `aria-current="page"` on `#/insights`.
- `web-tests/App.test.tsx`: `#/insights` and `#/insights?x=1` route to the page.
- `bun run typecheck` clean.

### End to end (agent-browser)

- Build with `bun run web:build`, then run a second server on a copy: `AM_PORT=4399 AM_DB_PATH=<scratchpad>/copy.sqlite AM_WORKFLOWS=0 bun run src/server/index.ts`; never restart or touch am-server on 4317 and never open the live DB for writing.
- Open `http://127.0.0.1:4399/#/insights` at 390 x 844, 1280 x 800 and 1600 x 900, in both light and dark (toggle via the AppBar theme button), and screenshot each.
- Check with a pixel-picky eye: no horizontal page scroll at 390, no nested vertical scroll in any card, no clipped or colliding labels, legends present on every multi-series chart, direct labels only where they fit, tabular numbers only on axes and tables, dark mode steps as in section 5.
- Hover and keyboard-focus one mark per chart and confirm the tooltip content listed in section 6; tab through the calendar with arrow keys; click a C7 dot and land on `#/workflows?run=<id>`.
- Cross-check five numbers against sqlite3 `-readonly` on the same copy: lifetime spend, Sep MTD, Aug total, the C5 September cache-write $, and the C7 September median.
- Re-run the validator commands in section 5 if any `--viz-*` value changes.
