# Linear-inspired dashboard redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the whole dashboard (`src/web/**` + `tailwind.config.js`) onto one glyph rail, one status-glyph family and one four-step ink/surface ramp, with **zero functional change** and no test deletions.

**Architecture:** A token layer lands first (new primitive tokens plus an alias layer that keeps every legacy token name resolving, so the app renders correctly between commits). Two new files — `StatusGlyph.tsx` and `primitives.tsx` — carry every shared idiom (rail slot, list row, section header, meter row, chip, segmented control, page header). Then each component is migrated in its own commit against the still-green suite. The suite is hardened with `data-testid`s **before** any styling moves, so a restyle can never silently break a selector.

**Tech Stack:** React 18 + Vite 5 + Tailwind 3.4 (`darkMode: "class"`, HSL channel-triple CSS variables), Vitest 2 + @testing-library/react (`web-tests/`), Bun (server, untouched here).

**Spec:** `docs/superpowers/specs/2026-08-10-linear-dashboard-redesign-design.md` — authoritative. Every task cites its sections. Read §Binding constraints, §6 (test coupling) and §7 (risks) before starting.

**Baseline measured on `main` at planning time (2026-08-10):** `npx vitest run` → **23 files / 111 tests, all green**. That is the number every task must keep.

---

## Global Constraints

Every task's requirements implicitly include this section.

**Scope**
- Only these may be modified: `src/web/styles.css`, `tailwind.config.js`, `src/web/components/**`, `src/web/workflowStatus.ts`, `web-tests/**`. Nothing else.
- **Never touched, and diff-verified at the end:** `src/web/api.ts`, `App.tsx`, `viewTransition.ts`, `index.html`, `useTheme.ts`, `useTextSize.ts`, `useMotion.ts`, `useNow.ts`, `useHashRoute.ts`, `usePersistedToggle.ts`, `useFeedLimit.ts`, `types.ts`, `tools.ts`, `cost.ts`, `time.ts`, and everything under `src/server/`, `src/cli/`, `src/mcp/`. (K1, K3, K4, K17)
- **Zero functional change.** No new prop that changes behaviour, no new interaction, no click-only row converted to a `<button>`/`<a>`, no new field on `State`/`Cost`/`WorkflowRun`, no endpoint change, no SSE cadence change. (§Non-goals, R7)
- **No new dependency.** No icon library, no `clsx`/`cva`/`tailwind-merge`, no Radix, no dialog/animation library, no router, no webfont file. `package.json` does not change.

**Styling rules**
- **No `dark:` variant anywhere in components.** `:root` is light, `html.dark` is a wholesale override. (K5) — `grep -ran "dark:" src/web/` must stay at **0**.
- **The rem rule:** no `px` inside a Tailwind arbitrary value, ever, except true hairlines (`h-px`, `w-px`, `border`, `border-b-hairline`) and blur radii (`backdrop-blur-[20px]`). Everything else is rem or a stock scale step, so the `[14,16,18,20,22]` text-size ladder keeps scaling it. (K4, §1.7)
- **The opacity rule:** Tailwind's default opacity scale is multiples of 5. **Any alpha that is not a multiple of 5 must be bracketed** — `bg-surface-0/[0.72]`, not `bg-surface-0/72` (which emits *no rule at all* and renders fully opaque). (R14, §1.8)
- **One utility per CSS property per element** — see Decision D3 below. Two classes touching the same property in one `className` are resolved by stylesheet emission order, *not* by the order they appear in the string.
- All keyframe animation stays behind the `.am-anim` ancestor selector, including the deliberate override of OS `prefers-reduced-motion` **with its explanatory comment intact**. (K6)
- `grep -ran "animate-" src/web/` must reach **0** and stay there. (§5.3) **It is 4 lines today, not 3** — verified on `main`: `ActivityFeed.tsx:16`, `SessionCard.tsx:52`, `SessionCard.tsx:65`, `WorkflowRunCard.tsx:8`. (§5.3's table has three *rows* because its row 2 covers two call sites.)

**Test rules**
- **No test deletions.** Copy assertions are the product contract and stay exactly as they are. Only *structural* selectors (`closest()`, `.className`, positional row index) may be re-pointed, and only in Task 0.
- Every `aria-label`, `title`, `aria-expanded`, `aria-pressed`, `aria-sort` and `data-status-known` in §6.2 survives verbatim.
- Every literal visible string in §6.2 survives verbatim **and keeps its element boundary** ("ONE element" = the whole string is one element's text content).
- `max-h-[40vh] overflow-y-auto` stays as the **literal class string** on the `TodosSection` open-list scroller and the `WorkflowsSection` live-run list; `ActivityFeed` keeps `max-h-[calc(100vh-8rem)]`. (K7)
- `line-clamp-1` stays on the `TodoCard` note element and on the `DoneDialog` row title; no `.cursor-grab` element may exist. (K15)
- `usePersistedToggle` keeps driving all five disclosures with unchanged localStorage keys. (K10)
- Native `<dialog>` + imperative `showModal()`/`close()` stays for `TodoModal` and `DoneDialog`. (K11)
- Per-item `viewTransitionName` stays: `vt-s-{session.id}`, `vt-t-{todo.id}`, `vt-a-{activity.id}`, `vt-donelist`. (K18)
- `WF_STATUS_CLASS` / `WF_STATUS_GLYPH` are display hints, **never validators**: unknown status → grey + `data-status-known="false"`. (K12)
- Zero-footprint-when-idle stays: `WorkflowsSection` (no live runs), `CostPanel` (`liveTotalUsd===0 && todayUsd===0`), `CostBreakdown` (empty `byProject`) still `return null`. (K8)
- Version-skew guards stay: `workflows_degraded ?? 0`, `byProject`/`byBranch` `?? []`, `schema_ok`, `phase`. (K9)

**Byte-level warnings — leave these bytes exactly as they are**
- `A−` in `AppBar.tsx:63` is **U+2212 MINUS SIGN** (verified: `M-bM-^HM-^R`), not an ASCII hyphen.
- `CostDailyPage.tsx:93` says `Couldn't load cost data.` with an **ASCII `'`**; `WorkflowsPage.tsx:149` says `Couldn’t load workflow runs.` with **U+2019**. Both tests match `/couldn.t load/i`, so "tidying" one to match the other is an undetected copy change. Leave each file's byte alone.

---

## Decisions taken during planning

The spec left one decision open and its class strings contain three latent Tailwind ordering bugs. All are resolved here, and all were **measured against this repo's own `tailwindcss@3.4.19`**, not assumed.

### D1 — Rail alignment: option (a). One `<Rail>` slot, no gap before the first text.

The spec (§3.3) flagged this as blocking and offered (a) a fixed-width leading slot or (b) dropping the "one rail" claim. **We take (a)** — it is the design's whole premise and it is one rule for six components.

Mechanism: a `<Rail>` primitive renders `<span className="flex w-rail shrink-0 items-center justify-center">`. A row is:

```tsx
<Row className="flex items-center">            {/* NO gap at this level */}
  <Rail><LeadingMark/></Rail>                  {/* exactly --rail wide */}
  <div className="flex min-w-0 flex-1 items-center gap-2">…content…</div>
</Row>
```

Flex `gap` applies between *all* children, so putting the gap on the outer row would push line-1 text to `rail + gap`. Nesting the content in its own gapped flex makes line-1 text start at **exactly `--rail`** regardless of whether the mark is a 14px glyph, a 16px checkbox or a 6px dot. Second lines and sub-lists use `pl-rail`. Applies to: `SessionCard`, `TodoCard`, `WorkflowRunCard`, `ActivityFeed` rows, `MeterRow`, and the `Column` group header.

### D2 — `border-hairline` is an **all-sides** utility. Never combine it with `border-b` / `border-l`.

**Measured:** Tailwind emits `.border-hairline { border-width: var(--hairline) }` *before* `.border-b { border-bottom-width: 1px }`. So the spec's `border-b border-hairline border-border-weak` produces a 1px bottom **plus a hairline top, right and left** — a full box where a single rule was intended.

Every single-edge hairline in this plan therefore ships as the side-specific width utility, which is generated from the same theme key and was verified to emit:

| Spec writes | Ships as |
|---|---|
| `border-b border-hairline border-border-weak` | `border-b-hairline border-border-weak` |
| `lg:border-l lg:border-hairline lg:border-border-weak` | `lg:border-l-hairline lg:border-border-weak` |

`border-hairline` **alone** (no side utility) stays correct for four-sided panel and control edges: the dialog panel, the `<Segmented>` shell, the A−/A+ pair, the ActivityFeed select.

### D3 — One utility per CSS property per element. Compose, never append.

**Measured emission order** (later wins, regardless of `className` order):

| Pair in one `className` | Winner |
|---|---|
| `text-ink-3 text-ink` | `text-ink-3` |
| `text-3xs text-2xs` | `text-3xs` |
| `hover:bg-attention/[0.08] hover:bg-surface-2` | `hover:bg-surface-2` |

Consequences, all binding:
- `ROW_BASE` carries **no** hover background. `ROW_TONE[tone]` supplies exactly one. (`tone="attention"` *replaces* `hover:bg-surface-2`; appending it would be a coin flip.)
- The AppBar ghost-button class carries **no** text colour; every call site appends exactly one (`text-ink-3` or `text-ink`).
- `<Chip>` takes a `size` prop instead of being overridden with a second `text-*` class.

### D4 — `<SectionHeader label>` is a single string; there is no separate count slot.

Three accessible names are regex-pinned (`/Todos/`, `/Workflows \(2\)/`, `/Tool usage \(511\)/`) and accessible-name computation concatenates element text with unpredictable spacing. Passing the whole label — parentheses and count included — as one string in one `<span>` removes the hazard. `Column`'s count stays a separate span because a `<div>` group header computes no accessible name.

### D5 — `<Chip tone="working">` standardises on `bg-working/[0.12]`.

The spec spells the AppBar workflows-count chip `bg-working/[0.14]` in §1.8 and the `working` chip tone `bg-working/[0.12]` in §3.3. One token, one alpha: `/[0.12]`. The 2% delta is imperceptible and the duplication is not worth a second variant.

### D6 — `Column`'s `dot` narrowing lands in Task 0, not Task 4.

The `session-group-{status}` test-id needs the status, and K16 forbids a fifth prop on `Column`. Task 0 therefore narrows `dot: string` → `dot: Session["status"]` and maps it back to the *identical* rendered class through a local `DOT_CLASS` record. **Zero rendered-class change** — verified by eye and by the green suite. Task 4 then only restyles.

### D7 — every acceptance `grep` must pass `-a`.

**Verified on `main`:** `src/web/components/CostBreakdown.tsx` contains a literal **NUL byte at offset 2483** (a deliberate `\x00` separator inside a React key). `file` reports the file as `data`, and `grep -rn "bg-primary/10" src/web/` **silently skips it** — it reports only `ToolStats.tsx` today, while `CostBreakdown.tsx:14` carries the same class. Without `-a` every acceptance grep in this plan passes green against a half-migrated file. **Decided: swap, not skip** (§10.5) — Task 9 replaces the `\x00` separator with a printable, collision-proof one as part of its restyle of `CostBreakdown.tsx`. Every acceptance grep keeps `-a` regardless (it costs nothing and this rule must hold up through Task 8); once Task 9 lands, `-a` is no longer load-bearing here but stays harmless.

### D8 — "ONE element" means *own text nodes*, not `textContent`.

`getByText` matches on an element's **direct child text nodes only** — element children are excluded. Three consequences that every component task depends on:

- `⚠ {s.attention_reason}` in one `<div>` matches `"⚠ Run migration?"`, because both text nodes are direct children. Splitting the reason into a nested `<span>` would break it.
- A `<td>` may hold `{label}` **plus** a sibling `<span>` (a glyph, a caret, a chip) and still match `getByText(label)` — this is how `WorkflowsPage.test:48` finds `wf_b` today next to its `structure unavailable` badge.
- But the moment a literal is *moved into* a child element, `getByText` matches **that child**, not the parent — so any attribute the test then reads (`data-status-known`, `className`) must move with it. This is exactly the trap in the `#/workflows` Status cell, and why the glyph there is a sibling of the label rather than a wrapper around it.

`container.textContent` (used by `SessionCard.test:41`) is the opposite: it *does* include descendants, which is why the `sr-only` status labels had to be checked against the "no `tok`" assertion.

---

## Conventions

- Web tests: `npx vitest run` (all) or `npx vitest run web-tests/X.test.tsx` (one file). RTL cleanup is registered globally in `web-tests/setup.ts`.
- Typecheck: `bun run typecheck` (runs `tsconfig.json` **and** `tsconfig.web.json`).
- Build: `bun run web:build` (vite → `dist/web`). Dev server: `bun run web:dev` → `http://127.0.0.1:5317`, proxying `/api` and `/events` to the live server on `127.0.0.1:4317` (so it renders **real live data**).
- Server suite: `bun test tests/` — must stay untouched and green; it is the proof that scope held.
- Components live in `src/web/components/`; pure helpers in `src/web/*.ts`; hooks are `src/web/useX.ts`.
- **Commit after every task.** One branch for the whole redesign; merge in the final task.
- Uppercase micro-label idiom, everywhere: `text-2xs font-semibold uppercase tracking-caps text-ink-3`.
- Every numeric cell gets `tabular-nums`; every *money* cell also gets `slashed-zero`.

```bash
git checkout -b feat/linear-dashboard-redesign
```

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/web/styles.css` | rewrite (Task 1) | token ramps (both themes), alias layer, non-colour tokens, global focus ring, scrollbars, all keyframes + `.am-anim` gates, `.am-check` reveal, `dialog::backdrop`, view-transition timing |
| `tailwind.config.js` | rewrite (Task 1); trimmed again (Task 9) | colour names → `hsl(var(--x) / <alpha-value>)`, rem type scale, `tracking-caps`, `border-hairline`, `spacing.rail`, `max-w-board/page`, shadows (`pop`; `card` dropped once `ActivityFeed`, its last consumer, migrates in Task 9), motion timing |
| `src/web/components/StatusGlyph.tsx` | **new** (Task 2) | the five-shape SVG status glyph family + `GlyphKind` |
| `src/web/components/primitives.tsx` | **new** (Task 2) | `Rail`, `ROW_BASE`, `ROW_TONE`, `ListRow`, `SectionHeader`, `Chevron`, `Chip`, `MeterRow`, `Segmented`, `PageHeader` |
| `src/web/components/AppBar.tsx` | rewrite (Task 3) | 3rem status rail: brand, three counts, ghost controls |
| `src/web/components/Board.tsx` | rewrite (Task 4) | page container, two-column grid, section order, degraded banner |
| `src/web/components/Lane.tsx` | rewrite (Task 4) | `Lane` section wrapper + `Column` sticky group header |
| `src/web/components/SessionCard.tsx` | rewrite (Task 5) | session row (two-line working/needs-you, one-line idle) |
| `src/web/components/TodosSection.tsx` | rewrite (Task 6) | todos section header + capped scroller |
| `src/web/components/TodoCard.tsx` | rewrite (Task 6) | todo row with rail checkbox + hover-revealed delete |
| `src/web/components/TodoModal.tsx` | rewrite (Task 7) | todo detail dialog |
| `src/web/components/DoneDialog.tsx` | rewrite (Task 7) | done-todos dialog + pager |
| `src/web/workflowStatus.ts` | modify (Task 8) | `WF_STATUS_CLASS` recolour + new `WF_STATUS_GLYPH`/`statusGlyphKind` |
| `src/web/components/WorkflowsSection.tsx` | rewrite (Task 8) | live-run section header + capped scroller |
| `src/web/components/WorkflowRunCard.tsx` | rewrite (Task 8) | workflow run row + phase bar + agent sub-rows |
| `src/web/components/ToolStats.tsx` | rewrite (Task 9) | tool-usage meter panel |
| `src/web/components/CostPanel.tsx` | rewrite (Task 9) | 2-up cost readout + per-model rows |
| `src/web/components/CostBreakdown.tsx` | rewrite (Task 9) | by-project / by-branch meter panel |
| `src/web/components/ActivityFeed.tsx` | rewrite (Task 9) | live activity lines + bottom fade |
| `src/web/components/CostDailyPage.tsx` | rewrite (Task 10) | `#/cost` page header + table |
| `src/web/components/WorkflowsPage.tsx` | rewrite (Task 10) | `#/workflows` page header + table + expanded detail |

New test files: `web-tests/StatusGlyph.test.tsx`, `web-tests/primitives.test.tsx`, `web-tests/motion-gating.test.ts`, `web-tests/workflowStatus.test.ts`.

---

## Task dependency map

| Task | Deliverable | Depends on | Parallel-safe with |
|---|---|---|---|
| 0 | test-id retrofit + selector re-points (no styling) | — | nothing (must be first) |
| 1 | tokens + Tailwind config + `styles.css` | 0 | nothing |
| 2 | `StatusGlyph` + `primitives` + motion-gate fix | 1 | nothing |
| 3 | `AppBar` | 2 | 4, 5, 6, 7, 8, 9 |
| 4 | `Board` + `Lane`/`Column` + banner | 2 (and 0 for the `dot` narrowing) | 3, 5, 6, 7, 8, 9 |
| 5 | `SessionCard` | 2 | 3, 4, 6, 7, 8, 9 |
| 6 | `TodosSection` + `TodoCard` | 2 | 3, 4, 5, 7, 8, 9 |
| 7 | `TodoModal` + `DoneDialog` | 2 | 3, 4, 5, 6, 8, 9 |
| 8 | `WorkflowsSection` + `WorkflowRunCard` + `workflowStatus.ts` | 2 | 3, 4, 5, 6, 7, 9 |
| 9 | `ToolStats` + `CostPanel` + `CostBreakdown` + `ActivityFeed` | 2 | 3, 4, 5, 6, 7, 8 |
| 10 | `CostDailyPage` + `WorkflowsPage` | 2 **and 8** (`statusGlyphKind` lives in `workflowStatus.ts`) | — |
| 11 **(ops)** | real-browser verification, both themes, ladder extremes | 3–10 all merged | nothing |
| 12 **(ops)** | full suite + acceptance greps + build + service restart + merge | 11 | nothing |

**Strictly sequential:** 0 → 1 → 2 → {3…9} → 10 → 11 → 12.
**Independent of each other:** 3, 4, 5, 6, 7, 8, 9 — each touches a disjoint file set and each ends with the full suite green. They may be dispatched in parallel to separate subagents; if so, rebase each on the previous merge before running its verification, because they all share `styles.css`'s output surface (not its source).

Tasks marked **(ops)** drive a real browser and the live systemd service. They are not code changes and cannot be delegated to a subagent that only runs tests.

---

## Task 0: `data-testid` retrofit + selector re-points — **no styling change** (§6.1)

The suite has **86 `getByText` / 18 `findByText` calls and exactly one `data-testid`**. Almost nothing is insulated from markup change, and that is the dominant risk in the whole redesign. This task buys the insulation *before* anything moves.

**Rule: test-ids are additive.** Every existing text / `aria-label` / `title` selector must still work when this task is done. Only the four *structural* selectors are migrated.

**Files:**
- Modify: `src/web/components/AppBar.tsx` (the `Count` component, lines 6-13 and its three call sites, lines 33-35)
- Modify: `src/web/components/Lane.tsx` (`Column`, lines 3-26 — includes the D6 `dot` narrowing)
- Modify: `src/web/components/Board.tsx` (`SESSION_COLS`, lines 13-17)
- Modify: `src/web/components/SessionCard.tsx` (root `<div>` line 33; wf badge line 40)
- Modify: `src/web/components/TodosSection.tsx` (scroller line 40; Done button lines 48-54)
- Modify: `src/web/components/TodoCard.tsx` (note element line 44)
- Modify: `src/web/components/CostPanel.tsx` (the two value spans, lines 21 and 25)
- Modify: `src/web/components/WorkflowRunCard.tsx` (root `<div>` line 19)
- Modify: `src/web/components/WorkflowsPage.tsx` (data `<tr>` line 181)
- Modify: `src/web/components/CostDailyPage.tsx` (data `<tr>` line 122)
- Test: `web-tests/TodosSection.test.tsx` (2 re-points), `web-tests/TodoCard.test.tsx` (1), `web-tests/WorkflowsPage.test.tsx` (1), `web-tests/CostDailyPage.test.tsx` (1)

**Interfaces:**
- Produces the following test-ids, which every later task must preserve:
  `appbar-count-working`, `appbar-count-needs-you`, `appbar-count-todo`,
  `session-group-working` / `session-group-needs_you` / `session-group-idle`,
  `session-row` (+ `data-status={s.status}`), `wf-badge`,
  `todos-scroller`, `todos-done-link`, `note`,
  `cost-today`, `cost-live-total`, `wf-run-row`, `wf-row`, `cost-row`.
  `wf-totals` already exists — **do not touch it**.
- Produces the D6 narrowing: `Column(title: string, count: number, dot: Session["status"], children: ReactNode)`. Name and arity unchanged (K16). `Lane.tsx` is imported by `Board.tsx` only and by no test — verified.

- [ ] **Step 1: Record the green baseline**

Run: `npx vitest run`
Expected: `Test Files 23 passed (23)`, `Tests 111 passed (111)`. If it is not green, stop — nothing below is meaningful against a red baseline.

- [ ] **Step 2: Re-point the four structural selectors (they will fail)**

In `web-tests/TodosSection.test.tsx`, replace lines 26-31 with:

```tsx
  it("caps the open list height with an inner scroll so the board stays visible", () => {
    render(<TodosSection todos={todos} />);
    const scroller = screen.getByTestId("todos-scroller");
    expect(scroller.className).toContain("max-h-[40vh]");
    expect(scroller.className).toContain("overflow-y-auto");
    // The row title must stay INSIDE the capped scroller, not beside it.
    expect(scroller.contains(screen.getByText("open1"))).toBe(true);
  });
```

and in the same file replace line 42 with:

```tsx
    fireEvent.click(screen.getByTestId("todos-done-link"));
```

(Line 23's `expect(screen.getByText(/Done \(1\)/)).toBeDefined()` **stays** — the copy assertion is the contract; only the *click* is re-pointed.)

In `web-tests/TodoCard.test.tsx`, replace line 52 with:

```tsx
    expect(screen.getByTestId("note").className).toContain("line-clamp-1");
```

In `web-tests/WorkflowsPage.test.tsx`, replace lines 76-77 with:

```tsx
    const rows = screen.getAllByTestId("wf-row");
    expect(within(rows[0]).getByText("$9.00")).toBeTruthy(); // wf_b (9.0) first
```

In `web-tests/CostDailyPage.test.tsx`, replace lines 35-36 with:

```tsx
    const rows = screen.getAllByTestId("cost-row"); // data rows only, no header
    expect(within(rows[0]).getByText("$9.00")).toBeTruthy(); // beta (9.0) now first
```

- [ ] **Step 3: Run the four files to verify they fail**

Run: `npx vitest run web-tests/TodosSection.test.tsx web-tests/TodoCard.test.tsx web-tests/WorkflowsPage.test.tsx web-tests/CostDailyPage.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="todos-scroller"]` and three more of the same shape.

- [ ] **Step 4: Add the attributes — attributes only, no class edits**

`src/web/components/AppBar.tsx` — give `Count` a `testId` prop and pass it at all three call sites:

```tsx
function Count({ testId, dotClass, label, n }: { testId: string; dotClass: string; label: string; n: number }) {
  return (
    <span
      data-testid={testId}
      className="am-count inline-flex items-center gap-2 rounded-full border border-border bg-chip px-2.5 py-1 text-xs text-muted-foreground"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      <span>{n} {label}</span>
    </span>
  );
}
```
```tsx
        <Count key={`w-${working}`} testId="appbar-count-working" dotClass="bg-working" label="working" n={working} />
        <Count key={`n-${needsYou}`} testId="appbar-count-needs-you" dotClass="bg-attention" label="needs you" n={needsYou} />
        <Count key={`t-${todoCount}`} testId="appbar-count-todo" dotClass="bg-attention" label="to do" n={todoCount} />
```

`src/web/components/Lane.tsx` — `Column` only (leave `Lane` alone). The `DOT_CLASS` map reproduces today's exact strings, so **not one rendered class changes**:

```tsx
import type { ReactNode } from "react";
import type { Session } from "../types.ts";

/** Maps the status to the dot class this column used to be handed directly.
 *  The narrowing (string → Session["status"]) is what lets the wrapper carry a
 *  status-keyed test id without adding a 5th prop (K16). */
const DOT_CLASS: Record<Session["status"], string> = {
  working: "bg-working",
  needs_you: "bg-attention",
  idle: "bg-idle",
  ended: "bg-idle",
};

export function Column({
  title,
  count,
  dot,
  children,
}: {
  title: string;
  count: number;
  dot: Session["status"];
  children: ReactNode;
}) {
  return (
    <div data-testid={`session-group-${dot}`} className="rounded-xl border border-border bg-card/50 p-2.5">
      <div className="mb-2 flex items-center justify-between px-1 py-0.5">
        <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${DOT_CLASS[dot] ?? "bg-idle"}`} />
          {title}
        </span>
        <span className="rounded-full bg-chip px-2 py-0.5 text-2xs text-muted-foreground">{count}</span>
      </div>
      {children}
    </div>
  );
}
```

`src/web/components/Board.tsx` — `SESSION_COLS` loses its now-duplicated `dot` field, and the `<Column>` call passes `c.id`:

```tsx
const SESSION_COLS: { id: Session["status"]; title: string }[] = [
  { id: "working", title: "Working" },
  { id: "needs_you", title: "Needs you" },
  { id: "idle", title: "Idle / done" },
];
```
```tsx
                <Column key={c.id} title={c.title} dot={c.id} count={items.length}>
```

(The **order stays `working, needs_you, idle`** here. Reordering is Task 4's job and Task 4's test.)

`src/web/components/SessionCard.tsx` — root `<div>` (line 33) and the wf badge (line 40):

```tsx
    <div
      data-testid="session-row"
      data-status={s.status}
      className="am-fade-in mb-2 rounded-lg border border-border bg-card p-3 shadow-card transition hover:bg-card-hover hover:shadow-card-hover"
      style={cardStyle}
    >
```
```tsx
          <span
            data-testid="wf-badge"
            title="owns a live workflow run"
            className="rounded-full border border-border bg-chip px-1.5 py-0.5 font-mono text-2xs text-working"
          >
```

`src/web/components/TodosSection.tsx` — scroller and Done button:

```tsx
            <div data-testid="todos-scroller" className="max-h-[40vh] overflow-y-auto pr-1">
```
```tsx
          <button
            type="button"
            data-testid="todos-done-link"
            onClick={() => setDoneOpen(true)}
            className="mt-1 text-2xs font-semibold text-muted-foreground transition hover:text-foreground"
          >
```

`src/web/components/TodoCard.tsx` — the note element:

```tsx
      {t.note && (
        <div data-testid="note" className="mt-1 line-clamp-1 text-xs text-muted-foreground">
          {t.note}
        </div>
      )}
```

`src/web/components/CostPanel.tsx` — the two value spans:

```tsx
          <span data-testid="cost-live-total" className="tabular-nums text-muted-foreground">{formatUsd(cost.liveTotalUsd)}</span>
```
```tsx
          <span data-testid="cost-today" className="tabular-nums text-muted-foreground">{formatUsd(cost.todayUsd)}</span>
```

`src/web/components/WorkflowRunCard.tsx` — root `<div>`:

```tsx
    <div data-testid="wf-run-row" className="am-fade-in mb-2 rounded-lg border border-border bg-card p-3 shadow-card">
```

`src/web/components/WorkflowsPage.tsx` — the **data** `<tr>` only (line 181). The expanded-detail `<tr>` and the totals `<tr>` get nothing:

```tsx
                <tr
                  key={r.run_id}
                  data-testid="wf-row"
                  onClick={() => toggleOpen(r.run_id)}
                  className="cursor-pointer border-b border-border/50 hover:bg-card-hover"
                >
```

`src/web/components/CostDailyPage.tsx` — the data `<tr>` (line 122):

```tsx
              <tr key={`${r.project}/${r.branch ?? ""}/${r.day}`} data-testid="cost-row" className="border-b border-border/50">
```

- [ ] **Step 5: Run the whole suite to verify it is green again**

Run: `npx vitest run && bun run typecheck`
Expected: `Test Files 23 passed (23)`, `Tests 111 passed (111)`; typecheck clean.

If any test **other than** the four re-pointed ones changed behaviour, an attribute edit accidentally touched markup — revert and redo that file.

- [ ] **Step 6: Prove no styling moved**

Six of the attribute inserts land on a **single existing line** (`TodosSection`
scroller, `TodoCard` note, both `CostPanel` values, the `WorkflowRunCard` root,
the `CostDailyPage` `<tr>`), so each one's `className` necessarily appears on
*both* sides of the diff. The check is therefore **not** "no `className`
appears" — it is "every class string that leaves comes back verbatim":

```bash
DIFF=$(git diff -U0 src/web/)
printf '%s\n' "$DIFF" | grep -E '^-[^-]' | grep -oE 'className="[^"]*"' | sort > /tmp/am-cls-before
printf '%s\n' "$DIFF" | grep -E '^\+[^+]' | grep -oE 'className="[^"]*"' | sort > /tmp/am-cls-after
diff /tmp/am-cls-before /tmp/am-cls-after && echo "CLASS STRINGS UNCHANGED"
```

(`^-[^-]` / `^\+[^+]` rather than `^-` + a `^---` filter: this shell's `grep` is
`ugrep`, which rejects `\+` in a BRE pattern. Verified working here.)

Expected: `CLASS STRINGS UNCHANGED`. A one-sided line means a class was *edited*,
not merely moved — revert that file and redo it.

`Lane.tsx`'s dot class is a **template literal**, so it is deliberately outside
that regex. Read it by eye instead: `${dot}` → `${DOT_CLASS[dot] ?? "bg-idle"}`
must resolve to the identical string for all four `Session["status"]` values
(`bg-working`, `bg-attention`, `bg-idle`, `bg-idle`).

Then confirm nothing else structural moved:

Run: `git diff -U0 src/web/ | grep -E "^[+-]" | grep -v "^[+-][+-]" | grep -vE "data-testid|data-status|testId|DOT_CLASS|dot:|dot=|Session\[|import type \{ Session|className|^\+\s*$" | cat`
Expected: only the `Count` signature line, the three `Count` call sites, the `Column` signature/props lines and the `SESSION_COLS` type line.

- [ ] **Step 7: Commit**

```bash
git add src/web/components web-tests
git commit -m "test(web): retrofit data-testids and re-point the 4 structural selectors

No styling change. Insulates the suite before the Linear redesign moves any
markup: 15 additive test ids, plus Column.dot narrowed to Session[\"status\"]
so the group wrapper can carry a status-keyed id without a 5th prop (K16).
Every existing text/aria-label/title selector still works."
```

---

## Task 1: token layer — `styles.css` + `tailwind.config.js` (§1.1–§1.5, §5.2)

The **alias layer is what makes this safe**: every legacy token name (`--background`, `--card`, `--muted-foreground`, `--border`, `--primary`, …) survives as an alias pointing at a primitive, so every component still renders correctly with its *current* class names. Nothing in `src/web/components/` changes in this task, and the suite is green by construction (Vitest runs jsdom with no CSS pipeline).

**Files:**
- Rewrite: `src/web/styles.css` (whole file, 116 lines → the content below)
- Rewrite: `tailwind.config.js` (whole file)

**Interfaces:**
- Produces these Tailwind colour names for later tasks: `surface-0..3`, `ink` / `ink-2` / `ink-3` / `ink-4`, `border` / `border-weak` / `border-strong`, `accent` / `accent-hover` / `accent-tint`, `working`, `attention`, `done`, `idle`, `danger`, `bar`, plus the surviving legacy names `background`, `foreground`, `chip`, `primary`, `card`, `card-hover`, `muted`, `muted-foreground`.
- Produces these utilities: `text-3xs`/`text-2xs`/`text-xs`/`text-sm`/`text-base`/`text-lg`/`text-xl`, `tracking-caps`/`tracking-tight`/`tracking-tighter`, `border-hairline` (+ `border-b-hairline`, `border-l-hairline`), `w-rail`/`pl-rail`/`left-rail`, `max-w-board`/`max-w-page`, `shadow-card`/`shadow-pop`, `ease-quad`/`ease-move`, `duration-quick`/`duration-base`/`duration-pop`/`duration-move`.
- Produces these CSS classes for later tasks: `.am-row-in`, `.am-fade-in`, `.am-count`, `.am-spin`, `.am-pulse`, `.am-ping`, `.am-shimmer`, `.am-check`, `[data-press]`.

**Two deliberate deviations from the spec's snippets, both load-bearing:**
1. **`--radius-1..4` are dropped** (they were px and would not scale with the ladder — a K4 violation). Tailwind's stock radii are rem and already on the 4px grid, so `rounded-sm`/`rounded`/`rounded-md`/`rounded-xl`/`rounded-full` are used directly per §1.5's map.
2. **`fontWeight.medium` is NOT overridden to `510`.** Verified on this machine: no Inter is installed, `fc-match sans-serif` → FreeSans (Regular + Bold only), and CSS weight matching for a requested weight **> 500** searches *upward* — `510` would render every `font-medium` row title **bold**. Only `semibold: 590` and `bold: 680` are set. (R13)

- [ ] **Step 1: Write `src/web/styles.css`**

Replace the entire file with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {                          /* LIGHT */
  color-scheme: light;

  /* surfaces — 4 steps, each a few L* apart */
  --surface-0: 0 0% 100%;        /* #ffffff  canvas */
  --surface-1: 220 24% 98.5%;    /* #fbfcfe  panel: dialogs, totals row, expanded rows */
  --surface-2: 220 20% 96%;      /* #f2f4f8  hover / selected */
  --surface-3: 220 18% 93%;      /* #e9ecf2  chips, controls, meter bars */

  /* lines */
  --border-1:      220 16% 88%;  /* #dce0e8  default edge */
  --border-weak:   220 18% 93%;  /* #e9ecf2  dividers inside a panel */
  --border-strong: 220 14% 80%;  /* #c5cad4  control edges */

  /* ink — 4 steps: title / body / meta / disabled */
  --text-1: 222 32% 11%;         /* #131826 */
  --text-2: 220 18% 26%;         /* #373e4b */
  --text-3: 220 10% 40%;         /* #5c6470 */
  --text-4: 220 10% 50%;         /* #727a86 */

  /* accent — one, restrained */
  --accent:       264 72% 54%;   /* #6d3ee0 */
  --accent-hover: 264 72% 46%;
  --accent-tint:  264 70% 96%;   /* reserved for a future selected/flash surface;
                                    `am-flash` uses hsl(var(--accent)/.10) directly */

  /* semantic status */
  --working:   212 88% 44%;      /* #0d69d3 */
  --attention:  30 92% 36%;      /* #b05e07 */
  --done:      154 62% 30%;      /* #1d7b4f */
  --idle:      220 10% 58%;
  --danger:    358 68% 48%;      /* #cf2a3a — closes the raw red-400 gap */

  --shadow: 222 32% 28%;
  --shadow-a: 0.10;
}

html.dark {                      /* DARK — the reference design */
  color-scheme: dark;

  --surface-0: 220 14% 4%;       /* #08090b */
  --surface-1: 220 12% 6.5%;     /* #0e1013 */
  --surface-2: 220 11% 9.5%;     /* #14171b */
  --surface-3: 220 10% 13%;      /* #1d2026 */

  --border-1:      220 10% 17%;  /* #272b31 */
  --border-weak:   220 10% 12%;  /* #1b1e22 */
  --border-strong: 220  9% 25%;  /* #3a3f47 */

  --text-1: 210 20% 97%;         /* #f5f7f9 — never pure white */
  --text-2: 214 15% 84%;         /* #ced4dc */
  --text-3: 218 10% 60%;         /* #8e949e */
  --text-4: 220  9% 42%;         /* #626873 */

  --accent:       265 78% 68%;   /* #9d84f6 */
  --accent-hover: 265 92% 78%;   /* #b9a4ff */
  --accent-tint:  265 40% 12%;   /* #191430 */

  --working:   211 92% 64%;      /* #4da2fa */
  --attention:  35 96% 62%;      /* #fcac3d */
  --done:      152 62% 50%;      /* #31cd83 */
  --idle:      220  9% 44%;
  --danger:    358 78% 66%;      /* #f4626c */

  --shadow: 0 0% 0%;
  --shadow-a: 0.55;
}

/* Alias layer — PERMANENT, not a migration scaffold. `toolDot()` returns
   `bg-primary` (K17) and `body { @apply bg-background text-foreground }` stays,
   so these names have live consumers forever. Both `:root` and `html.dark`
   select <html>; the aliases never set the same property as a theme block, so
   cascade order is irrelevant — this sits after both for readability. */
:root, html.dark {
  --background:       var(--surface-0);
  --card:             var(--surface-1);
  --card-hover:       var(--surface-2);
  --muted:            var(--surface-3);
  --chip:             var(--surface-3);
  --foreground:       var(--text-1);
  --muted-foreground: var(--text-3);
  --border:           var(--border-1);
  --primary:          var(--accent);

  --bar:        var(--surface-3);
  --focus-ring: var(--accent);
}

:root {
  --font-sans: "Inter Variable","Inter",ui-sans-serif,system-ui,-apple-system,
               "Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --font-mono: "Berkeley Mono",ui-monospace,"SF Mono","JetBrains Mono",
               "Cascadia Code",Menlo,Consolas,"Liberation Mono",monospace;

  --rail: 1.25rem;        /* THE glyph rail — every list's leading slot */
  --glyph: 0.875rem;      /* 14px status glyph — documents the value behind
                             StatusGlyph's `h-3.5 w-3.5` and its 14×14 fallback
                             width/height attributes */
  --hairline: 1px;

  --ease:      cubic-bezier(.25,.46,.45,.94);  /* ease-out-quad — the workhorse */
  --ease-move: cubic-bezier(.16,1,.3,1);       /* view transitions only */
  --t-quick: 100ms;  /* hover: bg/border/color */
  --t-base:  160ms;  /* controls, press, entrances */
  --t-pop:   175ms;  /* dialogs, menus */
  --t-move:  280ms;  /* view transitions */
}
@media (min-resolution: 2dppx) { :root { --hairline: 0.5px; } }

:root { font-family: var(--font-sans); font-feature-settings: "cv01","ss03"; }

body {
  @apply bg-background text-foreground antialiased;
}

/* One global ring, replacing the two ad-hoc focus-visible rings in TodoCard.
   No `border-radius` here: setting one would visibly re-shape rounded-full
   pills on focus, and both Chromium and Firefox already draw `outline`
   following the element's own border-radius. */
:where(a,button,select,summary,input,[tabindex]):focus-visible {
  outline: 2px solid hsl(var(--focus-ring) / .75);
  outline-offset: 2px;
}

/* thumb-only scrollbars for the three inner scrollers */
* { scrollbar-width: thin; scrollbar-color: hsl(var(--text-4)/.30) transparent; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: hsl(var(--text-4)/.28); border-radius: 999px;
  border: 2px solid transparent; background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background-color: hsl(var(--text-4)/.5); }

/* Theme-aware dialog backdrop (replaces the `backdrop:bg-black/50` utility). */
dialog::backdrop { background: hsl(var(--surface-0) / .6); backdrop-filter: blur(3px); }

/* The <StatusGlyph kind="todo"> check reveals on hover/focus of its button.
   One rule, no per-component plumbing. */
.am-check [data-glyph-check] { transition: opacity var(--t-quick) var(--ease); }
.am-check:hover [data-glyph-check],
.am-check:focus-visible [data-glyph-check] { opacity: 1; }

/* --- motion --- */
@keyframes am-row-in  { from { opacity:0; transform:translateY(-4px) } to { opacity:1; transform:none } }
@keyframes am-flash   { from { background-color: hsl(var(--accent)/.10) } to { background-color: transparent } }
@keyframes am-fade-in { from { opacity:0; transform:translateY(4px) }  to { opacity:1; transform:none } }
@keyframes am-pop     { from { opacity:0; transform:scale(.96) }       to { opacity:1; transform:none } }
@keyframes am-backdrop{ from { opacity:0 } to { opacity:1 } }
@keyframes am-count   { 0% { transform:scale(1.06) } 100% { transform:scale(1) } }
@keyframes am-shimmer { from { transform:translateX(-100%) } to { transform:translateX(100%) } }
@keyframes am-spin    { to { transform: rotate(360deg) } }
@keyframes am-pulse   { 0%,100% { opacity:1 } 50% { opacity:.45 } }
@keyframes am-ping    { from { transform:scale(1); opacity:1 } to { transform:scale(2.2); opacity:0 } }

/* All motion is gated behind `html.am-anim` (the Motion toggle, default on),
   which intentionally overrides the OS prefers-reduced-motion setting for this
   single-user dashboard. Toggle it off to disable everything below. */

.am-anim .am-row-in  { animation: am-row-in var(--t-base) var(--ease) both,
                                  am-flash .6s var(--ease); }
.am-anim .am-fade-in { animation: am-fade-in var(--t-base) var(--ease) both; }
.am-anim .am-count   { animation: am-count var(--t-base) var(--ease); }

.am-anim dialog[open]           { animation: am-pop var(--t-pop) var(--ease); }
.am-anim dialog[open]::backdrop { animation: am-backdrop var(--t-pop) var(--ease); }

/* These three replace Tailwind's animate-spin / animate-pulse / animate-ping,
   which carry NO `.am-anim` ancestor requirement and therefore ignored the
   Motion toggle entirely. */
.am-anim .am-spin  { animation: am-spin 1.4s linear infinite; }
.am-anim .am-pulse { animation: am-pulse 2s var(--ease) infinite; }
.am-anim .am-ping  { animation: am-ping 1.8s var(--ease) infinite; }

/* NB: no `position: relative` here. The shimmer element is itself `absolute`
   (so it is already a containing block for ::after), and this file's plain
   rules are emitted *after* `@tailwind utilities` — at equal specificity a bare
   `.am-shimmer { position: relative }` would beat Tailwind's `.absolute` and
   pull the underline out of the row's bottom edge. */
.am-shimmer { overflow: hidden; }
.am-anim .am-shimmer::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, hsl(var(--working)/.45), transparent);
  animation: am-shimmer 2s ease-in-out infinite;
}

.am-anim [data-press]:active {
  transform: scale(.97); filter: brightness(.98);
  transition: transform var(--t-base) var(--ease), filter var(--t-base) var(--ease);
}

/* View Transitions: glide rows between positions instead of jumping. Don't
   cross-fade the whole page. (These only ever run when a transition is
   started, which is gated on am-anim in JS.) */
::view-transition-group(*) {
  animation-duration: var(--t-move);
  animation-timing-function: var(--ease-move);
}
::view-transition-old(root), ::view-transition-new(root) { animation: none; }
```

- [ ] **Step 2: Write `tailwind.config.js`**

Replace the entire file with:

```js
export default {
  darkMode: "class",
  content: ["./src/web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        /* legacy names — unchanged spelling, now backed by the ramp */
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        chip:       "hsl(var(--chip) / <alpha-value>)",
        primary:    "hsl(var(--primary) / <alpha-value>)",
        card: { DEFAULT: "hsl(var(--card) / <alpha-value>)",
                hover:   "hsl(var(--card-hover) / <alpha-value>)" },
        muted:{ DEFAULT: "hsl(var(--muted) / <alpha-value>)",
                foreground: "hsl(var(--muted-foreground) / <alpha-value>)" },
        working:   "hsl(var(--working) / <alpha-value>)",
        attention: "hsl(var(--attention) / <alpha-value>)",
        done:      "hsl(var(--done) / <alpha-value>)",
        idle:      "hsl(var(--idle) / <alpha-value>)",

        /* new */
        danger: "hsl(var(--danger) / <alpha-value>)",
        accent: { DEFAULT: "hsl(var(--accent) / <alpha-value>)",
                  hover:   "hsl(var(--accent-hover) / <alpha-value>)",
                  tint:    "hsl(var(--accent-tint) / <alpha-value>)" },
        surface:{ 0: "hsl(var(--surface-0) / <alpha-value>)",
                  1: "hsl(var(--surface-1) / <alpha-value>)",
                  2: "hsl(var(--surface-2) / <alpha-value>)",
                  3: "hsl(var(--surface-3) / <alpha-value>)" },
        ink:    { DEFAULT: "hsl(var(--text-1) / <alpha-value>)",
                  2: "hsl(var(--text-2) / <alpha-value>)",
                  3: "hsl(var(--text-3) / <alpha-value>)",
                  4: "hsl(var(--text-4) / <alpha-value>)" },
        border: { DEFAULT: "hsl(var(--border-1) / <alpha-value>)",
                  weak:   "hsl(var(--border-weak) / <alpha-value>)",
                  strong: "hsl(var(--border-strong) / <alpha-value>)" },
        bar: "hsl(var(--bar) / <alpha-value>)",
      },
      fontFamily: { sans: ["var(--font-sans)"], mono: ["var(--font-mono)"] },

      /* ALL rem — the [14,16,18,20,22] ladder keeps scaling everything */
      fontSize: {
        "3xs": ["0.625rem",  { lineHeight: "1.40" }],                            /* 10 */
        "2xs": ["0.6875rem", { lineHeight: "1.45" }],                            /* 11 */
        xs:    ["0.75rem",   { lineHeight: "1.50" }],                            /* 12 */
        sm:    ["0.8125rem", { lineHeight: "1.45" }],                            /* 13 ← was 14 */
        base:  ["0.9375rem", { lineHeight: "1.45", letterSpacing: "-0.011em" }], /* 15 ← was 16 */
        lg:    ["1.125rem",  { lineHeight: "1.35", letterSpacing: "-0.016em" }], /* 18 */
        xl:    ["1.3125rem", { lineHeight: "1.30", letterSpacing: "-0.020em" }], /* 21 */
      },
      /* `medium` is deliberately NOT overridden to 510: no Inter is installed,
         the fallback (FreeSans) ships Regular+Bold only, and CSS weight
         matching for >500 searches upward — 510 would render bold. (R13) */
      fontWeight: { semibold: "590", bold: "680" },
      letterSpacing: { caps: "0.055em", tight: "-0.011em", tighter: "-0.018em" },
      borderWidth: { hairline: "var(--hairline)" },
      spacing: { rail: "var(--rail)" },
      maxWidth: { board: "86rem", page: "64rem" },
      boxShadow: {
        card: "0 1px 1px hsl(var(--shadow) / calc(var(--shadow-a) * .5))",
        pop:  "0 8px 32px hsl(var(--shadow) / var(--shadow-a)), 0 1px 2px hsl(var(--shadow) / calc(var(--shadow-a) * .6))",
      },
      transitionTimingFunction: { quad: "var(--ease)", move: "var(--ease-move)" },
      transitionDuration: { quick: "100ms", base: "160ms", pop: "175ms", move: "280ms" },
    },
  },
  plugins: [],
};
```

- [ ] **Step 3: Verify the suite is still green and the build still works**

Run: `npx vitest run && bun run typecheck && bun run web:build`
Expected: 23 files / 111 tests pass; typecheck clean; `vite build` succeeds and writes `dist/web/`.

(The suite is green by construction — Vitest uses jsdom with no CSS pipeline. The *real* check is the build plus Step 4.)

- [ ] **Step 4: Verify the alias layer actually resolves**

```bash
CSS=$(ls dist/web/assets/*.css | head -1)
grep -c -- "--surface-0" "$CSS"
grep -oE -- "--background: ?var\(--surface-0\)" "$CSS"
grep -oE -- "--primary: ?var\(--accent\)" "$CSS"
grep -c -- "am-spin" "$CSS"
```
Expected: the `--surface-0` count is ≥ 2 (light + dark), both alias lines print, and `am-spin` is present. (The ` ?` is deliberate — whether the minifier keeps the space after `:` is not something this check should depend on.) If `--background: var(--surface-0)` is missing, the alias block was dropped and **every existing component has just lost its colours**.

- [ ] **Step 5: Eyeball it once before moving on**

```bash
bun run web:dev
```
Open `http://127.0.0.1:5317`. The app must look *approximately* like it did before — same layout, same cards — but on the new ramp (deeper dark background, cooler light surfaces). It must not be unstyled, and no element may be invisible-on-invisible. This is the only moment in the plan where "looks basically the same" is the correct outcome. Stop the dev server afterwards.

**One expected, deliberate regression at this commit:** the config drops the `card-hover` shadow token (§1.9), while `SessionCard`/`TodoCard` still carry `hover:shadow-card-hover` until Tasks 5 and 6. Tailwind simply emits no rule for an unknown token, so those two rows lose their hover shadow for a few commits. That is the intended end state arriving early — **not** a failure of this step. Nothing else may change shape. `card` is left defined here, unlike `card-hover` — it still has live consumers (`TodoModal`, `DoneDialog`, `WorkflowRunCard`, `ActivityFeed`) that this step does not touch; it comes out in Task 9 once `ActivityFeed`, its last consumer, migrates.

- [ ] **Step 6: Commit**

```bash
git add src/web/styles.css tailwind.config.js
git commit -m "feat(web): Linear token ramp + alias layer, rem type scale, retuned motion

Four-step surface/ink ramps in both themes, a --danger token, the 20px --rail,
ease-out-quad timings and .am-spin/.am-pulse/.am-ping (the gated replacements
for the three Tailwind animate-* utilities that ignore the Motion toggle).

Every legacy token name survives as an alias onto a primitive, so every
component still renders correctly with its current classes — that is what lets
the rest of the redesign land one component per commit."
```

---

## Task 2: `StatusGlyph` + `primitives` + the Motion-toggle gating fix (§2, §3.3, §5.3)

Two new files carrying every shared idiom, plus the one honest fidelity fix in the redesign: three stock Tailwind animations currently **ignore the Motion toggle** because `animate-*` classes carry no `.am-anim` ancestor requirement. They become `am-*` here. The swaps are one-line class renames with identical visual output while motion is on — they belong in this task because the permanent grep-guard test lands with them.

**Files:**
- Create: `src/web/components/StatusGlyph.tsx`
- Create: `src/web/components/primitives.tsx`
- Modify: `src/web/components/SessionCard.tsx:52` (`animate-pulse` → `am-pulse`) and `:65` (`animate-spin` → `am-spin`)
- Modify: `src/web/components/WorkflowRunCard.tsx:8` (`AGENT_DOT.running`)
- Modify: `src/web/components/ActivityFeed.tsx:16` (`animate-ping` → `am-ping`)
- Create: `web-tests/StatusGlyph.test.tsx`
- Create: `web-tests/primitives.test.tsx`
- Create: `web-tests/motion-gating.test.ts`

**Interfaces — this block is how every later task learns the names:**

```tsx
// src/web/components/StatusGlyph.tsx
export type GlyphKind = "working" | "needs_you" | "idle" | "ended" | "todo" | "danger";
export function StatusGlyph(props: { kind: GlyphKind; animate?: boolean; className?: string }): JSX.Element;

// src/web/components/primitives.tsx
export function Rail(props: { children?: ReactNode }): JSX.Element;
export const ROW_BASE: string;
export type RowTone = "default" | "attention";
export const ROW_TONE: Record<RowTone, string>;
export function ListRow(props: HTMLAttributes<HTMLDivElement> & DataAttrs & { tone?: RowTone }): JSX.Element;
export function Chevron(props: { open: boolean }): JSX.Element;
export function SectionHeader(props: {
  label: string; leading?: ReactNode; right?: ReactNode; onToggle?: () => void; collapsed?: boolean;
}): JSX.Element;
export function Chip(props: {
  tone?: "neutral" | "working"; round?: boolean; size?: "3xs" | "2xs";
  className?: string; title?: string; children: ReactNode;
} & DataAttrs): JSX.Element;
export function MeterRow(props: {
  frac: number; leading?: ReactNode; label: string; a: ReactNode; b: ReactNode;
}): JSX.Element;
export function Segmented<T extends string | number>(props: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}): JSX.Element;
export function PageHeader(props: { title: string; right?: ReactNode }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

Create `web-tests/StatusGlyph.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusGlyph, type GlyphKind } from "../src/web/components/StatusGlyph.tsx";

const svgOf = (kind: GlyphKind, animate?: boolean) =>
  render(<StatusGlyph kind={kind} animate={animate} />).container.querySelector("svg")!;

describe("StatusGlyph", () => {
  it("renders one aria-hidden svg per kind, tagged with the kind", () => {
    for (const k of ["working", "needs_you", "idle", "ended", "todo", "danger"] as GlyphKind[]) {
      const svg = svgOf(k);
      expect(svg).toBeTruthy();
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("data-glyph")).toBe(k);
      // The glyph is never the accessible name; textual status lives elsewhere.
      expect(svg.textContent).toBe("");
    }
  });

  it("scales with the text-size ladder rather than the width/height fallback", () => {
    const svg = svgOf("idle");
    expect(svg.getAttribute("class")).toContain("h-3.5");
    expect(svg.getAttribute("class")).toContain("w-3.5");
    expect(svg.getAttribute("width")).toBe("14"); // no-CSS fallback only
  });

  it("spins only the working glyph, and only when animate is on", () => {
    expect(svgOf("working").getAttribute("class")).toContain("am-spin");
    expect(svgOf("working", false).getAttribute("class")).not.toContain("am-spin");
    expect(svgOf("ended").getAttribute("class")).not.toContain("am-spin");
  });

  it("gives the todo glyph a hidden check for the .am-check hover reveal", () => {
    const svg = svgOf("todo");
    const check = svg.querySelector("[data-glyph-check]")!;
    expect(check).toBeTruthy();
    expect(check.getAttribute("opacity")).toBe("0");
  });

  it("takes its colour from the wrapper class, never from a hard-coded fill", () => {
    const svg = render(<StatusGlyph kind="needs_you" className="text-attention" />).container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("text-attention");
    // Knockouts are the only non-currentColor paint, and they are a surface token.
    for (const el of svg.querySelectorAll("[fill],[stroke]")) {
      const paint = `${el.getAttribute("fill") ?? ""}${el.getAttribute("stroke") ?? ""}`;
      expect(/currentColor|none|hsl\(var\(--surface-0\)\)/.test(paint)).toBe(true);
    }
  });
});
```

Create `web-tests/primitives.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ListRow, Rail, SectionHeader, Chip, MeterRow, Segmented, PageHeader, ROW_TONE } from "../src/web/components/primitives.tsx";

describe("Rail", () => {
  it("is a fixed --rail-wide slot so every row's text starts at the same x", () => {
    const { container } = render(<Rail><b>x</b></Rail>);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain("w-rail");
    expect(cls).toContain("shrink-0");
  });
});

describe("ListRow", () => {
  it("passes data-* through and applies exactly one hover background", () => {
    const { container } = render(<ListRow data-testid="r" tone="default">x</ListRow>);
    const cls = screen.getByTestId("r").className;
    expect(cls).toContain("hover:bg-surface-2");
    expect(cls).not.toContain("bg-attention");
    expect(container.firstElementChild!.tagName).toBe("DIV");
  });

  it("REPLACES the hover background for the attention tone, never appends", () => {
    render(<ListRow data-testid="r" tone="attention">x</ListRow>);
    const cls = screen.getByTestId("r").className;
    expect(cls).toContain("bg-attention/[0.05]");
    expect(cls).toContain("hover:bg-attention/[0.08]");
    // Two same-specificity hover:bg-* classes are resolved by stylesheet order,
    // not className order, so the default tint must be GONE, not overridden.
    expect(cls).not.toContain("hover:bg-surface-2");
    expect(ROW_TONE.attention).not.toContain("hover:bg-surface-2");
  });
});

describe("SectionHeader", () => {
  it("renders a button with aria-expanded when it can toggle", () => {
    const onToggle = vi.fn();
    render(<SectionHeader label="★ Todos (5)" collapsed={false} onToggle={onToggle} />);
    const btn = screen.getByRole("button", { name: /Todos/ });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it("keeps the whole label in ONE element so name regexes stay stable", () => {
    render(<SectionHeader label="⚙ Workflows (2)" collapsed onToggle={() => {}} />);
    expect(screen.getByText("⚙ Workflows (2)")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Workflows \(2\)/ })).toBeTruthy();
  });

  it("renders no button and no caret without onToggle", () => {
    const { container } = render(<SectionHeader label="⚡ Live activity" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("⚡ Live activity")).toBeTruthy();
  });
});

describe("Chip", () => {
  it("passes title and data-* through — both are test contracts elsewhere", () => {
    render(<Chip data-testid="wf-badge" tone="working" title="owns a live workflow run">wf</Chip>);
    expect(screen.getByTitle("owns a live workflow run")).toBeTruthy();
    expect(screen.getByTestId("wf-badge").textContent).toBe("wf");
  });

  it("emits exactly one font-size class", () => {
    render(<Chip data-testid="c" size="2xs">3</Chip>);
    const cls = screen.getByTestId("c").className;
    expect(cls).toContain("text-2xs");
    expect(cls).not.toContain("text-3xs");
  });
});

describe("MeterRow", () => {
  // MeterRow is an <li>; render it inside a <ul> so React's DOM-nesting
  // validation stays quiet.
  const meter = (frac: number) =>
    render(<ul><MeterRow frac={frac} label="Bash" a={<>492</>} b={<>avg 1.2s</>} /></ul>);

  it("floors the bar at 6% so a tiny row is still visible", () => {
    const { container } = meter(0.001);
    expect((container.querySelector("[data-meter-bar]") as HTMLElement).style.width).toBe("6%");
  });

  it("keeps label, a and b in separate elements", () => {
    meter(1);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("492")).toBeTruthy();
    expect(screen.getByText("avg 1.2s")).toBeTruthy();
  });
});

describe("Segmented", () => {
  it("names each item exactly, so /^all$/i matches nothing else", () => {
    const onChange = vi.fn();
    render(
      <Segmented<string>
        value="14d"
        onChange={onChange}
        options={[{ value: "7d", label: "7d" }, { value: "14d", label: "14d" }, { value: "all", label: "All" }]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    expect(onChange).toHaveBeenCalledWith("all");
  });
});

describe("PageHeader", () => {
  it("introduces no button whose accessible name contains 'cost'", () => {
    render(<PageHeader title="Cost by day" />);
    expect(screen.getByText("Cost by day")).toBeTruthy();
    expect(screen.getByText("← Dashboard").tagName).toBe("A"); // a link, never a button
    expect(screen.queryByRole("button", { name: /cost/i })).toBeNull();
  });
});
```

Create `web-tests/motion-gating.test.ts` — the permanent guard for §5.3's acceptance check:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src/web/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("motion gating", () => {
  it("uses no stock Tailwind animate-* utility anywhere in src/web", () => {
    // Tailwind's animate-* classes carry no `.am-anim` ancestor requirement, so
    // they keep running with the Motion toggle OFF. Every animation in this app
    // must go through an `.am-anim`-gated class in styles.css instead.
    const offenders = walk(ROOT)
      .filter((f) => /\.(ts|tsx|css|html)$/.test(f))
      .filter((f) => /\banimate-/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .sort(); // readdirSync order is filesystem-defined; sort so the failure message is stable
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web-tests/StatusGlyph.test.tsx web-tests/primitives.test.tsx web-tests/motion-gating.test.ts`
Expected: FAIL — `Failed to resolve import "../src/web/components/StatusGlyph.tsx"` and `.../primitives.tsx`; `motion-gating` fails with `[ "components/ActivityFeed.tsx", "components/SessionCard.tsx", "components/WorkflowRunCard.tsx" ]`.

- [ ] **Step 3: Write `src/web/components/StatusGlyph.tsx`**

```tsx
export type GlyphKind = "working" | "needs_you" | "idle" | "ended" | "todo" | "danger";

/** Knockout paint for the filled glyphs. A hovered row is --surface-2 rather
 *  than --surface-0, but the delta is ~4% L in both themes on a ≤1.7px stroke —
 *  verified imperceptible, and using the literal surface token keeps this
 *  primitive to one file and zero new tokens. */
const KO = "hsl(var(--surface-0))";

const CHECK = "M5 8.2l2.1 2.1L11.2 6";

/** The signature primitive: five shapes, four semantic colours, one file.
 *  Replaces the border/dot/label/shimmer redundancy that announced a session's
 *  status up to four times per card.
 *
 *  Colourless by design — every stroke and fill is `currentColor`, so colour
 *  comes from the wrapper class (`text-working`, `text-attention`, …).
 *  `aria-hidden` throughout: the glyph is NEVER the accessible name. Textual
 *  status lives in the group header, the workflow status label, or an sr-only
 *  span on the row.
 *
 *  `needs_you` deliberately breaks the circle family — a filled rounded square
 *  with a `!`, Linear's Urgent-priority move. That break is what lets the row
 *  tint stay as faint as 5%. */
export function StatusGlyph({
  kind,
  animate = true,
  className = "",
}: {
  kind: GlyphKind;
  /** AppBar passes false — a spinning glyph in the chrome is too much. */
  animate?: boolean;
  className?: string;
}) {
  // `am-spin` goes on the <svg> ROOT, not an inner <g>: the track ring is
  // rotationally symmetric so only the arc appears to move, and a replaced
  // element needs no `transform-box: fill-box` workaround.
  const spin = animate && kind === "working" ? " am-spin" : "";
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
      data-glyph={kind}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 shrink-0 ${className}${spin}`}
    >
      {kind === "idle" && <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />}

      {kind === "working" && (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".35" />
          {/* a 90° arc, 12 → 3 o'clock. With motion off it sits still at 1–2
              o'clock and still reads "in progress" — a designed fallback. */}
          <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}

      {kind === "ended" && (
        <>
          <circle cx="8" cy="8" r="6.75" fill="currentColor" />
          <path d={CHECK} fill="none" stroke={KO} strokeWidth="1.6" />
        </>
      )}

      {kind === "needs_you" && (
        <>
          <rect x="2" y="2" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M8 4.6v4.2" fill="none" stroke={KO} strokeWidth="1.7" />
          <circle cx="8" cy="11.4" r="1" fill={KO} />
        </>
      )}

      {kind === "todo" && (
        <>
          <rect x="2" y="2" width="12" height="12" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          {/* revealed by `.am-check:hover` in styles.css — no per-component plumbing */}
          <path data-glyph-check="true" d={CHECK} fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0" />
        </>
      )}

      {kind === "danger" && (
        <>
          <rect x="2" y="2" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke={KO} strokeWidth="1.7" />
        </>
      )}
    </svg>
  );
}
```

- [ ] **Step 4: Write `src/web/components/primitives.tsx`**

```tsx
import type { HTMLAttributes, ReactNode } from "react";

/** React's HTMLAttributes has no index signature, and the JSX checker only
 *  special-cases data-* on intrinsic elements — so a component that forwards
 *  them has to declare them. */
type DataAttrs = { [k: `data-${string}`]: string | undefined };

/** THE rail. Every list row's leading mark sits in this fixed-width slot, so
 *  line-1 text starts at exactly --rail no matter how wide the mark is (14px
 *  glyph, 16px checkbox, 6px dot). Rows put NO gap at this level and nest their
 *  content in a gapped flex — see the row components. */
export function Rail({ children }: { children?: ReactNode }) {
  return <span className="flex w-rail shrink-0 items-center justify-center">{children}</span>;
}

/** Shared row chrome. Carries NO background: `ROW_TONE` supplies exactly one,
 *  because two same-specificity `hover:bg-*` classes in one className are
 *  resolved by stylesheet emission order, not by string order. */
export const ROW_BASE = "-mx-1.5 rounded-md px-1.5 transition-colors duration-quick ease-quad";

export type RowTone = "default" | "attention";

/** `attention` REPLACES the default hover, never appends to it. */
export const ROW_TONE: Record<RowTone, string> = {
  default: "hover:bg-surface-2",
  attention: "bg-attention/[0.05] hover:bg-attention/[0.08]",
};

export function ListRow({
  tone = "default",
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & DataAttrs & { tone?: RowTone }) {
  return <div className={`${ROW_BASE} ${ROW_TONE[tone]} ${className}`} {...rest} />;
}

/** 10px disclosure caret. aria-hidden, so it never enters an accessible name —
 *  which is why `"▸ ★ Todos (5)"` can become `"★ Todos (5)"` with every role
 *  query in the suite still matching. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      className={`h-2.5 w-2.5 shrink-0 text-ink-4 transition-transform duration-base ease-quad ${open ? "rotate-90" : ""}`}
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The uppercase micro-label idiom, which occurred 12 times across 9 files.
 *  `label` is ONE string in ONE element — including its parenthesised count —
 *  because accessible-name computation concatenates element text with
 *  unpredictable spacing and three of these names are regex-pinned by tests. */
export function SectionHeader({
  label,
  leading,
  right,
  onToggle,
  collapsed = false,
}: {
  label: string;
  leading?: ReactNode;
  right?: ReactNode;
  onToggle?: () => void;
  collapsed?: boolean;
}) {
  const labelEl = <span className="text-2xs font-semibold uppercase tracking-caps text-ink-3">{label}</span>;
  return (
    <div className="mb-2 flex items-center gap-2">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="inline-flex items-center gap-2 transition-colors duration-quick ease-quad hover:text-ink"
        >
          <Chevron open={!collapsed} />
          {leading}
          {labelEl}
        </button>
      ) : (
        <span className="inline-flex items-center gap-2">
          {leading}
          {labelEl}
        </span>
      )}
      {right && <div className="ml-auto flex items-center gap-3">{right}</div>}
    </div>
  );
}

const CHIP_TONE = {
  neutral: "bg-surface-3 text-ink-3",
  working: "bg-working/[0.12] text-working",
} as const;

/** A LOOKUP, never `text-${size}`: Tailwind's content scanner is a regex over
 *  source text and cannot see an interpolated class name. Written this way both
 *  classes are literal in this file, so they are guaranteed emitted from Task 2
 *  onward — no safelist, and no window (Tasks 5/8, before the §4.12 group labels
 *  land) where `text-3xs` exists nowhere in the source and chips render at the
 *  inherited size. */
const CHIP_SIZE = { "3xs": "text-3xs", "2xs": "text-2xs" } as const;

/** Micro chip. `size` is a prop rather than an override because two font-size
 *  classes on one element are another emission-order coin flip. `title` and
 *  data-* passthrough are load-bearing: `title="owns a live workflow run"` is
 *  pinned by three tests and `data-testid="wf-badge"` by Task 0. */
export function Chip({
  tone = "neutral",
  round = false,
  size = "3xs",
  className = "",
  title,
  children,
  ...rest
}: {
  tone?: keyof typeof CHIP_TONE;
  round?: boolean;
  size?: keyof typeof CHIP_SIZE;
  className?: string;
  title?: string;
  children: ReactNode;
} & DataAttrs) {
  const shape = round ? "rounded-full px-1.5" : "rounded-sm px-1";
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center font-mono ${CHIP_SIZE[size]} ${shape} ${CHIP_TONE[tone]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}

/** The unified sidebar row: one grid for ToolStats and CostBreakdown, which is
 *  what makes the two panels read as one system. The bar is neutral (`bg-bar`),
 *  not accent — the sidebar must stop competing with the board for colour. */
export function MeterRow({
  frac,
  leading,
  label,
  a,
  b,
}: {
  frac: number;
  leading?: ReactNode;
  label: string;
  a: ReactNode;
  b: ReactNode;
}) {
  return (
    <li className={`relative isolate flex h-6 items-center font-mono text-2xs ${ROW_BASE}`}>
      <span
        aria-hidden="true"
        data-meter-bar="true"
        className="absolute inset-y-[0.125rem] left-0 -z-10 rounded bg-bar"
        style={{ width: `${Math.max(6, Math.round(frac * 100))}%` }}
      />
      <Rail>{leading}</Rail>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-ink-2">{label}</span>
        <span className="w-14 shrink-0 whitespace-nowrap text-right tabular-nums text-ink-3">{a}</span>
        <span className="w-16 shrink-0 whitespace-nowrap text-right tabular-nums text-ink-4">{b}</span>
      </div>
    </li>
  );
}

/** Joined range control for the two pages. No `data-press`: a 3% scale on a
 *  joined 28px control reads as wobble (R12). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex h-7 items-center gap-0.5 rounded-md border-hairline border-border p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex h-[1.375rem] items-center rounded px-2.5 text-xs transition-colors duration-quick ease-quad ${
            o.value === value ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Shared chrome for #/cost and #/workflows. HARD CONSTRAINT: this must
 *  introduce no <button> whose accessible name contains "cost" — two tests do
 *  getByRole("button", { name: /cost/i }) expecting the Cost COLUMN header.
 *  `← Dashboard` is therefore an <a> and the title a <span>. */
export function PageHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 -mx-6 flex h-12 items-center gap-3 border-b-hairline border-border-weak bg-surface-0/[0.72] px-6 backdrop-blur-[20px]">
      <a href="#/" className="text-sm text-ink-3 transition-colors duration-quick ease-quad hover:text-ink">
        ← Dashboard
      </a>
      <span aria-hidden="true" className="h-4 w-px bg-border-weak" />
      <span className="text-sm font-semibold text-ink">{title}</span>
      {right && <div className="ml-auto">{right}</div>}
    </header>
  );
}
```

**Note on `CHIP_SIZE`:** Tailwind's content scanner is a regex over source text, so `text-${size}` would be invisible to it. Do **not** "simplify" it back to interpolation: `text-3xs` has *no* other literal call site until Task 9 lands the §4.12 group labels, so between here and there every default-size `<Chip>` (the `wf` badge, `structure unavailable`) would silently render at the inherited font size. The lookup keeps both classes literal in this file, which is also why no `safelist` entry is needed. Step 6 verifies.

- [ ] **Step 5: Make the three animations obey the Motion toggle**

`src/web/components/SessionCard.tsx` line 52 — the status dot (this element is deleted in Task 5; renaming it now keeps the guard test honest in between):

```tsx
        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}${st.pulse ? " am-pulse" : ""}`} />
```

`src/web/components/SessionCard.tsx` line 65 — the `⟳` active-tool glyph:

```tsx
          <span className="am-spin inline-block" aria-hidden="true">⟳</span>
```

`src/web/components/WorkflowRunCard.tsx` line 8:

```tsx
const AGENT_DOT: Record<string, string> = {
  running: "bg-working am-pulse",
  done: "bg-idle",
  abandoned: "bg-attention/60",
};
```

`src/web/components/ActivityFeed.tsx` line 16 — the live ping ring:

```tsx
            <span className="am-ping absolute inline-flex h-full w-full rounded-full bg-primary/60" />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && bun run typecheck && bun run web:build`
Expected: **26 files / 129 tests** pass (23 + 3 new files; 111 + 18 new tests); typecheck clean; build succeeds.

Then confirm **both** chip sizes survived the content scan — check them **separately**, because an `\|` grep passes on `text-2xs` alone and would hide exactly the failure this guards against:
```bash
CSS=$(ls dist/web/assets/*.css | head -1)
grep -c -- "text-3xs" "$CSS"
grep -c -- "text-2xs" "$CSS"
```
Expected: **both ≥ 1**. If `text-3xs` is 0, the `CHIP_SIZE` lookup was collapsed back to `text-${size}` — restore it (or, as a last resort, add `safelist: ["text-3xs", "text-2xs"]` to `tailwind.config.js`).

- [ ] **Step 7: Commit**

```bash
git add src/web/components/StatusGlyph.tsx src/web/components/primitives.tsx \
        src/web/components/SessionCard.tsx src/web/components/WorkflowRunCard.tsx \
        src/web/components/ActivityFeed.tsx web-tests
git commit -m "feat(web): StatusGlyph + shared primitives; gate the last 3 animations

StatusGlyph is five shapes and four semantic colours in one colourless SVG
(needs_you deliberately breaks the circle family). primitives.tsx carries the
rail slot, list row, section header, chip, meter row, segmented control and
page header — the uppercase micro-label idiom alone was duplicated 12 times.

animate-spin/pulse/ping ignored the Motion toggle because Tailwind's animate-*
classes carry no .am-anim ancestor requirement. They are now am-spin/am-pulse/
am-ping, and web-tests/motion-gating.test.ts keeps them that way."
```

---

## Task 3: `AppBar` — the 3rem status rail (§4.1)

The top bar borrows the Linear sidebar's *discipline*, not its geometry: it becomes **dimmer than the work surface** — ghost controls, hairline dividers, `ink-3` labels — so the content reads as primary. The three bordered `bg-chip` count pills and the uniform `h-9 border bg-muted` control treatment are what made the chrome as loud as the board; both go.

**No left sidebar** — three hash routes do not justify 200–220px of permanent width on the one page starved for it, and it would force `App.tsx`'s three independently-returned pages into a persistent shell (K2). (§3.0)

**Files:**
- Rewrite: `src/web/components/AppBar.tsx`
- Test: `web-tests/AppBar.test.tsx` (append 4 tests; the 2 existing ones stay untouched)

**Interfaces:**
- Consumes: `StatusGlyph`, `Chip` (Task 2); test-ids `appbar-count-{working,needs-you,todo}` (Task 0).
- Produces: an `<header>` with `-mx-6` — it is only ever rendered by `Board`, whose container is `px-6` (Task 4). It carries **no bottom margin**; the gap under it is owned by Board's `mt-3` plus each section's `mt-6`.

**Preserved verbatim at every breakpoint** (K13, K14): `aria-label` × {`Toggle theme`, `Toggle motion`, `Decrease text size`, `Increase text size`}, `aria-pressed` on Motion, the Motion `title`, and the visible words `Cost`, `Workflows`, `Motion`, `Dark`/`Light`, `A−` (U+2212), `A+`. Nothing hides behind an icon.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/AppBar.test.tsx`:

```tsx
import type { LiveWorkflow } from "../src/web/types.ts";

const liveRun: LiveWorkflow = {
  run_id: "wf_abc", session_id: "s1", project: "p", branch: null, name: "research",
  status: null, state: "running", started_at: 0, phase: null, schema_ok: true,
  costUsd: 0, tokens: 0, agents: [],
};

describe("AppBar chrome", () => {
  it("leads each count with its status glyph and keeps '{n} {label}' in one element", () => {
    render(<AppBar state={state} />);
    expect(screen.getByTestId("appbar-count-working").querySelector('[data-glyph="working"]')).toBeTruthy();
    expect(screen.getByTestId("appbar-count-needs-you").querySelector('[data-glyph="needs_you"]')).toBeTruthy();
    expect(screen.getByTestId("appbar-count-todo").querySelector('[data-glyph="todo"]')).toBeTruthy();
    expect(screen.getByText("1 working").tagName).toBe("SPAN");
  });

  it("never spins a glyph in the chrome", () => {
    render(<AppBar state={state} />);
    expect(screen.getByTestId("appbar-count-working").innerHTML).not.toContain("am-spin");
  });

  it("escalates the needs-you group only while it is non-zero, and recedes zeroes", () => {
    render(<AppBar state={state} />);
    expect(screen.getByTestId("appbar-count-needs-you").className).toContain("text-attention");
    cleanup();
    const calm = { ...state, sessions: [state.sessions[0]], todos: [] };
    render(<AppBar state={calm} />);
    expect(screen.getByTestId("appbar-count-needs-you").className).toContain("text-ink-4");
    expect(screen.getByTestId("appbar-count-needs-you").className).not.toContain("text-attention");
  });

  it("shows the live workflow count chip only when a run is live", () => {
    render(<AppBar state={state} />);
    expect(screen.queryByTestId("appbar-wf-count")).toBeNull();
    cleanup();
    render(<AppBar state={state} workflows={[liveRun]} />);
    expect(screen.getByTestId("appbar-wf-count").textContent).toBe("1");
  });
});
```

Add `cleanup` to the existing `@testing-library/react` import at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web-tests/AppBar.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-glyph="working"]` (Task 0 added the count test-ids, but the glyph, the tone classes and the wf-count chip do not exist yet).

- [ ] **Step 3: Write the implementation**

Replace `src/web/components/AppBar.tsx` with:

```tsx
import type { State, LiveWorkflow } from "../types.ts";
import { useTheme } from "../useTheme.ts";
import { useTextSize } from "../useTextSize.ts";
import { useMotion } from "../useMotion.ts";
import { StatusGlyph, type GlyphKind } from "./StatusGlyph.tsx";
import { Chip } from "./primitives.tsx";

/** Ghost control: no border, no fill, no colour. Every call site appends
 *  EXACTLY ONE text colour — two `text-*` classes on one element are resolved
 *  by stylesheet order, not by className order. */
const GHOST =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors duration-quick ease-quad hover:bg-surface-2 hover:text-ink";

function Count({
  testId,
  kind,
  label,
  n,
  escalate = false,
}: {
  testId: string;
  kind: GlyphKind;
  label: string;
  n: number;
  escalate?: boolean;
}) {
  // Tone IS the hierarchy: a zero count recedes on its own, with no branch in
  // the markup. The one escalation in the whole app is a non-zero needs-you.
  const tone =
    escalate && n > 0
      ? "rounded-full bg-attention/[0.08] px-2 py-0.5 text-attention"
      : n > 0
        ? "text-ink-2"
        : "text-ink-4";
  return (
    <span data-testid={testId} className={`am-count inline-flex items-center gap-1.5 text-xs ${tone}`}>
      <StatusGlyph kind={kind} animate={false} />
      <span>{n} {label}</span>
    </span>
  );
}

export function AppBar({ state, workflows = [] }: { state: State; workflows?: LiveWorkflow[] }) {
  const { theme, toggle } = useTheme();
  const { inc, dec, canInc, canDec } = useTextSize();
  const { on: motionOn, toggle: toggleMotion } = useMotion();
  const working = state.sessions.filter((s) => s.status === "working").length;
  const needsYou = state.sessions.filter((s) => s.status === "needs_you").length;
  const todoCount = state.todos.filter((t) => t.status === "todo").length;

  return (
    <header className="sticky top-0 z-20 -mx-6 flex h-12 items-center gap-4 border-b-hairline border-border-weak bg-surface-0/[0.72] px-6 backdrop-blur-[20px]">
      <div className="flex items-center gap-2">
        {/* the inline boxShadow glow ring is deleted — pure decoration */}
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-accent" />
        <span className="text-sm font-semibold tracking-tight text-ink">agent-monitor</span>
      </div>

      <span aria-hidden="true" className="h-4 w-px bg-border-weak" />

      <div className="flex items-center gap-4">
        {/* keyed on the COUNT only — never on the 1Hz clock (§5.5) */}
        <Count key={`w-${working}`} testId="appbar-count-working" kind="working" label="working" n={working} />
        <Count key={`n-${needsYou}`} testId="appbar-count-needs-you" kind="needs_you" label="needs you" n={needsYou} escalate />
        <Count key={`t-${todoCount}`} testId="appbar-count-todo" kind="todo" label="to do" n={todoCount} />
      </div>

      <div className="ml-auto flex items-center gap-1">
        <a href="#/cost" data-press className={`${GHOST} text-ink-3`}>
          <span aria-hidden="true" className="text-2xs text-ink-4">$</span>
          <span>Cost</span>
        </a>
        <a href="#/workflows" data-press className={`${GHOST} text-ink-3`}>
          <span aria-hidden="true" className="text-2xs text-ink-4">⚙</span>
          <span>Workflows</span>
          {workflows.length > 0 && (
            <Chip data-testid="appbar-wf-count" tone="working" round size="2xs" className="tabular-nums">
              {workflows.length}
            </Chip>
          )}
        </a>

        {/* the one control that keeps a border, because it is a joined pair.
            No data-press: a 3% scale on a joined 28px control reads as wobble. */}
        <div className="inline-flex h-7 items-center rounded-md border-hairline border-border">
          <button
            type="button"
            onClick={dec}
            disabled={!canDec}
            aria-label="Decrease text size"
            className="flex h-full items-center px-2.5 text-xs text-ink-3 transition-colors duration-quick ease-quad hover:text-ink disabled:opacity-40"
          >
            A−
          </button>
          <span aria-hidden="true" className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={inc}
            disabled={!canInc}
            aria-label="Increase text size"
            className="flex h-full items-center px-2.5 text-sm text-ink-3 transition-colors duration-quick ease-quad hover:text-ink disabled:opacity-40"
          >
            A+
          </button>
        </div>

        <button
          type="button"
          data-press
          onClick={toggleMotion}
          aria-label="Toggle motion"
          aria-pressed={motionOn}
          title={motionOn ? "Animations on" : "Animations off"}
          className={`${GHOST} ${motionOn ? "text-ink" : "text-ink-3"}`}
        >
          <span aria-hidden="true" className="text-2xs">{motionOn ? "✨" : "⊘"}</span>
          <span>Motion</span>
        </button>
        <button
          type="button"
          data-press
          onClick={toggle}
          aria-label="Toggle theme"
          className={`${GHOST} text-ink-3`}
        >
          <span aria-hidden="true" className="text-2xs">{theme === "dark" ? "☾" : "☀"}</span>
          <span>{theme === "dark" ? "Dark" : "Light"}</span>
        </button>
      </div>
    </header>
  );
}
```

**Do not retype `A−`** — copy the character from the old file. It is U+2212 MINUS SIGN, not `-`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web-tests/AppBar.test.tsx && npx vitest run`
Expected: `AppBar.test.tsx (6 tests)` and the whole suite green (26 files).

- [ ] **Step 5: Commit**

```bash
git add src/web/components/AppBar.tsx web-tests/AppBar.test.tsx
git commit -m "feat(web): AppBar becomes a 3rem status rail

Count pills → glyph + text on a tone hierarchy (zero counts recede; a non-zero
needs-you is the only chrome-level alarm in the app). Uniform h-9 bordered
controls → ghost buttons; brand glow ring deleted. Every aria-label, title and
visible word is preserved verbatim at every breakpoint."
```

---

## Task 4: `Board` layout + `Lane`/`Column` + degraded banner (§3.1, §4.2, §4.3)

Three structural moves land together because they are one change: the 3-column kanban becomes a grouped vertical list, the sections reorder so **sessions come first**, and the four bordered sidebar boxes collapse to one vertical hairline.

**Files:**
- Rewrite: `src/web/components/Board.tsx`
- Rewrite: `src/web/components/Lane.tsx`
- Test: `web-tests/Board.test.tsx` (append 3 tests; the 6 existing ones stay untouched)

**Interfaces:**
- Consumes: `StatusGlyph`, `Rail` (Task 2); `Column(title, count, dot: Session["status"], children)` narrowed in Task 0.
- Produces: a `px-6` container (which `AppBar`'s and `PageHeader`'s `-mx-6` depend on) and the group order **needs_you → working → idle**.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/Board.test.tsx`:

```tsx
import { within } from "@testing-library/react";

describe("Board layout", () => {
  it("orders the session groups needs-you, working, idle", () => {
    const { container } = render(<Board state={state} />);
    const ids = [...container.querySelectorAll('[data-testid^="session-group-"]')].map((e) =>
      e.getAttribute("data-testid")
    );
    expect(ids).toEqual(["session-group-needs_you", "session-group-working", "session-group-idle"]);
  });

  it("still renders an empty group's header with a zero count — it is the board's legend", () => {
    render(<Board state={state} />);
    const idle = screen.getByTestId("session-group-idle");
    expect(within(idle).getByText("Idle / done")).toBeTruthy();
    expect(within(idle).getByText("0")).toBeTruthy();
  });

  it("puts the degraded banner first in main, above the sessions lane", () => {
    const { container } = render(<Board state={{ ...state, workflows_degraded: 3 }} />);
    const main = container.querySelector("main")!;
    expect(main.firstElementChild!.textContent).toContain("workflow data looks off");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web-tests/Board.test.tsx`
Expected: FAIL — the group order assertion gets `["session-group-working", "session-group-needs_you", "session-group-idle"]`, and the banner assertion finds the Todos section first.

- [ ] **Step 3: Write `src/web/components/Lane.tsx`**

```tsx
import type { ReactNode } from "react";
import type { Session } from "../types.ts";
import { StatusGlyph, type GlyphKind } from "./StatusGlyph.tsx";
import { Rail } from "./primitives.tsx";

/** The only place the session-status → glyph/colour mapping lives outside
 *  SessionCard. Transcribed from spec §2.4's session table. */
const GLYPH: Record<Session["status"], GlyphKind> = {
  working: "working",
  needs_you: "needs_you",
  idle: "idle",
  ended: "ended",
};

/** The GROUP HEADER carries the semantic colour once; the rows inside it
 *  recede to ink-4. That is how a 12-session idle backlog stops dominating the
 *  board without adding a new collapse control. */
const HEADER_TONE: Record<Session["status"], string> = {
  working: "text-working",
  needs_you: "text-attention",
  idle: "text-idle",
  ended: "text-idle",
};

export function Column({
  title,
  count,
  dot,
  children,
}: {
  title: string;
  count: number;
  dot: Session["status"];
  children: ReactNode;
}) {
  return (
    <div data-testid={`session-group-${dot}`}>
      {/* opaque, NOT blurred: one blurred layer per page is enough (R6) */}
      <div className="sticky top-12 z-10 -mx-1.5 flex h-7 items-center border-b-hairline border-border-weak bg-surface-0 px-1.5">
        <Rail>
          <StatusGlyph kind={GLYPH[dot] ?? "idle"} animate={false} className={HEADER_TONE[dot] ?? "text-idle"} />
        </Rail>
        <div className="flex items-center gap-2">
          <span className="text-2xs font-semibold uppercase tracking-caps text-ink-3">{title}</span>
          <span className="text-2xs tabular-nums text-ink-4">{count}</span>
        </div>
      </div>
      <div className="pt-1">{children}</div>
    </div>
  );
}

export function Lane({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-2.5">
        <span className="text-2xs font-semibold uppercase tracking-caps text-ink-3">{label}</span>
        <span className="text-2xs text-ink-4">{hint}</span>
      </div>
      {/* was: grid grid-cols-1 sm:grid-cols-3 gap-3 — todos and sessions are
          list-shaped; a single column is what makes them scannable */}
      <div>{children}</div>
    </section>
  );
}
```

- [ ] **Step 4: Write `src/web/components/Board.tsx`**

```tsx
import type { State, Session, Activity, LiveWorkflow } from "../types.ts";
import { useNow } from "../useNow.ts";
import { Lane, Column } from "./Lane.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";
import { TodosSection } from "./TodosSection.tsx";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { ToolStats } from "./ToolStats.tsx";
import { CostPanel } from "./CostPanel.tsx";
import { CostBreakdown } from "./CostBreakdown.tsx";
import { WorkflowsSection } from "./WorkflowsSection.tsx";

/** Needs you first: the board's job is to tell you when it needs you. */
const SESSION_COLS: { id: Session["status"]; title: string }[] = [
  { id: "needs_you", title: "Needs you" },
  { id: "working", title: "Working" },
  { id: "idle", title: "Idle / done" },
];

export function Board({ state, workflows = [] }: { state: State; workflows?: LiveWorkflow[] }) {
  // Re-render every second so relative timestamps tick live.
  useNow();

  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

  // Newest-first activity → first entry per session is its latest tool call.
  const latest = new Map<string, Activity>();
  for (const a of state.activity) {
    if (!latest.has(a.session_id)) latest.set(a.session_id, a);
  }

  // Computed once per render rather than passing the array down to every card.
  const wfSessions = new Set(workflows.map((w) => w.session_id));

  return (
    <div className="mx-auto max-w-board px-6 pb-16">
      <AppBar state={state} workflows={workflows} />

      <div className="mt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <main className="min-w-0 lg:pr-6">
          {/* First in main, no top margin. Together with the needs_you row tint
              these are the only two tinted surfaces in the whole app. */}
          {(state.workflows_degraded ?? 0) > 0 && (
            <div className="flex h-8 items-center gap-2 rounded-md border-hairline border-attention/25 bg-attention/[0.07] px-2.5 text-2xs text-attention">
              ⚠ workflow data looks off — Claude Code may have changed format
            </div>
          )}

          {/* Sessions are the reason the page exists; the 40vh caps on Todos and
              Workflows were compensating for them sitting third. */}
          <Lane label="Sessions" hint="auto — moves itself from agent hook events">
            {SESSION_COLS.map((c) => {
              const items = bySession(c.id);
              return (
                <Column key={c.id} title={c.title} dot={c.id} count={items.length}>
                  {items.map((s) => (
                    <SessionCard
                      key={s.id}
                      s={s}
                      latestTool={latest.get(s.id)?.tool}
                      latestDetail={latest.get(s.id)?.detail ?? null}
                      cost={state.cost.perSession[s.id]}
                      wf={wfSessions.has(s.id)}
                    />
                  ))}
                </Column>
              );
            })}
          </Lane>

          <WorkflowsSection workflows={workflows} />
          <TodosSection todos={state.todos} />
        </main>

        {/* One vertical hairline replaces four bordered card boxes. Below lg the
            grid stacks and the border drops — lg: prefixes only. */}
        <aside className="mt-6 lg:sticky lg:top-14 lg:mt-0 lg:border-l-hairline lg:border-border-weak lg:pl-6">
          <ToolStats stats={state.stats} />
          <CostPanel cost={state.cost} />
          <CostBreakdown cost={state.cost} />
          <ActivityFeed activity={state.activity} sessions={state.sessions} />
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run web-tests/Board.test.tsx && npx vitest run && bun run typecheck`
Expected: `Board.test.tsx (9 tests)`; whole suite green; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/Board.tsx src/web/components/Lane.tsx web-tests/Board.test.tsx
git commit -m "feat(web): grouped session list, sessions first, one sidebar hairline

3-column kanban → a single grouped list with sticky group headers, ordered
needs-you → working → idle. Sections reorder to sessions → workflows → todos.
The four bordered sidebar boxes become one vertical hairline that drops below
lg. Empty groups still render their header — it is the board's legend."
```

---

## Task 5: `SessionCard` → session row (§4.4)

The card announces status up to four times (3px left border, coloured dot, coloured uppercase label, shimmer bar). One glyph replaces all four. Idle sessions drop to a single ~26px line — same information, a third of the weight.

**Files:**
- Rewrite: `src/web/components/SessionCard.tsx`
- Test: `web-tests/SessionCard.test.tsx` (append 4 tests; the 8 existing ones stay untouched)

**Interfaces:**
- Consumes: `StatusGlyph`, `ListRow`, `Rail`, `Chip` (Task 2); test-ids `session-row`, `wf-badge` (Task 0).
- Produces: prop signature **unchanged** — `SessionCard(s, latestTool, latestDetail, cost, wf)` (K16).

**Four element boundaries here are hard test contracts. Do not flatten them:**

| Literal | Boundary | Test |
|---|---|---|
| `⎇ feat/x` | ONE element; **absent** when `branch == null` | `SessionCard.test:15,19` |
| `Bash…` | ONE element | `SessionCard.test:23` |
| `$1.24 · 312K tok` | ONE element | `SessionCard.test:36` |
| `⚠ Run migration?` | ONE element | `Board.test:26` |

And `SessionCard.test:41` asserts `container.textContent` does **not** contain `"tok"` when there is no cost — so no literal "tok" label may appear anywhere else in the row. The four `sr-only` labels (`Working`, `Needs you`, `Idle`, `Ended`) are safe against it.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/SessionCard.test.tsx`:

```tsx
describe("SessionCard row", () => {
  afterEach(cleanup);

  it("keeps status in the accessibility tree after the visible label is removed", () => {
    // The coloured uppercase status line is gone — the glyph is aria-hidden, so
    // an sr-only label is the only thing carrying status to a screen reader.
    const { container } = render(<SessionCard s={{ ...base, status: "needs_you", attention_reason: "why?" }} />);
    expect(screen.getByText("Needs you").className).toContain("sr-only");
    expect(container.querySelector('[data-glyph="needs_you"]')).toBeTruthy();
  });

  it("tints the whole needs-you row instead of drawing a callout box", () => {
    render(<SessionCard s={{ ...base, status: "needs_you", attention_reason: "why?" }} />);
    const row = screen.getByTestId("session-row");
    expect(row.getAttribute("data-status")).toBe("needs_you");
    expect(row.className).toContain("bg-attention/[0.05]");
    expect(row.className).not.toContain("hover:bg-surface-2"); // tone replaces, never appends
  });

  it("draws an idle row as one compact line — no tool line, no shimmer, no branch", () => {
    const { container } = render(
      <SessionCard s={{ ...base, status: "idle", branch: "feat/x" }} latestTool="Read" cost={{ costUsd: 0.02, tokens: 100 }} />
    );
    expect(container.querySelector(".am-shimmer")).toBeNull();
    expect(screen.queryByText(/Read/)).toBeNull();
    expect(screen.queryByText(/⎇/)).toBeNull();
    expect(screen.getByText("$0.02")).toBeTruthy(); // cost only, no "· … tok" suffix
    expect(container.textContent).not.toContain("tok");
  });

  it("shimmers only while working", () => {
    const { container, rerender } = render(<SessionCard s={base} />); // working
    expect(container.querySelector(".am-shimmer")).toBeTruthy();
    rerender(<SessionCard s={{ ...base, status: "needs_you" }} />);
    expect(container.querySelector(".am-shimmer")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web-tests/SessionCard.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-glyph="needs_you"]`, and the idle row still renders the tool line and the `· 100 tok` suffix.

- [ ] **Step 3: Write the implementation**

Replace `src/web/components/SessionCard.tsx` with:

```tsx
import type { CSSProperties } from "react";
import type { Session, SessionCost } from "../types.ts";
import { ago } from "../time.ts";
import { prettyTool } from "../tools.ts";
import { formatUsd, formatTokens } from "../cost.ts";
import { StatusGlyph, type GlyphKind } from "./StatusGlyph.tsx";
import { ListRow, Rail, Chip } from "./primitives.tsx";

/** Rows in the idle group are drawn in ink-4, not `idle`: the GROUP HEADER
 *  carries the semantic colour once (Lane.tsx), and the rows recede. */
const STATUS: Record<string, { kind: GlyphKind; tone: string; label: string }> = {
  working: { kind: "working", tone: "text-working", label: "Working" },
  needs_you: { kind: "needs_you", tone: "text-attention", label: "Needs you" },
  idle: { kind: "idle", tone: "text-ink-4", label: "Idle" },
  ended: { kind: "ended", tone: "text-ink-4", label: "Ended" },
};

export function SessionCard({
  s,
  latestTool,
  latestDetail,
  cost,
  wf = false,
}: {
  s: Session;
  latestTool?: string;
  latestDetail?: string | null;
  cost?: SessionCost;
  wf?: boolean;
}) {
  const st = STATUS[s.status] ?? STATUS.idle;
  const isWorking = s.status === "working";
  const compact = s.status === "idle" || s.status === "ended";
  const task = s.current_task ?? s.current_intent ?? "—";

  // Stable name so a status change (group move) tweens between positions.
  const style: CSSProperties = {};
  (style as Record<string, string>).viewTransitionName = `vt-s-${s.id}`;

  if (compact) {
    return (
      <ListRow
        data-testid="session-row"
        data-status={s.status}
        className="am-fade-in flex items-center py-1"
        style={style}
      >
        <Rail>
          <StatusGlyph kind={st.kind} animate={false} className={st.tone} />
        </Rail>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="sr-only">{st.label}</span>
          <span className="shrink-0 text-xs text-ink-2">{s.project}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink-4">{task}</span>
          {cost && (
            <span className="shrink-0 font-mono text-2xs tabular-nums slashed-zero text-ink-4">
              {formatUsd(cost.costUsd)}
            </span>
          )}
          <span className="w-14 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-4">
            {ago(s.last_activity_at)}
          </span>
        </div>
      </ListRow>
    );
  }

  return (
    <ListRow
      data-testid="session-row"
      data-status={s.status}
      tone={s.status === "needs_you" ? "attention" : "default"}
      className="am-fade-in relative py-1.5"
      style={style}
    >
      <div className="flex items-center">
        <Rail>
          <StatusGlyph kind={st.kind} className={st.tone} />
        </Rail>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* removing the visible status label must not remove status from the
              accessibility tree — the glyph is aria-hidden */}
          <span className="sr-only">{st.label}</span>
          <span className="shrink-0 text-sm font-medium text-ink">{s.project}</span>
          {wf && (
            <Chip data-testid="wf-badge" tone="working" title="owns a live workflow run">
              wf
            </Chip>
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-ink-3">{task}</span>
          {s.branch && <span className="shrink-0 font-mono text-2xs text-ink-4">⎇ {s.branch}</span>}
          {cost && (
            <span className="shrink-0 font-mono text-2xs tabular-nums slashed-zero text-ink-4">
              {formatUsd(cost.costUsd)} · {formatTokens(cost.tokens)} tok
            </span>
          )}
          <span className="w-14 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-4">
            {ago(s.last_activity_at)}
          </span>
        </div>
      </div>

      {isWorking && s.active_tool ? (
        <div className="flex min-w-0 items-center gap-1.5 pl-rail font-mono text-2xs text-working">
          <span className="am-spin inline-block" aria-hidden="true">⟳</span>
          <span className="truncate">{prettyTool(s.active_tool)}…</span>
        </div>
      ) : isWorking && latestTool ? (
        <div className="flex min-w-0 items-center gap-1.5 pl-rail font-mono text-2xs text-working/80">
          <span aria-hidden="true">▸</span>
          <span className="truncate">
            {prettyTool(latestTool)}
            {latestDetail ? <span className="text-working/60"> · {latestDetail}</span> : null}
          </span>
        </div>
      ) : null}

      {/* the guard is preserved: a needs-you session with a null reason renders
          no second line rather than a bare ⚠ */}
      {s.attention_reason && s.status === "needs_you" && (
        <div className="truncate pl-rail font-mono text-2xs text-attention">⚠ {s.attention_reason}</div>
      )}

      {/* a 1px underline at the row's bottom edge, rail → right */}
      {isWorking && (
        <span aria-hidden="true" className="am-shimmer absolute bottom-0 left-rail right-0 h-px bg-working/[0.14]" />
      )}
    </ListRow>
  );
}
```

**Deleted outright:** the 3px `borderLeft` inline style, the `border`/`bg-card`/`shadow-card`/`shadow-card-hover`, the visible status dot + `Working`/`Needs you` label line, and the `attention_reason` callout box.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web-tests/SessionCard.test.tsx web-tests/Board.test.tsx && npx vitest run`
Expected: `SessionCard.test.tsx (12 tests)`; `Board.test.tsx` still green (it asserts `⚠ Run migration?`, `browns`, `Refactor (1/3 done)` and the `wf` badge title through this component); whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/SessionCard.tsx web-tests/SessionCard.test.tsx
git commit -m "feat(web): SessionCard becomes a rail row

One glyph replaces the 3px border + dot + uppercase label + shimmer bar. The
needs_you row is tinted whole at 5% instead of carrying a callout box — louder
than a border and still flat. Idle rows collapse to one ~26px line. An sr-only
status label keeps the removed visible label in the accessibility tree."
```

---

## Task 6: `TodosSection` + `TodoCard` → todo rows (§4.5, §4.6)

The masonry (`columns-1 sm:columns-2 xl:columns-3`) goes: todos are list-shaped, and a single column is what makes them scannable down the left edge. `✓ Done (n) →` moves up into the header — **the one behaviour-visible change in this task**, because it now renders while the section is collapsed.

**Files:**
- Rewrite: `src/web/components/TodosSection.tsx`
- Rewrite: `src/web/components/TodoCard.tsx`
- Test: `web-tests/TodosSection.test.tsx` (append 2), `web-tests/TodoCard.test.tsx` (append 2)

**Interfaces:**
- Consumes: `SectionHeader`, `ROW_BASE`, `ROW_TONE`, `Rail`, `StatusGlyph` (Task 2); test-ids `todos-scroller`, `todos-done-link`, `note` (Task 0).
- Produces: `TodoCard(t, onOpen)` unchanged (K16).

**Preserved:** the literal class string `max-h-[40vh] overflow-y-auto` on the same element (K7); `line-clamp-1` on the note (K15); `aria-label`/`title` `Mark done` and `Delete`; both `stopPropagation` handlers on both buttons; `viewTransitionName: vt-t-${t.id}` (K18); the exact strings `✓ to complete · ✕ to delete`, `✓ Done (n) →`, `Nothing open. 🎉`, and `→ {for_who}` as ONE element.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/TodosSection.test.tsx`:

```tsx
describe("TodosSection header", () => {
  it("keeps the Done link reachable while the section is collapsed", () => {
    // It moved out of the {!collapsed && …} branch and into the header.
    render(<TodosSection todos={todos} />);
    fireEvent.click(screen.getByRole("button", { name: /Todos/ }));
    expect(screen.queryByText("open1")).toBeNull();
    fireEvent.click(screen.getByTestId("todos-done-link"));
    expect(screen.getByText("gone")).toBeDefined();
  });

  it("shows the bare empty state with no bordered shell", () => {
    render(<TodosSection todos={[]} />);
    const empty = screen.getByText("Nothing open. 🎉");
    expect(empty.className).not.toContain("border");
    expect(screen.queryByTestId("todos-scroller")).toBeNull();
  });
});
```

Append to `web-tests/TodoCard.test.tsx`:

```tsx
describe("TodoCard row", () => {
  it("puts a todo glyph in the rail instead of a ✓ character", () => {
    const { container } = renderCard();
    const btn = screen.getByLabelText("Mark done");
    expect(btn.textContent).toBe("");
    expect(btn.querySelector('[data-glyph="todo"]')).toBeTruthy();
    expect(btn.className).toContain("am-check"); // drives the hover check reveal
    expect(container.querySelector(".w-rail")).toBeTruthy();
  });

  it("keeps delete in the DOM behind progressive disclosure, on the danger token", () => {
    renderCard();
    const del = screen.getByLabelText("Delete");
    expect(del.className).toContain("opacity-0");
    expect(del.className).toContain("group-hover:opacity-100");
    expect(del.className).toContain("hover:text-danger");
    expect(del.className).not.toContain("red-400"); // the app's last un-tokenized colour
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web-tests/TodosSection.test.tsx web-tests/TodoCard.test.tsx`
Expected: FAIL — the Done link is not in the DOM while collapsed; `Mark done` still has `textContent === "✓"`.

- [ ] **Step 3: Write `src/web/components/TodosSection.tsx`**

```tsx
import { useState } from "react";
import type { Todo } from "../types.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { SectionHeader } from "./primitives.tsx";
import { TodoCard } from "./TodoCard.tsx";
import { TodoModal } from "./TodoModal.tsx";
import { DoneDialog } from "./DoneDialog.tsx";

export function TodosSection({ todos }: { todos: Todo[] }) {
  const [collapsed, toggleCollapsed] = usePersistedToggle("am-todos-collapsed");
  const [doneOpen, setDoneOpen] = useState(false);
  const [selected, setSelected] = useState<Todo | null>(null);

  const open = todos.filter((t) => t.status === "todo");
  const done = todos.filter((t) => t.status === "done");

  return (
    <section className="mt-6">
      <SectionHeader
        label={`★ Todos (${open.length})`}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        right={
          <>
            <span className="text-2xs text-ink-4">✓ to complete · ✕ to delete</span>
            <button
              type="button"
              data-testid="todos-done-link"
              onClick={() => setDoneOpen(true)}
              className="text-2xs font-semibold text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
            >
              ✓ Done ({done.length}) →
            </button>
          </>
        }
      />

      {!collapsed && (
        <div className="am-fade-in">
          {open.length === 0 ? (
            <div className="py-3 text-xs text-ink-4">Nothing open. 🎉</div>
          ) : (
            <div data-testid="todos-scroller" className="max-h-[40vh] overflow-y-auto pr-1">
              {/* the columns-1 sm:columns-2 xl:columns-3 masonry is deleted */}
              {open.map((t) => (
                <TodoCard key={t.id} t={t} onOpen={setSelected} />
              ))}
            </div>
          )}
        </div>
      )}

      <DoneDialog open={doneOpen} done={done} onClose={() => setDoneOpen(false)} />
      <TodoModal todo={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
```

- [ ] **Step 4: Write `src/web/components/TodoCard.tsx`**

```tsx
import type { Todo } from "../types.ts";
import { patchTodo, deleteTodo } from "../api.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { Rail, ROW_BASE, ROW_TONE } from "./primitives.tsx";

export function TodoCard({ t, onOpen }: { t: Todo; onOpen?: (t: Todo) => void }) {
  // Stable name so marking done / deleting / adding tweens the list.
  const style: Record<string, string> = { viewTransitionName: `vt-t-${t.id}` };
  return (
    <div
      onClick={() => onOpen?.(t)}
      style={style}
      className={`am-fade-in group flex cursor-pointer items-center py-1.5 ${ROW_BASE} ${ROW_TONE.default}`}
    >
      <Rail>
        <button
          type="button"
          className="am-check inline-flex h-4 w-4 shrink-0 items-center justify-center text-ink-4 transition-colors duration-quick ease-quad hover:text-done"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            patchTodo(t.id, { status: "done" });
          }}
          aria-label="Mark done"
          title="Mark done"
        >
          <StatusGlyph kind="todo" />
        </button>
      </Rail>

      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {/* one-line rows want truncation, not line-clamp-2 */}
        <span className="max-w-[46%] truncate text-sm font-medium text-ink">{t.title}</span>
        {t.note && (
          <span data-testid="note" className="line-clamp-1 min-w-0 flex-1 text-xs text-ink-4">
            {t.note}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2.5 text-2xs">
          {t.for_who && <span className="font-medium text-attention">→ {t.for_who}</span>}
          {t.branch && <span className="text-ink-4">⎇ {t.branch}</span>}
          {t.origin_project && <span className="text-ink-4">{t.origin_project}</span>}
        </div>
        {/* stays in the DOM — opacity does not affect getByLabelText */}
        <button
          type="button"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border-hairline border-transparent text-2xs leading-none text-ink-4 opacity-0 transition-opacity duration-quick ease-quad group-focus-within:opacity-100 group-hover:opacity-100 hover:border-danger/40 hover:bg-danger/[0.12] hover:text-danger"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            deleteTodo(t.id);
          }}
          aria-label="Delete"
          title="Delete"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
```

The ad-hoc `focus-visible:ring-done/50` and `focus-visible:ring-red-400/50` are dropped in favour of the global `:focus-visible` outline from Task 1.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run web-tests/TodosSection.test.tsx web-tests/TodoCard.test.tsx web-tests/Board.test.tsx && npx vitest run`
Expected: `TodosSection.test.tsx (6 tests)`, `TodoCard.test.tsx (7 tests)`, `Board.test.tsx` green (it asserts `Hand off spec`, `→ Maria`, `/Done \(0\)/` through these components); whole suite green.

- [ ] **Step 6: Verify the last un-tokenized colour is gone**

Run: `grep -ran "red-400" src/web/`
Expected: **0 hits**. (Today it prints **one line** — `TodoCard.tsx:32` — which carries all four occurrences: `hover:border-`, `hover:bg-`, `hover:text-`, `focus-visible:ring-`. §1.9's "×4" counts occurrences; `grep` counts lines. Both go to zero together.)

- [ ] **Step 7: Commit**

```bash
git add src/web/components/TodosSection.tsx src/web/components/TodoCard.tsx \
        web-tests/TodosSection.test.tsx web-tests/TodoCard.test.tsx
git commit -m "feat(web): todos become rows on the rail

Masonry → a single column of rows; the ✓ character → a StatusGlyph checkbox in
the rail whose check reveals on hover; delete → progressive disclosure on the
new --danger token, retiring the app's last raw red-400. The Done link moves
into the header and is now reachable while the section is collapsed."
```

---

## Task 7: `TodoModal` + `DoneDialog` (§4.7)

Both stay native `<dialog>` with the same imperative ref + `useEffect` wiring (K11). The `backdrop:bg-black/50` utility is replaced by the theme-aware `dialog::backdrop` rule that Task 1 put in `styles.css` — a hard-coded black backdrop was the one place the light theme leaked a dark surface.

**Files:**
- Rewrite: `src/web/components/TodoModal.tsx`
- Rewrite: `src/web/components/DoneDialog.tsx`
- Test: `web-tests/DoneDialog.test.tsx` (append 2; the 4 existing ones stay untouched)

**Interfaces:**
- Consumes: `StatusGlyph`, `Rail`, `ROW_BASE`, `ROW_TONE` (Task 2).
- Produces: no signature change. `TodoModal(todo, onClose)`, `DoneDialog(open, done, onClose)`.

**Preserved:** `aria-labelledby` on both dialogs, `aria-label="Close"`, the backdrop-click-to-close handler, `viewTransitionName: "vt-donelist"` on the list wrapper (K18), the `runViewTransition` wrapping of page changes (K3), `line-clamp-1` on the row title, the pagination string `1–10 of 12` as one element, and `Prev`/`Next`.

**`DoneDialog.test:15`** does `getAllByText(/^(old|new|mid)$/)` and asserts DOM order — the title must stay its own element and the sort must stay newest-first.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/DoneDialog.test.tsx`:

```tsx
it("marks each done row with the ended glyph in the rail, and no strikethrough", () => {
  const { container } = render(<DoneDialog open done={[mk("a", 1)]} onClose={() => {}} />);
  expect(container.querySelectorAll('[data-glyph="ended"]').length).toBe(1);
  expect(screen.getByText("a").className).toContain("line-clamp-1");
  expect(screen.getByText("a").className).not.toContain("line-through");
});

it("separates rows by rhythm, not by dividers", () => {
  const { container } = render(<DoneDialog open done={[mk("a", 2), mk("b", 1)]} onClose={() => {}} />);
  expect(container.querySelector(".divide-y")).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web-tests/DoneDialog.test.tsx`
Expected: FAIL — no `[data-glyph="ended"]` element; `.divide-y` still present.

- [ ] **Step 3: Write `src/web/components/TodoModal.tsx`**

```tsx
import { useEffect, useRef } from "react";
import type { Todo } from "../types.ts";

export function TodoModal({ todo, onClose }: { todo: Todo | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    try {
      if (todo && !d.open) d.showModal();
      else if (!todo && d.open) d.close();
    } catch {}
  }, [todo]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="todo-modal-title"
      /* the backdrop is theme-aware in styles.css now — no backdrop: utility */
      className="m-auto w-[min(35rem,100vw-2rem)] rounded-xl border-hairline border-border bg-surface-1 p-0 text-ink shadow-pop"
    >
      {todo && (
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 id="todo-modal-title" className="text-base font-semibold">{todo.title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
            >
              ✕
            </button>
          </div>
          {todo.note && (
            <div className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm text-ink-2">
              {todo.note}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
            {todo.for_who && <span className="font-medium text-attention">→ {todo.for_who}</span>}
            {todo.branch && <span>⎇ {todo.branch}</span>}
            {todo.origin_project && <span className="text-ink-4">{todo.origin_project}</span>}
          </div>
          {todo.links && todo.links.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {todo.links.map((l, i) => (
                <li key={i}>
                  {/^https?:\/\//.test(l) ? (
                    <a
                      href={l}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent transition-colors duration-quick ease-quad hover:text-accent-hover"
                    >
                      {l}
                    </a>
                  ) : (
                    <span className="text-ink-3">{l}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </dialog>
  );
}
```

- [ ] **Step 4: Write `src/web/components/DoneDialog.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { Todo } from "../types.ts";
import { ago } from "../time.ts";
import { runViewTransition } from "../viewTransition.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { Rail, ROW_BASE, ROW_TONE } from "./primitives.tsx";

const listStyle: Record<string, string> = { viewTransitionName: "vt-donelist" };

const PAGE_SIZE = 10;

const PAGER =
  "inline-flex h-6 items-center rounded-md px-2 text-ink-3 transition-colors duration-quick ease-quad hover:bg-surface-2 hover:text-ink disabled:opacity-40";

export function DoneDialog({
  open,
  done,
  onClose,
}: {
  open: boolean;
  done: Todo[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    try {
      if (open && !d.open) d.showModal();
      else if (!open && d.open) d.close();
    } catch {}
  }, [open]);

  useEffect(() => {
    if (open) setPage(0);
  }, [open]);

  const sorted = [...done].sort((a, b) => b.updated_at - a.updated_at);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const clamped = Math.min(page, pageCount - 1);
  const start = clamped * PAGE_SIZE;
  const rows = sorted.slice(start, start + PAGE_SIZE);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="done-dialog-title"
      className="m-auto w-[min(35rem,100vw-2rem)] rounded-xl border-hairline border-border bg-surface-1 p-0 text-ink shadow-pop"
    >
      {open && (
        <div className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 id="done-dialog-title" className="text-base font-semibold">Done</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
            >
              ✕
            </button>
          </div>

          {sorted.length === 0 ? (
            <div className="mt-4 text-sm text-ink-3">No completed todos yet.</div>
          ) : (
            <>
              {/* rows separate by rhythm — the divide-y is gone */}
              <ul className="mt-4" style={listStyle}>
                {rows.map((t) => (
                  <li key={t.id} className={`flex items-start py-1.5 ${ROW_BASE} ${ROW_TONE.default}`}>
                    <Rail>
                      <StatusGlyph kind="ended" animate={false} className="text-done" />
                    </Rail>
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-1 text-sm font-medium text-ink">{t.title}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-4">
                        {t.for_who && <span className="font-medium text-attention">→ {t.for_who}</span>}
                        {t.branch && <span>⎇ {t.branch}</span>}
                        {t.origin_project && <span>{t.origin_project}</span>}
                        <span className="tabular-nums">done {ago(t.updated_at)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex items-center justify-between text-xs text-ink-3">
                <button
                  type="button"
                  data-press
                  onClick={() => runViewTransition(() => setPage((p) => Math.max(0, p - 1)))}
                  disabled={clamped === 0}
                  className={PAGER}
                >
                  Prev
                </button>
                <span className="tabular-nums">{start + 1}–{start + rows.length} of {sorted.length}</span>
                <button
                  type="button"
                  data-press
                  onClick={() => runViewTransition(() => setPage((p) => Math.min(pageCount - 1, p + 1)))}
                  disabled={clamped >= pageCount - 1}
                  className={PAGER}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run web-tests/DoneDialog.test.tsx web-tests/TodoModal.test.tsx && npx vitest run`
Expected: `DoneDialog.test.tsx (6 tests)`, `TodoModal.test.tsx (3 tests)`; whole suite green.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/TodoModal.tsx src/web/components/DoneDialog.tsx web-tests/DoneDialog.test.tsx
git commit -m "feat(web): dialogs on surface-1 with a theme-aware backdrop

backdrop:bg-black/50 → a dialog::backdrop rule on --surface-0, so the light
theme stops flashing a black scrim. Done rows reuse the todo row primitive with
an ended glyph in the rail; dividers give way to rhythm; the pager goes ghost.
Native <dialog> + imperative showModal/close is unchanged."
```

---

## Task 8: `WorkflowsSection` + `WorkflowRunCard` + `workflowStatus.ts` (§4.8, §4.9, §4.15)

Two mappings in `workflowStatus.ts` are semantically wrong and the new `--danger` token fixes them: `completed` was `text-working` (completed is not running) and `failed`/`killed` were `text-attention` (attention means *you* are needed; danger means it broke). **Verified during design: no test asserts on `statusClass()`'s return value** — only `data-status-known` is pinned — so the recolour lands with no existing test change.

The phase bar is the one graphical element spent on this section. It is derived entirely from the already-optional `w.phase` (K9), and its width is a **static inline style with no transition**: it is fed by the 5s `workflows` channel and must never animate layout (§5.5).

**Files:**
- Modify: `src/web/workflowStatus.ts` (whole file)
- Rewrite: `src/web/components/WorkflowsSection.tsx`
- Rewrite: `src/web/components/WorkflowRunCard.tsx`
- Create: `web-tests/workflowStatus.test.ts`
- Test: `web-tests/WorkflowRunCard.test.tsx` (append 2; the 10 existing ones stay untouched)

**Interfaces:**
- Consumes: `StatusGlyph`, `ListRow`, `Rail`, `Chip`, `SectionHeader`, `Chevron` (Task 2); test-id `wf-run-row` (Task 0).
- Produces: `statusGlyphKind(label: string): GlyphKind` from `src/web/workflowStatus.ts`. **Task 10 imports it.**

**Seven literals are test-pinned here** and their element boundaries must not move: `research`, `alpha · feat/x` (ONE), `$1.25`, `512K tok`, `phases resolve on completion` (ONE), `Phase 2/4 · Judge` (ONE), `structure unavailable` (ONE), plus `data-status-known` and the `aria-expanded` button whose name matches `/research/`.

- [ ] **Step 1: Write the failing tests**

Create `web-tests/workflowStatus.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { statusClass, statusKnown, statusGlyphKind } from "../src/web/workflowStatus.ts";

describe("workflowStatus", () => {
  it("colours completed as done and failures as danger", () => {
    expect(statusClass("completed")).toBe("text-done"); // was text-working
    expect(statusClass("running")).toBe("text-working");
    expect(statusClass("failed")).toBe("text-danger"); // was text-attention
    expect(statusClass("killed")).toBe("text-danger");
    expect(statusClass("orphaned")).toBe("text-ink-4");
    expect(statusClass("settled")).toBe("text-ink-4");
  });

  it("stays a display hint, never a validator", () => {
    expect(statusKnown("brand-new-status")).toBe(false);
    expect(statusClass("brand-new-status")).toBe("text-ink-4"); // grey, never a throw
    expect(statusGlyphKind("brand-new-status")).toBe("idle"); // hollow ring
  });

  it("maps every known status to a glyph, with no key the class map lacks", () => {
    expect(statusGlyphKind("running")).toBe("working");
    expect(statusGlyphKind("completed")).toBe("ended");
    expect(statusGlyphKind("failed")).toBe("danger");
    expect(statusGlyphKind("killed")).toBe("danger");
    expect(statusGlyphKind("orphaned")).toBe("idle");
    expect(statusGlyphKind("settled")).toBe("idle");
    // The two maps must be edited together, or a run can get a text-danger
    // label under an idle ring.
    for (const k of ["completed", "running", "failed", "killed", "orphaned", "settled"]) {
      expect(statusKnown(k)).toBe(true);
    }
  });
});
```

Append to `web-tests/WorkflowRunCard.test.tsx`:

```tsx
it("pairs the status label with a glyph of the same colour", () => {
  const { container } = render(<WorkflowRunCard w={live({ status: "failed" })} />);
  expect(container.querySelector('[data-glyph="danger"]')).toBeTruthy();
  expect(screen.getByText("failed").className).toContain("text-danger");
});

it("draws the phase bar only when a phase is known, with no transition on its width", () => {
  const { container, rerender } = render(<WorkflowRunCard w={live({ phase: null })} />);
  expect(container.querySelector("[data-phase-bar]")).toBeNull();
  rerender(<WorkflowRunCard w={live({ phase: { index: 2, total: 4, title: "Judge" } })} />);
  const bar = container.querySelector("[data-phase-bar]") as HTMLElement;
  expect(bar.style.width).toBe("50%");
  // fed by the 5s workflows channel — width must never animate layout
  expect(bar.className).not.toContain("transition");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web-tests/workflowStatus.test.ts web-tests/WorkflowRunCard.test.tsx`
Expected: FAIL — `statusGlyphKind is not a function`; `statusClass("completed")` returns `"text-working"`; no `[data-phase-bar]`.

- [ ] **Step 3: Write `src/web/workflowStatus.ts`**

```ts
import type { GlyphKind } from "./components/StatusGlyph.tsx";

// Known statuses get a colour; anything else renders grey rather than being
// rejected. Claude Code's vocabulary has already grown once ("failed"), so this
// map is a display hint, never a validator.
const WF_STATUS_CLASS: Record<string, string> = {
  completed: "text-done", // completed is not running
  running: "text-working",
  failed: "text-danger", // attention means YOU are needed; danger means it broke
  killed: "text-danger",
  orphaned: "text-ink-4",
  settled: "text-ink-4",
};

/** The glyph half of the same display hint. Its keys are EXACTLY
 *  WF_STATUS_CLASS's keys — the two maps must be edited together, or a run can
 *  get a text-danger label under an idle ring. `w.state` is server-derived and
 *  only ever running/settled/orphaned; `w.status` is Claude Code's own
 *  unvalidated vocabulary, which is what the ?? fallback is for. */
const WF_STATUS_GLYPH: Record<string, GlyphKind> = {
  running: "working",
  completed: "ended",
  failed: "danger",
  killed: "danger",
  orphaned: "idle",
  settled: "idle",
};

export function statusKnown(label: string): boolean {
  return Object.prototype.hasOwnProperty.call(WF_STATUS_CLASS, label);
}

export function statusClass(label: string): string {
  return WF_STATUS_CLASS[label] ?? "text-ink-4";
}

export function statusGlyphKind(label: string): GlyphKind {
  return WF_STATUS_GLYPH[label] ?? "idle"; // unknown → hollow ring, never a throw
}
```

- [ ] **Step 4: Write `src/web/components/WorkflowsSection.tsx`**

```tsx
import type { LiveWorkflow } from "../types.ts";
import { useNow } from "../useNow.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { SectionHeader } from "./primitives.tsx";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";

/** Live workflow strip. Renders NOTHING when no run is live — zero vertical
 *  footprint on non-workflow days, which matters given how hard the board is
 *  already fighting for space. Inner-scrolls like TodosSection. */
export function WorkflowsSection({ workflows }: { workflows: LiveWorkflow[] }) {
  // 1Hz re-render so each row's elapsed timer ticks.
  useNow();
  const [collapsed, toggleCollapsed] = usePersistedToggle("am-workflows-collapsed");
  if (workflows.length === 0) return null;

  return (
    <section className="mt-6">
      <SectionHeader
        label={`⚙ Workflows (${workflows.length})`}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        right={
          <a
            href="#/workflows"
            className="text-2xs text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
          >
            history →
          </a>
        }
      />
      {!collapsed && (
        <div className="am-fade-in max-h-[40vh] overflow-y-auto pr-1">
          {workflows.map((w) => (
            <WorkflowRunCard key={w.run_id} w={w} />
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Write `src/web/components/WorkflowRunCard.tsx`**

```tsx
import type { LiveWorkflow } from "../types.ts";
import { formatUsd, formatTokens, prettyModel } from "../cost.ts";
import { formatDuration } from "../time.ts";
import { statusClass, statusKnown, statusGlyphKind } from "../workflowStatus.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { ListRow, Rail, Chip, Chevron } from "./primitives.tsx";

/** Agent rows keep the 5px dot and do NOT use StatusGlyph: they sit one rail
 *  level in, and a second glyph family there over-signals a sub-list. */
const AGENT_DOT: Record<string, string> = {
  running: "bg-working am-pulse",
  done: "bg-idle",
  abandoned: "bg-attention/60",
};

export function WorkflowRunCard({ w }: { w: LiveWorkflow }) {
  const [collapsed, toggleCollapsed] = usePersistedToggle(`am-wf-${w.run_id}`);
  const label = w.status ?? w.state;
  const title = w.name ?? w.run_id;
  const pct = w.phase ? Math.round((w.phase.index / w.phase.total) * 100) : 0;

  return (
    <ListRow data-testid="wf-run-row" className="am-fade-in py-1.5">
      <div className="flex items-center">
        <Rail>
          {/* colour comes from statusClass, so glyph and label always agree */}
          <StatusGlyph kind={statusGlyphKind(label)} className={statusClass(label)} />
        </Rail>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-ink transition-colors duration-quick ease-quad hover:text-accent"
          >
            <Chevron open={!collapsed} />
            {title}
          </button>
          <span className="shrink-0 font-mono text-2xs text-ink-4">{w.project} · {w.branch ?? "—"}</span>
          <span
            data-status-known={String(statusKnown(label))}
            className={`shrink-0 text-2xs font-medium ${statusClass(label)}`}
          >
            {label}
          </span>
          {!w.schema_ok && <Chip>structure unavailable</Chip>}
          <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-ink-3">
            {/* Ticks because WorkflowsSection re-renders at 1Hz via useNow(). */}
            {w.started_at != null ? formatDuration(Date.now() - w.started_at) : "—"}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-rail font-mono text-2xs">
        <span className="text-ink-4">
          {w.phase ? `Phase ${w.phase.index}/${w.phase.total} · ${w.phase.title}` : "phases resolve on completion"}
        </span>
        <span className="text-ink">{formatUsd(w.costUsd)}</span>
        <span className="text-ink-4">{formatTokens(w.tokens)} tok</span>
      </div>

      {w.phase && (
        <div className="pl-rail">
          <div className="h-0.5 rounded bg-surface-3">
            {/* NO transition: this is fed by the 5s workflows channel and must
                not animate layout (§5.5 rule 1). */}
            <div data-phase-bar="true" className="h-full rounded bg-working/50" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {!collapsed && (
        <div className="mt-1 flex flex-col">
          {w.agents.map((a) => (
            <div key={a.agent_id} className="flex h-6 min-w-0 items-center gap-2 pl-10 font-mono text-2xs">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_DOT[a.state ?? ""] ?? "bg-idle"}`} />
              {/* Labels live only in the manifest, so agentId is the common live case. */}
              <span className="truncate text-ink-2">{a.label ?? a.agent_id}</span>
              <span className="shrink-0 text-ink-4">{a.model ? prettyModel(a.model) : "—"}</span>
              <span className="w-14 shrink-0 text-right tabular-nums text-ink-4">{formatTokens(a.tokens)}</span>
              {a.last_tool && <span className="truncate text-working/70">▸ {a.last_tool}</span>}
            </div>
          ))}
        </div>
      )}
    </ListRow>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run web-tests/workflowStatus.test.ts web-tests/WorkflowRunCard.test.tsx web-tests/Board.test.tsx web-tests/App.test.tsx && npx vitest run && bun run typecheck`
Expected: `workflowStatus.test.ts (3 tests)`, `WorkflowRunCard.test.tsx (12 tests)`; `Board.test.tsx` and `App.test.tsx` still green (both assert `getByRole("button", { name: /Workflows \(1\)/ })` through `SectionHeader`); whole suite green.

- [ ] **Step 7: Commit**

```bash
git add src/web/workflowStatus.ts src/web/components/WorkflowsSection.tsx \
        src/web/components/WorkflowRunCard.tsx web-tests/workflowStatus.test.ts \
        web-tests/WorkflowRunCard.test.tsx
git commit -m "feat(web): workflow runs become rows, with a phase bar and honest colours

completed was text-working and failed/killed were text-attention; they are now
text-done and text-danger. WF_STATUS_GLYPH pairs each status with a glyph off
the same keys, so label and ring can never disagree. The card becomes a row and
gains a 2px phase bar derived entirely from the already-optional w.phase — a
static width with no transition, because it is fed by the 5s channel."
```

---

## Task 9: sidebar panels — `ToolStats`, `CostPanel`, `CostBreakdown`, `ActivityFeed` (§4.10–§4.13)

Four panels, one commit, because they share `<MeterRow>` and `<SectionHeader>` and the whole point is that they read as **one system**. Two changes carry most of the value:

1. **The proportional bars go neutral** (`bg-primary/10` → `bg-bar`). The sidebar stops competing with the board for accent colour — the single biggest hierarchy win in the restyle.
2. **ActivityFeed rows lose their card entirely** (`rounded-lg border bg-card/60 shadow-card` → `ROW_BASE` + `py-1`). ~20 boxes become 20 lines: the largest single noise reduction in the app.

Two smaller pieces of housekeeping ride along because this is the commit that removes the code they were waiting on: **CostBreakdown's NUL-byte key separator gets swapped for a printable one** (Step 5, verified in Step 9), and **the now-fully-unused `shadow-card` boxShadow token comes out of `tailwind.config.js`** (Step 7) — both decided in §10.5/§1.9 rather than left open.

**Files:**
- Rewrite: `src/web/components/ToolStats.tsx`
- Rewrite: `src/web/components/CostPanel.tsx`
- Rewrite: `src/web/components/CostBreakdown.tsx`
- Rewrite: `src/web/components/ActivityFeed.tsx`
- Trim: `tailwind.config.js` (drops the `card` `boxShadow` key)
- Test: `web-tests/ToolStats.test.tsx` (append 1), `web-tests/CostPanel.test.tsx` (append 1), `web-tests/CostBreakdown.test.tsx` (append 1), `web-tests/ActivityFeed.test.tsx` (append 1)

**Interfaces:**
- Consumes: `SectionHeader`, `MeterRow`, `ROW_BASE`, `ROW_TONE`, `Rail` (Task 2); test-ids `cost-today`, `cost-live-total` (Task 0).
- Produces: no signature change on any of the four.

**Preserved:** all three `return null` zero-footprint guards (K8); `byProject`/`byBranch` `?? []` (K9); `max-h-[calc(100vh-8rem)]` on the feed (K7); `aria-label="Number of tool calls to show"`; the API-equiv `title`; the exact strings `Waiting for tool activity…`, `⚡ Live activity` (⚡ in the **same text run** as the label), `Σ Tool usage (n)`, `≣ Cost breakdown`, `today`, `live total`, `+n more`; `toolDot()` untouched (K17); `viewTransitionName: vt-a-${a.id}` (K18).

> **`CostBreakdown.tsx` contains a literal NUL byte** inside the branch-row React key (`` `${b.project}\x00${b.branch ?? ""}` ``, offset 2483). **Decided: swap it here** (§10.5) — Step 5 below replaces it with a printable, collision-proof separator (`'␟'`, U+241F) rather than copying the NUL byte forward. This is the one place in the whole plan where `CostBreakdown.tsx`'s branch-row key is *meant* to change byte-for-byte; every other file's untouched bytes (§Byte-level warnings) stay exactly as they are.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/ToolStats.test.tsx`:

```tsx
it("draws a neutral proportional bar, not an accent one", () => {
  const { container } = render(<ToolStats stats={stats} />);
  const bars = container.querySelectorAll("[data-meter-bar]");
  expect(bars.length).toBe(2);
  expect((bars[0] as HTMLElement).className).toContain("bg-bar");
  expect(container.innerHTML).not.toContain("bg-primary/10");
});
```

Append to `web-tests/CostPanel.test.tsx`:

```tsx
it("reads as a 2-up grid with today primary and live total one step back", () => {
  render(<CostPanel cost={cost} />);
  expect(screen.getByTestId("cost-today").textContent).toBe("$12.40");
  expect(screen.getByTestId("cost-live-total").textContent).toBe("$3.71");
  expect(screen.getByTestId("cost-today").className).toContain("text-ink");
  expect(screen.getByTestId("cost-live-total").className).toContain("text-ink-3");
});
```

Append to `web-tests/CostBreakdown.test.tsx`:

```tsx
it("uses the same MeterRow grid as ToolStats so the two panels read as one", () => {
  const { container } = render(<CostBreakdown cost={cost} />);
  const bars = container.querySelectorAll("[data-meter-bar]");
  expect(bars.length).toBe(4); // 2 projects + 2 branches
  expect((bars[0] as HTMLElement).className).toContain("bg-bar");
});
```

Append to `web-tests/ActivityFeed.test.tsx`:

```tsx
it("draws rows as lines, not cards", () => {
  const { container } = render(
    <ActivityFeed activity={[act(1, "s1", "Bash", "git status", 1234)]} sessions={[session("s1", "p")]} />
  );
  const li = container.querySelector("li")!;
  expect(li.className).not.toContain("border");
  expect(li.className).not.toContain("shadow-card");
  expect(li.className).toContain("am-row-in");
  // the stagger is capped so a 100-row feed does not cascade for 3 seconds
  expect(li.style.animationDelay).toBe("0ms");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web-tests/ToolStats.test.tsx web-tests/CostPanel.test.tsx web-tests/CostBreakdown.test.tsx web-tests/ActivityFeed.test.tsx`
Expected: FAIL — no `[data-meter-bar]` elements; `cost-today` is `text-muted-foreground`; the feed `<li>` still carries `border` and `shadow-card`.

- [ ] **Step 3: Write `src/web/components/ToolStats.tsx`**

```tsx
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
```

`overflow-hidden` is dropped from the row: the bar's width is a percentage *of the row*, so it cannot overflow horizontally, and `inset-y-[0.125rem]` insets it vertically — there is nothing left to clip.

- [ ] **Step 4: Write `src/web/components/CostPanel.tsx`**

```tsx
import type { Cost } from "../types.ts";
import { formatUsd, prettyModel } from "../cost.ts";
import { SectionHeader } from "./primitives.tsx";

export function CostPanel({ cost }: { cost: Cost }) {
  if (cost.liveTotalUsd === 0 && cost.todayUsd === 0) return null;

  return (
    <section className="mt-6">
      <SectionHeader
        label="Session cost"
        leading={<span aria-hidden="true" className="text-ink-4">$</span>}
        right={
          <span
            className="text-3xs text-ink-4"
            title="Notional API-equivalent cost — subscription plans aren't billed per token."
          >
            API-equiv
          </span>
        }
      />
      {/* the one place a number is allowed to be bigger */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-2xs text-ink-4">today</div>
          <div
            data-testid="cost-today"
            className="font-mono text-base font-medium tabular-nums slashed-zero text-ink"
          >
            {formatUsd(cost.todayUsd)}
          </div>
        </div>
        <div>
          <div className="text-2xs text-ink-4">live total</div>
          <div
            data-testid="cost-live-total"
            className="font-mono text-base tabular-nums slashed-zero text-ink-3"
          >
            {formatUsd(cost.liveTotalUsd)}
          </div>
        </div>
      </div>
      <ul className="mt-2">
        {cost.byModelToday.map((m) => (
          <li key={m.model} className="flex h-5 items-center gap-2 font-mono text-2xs">
            <span className="min-w-0 flex-1 truncate text-ink-4">{prettyModel(m.model)}</span>
            <span className="tabular-nums slashed-zero text-ink-4">{formatUsd(m.costUsd)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Write `src/web/components/CostBreakdown.tsx`**

```tsx
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
  rows: { key: string; label: string; costUsd: number; tokens: number }[];
  total: number;
}) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, TOP);
  const max = shown[0]?.costUsd || 1; // rows arrive sorted by cost desc
  return (
    <>
      <div className="mt-3 flex h-5 items-center text-3xs uppercase tracking-caps text-ink-4">{label}</div>
      <ul>
        {shown.map((r) => (
          <MeterRow
            key={r.key}
            frac={r.costUsd / max}
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
        label="Cost breakdown"
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
```

- [ ] **Step 6: Write `src/web/components/ActivityFeed.tsx`**

```tsx
import type { Activity, Session } from "../types.ts";
import { ago } from "../time.ts";
import { prettyTool, toolDot, formatDur } from "../tools.ts";
import { useFeedLimit } from "../useFeedLimit.ts";
import { SectionHeader, Rail, ROW_BASE, ROW_TONE } from "./primitives.tsx";

/** Bottom fade so the feed ends instead of being guillotined. React does not
 *  auto-prefix maskImage, so BOTH properties are set to the SAME value. rem,
 *  not px, so the fade scales with the text-size ladder. */
const FADE = "linear-gradient(to bottom,#000 calc(100% - 1.5rem),transparent)";

export function ActivityFeed({ activity, sessions }: { activity: Activity[]; sessions: Session[] }) {
  const { limit, setLimit, options } = useFeedLimit();
  const projectFor = (id: string) => sessions.find((s) => s.id === id)?.project ?? "—";
  const rows = activity.slice(0, limit);

  return (
    <section className="mt-6">
      <SectionHeader
        label="⚡ Live activity"
        leading={
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="am-ping absolute inline-flex h-full w-full rounded-full bg-accent/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
        }
        right={
          <div className="group relative inline-flex items-center">
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              aria-label="Number of tool calls to show"
              className="h-6 cursor-pointer appearance-none rounded-md border-hairline border-border bg-transparent pl-2 pr-6 text-2xs text-ink-3 transition-colors duration-quick ease-quad hover:text-ink"
            >
              {options.map((n) => (
                <option key={n} value={n}>last {n}</option>
              ))}
            </select>
            <svg
              aria-hidden="true"
              viewBox="0 0 12 12"
              className="pointer-events-none absolute right-2 h-2.5 w-2.5 text-ink-4"
            >
              <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        }
      />

      <div
        className="max-h-[calc(100vh-8rem)] overflow-y-auto pr-0.5"
        style={{ WebkitMaskImage: FADE, maskImage: FADE }}
      >
        {rows.length === 0 ? (
          <div className="py-6 text-center text-2xs text-ink-4">Waiting for tool activity…</div>
        ) : (
          <ul>
            {rows.map((a, i) => {
              // animationDelay → staggered cascade on load; viewTransitionName →
              // existing rows slide down when a newer call is inserted on top.
              const liStyle: Record<string, string> = {
                animationDelay: `${Math.min(i, 6) * 16}ms`,
                viewTransitionName: `vt-a-${a.id}`,
              };
              return (
                <li key={a.id} style={liStyle} className={`am-row-in py-1 font-mono text-2xs ${ROW_BASE} ${ROW_TONE.default}`}>
                  <div className="flex items-center">
                    <Rail>
                      <span className={`h-1.5 w-1.5 rounded-full ${toolDot(a.tool)}`} />
                    </Rail>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="shrink-0 font-medium text-ink">{prettyTool(a.tool)}</span>
                      {a.dur != null && <span className="shrink-0 tabular-nums text-ink-4">{formatDur(a.dur)}</span>}
                      <span className="ml-auto shrink-0 tabular-nums text-ink-4">{ago(a.at)}</span>
                    </div>
                  </div>
                  <div className="flex items-baseline gap-2 pl-rail">
                    <span className="min-w-0 flex-1 truncate text-ink-3">{a.detail ?? ""}</span>
                    <span className="shrink-0 text-ink-4">{projectFor(a.session_id)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
```

The `space-y-2` between rows is gone (rows separate by rhythm), and so is the bordered empty-state box.

- [ ] **Step 7: Trim the now-unused `shadow-card` token from `tailwind.config.js`**

`ActivityFeed` (Step 6, above) was the last remaining consumer of the `shadow-card` class in `src/web/` — `SessionCard`/`TodoCard` dropped it in Tasks 5/6, `TodoModal`/`DoneDialog` moved to `shadow-pop` in Task 7, and `WorkflowRunCard` deleted its whole card wrapper in Task 8. Confirm that, then remove the token (§1.9 — decided: dropped, not reserved):

```bash
grep -ran "shadow-card" src/web/
```
Expected: **0 hits.** If anything prints, stop — a consumer was missed and the token cannot come out yet.

Remove the `card` key from the `boxShadow` map in `tailwind.config.js` (added in Task 1, Step 2), leaving only `pop`:

```js
      boxShadow: {
        pop: "0 8px 32px hsl(var(--shadow) / var(--shadow-a)), 0 1px 2px hsl(var(--shadow) / calc(var(--shadow-a) * .6))",
      },
```

```bash
grep -n "card:" tailwind.config.js
```
Expected: **0 hits** — the token is gone from the config, not just unreferenced by components.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run web-tests/ToolStats.test.tsx web-tests/CostPanel.test.tsx web-tests/CostBreakdown.test.tsx web-tests/ActivityFeed.test.tsx web-tests/Board.test.tsx && npx vitest run && bun run typecheck && bun run web:build`
Expected: `ToolStats (4)`, `CostPanel (3)`, `CostBreakdown (5)`, `ActivityFeed (6)`, `Board` green (it asserts `⚡ Live activity` and `Bash` through these); whole suite green; `web:build` succeeds — proof the trimmed `boxShadow` map is still valid Tailwind config.

- [ ] **Step 9: Verify the key separator swap, not just the NUL byte's absence**

```bash
python3 -c "
d = open('src/web/components/CostBreakdown.tsx', 'rb').read()
print('NUL present:', b'\x00' in d)
print('unit separator present:', '␟'.encode('utf-8') in d)"
file src/web/components/CostBreakdown.tsx
```
Expected: `NUL present: False`, `unit separator present: True`, and `file` now reports the source as text (e.g. `Unicode text, UTF-8 text`), not `data`. If the NUL is still present, Step 5 was skipped or reverted. If the unit separator is absent, the character was mangled in transit — check the file was saved as UTF-8, not Latin-1 or Windows-1252.

This is the one file in the whole plan whose byte content is *meant* to change (§Byte-level warnings lists the ones that are not).

- [ ] **Step 10: Commit**

```bash
git add src/web/components/ToolStats.tsx src/web/components/CostPanel.tsx \
        src/web/components/CostBreakdown.tsx src/web/components/ActivityFeed.tsx \
        tailwind.config.js web-tests
git commit -m "feat(web): sidebar panels share one MeterRow grid; feed rows lose their cards

ToolStats and CostBreakdown now render the identical h-6 meter row with the
same right-aligned numeric slots, and the proportional bar goes neutral —
the sidebar stops competing with the board for accent colour. ActivityFeed's
~20 bordered cards become ~20 lines with a bottom fade. CostPanel becomes a
2-up readout with today primary.

Also: CostBreakdown's branch-row React key drops its literal NUL byte for a
printable unit-separator character (D7, §10.5), and the now-fully-unused
shadow-card boxShadow token comes out of tailwind.config.js (§1.9)."
```

---

## Task 10: `CostDailyPage` + `WorkflowsPage` — one shared table treatment (§3.2, §4.14, §4.16)

Both pages get the identical chrome (`<PageHeader>` + `<Segmented>`) and the identical table treatment. Tables run **full-bleed to the container edges** — no wrapper card. `WorkflowsPage` gains a disclosure caret in the name cell, so the clickable rows finally show that they are clickable.

**Depends on Task 8** — `statusGlyphKind` lives in `src/web/workflowStatus.ts`.

**Files:**
- Rewrite: `src/web/components/CostDailyPage.tsx`
- Rewrite: `src/web/components/WorkflowsPage.tsx`
- Test: `web-tests/CostDailyPage.test.tsx` (append 2), `web-tests/WorkflowsPage.test.tsx` (append 2)

**Interfaces:**
- Consumes: `PageHeader`, `Segmented`, `Chip`, `Chevron`, `StatusGlyph` (Task 2); `statusGlyphKind` (Task 8); test-ids `cost-row`, `wf-row` (Task 0).

**Four hard constraints on this task:**
1. **No `<button>` may exist whose accessible name contains "cost", other than the Cost column header.** `CostDailyPage.test:34` and `WorkflowsPage.test:75` do `getByRole("button", { name: /cost/i })`. `← Dashboard` is an `<a>`; the page title is a `<span>`.
2. `<Segmented>` item names must be exactly `7d` / `14d` / `30d` / `All` (`/^all$/i`).
3. The **totals row stays the last `<tr>` in `<tbody>`** and no `<tr>` may be inserted before the data rows. Its `data-testid="wf-totals"` and its **8 `<td>`s** are untouched.
4. The caret in the Workflow-name cell **must be an SVG with no text content** — `WorkflowsPage.test:92` does `fireEvent.click(await findByText("research"))`, which resolves by text content.

**Table treatment, both pages:**
- `table w-full border-collapse font-mono text-xs` (12px, up from 11px — these are reading surfaces, not chrome).
- `thead th`: `sticky top-12 z-10 h-8 bg-surface-0 border-b border-border` — **opaque, not blurred.** Two stacked blur layers per page is exactly the paint cost R6 rules out.
- `tbody tr`: `h-8 border-b border-border-weak hover:bg-surface-2`. Row dividers use a **plain 1px `border-b`, not `border-hairline`** — a 0.5px border inside `border-collapse: collapse` can vanish at some zoom levels (R8). No vertical rules, no zebra striping.
- `td`: `px-2 py-[0.3125rem]`; first text column `text-ink font-medium`; other text columns `text-ink-3`; numerics `text-right tabular-nums slashed-zero`, money at `text-ink`, tokens at `text-ink-4`.
- Page-level states: `py-16 text-center text-sm text-ink-3`, with `role="status" aria-live="polite"` on the **loading branch only**.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/CostDailyPage.test.tsx`:

```tsx
it("exposes exactly one button whose name matches /cost/i — the column header", async () => {
  mockFetch(ROWS);
  render(<CostDailyPage />);
  await screen.findByText("alpha");
  expect(screen.getAllByRole("button", { name: /cost/i }).length).toBe(1);
  expect(screen.getByText("← Dashboard").tagName).toBe("A");
  expect(screen.getByText("Cost by day").tagName).toBe("SPAN");
});

it("announces the loading state to assistive tech", () => {
  mockFetch(ROWS);
  render(<CostDailyPage />);
  const loading = screen.getByText("Loading…");
  expect(loading.getAttribute("role")).toBe("status");
  expect(loading.getAttribute("aria-live")).toBe("polite");
});
```

Append to `web-tests/WorkflowsPage.test.tsx`:

```tsx
it("marks each run with a glyph that agrees with its status label", async () => {
  mockFetch(RUNS);
  const { container } = render(<WorkflowsPage />);
  await screen.findByText("research");
  expect(container.querySelector('[data-glyph="ended"]')).toBeTruthy(); // completed
  expect(screen.getByText("completed").className).toContain("text-done");
});

it("keeps the totals row last in tbody with its 8 cells", async () => {
  mockFetch(RUNS);
  render(<WorkflowsPage />);
  await screen.findByText("research");
  const totals = screen.getByTestId("wf-totals");
  expect(totals.querySelectorAll("td").length).toBe(8);
  expect(totals.parentElement!.lastElementChild).toBe(totals);
  // the caret must carry no text, or findByText("research") stops resolving
  expect(screen.getAllByTestId("wf-row")[0].querySelector("svg")).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web-tests/CostDailyPage.test.tsx web-tests/WorkflowsPage.test.tsx`
Expected: FAIL — `Loading…` has no `role`; no `[data-glyph="ended"]`; no `svg` in the first data row.

- [ ] **Step 3: Write `src/web/components/CostDailyPage.tsx`**

Keep every line of logic (`useEffect` fetch, `sorted` memo, `toggleSort`) **exactly as it is today**; only the returned markup changes.

```tsx
import { useEffect, useMemo, useState } from "react";
import { formatUsd, formatTokens, formatDay, costDailyRange, type CostWindow } from "../cost.ts";
import { PageHeader, Segmented } from "./primitives.tsx";

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
  const [range, setRange] = useState<CostWindow>(14);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "day", dir: "desc" });

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const { since } = costDailyRange(range, Date.now());
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
  }, [range]);

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
    <div className="mx-auto max-w-page px-6 pb-16">
      <PageHeader
        title="Cost by day"
        right={
          <Segmented
            value={range}
            onChange={setRange}
            options={WINDOWS.map((w) => ({ value: w, label: w === "all" ? "All" : `${w}d` }))}
          />
        }
      />

      {status === "error" ? (
        <p className="py-16 text-center text-sm text-ink-3">Couldn't load cost data.</p>
      ) : status === "loading" ? (
        <p role="status" aria-live="polite" className="py-16 text-center text-sm text-ink-3">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-3">No usage in this window.</p>
      ) : (
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={`sticky top-12 z-10 h-8 border-b border-border bg-surface-0 px-2 text-left font-normal ${c.numeric ? "text-right" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c)}
                    className="inline-flex items-center gap-1 text-2xs uppercase tracking-caps text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
                  >
                    {c.label}
                    {sort.key === c.key && <span aria-hidden="true" className="text-3xs">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={`${r.project}/${r.branch ?? ""}/${r.day}`}
                data-testid="cost-row"
                className="h-8 border-b border-border-weak transition-colors duration-quick ease-quad hover:bg-surface-2"
              >
                <td className="px-2 py-[0.3125rem] font-medium text-ink">{r.project}</td>
                <td className="px-2 py-[0.3125rem] text-ink-3">{r.branch ?? "—"}</td>
                <td className="px-2 py-[0.3125rem] text-ink-3">{formatDay(r.day)}</td>
                <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink">{formatUsd(r.costUsd)}</td>
                <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink-4">{formatTokens(r.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

**`Couldn't load cost data.` uses an ASCII apostrophe here.** Copy the string from the old file.

- [ ] **Step 4: Write `src/web/components/WorkflowsPage.tsx`**

Keep `sortValue`, `byPhase`, the `useEffect` fetch, `sorted`, `totals`, `toggleSort` and `toggleOpen` **exactly as they are today**. Only the returned markup changes. The full new `return` block, plus the two imports to add:

```tsx
import { statusClass, statusKnown, statusGlyphKind } from "../workflowStatus.ts";
import { PageHeader, Segmented, Chip, Chevron } from "./primitives.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";
```

```tsx
  return (
    <div className="mx-auto max-w-board px-6 pb-16">
      <PageHeader
        title="Workflow runs"
        right={
          <Segmented
            value={range}
            onChange={setRange}
            options={WINDOWS.map((w) => ({ value: w, label: w === "all" ? "All" : `${w}d` }))}
          />
        }
      />

      {/* Same four states, in the same order, as CostDailyPage: error → loading →
          empty → table. Without the loading branch the totals row renders "0 runs"
          for one frame on every window change. */}
      {status === "error" ? (
        <p className="py-16 text-center text-sm text-ink-3">Couldn’t load workflow runs.</p>
      ) : status === "loading" ? (
        <p role="status" aria-live="polite" className="py-16 text-center text-sm text-ink-3">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-3">No workflow runs in this window.</p>
      ) : (
        <>
          <table className="w-full border-collapse font-mono text-xs">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={`sticky top-12 z-10 h-8 border-b border-border bg-surface-0 px-2 text-left font-normal ${c.numeric ? "text-right" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c)}
                      className="inline-flex items-center gap-1 text-2xs uppercase tracking-caps text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
                    >
                      {c.label}
                      {sort.key === c.key && <span aria-hidden="true" className="text-3xs">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const label = r.status ?? r.state;
                return [
                  <tr
                    key={r.run_id}
                    data-testid="wf-row"
                    onClick={() => toggleOpen(r.run_id)}
                    className="h-8 cursor-pointer border-b border-border-weak transition-colors duration-quick ease-quad hover:bg-surface-2"
                  >
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums text-ink-3">{formatWhen(r.started_at)}</td>
                    <td className="px-2 py-[0.3125rem] font-medium text-ink">
                      {/* SVG only — no text content, or findByText("research") stops resolving */}
                      <span className="mr-1.5 inline-flex align-[-0.1em]">
                        <Chevron open={open.has(r.run_id)} />
                      </span>
                      {r.name ?? r.run_id}
                      {!r.schema_ok && (
                        <Chip className="ml-1.5">structure unavailable</Chip>
                      )}
                    </td>
                    <td className="px-2 py-[0.3125rem] text-ink-3">
                      {r.project} · {r.branch ?? "—"}
                    </td>
                    {/* `label` MUST stay a direct text child of the <td>:
                        testing-library's getByText reads only an element's own
                        text nodes, so wrapping it in a span would move both
                        `data-status-known` assertions off the matched element
                        (WorkflowsPage.test:57-59). The glyph is a sibling. */}
                    <td data-status-known={String(statusKnown(label))} className={`px-2 py-[0.3125rem] ${statusClass(label)}`}>
                      <span className="mr-1.5 inline-flex align-[-0.1em]">
                        <StatusGlyph kind={statusGlyphKind(label)} animate={false} />
                      </span>
                      {label}
                    </td>
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums text-ink-3">{formatDuration(r.duration_ms)}</td>
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums text-ink-3">{r.agents.length}</td>
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink-4">{formatTokens(r.tokens)}</td>
                    <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero text-ink">{formatUsd(r.costUsd)}</td>
                  </tr>,
                  open.has(r.run_id) ? (
                    <tr key={`${r.run_id}-detail`} className="border-b border-border-weak bg-surface-1">
                      <td colSpan={COLS.length} className="px-3 py-2">
                        {byPhase(r.agents).map((g) => (
                          <div key={g.title} className="mb-2 last:mb-0">
                            <div className="text-3xs uppercase tracking-caps text-ink-4">{g.title}</div>
                            {/* the rail one more time, now as a tree: a hairline
                                connecting agents under their phase */}
                            <div className="ml-rail border-l-hairline border-border-weak pl-3">
                              {g.agents.map((a) => (
                                <div key={a.agent_id} className="flex h-6 flex-wrap items-center gap-3 text-2xs">
                                  <span className="font-medium text-ink">{a.label ?? a.agent_id}</span>
                                  <span className="text-ink-3">{a.model ? prettyModel(a.model) : "—"}</span>
                                  <span className="text-ink-3">{a.state ?? "—"}</span>
                                  <span className="text-ink-4">attempt {a.attempt ?? 1}</span>
                                  <span className="text-ink-4">{formatDuration(a.duration_ms)}</span>
                                  <span className="tabular-nums slashed-zero text-ink-4">{formatTokens(a.tokens)}</span>
                                  <span className="tabular-nums slashed-zero text-ink">{formatUsd(a.costUsd)}</span>
                                  {a.last_tool_summary && <span className="truncate text-working/70">▸ {a.last_tool_summary}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
              <tr data-testid="wf-totals" className="border-t border-border bg-surface-1 font-semibold text-ink">
                <td className="px-2 py-[0.3125rem]" />
                <td className="px-2 py-[0.3125rem]">{sorted.length} runs</td>
                <td className="px-2 py-[0.3125rem]" />
                <td className="px-2 py-[0.3125rem]" />
                <td className="px-2 py-[0.3125rem]" />
                <td className="px-2 py-[0.3125rem] text-right tabular-nums">{totals.agents}</td>
                <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero">{formatTokens(totals.tokens)}</td>
                <td className="px-2 py-[0.3125rem] text-right tabular-nums slashed-zero">{formatUsd(totals.cost)}</td>
              </tr>
            </tbody>
          </table>
          {sorted.find((r) => r.cc_version)?.cc_version && (
            <p className="mt-3 px-2 text-2xs text-ink-4">
              format last verified on {sorted.find((r) => r.cc_version)!.cc_version}
            </p>
          )}
        </>
      )}
    </div>
  );
```

**`Couldn’t load workflow runs.` uses U+2019 here.** Copy the string from the old file.

**Note on `ml-rail`:** `spacing.rail` feeds margin as well as width and padding, so `ml-rail` emits. If a future Tailwind upgrade drops that, use `ml-5`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run web-tests/CostDailyPage.test.tsx web-tests/WorkflowsPage.test.tsx web-tests/App.test.tsx && npx vitest run && bun run typecheck && bun run web:build`
Expected: `CostDailyPage.test.tsx (7 tests)`, `WorkflowsPage.test.tsx (11 tests)`, `App.test.tsx` green (it does `findByText("Cost by day")` and `findByText("Workflow runs")` through `PageHeader`); whole suite green; typecheck clean; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/CostDailyPage.tsx src/web/components/WorkflowsPage.tsx web-tests
git commit -m "feat(web): shared PageHeader + Segmented + one table treatment for both pages

Tables run full-bleed with an opaque sticky thead (two blur layers per page is
the paint cost R6 rules out), plain 1px row dividers (0.5px vanishes inside
border-collapse), and a status glyph beside each workflow status. The workflow
name cell gains an SVG disclosure caret so the clickable rows show it. Loading
states gain role=status; the totals row and its 8 cells are untouched."
```

---

## Task 11 (ops): real-browser verification — both themes, both ladder extremes (§8.2)

**Not a code change.** This drives a real browser against **live data** and fixes forward whatever it finds. Nothing is "done" until every check below has been *run* and its output *read*.

Every tool named here is prefixed `mcp__plugin_chrome-devtools-mcp_chrome-devtools__` — written short below (`navigate_page`, `take_screenshot`, `evaluate_script`, `resize_page`, `list_console_messages`, `click`, `press_key`, `performance_start_trace`, `performance_stop_trace`).

**Setup.** All of Tasks 3–10 are committed on the branch.

```bash
systemctl --user is-active am-server.service   # expect: active — the dev server proxies to it
bun run web:dev                                # http://127.0.0.1:5317, proxies /api + /events to :4317
```

The dev server renders **real live sessions, todos, workflows and cost** — not fixtures. That is the point: fixtures cannot show you a 12-session idle backlog.

- [ ] **Step 1: V1 — the visual matrix (18 screenshots minimum)**

`resize_page` to **1440×900**, then for each cell: `navigate_page`, `take_screenshot`, `list_console_messages`.

| axis | values |
|---|---|
| route | `#/`, `#/cost`, `#/workflows` |
| theme | dark (default), light — toggle via the **Theme button**, not devtools, so the toggle is exercised |
| text size | 14px (A− ×1), 16px (default), 22px (A+ ×3) |

**Gate:** every screenshot renders; `list_console_messages` is free of errors in all 18. Then repeat `#/` alone at **1280×800** and **390×844** and confirm the `lg:` grid stacks and the sidebar hairline drops.

- [ ] **Step 2: V2 — the ladder extremes (R4, R5)**

At 14px and at 22px, on `#/`:

```js
// no sticky group header may overlap the app bar or a row
const bar = document.querySelector("header").getBoundingClientRect().height;
[...document.querySelectorAll('[data-testid^="session-group-"] > div:first-child')]
  .map(h => ({ id: h.parentElement.dataset.testid, top: h.getBoundingClientRect().top, bar }));
```
**Gate:** every header's `top` is ≥ `bar` when scrolled to it, never negative.

Then, still via `evaluate_script`: the ActivityFeed scroller (`max-h-[calc(100vh-8rem)]`) is not clipped and `scrollTop + clientHeight` can reach `scrollHeight`; on `#/workflows`, `thead th` stays pinned at exactly the page-header height.

**Gate:** rows in the Idle group are still visually separable at 22px. Separation now rests entirely on hover + rail + rhythm. **If they smear:** add `divide-y divide-border-weak` to the **Idle group only** (the densest, lowest-signal list) and re-shoot. That is the pre-authorised R4 fallback — no other group gets dividers.

- [ ] **Step 3: V3 — hairlines at sub-pixel (R8)**

At 1dppx, force the 2dppx branch — the worst case, a 0.5px border on a 1-device-pixel display:

```js
document.documentElement.style.setProperty('--hairline','0.5px')
```

Screenshot the sidebar hairline, the app-bar bottom border, the `<Segmented>` control, the A−/A+ pair and both tables.
**Gate:** **no border disappears.** Table row dividers are plain 1px and must be visibly *unaffected* — if they change at all, a `border-hairline` leaked into a table and must be replaced with `border-b border-border-weak`.

Reset with `document.documentElement.style.removeProperty('--hairline')`.

- [ ] **Step 4: V5 — paint cost of the one blurred layer (R6)**

`performance_start_trace` on `#/`, let it run **20 s** of live SSE ticking, and trigger one `state` commit inside the window by marking a todo done and undoing it. `performance_stop_trace`.

**Gate:** no long task > 50 ms attributable to paint/composite; no layout thrash from the phase bar (its width is a static inline style — if you see layout invalidation on the 5s tick, a `transition` leaked onto it).
**If it fails:** drop the app bar's and `PageHeader`'s `backdrop-blur-[20px]` for a solid `bg-surface-0` (i.e. `bg-surface-0` instead of `bg-surface-0/[0.72] backdrop-blur-[20px]`). Board group headers and table `<thead>` are already opaque, so this is the only blur left to cut.

- [ ] **Step 5: V4 — the vertical-growth gate (R2). The hard one.**

Everything is committed, so the baseline is one checkout away. Take both measurements **within the same minute** so the SSE snapshot is comparable.

```js
// run on BOTH, at 1440×900, on #/
({
  scrollHeight: document.querySelector("main").scrollHeight,
  sessions: [...document.querySelectorAll('[data-testid="session-row"], .am-fade-in')].length,
  firstRowTop: document.querySelector('[data-testid="session-row"], main .am-fade-in')?.getBoundingClientRect().top,
})
```

1. On the branch: record all three.
2. `git checkout main`, restart the dev server, record all three.
3. `git checkout feat/linear-dashboard-redesign`, restart the dev server.

**Gate:** branch `main.scrollHeight` ≤ **1.10 ×** baseline, **and** the first session row is above the fold on the branch whenever it was on the baseline.

Then the **20-session pathological case**, measured rather than guessed. On the branch, via `evaluate_script`:

```js
const h = (sel) => document.querySelector(sel)?.getBoundingClientRect().height ?? 0;
const idle = h('[data-status="idle"]');
const working = h('[data-status="working"]');
const header = h('[data-testid="session-group-idle"] > div:first-child');
({ idle, working, header, projected20: 3 * header + 2 * working + 18 * idle });
```

Compare `projected20` against the baseline kanban's projection (`Math.ceil(20/3) × cardHeight + 3 × columnChrome`, measured the same way on `main`).
**If the gate fails only at 20 sessions**, that is the R2 follow-up (cap the Idle group with its own inner scroll), **not** a blocker — it is a new affordance and ships separately (§10.2). Record the numbers in the merge commit either way.

- [ ] **Step 6: V6 — typography on the real fallback (R9, R13)**

No Inter is installed on this machine; the negative tracking values were tuned for it. Side-by-side screenshot of the AppBar counts and a `#/workflows` numeric column at 16px.

**Gate:** numerals are consistent between the sans and mono stacks; the negative tracking at `text-base` (the CostPanel numbers) does not look cramped on FreeSans; and **`font-medium` row titles are visibly lighter than `font-semibold` headers**. If they look identical and bold, `fontWeight.medium: 510` crept back into `tailwind.config.js` — remove it (R13).

- [ ] **Step 7: V7 — mask + scrollbar (R10)**

Scroll the ActivityFeed to the bottom. Confirm the bottom fade renders and the custom scrollbar thumb is **not clipped** by the mask.
**If it is clipped:** delete the `style={{ WebkitMaskImage: FADE, maskImage: FADE }}` from `ActivityFeed`. It is pure garnish and the first thing to cut.

- [ ] **Step 8: V8 — Motion off. This is the fix, verified in the browser.**

`click` the Motion button, then:

```js
({
  gated: document.documentElement.classList.contains('am-anim'),   // expect false
  running: document.getAnimations().length,                        // expect 0
})
```

**Gate:** `gated: false` **and `running: 0`** — an empty animation list is the §5.3 acceptance and is exactly what is broken on `main` today (three `animate-*` utilities keep running).

Screenshot `#/` and confirm the designed static fallbacks: the working glyph shows its static 3/4-arc at 1–2 o'clock, agent dots are solid at full opacity, and the ActivityFeed ping ring is gone while its solid accent dot remains. Reload with Motion off and confirm **no flash** (the `index.html` bootstrap, K4).

- [ ] **Step 9: V9 — colour contrast, measured not trusted**

Sample the computed colour of each ink step against `--surface-0` and `--surface-1`, in **both** themes.

**Gate:** `text-1` / `text-2` / `text-3` / `text-4` all ≥ **4.5:1**; `accent`, `working`, `attention`, `done`, `danger` as *text* on `surface-0` all ≥ **4.5:1**. The hex comments in `styles.css` are the design's estimates — **re-measure them.** Any step that fails gets its L% adjusted in `styles.css` and the whole V1 matrix re-shot.

- [ ] **Step 10: Focus-visible reaches every real control, and no `<tr>` (R7)**

On `#/workflows`, `press_key Tab` repeatedly and after each press:

```js
({ tag: document.activeElement.tagName, label: document.activeElement.textContent?.slice(0, 24) })
```

**Gate:** the column-header buttons, the `<Segmented>` items and `← Dashboard` all take focus and show the global 2px accent ring; `document.activeElement.tagName` is **never `TR`** — the global ring's `:where(a,button,select,summary,input,[tabindex])` list deliberately excludes them, so it cannot start outlining table rows. Rows staying keyboard-unreachable is a **pre-existing** gap, neither introduced nor worsened here; it is filed as §10.1 and is out of scope.

Repeat on `#/`: `Tab` must reach the AppBar controls, the section-header disclosure buttons, `Mark done` and `Delete` (which becomes visible via `group-focus-within:opacity-100`) — and never a session row.

- [ ] **Step 11: V10 — persistence**

Toggle theme, text size and motion; reload after each. Confirm `localStorage` holds `am-theme`, `am-text-size`, `am-motion` and that the three pre-paint scripts in `index.html` apply them with **no flash** (K4).

- [ ] **Step 12: Fix forward, then re-shoot**

Every finding above has a named, pre-authorised fix. Apply it, re-run the affected check, and commit each fix separately:

```bash
git add -A && git commit -m "fix(web): <finding> found by V<n>"
```

If a finding has **no** pre-authorised fix, stop and re-read the spec section it contradicts rather than inventing a treatment.

---

## Task 12 (ops): full gates, acceptance greps, build + service restart, merge

**Not a code change.** The build and the service restart are **one step, never two** — see the version-skew note below.

- [ ] **Step 1: The automated gates, in this order**

```bash
npx vitest run          # every web test
bun run typecheck       # tsc on both tsconfigs
bun run web:build       # vite build must succeed
bun test tests/         # the SERVER suite — must be untouched; proves scope discipline
```
Expected: all four green. The web suite is 23 original files + 4 new = **27 files**, and 111 original tests + 48 added (Task 2: 18 · 3: 4 · 4: 3 · 5: 4 · 6: 4 · 7: 2 · 8: 5 · 9: 4 · 10: 4) = **159 tests**. A lower number means a task's appended tests were dropped somewhere along the way; a higher one means a test was added that no task authorised.

- [ ] **Step 2: Prove the untouchable files are untouched**

```bash
git diff --exit-code main -- src/web/api.ts src/web/App.tsx src/web/viewTransition.ts \
                     src/web/index.html src/web/useTheme.ts src/web/useTextSize.ts \
                     src/web/useMotion.ts src/web/useNow.ts src/web/useHashRoute.ts \
                     src/web/usePersistedToggle.ts src/web/useFeedLimit.ts \
                     src/web/types.ts src/web/tools.ts src/web/cost.ts src/web/time.ts
git diff --exit-code main -- src/server/ src/cli/ src/mcp/ package.json
```
Expected: **both exit 0, no output.** A non-empty diff on any of these means the redesign crossed its own scope line (K1, K3, K4, K17).

- [ ] **Step 3: The acceptance greps — every one with `-a`**

`src/web/components/CostBreakdown.tsx` held a literal NUL byte through Task 8, which made `grep` classify it as binary and **silently skip it** without `-a` — without the flag, every grep below would have passed green against a half-migrated file (D7). Task 9 already swapped that byte for a printable separator, so by this step `-a` is no longer load-bearing for this specific reason — but it stays on every grep below anyway: it is free, and this is the one gate that must never again depend on remembering which files are secretly binary.

```bash
grep -ran "animate-" src/web/                                    # 0  (4 lines today: ActivityFeed:16, SessionCard:52, SessionCard:65, WorkflowRunCard:8)
grep -ran "dark:" src/web/                                       # 0
grep -ran "red-400\|shadow-card\|bg-primary/10\|border-border/50\|tracking-wide\|text-\[10px\]\|text-\[0.65rem\]" src/web/   # 0 (matches shadow-card and shadow-card-hover both)
grep -n "card:" tailwind.config.js                                # 0 — boxShadow.card is dropped (§1.9), not just unreferenced
grep -ran "muted-foreground/" src/web/                           # 0  (32 today)
grep -ran "cursor-grab" src/web/                                 # 0
grep -ran "max-h-\[40vh\]" src/web/                              # exactly 2 (TodosSection, WorkflowsSection)
grep -ran "max-h-\[calc(100vh-8rem)\]" src/web/                  # exactly 1 (ActivityFeed)
grep -ran "prefers-reduced-motion" src/web/                      # exactly 3 (useMotion.ts, viewTransition.ts, styles.css)
grep -ranE "\[[0-9]+px\]" src/web/components/                    # exactly 2 — backdrop-blur-[20px] ×2 (AppBar, PageHeader)
grep -ranE "/[0-9]*[1-46-9]\b" src/web/                          # 0 — no unbracketed off-scale opacity modifier
grep -ran "border-b border-hairline\|border-l border-hairline" src/web/   # 0 — D2: side utilities only
file src/web/components/CostBreakdown.tsx                        # now reports text (e.g. "Unicode text, UTF-8 text"), not "data"
```

Then re-run the R11 type-scale sweep and check it against §1.9's 22-site table:

```bash
grep -ran "text-sm\|text-base\|text-lg\|text-xl" src/web/
```
Expected: no `text-lg` and no `text-xl` anywhere (both were retired), and every remaining `text-sm`/`text-base` site is one the spec's table lists.

- [ ] **Step 4: Build and restart, paired**

**The gotcha this pairing exists for:** the server is a long-running daemon that serves the web bundle from `dist/` on disk. After a `web:build` the new bundle loads in the browser while the **old in-memory server** is still answering `/api/state` — a shape mismatch white-screens the whole React tree. This redesign adds no server field, so the risk is low, but the rule is unconditional: **rebuild and restart in the same step.**

```bash
bun run web:build && systemctl --user restart am-server.service && systemctl --user is-active am-server.service
```
Expected: build succeeds, then `active`.

- [ ] **Step 5: Smoke the production bundle**

Open `http://localhost:4317/` (the **service**, not the dev server) and confirm on all three routes:
- no console errors,
- the board renders live sessions, todos, workflows and cost,
- the theme, text-size and motion toggles all work and survive a reload.

This is the first time the built bundle — not Vite's dev transform — has been in front of you.

- [ ] **Step 6: Merge**

```bash
git checkout main
git merge --no-ff feat/linear-dashboard-redesign
```

Merge-commit body: record the V4 numbers (baseline vs branch `main.scrollHeight`, and the 20-session projection), plus any V-check that fired its pre-authorised fallback (R4 dividers, R6 blur drop, R10 mask deletion) so the next reader knows which parts of the design shipped as specified and which shipped as their fallback.

Do **not** push — the standing preference is local-only unless asked.

- [ ] **Step 7: Leave the superseded spec a forwarding address**

`docs/superpowers/specs/2026-06-14-work-monitor-ui-redesign-design.md` still reads "Status: Implemented — merged to `main`". Add one line under its status:

```markdown
- **Superseded by:** `docs/superpowers/specs/2026-08-10-linear-dashboard-redesign-design.md` (2026-08-10). Its token table, card aesthetic, three-column kanban and `--handed` status colour are retired; its *mechanisms* (HSL channel triples, `darkMode: "class"`, the pre-paint `index.html` bootstrap, `hsl(var(--x) / <alpha-value>)`) are kept verbatim.
```

```bash
git add docs/superpowers/specs/2026-06-14-work-monitor-ui-redesign-design.md
git commit -m "docs: mark the 2026-06-14 UI redesign spec superseded"
```

---

## Out of scope, filed on purpose (§10)

These are **decisions, not oversights**. Do not fold them into this work.

1. **Keyboard reachability of rows.** Session rows, todo rows and `WorkflowsPage` `<tr>`s are click-only. The global focus ring makes that *visible* without making it *worse*. Converting them to real controls changes behaviour and belongs in its own spec (R7).
2. **Idle-group inner scroll.** If V4 fails only on a 20-session day, capping the Idle group is the answer — but it is a new affordance, so it ships separately (R2).
3. **Shipping Inter.** The type scale, tracking and `font-feature-settings` were designed for Inter Variable, which is not installed. Self-hosting a subset woff2 would deliver the intended typography at the cost of a binary asset in the repo. Nothing in this design depends on it (§1.6).

(The NUL byte in `CostBreakdown.tsx` and the `shadow-card`/`shadow-card-hover` tokens are **not** on this list — neither is left open or reserved: both are decided and land inside this work, in Task 9. See §10.5/§1.9 and D7.)
