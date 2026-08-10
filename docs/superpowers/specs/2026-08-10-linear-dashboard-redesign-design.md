# Linear-inspired dashboard redesign — design

- **Status:** approved (design); ship order in §9. Rail alignment is decided
  (§3.3): option (a), a `<Rail>` slot primitive.
- **Date:** 2026-08-10
- **Scope:** `src/web/**` + `tailwind.config.js` only. No server, API, MCP, hook,
  schema, or data-model change. **Zero functional change.**
- **Supersedes:** `docs/superpowers/specs/2026-06-14-work-monitor-ui-redesign-design.md`
  (the "shadcn-inspired" redesign). That document's token table, card aesthetic,
  three-column kanban and `--handed` status colour are retired by this one. Its
  *mechanisms* — HSL channel-triple CSS variables, `darkMode: "class"`, the
  pre-paint `index.html` bootstrap, `hsl(var(--x) / <alpha-value>)` in Tailwind —
  are kept verbatim and are load-bearing here.

## Summary

The dashboard currently draws **every** list item as a bordered, shadowed,
rounded card with its own padding box. On a normal day that is ~17 boxes on one
screen, so the chrome repeats 17 times and the content fights it. Status is
announced up to four times per session card (3px left border, coloured dot,
coloured uppercase label, shimmer bar).

This redesign makes three structural moves and changes nothing else:

1. **One rail.** Every list-shaped surface (sessions, todos, workflow runs,
   activity events, tool stats, cost rows) becomes a dense row on a shared
   **20px glyph rail** at `x = 1.25rem`. Every leading glyph, checkbox, caret and
   second-line indent in the app snaps to it. Cards, per-row borders, per-row
   shadows and inter-row dividers are deleted.
2. **One status glyph family.** A single `<StatusGlyph>` SVG primitive — five
   shapes, four semantic colours — replaces the border/dot/label/shimmer
   redundancy, and is used identically for sessions, workflow runs and todos.
   `needs_you` deliberately breaks the circle family (filled rounded square with
   a `!`), the way Linear's Urgent priority breaks its bar-chart family.
3. **Colour spent once.** ~95% of the UI goes achromatic on a four-step ink ramp
   over a four-step surface ramp. The violet accent is spent on exactly six
   things. The proportional bars in `ToolStats` / `CostBreakdown` go neutral.
   The only two tinted *surfaces* in the whole app become the `needs_you` session
   row and the degraded banner.

Plus one honest fidelity fix: three Tailwind animations (`animate-spin`,
`animate-pulse`, `animate-ping`) currently **ignore the Motion toggle**. They are
replaced with `.am-anim`-gated equivalents so the toggle finally governs
everything.

Navigation stays a **top bar**, not a sidebar (§3.0).

## Goals

- The board reads as **one instrument panel**, not seventeen restyled parts.
- A session's state is legible from the rail alone, at a glance, without reading.
- `needs you` is the loudest thing on the page without a border, a badge or a
  callout box.
- Idle sessions stop dominating the board without adding a new collapse control.
- The Motion toggle governs **100%** of animation.
- Every existing behaviour, string, ARIA attribute and localStorage key survives.

## Non-goals (decided, not deferred-with-regret)

- **No left sidebar.** Three hash routes do not justify 200–220px of permanent
  width on the one page starved for it (§3.0).
- No icon library, no `clsx`/`cva`/`tailwind-merge`, no Radix, no dialog or
  animation library, no router. Dependency count does not change.
- No webfont ship. `Inter Variable` is *declared* in the stack and gracefully
  absent (verified: `fc-list` finds no Inter on this machine, no font files in
  the repo). Nothing may depend on it (§1.6).
- No new interaction: no drag, no keyboard shortcuts, no row-selection model, no
  new collapse affordance, no filters, no skeletons.
- No conversion of click-only rows to `<button>`/`<a>` — that is a functional
  change (§7, R7).
- No new field on `State` / `Cost` / `WorkflowRun`, no new endpoint, no change to
  SSE cadence or channel shape.
- No test *deletions*. Tests may be re-pointed at `data-testid`s; assertions on
  copy stay.

## Binding constraints — the `keepUnchanged` contract

These 18 items are **binding**. A change that violates one is a bug, not a
tradeoff. Each row names the enforcing check.

| # | Constraint | Enforced by |
|---|---|---|
| K1 | SSE consumption: one `EventSource` on `/api/stream`, two named events (`state` ~60s snapshot, `workflows` ~5s `LiveWorkflow[]`), never merged, no cadence increase. **`api.ts` is not touched.** | `git diff --exit-code src/web/api.ts` |
| K2 | Hash routing: `#/cost` and `#/workflows` matched by literal string in `App.tsx` via `useHashRoute`; **everything else — including `#/` and the empty hash, which `useHashRoute` normalises to `#/` — falls through to `<Board>`**. Navigation stays plain `<a href="#/…">`. **No persistent shell wrapping the three page components.** | `App.test.tsx`, `useHashRoute.test.ts`; `App.tsx` keeps its two early returns + the fallback |
| K3 | View-transition discipline: `runViewTransition`/`flushSync` wraps only post-first-paint `state` commits and `DoneDialog` pagination. The `workflows` channel and first paint stay plain `setState`. | `git diff --exit-code src/web/App.tsx src/web/viewTransition.ts` |
| K4 | All three localStorage toggles + their pre-paint scripts in `index.html`: theme (`html.dark` / `am-theme`), text size (inline root `fontSize` on the fixed `[14,16,18,20,22]` ladder / `am-text-size`), motion (`html.am-anim` / `am-motion`). **Every new size/spacing value is expressed in rem** so the ladder keeps scaling it. | `git diff --exit-code src/web/index.html src/web/useTheme.ts src/web/useTextSize.ts src/web/useMotion.ts`; §1.7 rem rule |
| K5 | Tailwind `darkMode:"class"`, `:root` = light, `html.dark` = wholesale override. No `@media prefers-color-scheme` split, **no `dark:` variant anywhere in components.** | `grep -r "dark:" src/web/` → 0 hits |
| K6 | The `.am-anim` ancestor-gating convention for **all** keyframe animation, including the deliberate override of OS `prefers-reduced-motion` **with its explanatory comment intact**, and `canViewTransition()` requiring both browser support and `am-anim`. | `useMotion.test.ts`; §5 |
| K7 | `max-h-[40vh] overflow-y-auto` — the **literal class string** — on the `TodosSection` open-list scroller and the `WorkflowsSection` live-run list. `ActivityFeed` keeps `max-h-[calc(100vh-8rem)]`. | `TodosSection.test.tsx:30` asserts `className` contains `max-h-[40vh]` |
| K8 | Zero-footprint-when-idle: `WorkflowsSection` (no live runs), `CostPanel` (`liveTotalUsd===0 && todayUsd===0`) and `CostBreakdown` (empty `byProject`) still `return null` — no wrapper, no header, no empty-state shell. | `CostPanel.test:35`, `ToolStats.test:30`, `CostBreakdown.test:38,46`, `WorkflowRunCard.test:77`, `Board.test:54` |
| K9 | Version-skew tolerance: `workflows_degraded ?? 0`, `byProject`/`byBranch` `?? []`, `schema_ok` and `phase` guards. **No new field** is added; the phase progress bar is derived entirely from the already-optional `w.phase`. | `Board.test:68`, `CostBreakdown.test:46` |
| K10 | `usePersistedToggle` drives every disclosure (`am-todos-collapsed`, `am-stats-collapsed`, `am-cost-breakdown-collapsed`, `am-workflows-collapsed`, `am-wf-<run_id>`) as a boolean+toggle pair with `aria-expanded`. No native `<details>`, no key renames. | `usePersistedToggle.test.ts`, `WorkflowRunCard.test:70` |
| K11 | Native `<dialog>` for `TodoModal` and `DoneDialog`, opened imperatively via ref + `useEffect` diffing a nullable/boolean prop. No portal/library. Entrance stays `dialog[open]` + `::backdrop`. | `TodoModal.test`, `DoneDialog.test` |
| K12 | `WF_STATUS_CLASS` stays a **display hint, never a validator**: unknown statuses render grey with `data-status-known="false"`. | `WorkflowRunCard.test:57`, `WorkflowsPage.test:57-59` |
| K13 | Every `aria-label`, `title` and ARIA state attribute: `Toggle theme`, `Toggle motion`, `Mark done`, `Delete`, `Close`, `Decrease text size`, `Increase text size`, `Number of tool calls to show`, `title="owns a live workflow run"`, the API-equiv `title`, `aria-expanded`, `aria-pressed`, `aria-sort`, `data-testid="wf-totals"`. | §6.2 |
| K14 | All literal visible copy, formatted values and glyphs that tests select on — and **the element boundaries they depend on**. | §6.2 (exhaustive table) |
| K15 | The `line-clamp-1` class on the `TodoCard` note element; the absence of any `.cursor-grab` element. | `TodoCard.test:52`, `TodoCard.test` (cursor-grab absence) |
| K16 | Component prop signatures: `Column(title,count,dot,children)`, `Lane(label,hint,children)`, `SessionCard(s,latestTool,latestDetail,cost,wf)`, `TodoCard(t,onOpen)`, `WorkflowRunCard(w)`. Internal markup changes, public shapes don't. | §4.3 (one narrowing, documented) |
| K17 | `toolDot()`'s tool→colour map, and `prettyTool`/`prettyModel`/`formatUsd`/`formatTokens`/`formatDur`/`formatDuration`/`formatWhen`/`formatDay`/`ago`/`costDailyRange` — formatting logic untouched. | `git diff --exit-code src/web/tools.ts src/web/cost.ts src/web/time.ts` |
| K18 | Per-item `viewTransitionName`: `vt-s-{session.id}`, `vt-t-{todo.id}`, `vt-a-{activity.id}`, and `vt-donelist` on the `DoneDialog` list wrapper. | §4, §5.6 |

**Note on K17 + the accent rename.** `toolDot()` returns `bg-primary` for MCP
tools. `--primary` survives as an alias for `--accent` (§1.3), so `toolDot()` is
**not edited** and MCP dots keep their (now correctly-named) accent violet.

**Note on K12 + the recolour.** `workflowStatus.ts` is recoloured (§4.14).
Verified against the suite: **no test anywhere asserts on `statusClass()`'s
return value** — `WorkflowRunCard.test:57` and `WorkflowsPage.test:57-59` assert
only `data-status-known`. The recolour therefore lands with **no test change**.

---

## 1. Token system

### 1.0 Mechanism (unchanged, deliberately)

Bare HSL channel-triples on `:root` (light), re-declared wholesale on
`html.dark`, consumed by Tailwind as `hsl(var(--x) / <alpha-value>)`.
`index.html`'s three pre-paint bootstrap scripts and `darkMode: "class"` need
**no edits**. New primitive tokens are *added*; every existing token name
survives as an **alias** pointing at a primitive, so no component breaks
mid-migration — CSS var substitution is textual, so `--background: var(--surface-0)`
resolves to the triple and `hsl(… / 0.72)` still works.

### 1.1 `src/web/styles.css` — colour tokens, both themes

Replaces lines 5–41 of the current file.

```css
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
  --accent-tint:  264 70% 96%;   /* no consumer in this spec — reserved for a
                                    future selected/flash surface; `am-flash`
                                    uses hsl(var(--accent)/.10) directly */

  /* semantic status */
  --working:   212 88% 44%;      /* #0d69d3 */
  --attention:  30 92% 36%;      /* #b05e07 */
  --done:      154 62% 30%;      /* #1d7b4f */
  --idle:      220 10% 58%;
  --danger:    358 68% 48%;      /* #cf2a3a — NEW, closes the raw red-400 gap */

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
```

### 1.2 Alias layer — **placed after `html.dark`**

Every legacy token name keeps working, so a component can be migrated in
isolation and the app is never broken between commits. Both `:root` and
`html.dark` select the same element (`<html>`); the aliases and the theme
declarations never set the same property, so cascade order is irrelevant — but
the block is placed **after** both theme blocks for readability.

```css
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
```

The alias layer is **permanent**, not a migration scaffold: `toolDot()` returns
`bg-primary` (K17) and `body { @apply bg-background text-foreground }` stays.

### 1.3 Non-colour tokens (theme-independent)

```css
:root {
  --font-sans: "Inter Variable","Inter",ui-sans-serif,system-ui,-apple-system,
               "Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --font-mono: "Berkeley Mono",ui-monospace,"SF Mono","JetBrains Mono",
               "Cascadia Code",Menlo,Consolas,"Liberation Mono",monospace;

  --rail: 1.25rem;        /* THE glyph rail — every list's leading slot */
  --glyph: 0.875rem;      /* 14px status glyph — documents the value behind
                             StatusGlyph's `h-3.5 w-3.5` class and its 14×14
                             width/height fallback attributes (§2.1) */
  --hairline: 1px;

  --ease:      cubic-bezier(.25,.46,.45,.94);  /* ease-out-quad — the workhorse */
  --ease-move: cubic-bezier(.16,1,.3,1);       /* view transitions only */
  --t-quick: 100ms;  /* hover: bg/border/color */
  --t-base:  160ms;  /* controls, press, entrances */
  --t-pop:   175ms;  /* dialogs, menus */
  --t-move:  280ms;  /* view transitions (was 340ms) */
}
@media (min-resolution: 2dppx) { :root { --hairline: 0.5px; } }

:root { font-family: var(--font-sans); font-feature-settings: "cv01","ss03"; }
body { @apply bg-background text-foreground antialiased; }
```

**Deliberate deviations from the approved design's token snippet**, each
required by a binding constraint:

- **`--radius-1..4` are dropped.** They were px values (`4px/6px/8px/12px`) and
  would *not* scale with the text-size ladder — a K4 violation. Tailwind's stock
  radii are already on the 4px grid **and rem-based**, so they are used directly
  (§1.5 radius map).
- **`--bar` and `--focus-ring` moved to the alias block** — they are pure
  aliases and duplicating them in both theme blocks invites drift.
- **`font-family` / `font-feature-settings` are set on `:root`, not `html`**
  (same element; `:root` is the documented scope per R9's mitigation).

### 1.4 Focus, scrollbars

```css
/* one global ring, replacing the two ad-hoc focus-visible rings in TodoCard */
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
```

**Deviation:** the design snippet's `border-radius: var(--radius-2)` inside the
focus rule is **removed**. It would set a real `border-radius` on the focused
element, visibly re-shaping `rounded-full` pills and the segmented control on
focus. Chromium and Firefox already draw `outline` following the element's own
`border-radius`, so the line is unnecessary as well as harmful.

### 1.5 `tailwind.config.js`

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
      fontWeight: { semibold: "590", bold: "680" },
      letterSpacing: { caps: "0.055em", tight: "-0.011em", tighter: "-0.018em" },
      borderWidth: { hairline: "var(--hairline)" },
      spacing: { rail: "var(--rail)" },
      maxWidth: { board: "86rem", page: "64rem" },
      boxShadow: {
        /* `card` is not defined here — decided: dropped (§1.9). Its last
           consumers (`TodoModal`, `DoneDialog`) move to `pop`; nothing in
           `src/web/` references `shadow-card` after this redesign. */
        pop: "0 8px 32px hsl(var(--shadow) / var(--shadow-a)), 0 1px 2px hsl(var(--shadow) / calc(var(--shadow-a) * .6))",
      },
      transitionTimingFunction: { quad: "var(--ease)", move: "var(--ease-move)" },
      transitionDuration: { quick: "100ms", base: "160ms", pop: "175ms", move: "280ms" },
    },
  },
  plugins: [],
};
```

**Two deviations from the design's config snippet, both measured on this machine:**

1. **`fontWeight.medium` is NOT overridden to `510`.** Verified: no Inter is
   installed (`fc-list | grep -ci inter` → `0`); `fc-match sans-serif` resolves
   to **FreeSans**, which ships only Regular (400) and Bold (700). CSS font
   matching for a requested weight **> 500** searches *upward* first — so `510`
   would resolve to **700**, turning every `font-medium` row title bold on the
   actual shipping font. `500` stays on the ≤500 side and resolves to Regular on
   static faces and true Medium on a variable face. `semibold: 590` and
   `bold: 680` are safe (both already resolve to 700 on static faces, exactly as
   today's 600/700 do).
2. **A `3xs` step (0.625rem / 10px) is added.** The design specifies
   `text-[0.625rem]` in six places and the codebase already carries `text-[10px]`
   (×3) and `text-[0.65rem]` (×1). A named rem step replaces all ten: it removes
   a repeated magic number *and* fixes the `text-[10px]` sites, which are px and
   therefore do not scale with the ladder (K4).

**Radius map** (Tailwind stock, all rem, all on the 4px grid — no override):

| Use | Class | @16px |
|---|---|---|
| micro chips (`wf`, `structure unavailable`) | `rounded-sm` | 2px |
| todo checkbox, segmented items, meter-bar fills | `rounded` | 4px |
| row hover pills, ghost buttons, selects, banner | `rounded-md` | 6px |
| (unused — reserved) | `rounded-lg` | 8px |
| dialogs | `rounded-xl` | 12px |
| dots, live pulse, count pills | `rounded-full` | — |

### 1.6 Type scale in use

| Size | Class | Where |
|---|---|---|
| 10px | `text-3xs` | API-equiv note, `+n more`, cost-breakdown group labels, `structure unavailable` |
| 11px | `text-2xs` | **the dominant size** — all mono/meta/chrome, second lines, group headers, uppercase micro-labels |
| 12px | `text-xs` | table bodies, idle session rows, AppBar counts, segmented items |
| 13px | `text-sm` | **the workhorse** — row titles, nav links, page titles, dialog body |
| 15px | `text-base` | dialog headings, the one prominent cost number |
| 18/21px | `text-lg` / `text-xl` | reserved; unused after this redesign |

- Uppercase micro-labels are exactly
  `text-2xs font-semibold uppercase tracking-caps text-ink-3`.
- Negative tracking **only at ≥15px** (baked into `base`/`lg`/`xl`).
- Every numeric cell gets `tabular-nums`; every *money* cell also gets
  `slashed-zero` (both are stock Tailwind `fontVariantNumeric` utilities — no
  custom class).
- **Fonts are declared, not shipped.** No `@font-face`, no webfont file, no
  network request (the app is served from `127.0.0.1` and must stay
  self-contained). `font-feature-settings: "cv01","ss03"` is a deliberate no-op
  on the fallback. The negative tracking values were tuned for Inter and must be
  eyeballed on the actual fallback (FreeSans) — see §8, V6.

### 1.7 The rem rule (K4)

> **No px in a Tailwind arbitrary value, ever — except true hairlines
> (`h-px`, `w-px`, `border`, `border-hairline`) and blur radii
> (`backdrop-blur-[20px]`).**

Everything else is rem or a stock scale step, so the `[14,16,18,20,22]` ladder
keeps scaling it. Concretely, the design's px sketches are realised as:

| Design says | Ships as | Note |
|---|---|---|
| 9px brand square | `h-2.5 w-2.5` (10px) | stays on the spacing scale; the meaningful change is losing the glow |
| 5px dots | `h-1.5 w-1.5` (6px) | unchanged from today |
| 14px glyph | `h-3.5 w-3.5` | |
| 16px checkbox | `h-4 w-4` | |
| 9px chevron | `h-2.5 w-2.5` | matches today's ActivityFeed chevron |
| 2px phase-bar track | `h-0.5` | |
| 1px shimmer underline | `h-px` | hairline exception |
| `pl-[2.5rem]` agent indent | `pl-10` | |
| `h-[22px]` segmented item | `h-[1.375rem]` | |
| `p-[2px]` / `gap-[2px]` | `p-0.5` / `gap-0.5` | |
| `rounded-[3px]` / `rounded-[4px]` | `rounded-sm` / `rounded` | §1.5 map |

### 1.8 Opacity-modifier rule

Tailwind's default opacity scale has no `8`, `12`, `14`. **Any non-scale alpha
must be bracketed.** The canonical alphas:

| Surface | Class |
|---|---|
| `needs_you` row tint / hover | `bg-attention/[0.05]` / `hover:bg-attention/[0.08]` |
| AppBar needs-you escalation pill | `bg-attention/[0.08]` |
| degraded banner | `border-attention/25 bg-attention/[0.07]` |
| `wf` badge | `bg-working/[0.12] text-working` |
| AppBar workflows count | `bg-working/[0.14] text-working` |
| shimmer underline | `bg-working/[0.14]` |
| phase-bar fill | `bg-working/50` |
| todo check hover | `border-done bg-done/[0.12] text-done` |
| delete hover | `border-danger/40 bg-danger/[0.12] text-danger` |
| app-bar / page-header backdrop | `bg-surface-0/[0.72]` |

**Measured, not assumed.** A throwaway Tailwind build on this repo's own
`tailwindcss` confirms the rule: `bg-black/72` and `bg-surface-0/72` emit **no
rule at all**, while `bg-surface-0/[0.72]`, `bg-attention/[0.05]` and
`bg-working/[0.12]` all emit correctly. `72` is not on the default opacity scale
(which is `0,5,10,…,100`), so the app-bar backdrop **must** be bracketed —
§4.1 and §3.2 spell it `bg-surface-0/[0.72]` for exactly this reason.

### 1.9 Deliberately deleted

| Deleted | Replacement | Sites |
|---|---|---|
| `shadow-card-hover` (two-tier elevation) | nothing — rows don't float | `SessionCard`, `TodoCard` — its only two sites. `shadow-card` comes off those two plus the `ActivityFeed` rows and `WorkflowRunCard`; its last two consumers, `TodoModal` and `DoneDialog`, move to `shadow-pop` (§4.7), so after this redesign nothing in `src/web/` references either class. **Decided: dropped, not reserved** — both the `card` and `card-hover` keys come out of `tailwind.config.js`'s `boxShadow` map (§1.5) rather than staying defined with zero consumers. (The implementation plan sequences the actual removal against each token's last consumer.) |
| `border-border/50` alpha hack | `border-border-weak` | `WorkflowsPage` ×2, `CostDailyPage` ×1 |
| `text-muted-foreground/{40,45,50,55,60,70,80}` | `text-ink-3` / `text-ink-4` per the §4 component tables | **32 sites across 12 files** (counted: ActivityFeed 5, CostBreakdown 3, CostDailyPage 1, CostPanel 2, DoneDialog 3, SessionCard 3, TodoCard 1, TodoModal 2, ToolStats 1, WorkflowRunCard 4, WorkflowsPage 6, **plus** `workflowStatus.ts` 1 — that last one is retired by §4.15, not by this sweep) |
| raw `red-400` (the app's only un-tokenized colour) | `danger` | `TodoCard` ×4 — all on one element (`hover:border-`, `hover:bg-`, `hover:text-`, `focus-visible:ring-`); **`TodoModal`: none — verified** |
| `bg-primary/10` meter bars | `bg-bar` | `ToolStats`, `CostBreakdown` |
| `tracking-wide` / `tracking-wider` | `tracking-caps` | **12 sites across 9 files** (`Lane` ×2 — one `wide`, one `wider` — `CostBreakdown` ×2, `WorkflowsPage` ×2, and ×1 each in `ActivityFeed`, `CostDailyPage`, `CostPanel`, `TodosSection`, `ToolStats`, `WorkflowsSection`) |
| `text-[10px]`, `text-[0.65rem]` | `text-3xs` | `CostPanel`, `CostBreakdown` ×2, `WorkflowsPage` |
| the brand mark's inline `boxShadow` glow ring | nothing | `AppBar` |
| `focus-visible:ring-*` ad-hoc rings | global `:focus-visible` outline | `TodoCard` ×2 |

**`text-sm` / `text-base` / `text-lg` override sweep (R11).** The scale override
silently reflows every existing usage. All 22 sites, with their disposition
(counted: 19 × `text-sm`, 1 × `text-base`, 2 × `text-lg`, 0 × `text-xl`):

| File | Site | Today | Ships as |
|---|---|---|---|
| `AppBar` | `← Cost` nav link | `text-sm` | `text-sm` (13px — intended) |
| `AppBar` | `⚙ Workflows` nav link | `text-sm` | `text-sm` |
| `AppBar` | `A−` | `text-sm` | `text-xs` |
| `AppBar` | `A+` | `text-base` | `text-sm` |
| `AppBar` | Motion button | `text-sm` | `text-sm` |
| `AppBar` | Theme button | `text-sm` | `text-sm` |
| `CostDailyPage` | `← Dashboard` | `text-sm` | `text-sm` (via `<PageHeader>`) |
| `CostDailyPage` | range wrapper | `text-sm` | deleted → `<Segmented>` (`text-xs` items) |
| `CostDailyPage` | `Couldn't load cost data.` | `text-sm` | `text-sm text-ink-3` |
| `CostDailyPage` | `Loading…` | `text-sm` | `text-sm text-ink-3` + `role="status"` |
| `CostDailyPage` | `No usage in this window.` | `text-sm` | `text-sm text-ink-3` |
| `WorkflowsPage` | the same five (`← Dashboard`, range wrapper, `Couldn’t load workflow runs.`, `Loading…`, `No workflow runs in this window.`) | `text-sm` ×5 | as above |
| `TodoModal` | `<h2>` title | `text-lg` | `text-base font-semibold` |
| `TodoModal` | note body | `text-sm` | `text-sm text-ink-2` |
| `TodoModal` | links list | `text-sm` | `text-sm` |
| `DoneDialog` | `<h2> Done` | `text-lg` | `text-base font-semibold` |
| `DoneDialog` | `No completed todos yet.` | `text-sm` | `text-sm text-ink-3` |
| `DoneDialog` | row title | `text-sm` | `text-sm` (keeps `line-clamp-1`) |

Also note: `text-2xs` gains a `lineHeight` (1.45) it did not have, and `text-xs`
goes from Tailwind's `1rem` to `1.5` — both make existing rows *taller*. This is
an input to the vertical-growth measurement (§7, R2), not a surprise.

---

## 2. `StatusGlyph` — the signature primitive

New file: `src/web/components/StatusGlyph.tsx`.

### 2.1 API

```tsx
export type GlyphKind = "working" | "needs_you" | "idle" | "ended" | "todo" | "danger";

export function StatusGlyph({
  kind,
  animate = true,        // AppBar passes false — a spinning glyph in the chrome is too much
  className = "",        // colour lives here: text-working / text-attention / …
}: { kind: GlyphKind; animate?: boolean; className?: string }): JSX.Element;
```

- Renders `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
  focusable="false" class={"h-3.5 w-3.5 shrink-0 " + className}>`. The `14`
  attributes are only a no-CSS fallback; `h-3.5 w-3.5` (= `--glyph`, 0.875rem)
  is what ships, so the glyph scales with the text-size ladder (K4).
- **Colourless code.** All strokes/fills are `currentColor`; colour comes from
  the wrapper class. Knockouts use `hsl(var(--surface-0))`.
- Stroke width `1.5`, `stroke-linecap="round"`, `stroke-linejoin="round"`.
- `aria-hidden` throughout: the glyph is *never* the accessible name. Textual
  status lives in the group header, the workflow status label, or an `sr-only`
  span (§4.4).

### 2.2 Geometry

| kind | Markup |
|---|---|
| `idle` | `<circle cx=8 cy=8 r=6 fill=none stroke=currentColor stroke-width=1.5/>` |
| `working` | track `<circle cx=8 cy=8 r=6 fill=none stroke=currentColor stroke-width=1.5 opacity=".35"/>` + arc `<path d="M8 2a6 6 0 0 1 6 6" fill=none stroke=currentColor stroke-width=1.5 stroke-linecap=round/>` — a 90° (25%) arc from 12 to 3 o'clock |
| `ended` | `<circle cx=8 cy=8 r=6.75 fill=currentColor/>` + knocked-out check `<path d="M5 8.2l2.1 2.1L11.2 6" fill=none stroke="hsl(var(--surface-0))" stroke-width=1.6/>` |
| `needs_you` | `<rect x=2 y=2 width=12 height=12 rx=3 fill=currentColor/>` + knocked-out `!`: `<path d="M8 4.6v4.2" stroke="hsl(var(--surface-0))" stroke-width=1.7 stroke-linecap=round/>` + `<circle cx=8 cy=11.4 r=1 fill="hsl(var(--surface-0))"/>` |
| `todo` | `<rect x=2 y=2 width=12 height=12 rx=4 fill=none stroke=currentColor stroke-width=1.5/>` + `<path data-glyph-check d="M5 8.2l2.1 2.1L11.2 6" fill=none stroke=currentColor stroke-width=1.6 opacity=0/>` |
| `danger` | `<rect x=2 y=2 width=12 height=12 rx=3 fill=currentColor/>` + knocked-out `×`: `<path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="hsl(var(--surface-0))" stroke-width=1.7 stroke-linecap=round/>` |

**Why `needs_you` is a square.** Breaking it out of the circle family is the
whole point — it is Linear's Urgent-priority move applied to this dashboard's
actual urgent state, and it is what lets the row tint stay as faint as 5%.

**Knockout colour note.** Knockouts are `--surface-0`, but a hovered row is
`--surface-2`. The delta is ~4% L in both themes on a ≤1.7px stroke; verified
imperceptible. Using the literal surface token (rather than a second "on-glyph"
token) keeps the primitive to one file and zero new tokens.

**`todo` hover check.** One rule in `styles.css`, no per-component plumbing:

```css
.am-check [data-glyph-check] { transition: opacity var(--t-quick) var(--ease); }
.am-check:hover [data-glyph-check],
.am-check:focus-visible [data-glyph-check] { opacity: 1; }
```

The mark-done `<button>` carries `class="am-check … hover:text-done"`.

### 2.3 Spin

`animate && kind === "working"` adds `am-spin` **to the `<svg>` root element**
(not an inner `<g>`): the track ring is rotationally symmetric, so only the arc
appears to move, and `transform-origin` needs no `transform-box: fill-box`
workaround on a replaced element.

Motion-off (`html` lacks `am-anim`) leaves the arc **static, spanning 12→3
o'clock** — its leading edge sits at 1–2 o'clock and still reads "in progress".
This is a designed fallback, not a degradation.

### 2.4 State mappings

**Sessions** — `Session["status"]`, used by `SessionCard` (row) and `Column`
(group header):

| status | kind | row colour | group-header colour |
|---|---|---|---|
| `working` | `working` (spins) | `text-working` | `text-working` |
| `needs_you` | `needs_you` | `text-attention` | `text-attention` |
| `idle` | `idle` | `text-ink-4` | `text-idle` |
| `ended` | `ended` | `text-ink-4` | — (no group of its own; see below) |
| *unknown* | `idle` | `text-ink-4` | `text-idle` |

Rows in the Idle/done group are deliberately drawn in `ink-4`, not `idle`: the
*group header* carries the semantic colour once, the rows recede.

**On `ended` (verified, and deliberately left alone).** `SessionStatus` is
`working | needs_you | idle | ended`, but `store.listSessions()` runs
`WHERE status != 'ended'` unless `includeEnded` is passed, and `/api/state`
never passes it — so **no `ended` session ever reaches the board today**, and
`SESSION_COLS`'s `idle` group filters on `status === "idle"` only. Neither the
filter nor the grouping changes here (that would be a functional change). The
`ended` glyph exists because `SessionCard`'s `STATUS` map already has an `ended`
branch and the union permits it; the group title stays the literal
`Idle / done`.

**Workflow runs** — keyed off `w.status ?? w.state`. `workflowStatus.ts` gains a
second display-hint map alongside `WF_STATUS_CLASS`, with the identical
never-a-validator contract (K12):

```ts
const WF_STATUS_GLYPH: Record<string, GlyphKind> = {
  running:   "working",
  completed: "ended",
  failed:    "danger",
  killed:    "danger",
  orphaned:  "idle",
  settled:   "idle",
};
export function statusGlyphKind(label: string): GlyphKind {
  return WF_STATUS_GLYPH[label] ?? "idle";   // unknown → hollow ring, never a throw
}
```

Colour comes from the *existing* `statusClass(label)` so glyph and label always
agree. Used on both `WorkflowRunCard` and the `WorkflowsPage` name cell.

**Coverage, verified.** `WF_STATUS_GLYPH`'s six keys are exactly
`WF_STATUS_CLASS`'s six keys (`completed`, `running`, `failed`, `killed`,
`orphaned`, `settled`) — the two maps must be edited together or a run can get a
`text-danger` label under an `idle` ring. The label is `w.status ?? w.state`;
`w.state` is server-derived and only ever `running` / `settled` / `orphaned`
(all three mapped), while `w.status` is Claude Code's own unvalidated
vocabulary — which is what the `?? "idle"` fallback is for (K12).

**Workflow agents** — **keep the 5px dot**, do *not* use `StatusGlyph`. The
agent rows sit one rail level in (`pl-10`); a second glyph family there
over-signals a sub-list. The existing `AGENT_DOT` map is kept, with exactly one
edit (`animate-pulse` → `am-pulse`):

| `a.state` | class |
|---|---|
| `running` | `bg-working am-pulse` |
| `done` | `bg-idle` |
| `abandoned` | `bg-attention/60` |
| *unknown / null* | `bg-idle` |

**Todos:**

| where | kind | colour |
|---|---|---|
| open todo, mark-done button | `todo` | `text-ink-4`, hover → `text-done` + check |
| `DoneDialog` row | `ended` | `text-done` |
| AppBar "n to do" | `todo` (`animate={false}`) | inherits the count colour |

**Tool dots** (`ActivityFeed`, `ToolStats`) keep `toolDot()` and stay 6px dots
(K17) — they encode a *category*, not a state, and must not read as status.

---

## 3. Layout, per route

### 3.0 Navigation: keep the top bar. Do not build a left sidebar.

Linear's sidebar exists to hold a growing tree — workspaces, teams, projects,
saved views — and to be where identity lives. We have three hash routes.
Spending 200–220px of permanent width on three links, on the one page in the app
that is *starved* for width (a full-width session list plus a 320px ambient
column), would be cargo-culting the shape and discarding the reason. It would
also require wrapping `App.tsx`'s three independently-returned page components in
a persistent shell — real structural churn against K2 and the zero-functional-
change brief.

So: borrow the sidebar's **discipline**, not its geometry. The top bar becomes a
3rem status rail that is **dimmer than the work surface** — ghost controls,
hairline dividers, `ink-3` labels — exactly as Linear dimmed its sidebar so the
content reads as primary.

### 3.1 Board (`#/`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▪ agent-monitor │ ◐ 2 working  ▲ 1 needs you  ☐ 5 to do   $ Cost  ⚙ Workflows │ h-12 sticky
├──────────────────────────────────────────────────────────────────────────────┤ hairline
│                                                     │                        │
│ ⚠ workflow data looks off — …                       │  Σ TOOL USAGE (511)    │
│                                                     │  ▪ Bash   142  avg 1.2s│
│ SESSIONS  auto — moves itself from agent hook events│  ▪ Read    98  avg 0.3s│
│ ▲ NEEDS YOU  1                          ← sticky    │                        │
│ ▣ browns · Refactor (1/3 done)  $0.42 · 8K   14s    │  $ SESSION COST        │
│   ⚠ Run migration?                                  │  today      live total │
│                                                     │  $4.12         $18.40  │
│ ◐ WORKING  2                                        │                        │
│ ◐ agent-monitor · redesign board  $1.24…    2s      │  ≣ COST BREAKDOWN      │
│   ⟳ Bash…                                           │  ▪ agent-monitor  $8.10│
│ ◐ payload · migrate fields  wf  $0.31…      8s      │                        │
│   ⟳ Edit…                                           │  ⚡ LIVE ACTIVITY   ⌄20 │
│                                                     │  ▪ Bash 1.2s      14s  │
│ ○ IDLE / DONE  6                                    │    vitest run   monitor│
│ ○ storefront · —                    $0.02  4h       │  ▪ Read 0.3s      22s  │
│ ○ workos · —                        $0.11  6h       │    api.ts       payload│
│                                                     │                        │
│ ⚙ WORKFLOWS (1)                        history →    │                        │
│ ◐ research · alpha·feat/x  running          3m 5s   │                        │
│   Phase 2/4 · Judge · $1.25 · 512K tok              │                        │
│   ▬▬▬▬▬▬▬▬▬░░░░░░░░                                 │                        │
│                                                     │                        │
│ ★ TODOS (5)      ✓ to complete · ✕ to delete   ✓ Done (12) →                 │
│ ☐ Hand off spec              → Maria  ⎇ main  agent-monitor              ✕   │
│ ☐ Cap todos height           ⎇ fix/cap-todos  agent-monitor              ✕   │
└─────────────────────────────────────────────────────┴────────────────────────┘
     ↑ the 20px rail — every glyph, caret and 2nd-line indent lands here
```

**`Board.tsx` structure:**

```tsx
<div className="mx-auto max-w-board px-6 pb-16">
  <AppBar state={state} workflows={workflows} />
  <div className="mt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
    <main className="min-w-0 lg:pr-6">
      {degraded && <Banner/>}          {/* mt-0 — it is first */}
      <Lane …>  {/* Sessions */}
      <WorkflowsSection …/>
      <TodosSection …/>
    </main>
    <aside className="mt-6 lg:mt-0 lg:sticky lg:top-14 lg:border-l lg:border-hairline lg:border-border-weak lg:pl-6">
      <ToolStats/> <CostPanel/> <CostBreakdown/> <ActivityFeed/>
    </aside>
  </div>
</div>
```

Concrete decisions:

- **Container `max-w-board` (86rem, up from `max-w-7xl`/80rem), `px-6` (from
  `px-4`), `pb-16`.** Rows want width; being rem-based it grows with the ladder.
- **One vertical hairline replaces four bordered card boxes** in the sidebar.
  Below `lg` the grid stacks and the border drops (`lg:` prefixes only).
- **Main order changes** to: degraded banner → **Sessions** → WorkflowsSection →
  TodosSection. Sessions are the reason the page exists; the 40vh caps on
  Todos/Workflows were compensating for them sitting third.
- **Section rhythm.** Every `<section>` keeps owning its own top margin, dropping
  from `mt-7` (1.75rem) to `mt-6` (1.5rem). With the body wrapper at `mt-3` the
  gap under the app bar is `0.75 + 1.5 = 2.25rem`. Today it is `2.75rem`
  (`AppBar`'s own `mb-2` + the body wrapper's `mt-2` + `mt-7`); the new `AppBar`
  (§4.1) carries **no bottom margin**, so this is a deliberate 0.5rem tightening,
  not a wash.
- **`Lane` stops being a grid.** `grid-cols-1 sm:grid-cols-3` → a plain vertical
  stack (`<div>` with no grid classes). `Lane` keeps its `label`/`hint` header,
  restyled bare (§4.3). The ASCII sketch elides it; the spec keeps it, because it
  preserves copy (K14) and makes Sessions/Workflows/Todos a consistent
  section family.
- **Group order: Needs you → Working → Idle/done.** `SESSION_COLS` in `Board.tsx`
  reorders.
- **Empty groups still render their header** (28px, count `0`, dimmed). It is the
  board's legend, and hiding it would change what text-query tests can find.
- **Group headers are `sticky top-12` with an opaque `bg-surface-0`** — *not*
  blurred. One blurred layer per page is enough (R6).
- Aside sticky offset `lg:top-14` (3.5rem) clears the 3rem bar plus 0.5rem.

### 3.2 `#/cost` and `#/workflows`

Identical chrome, extracted into one `<PageHeader>`:

```
sticky top-0 z-20 -mx-6 h-12 px-6 flex items-center gap-3
bg-surface-0/[0.72] backdrop-blur-[20px] border-b border-hairline border-border-weak
  → <a href="#/"> ← Dashboard </a>       text-sm text-ink-3 hover:text-ink
  → <span className="h-4 w-px bg-border-weak"/>          (hairline divider)
  → <span> {title} </span>               text-sm font-semibold text-ink
  → <div className="ml-auto"> {right} </div>
```

- `<PageHeader title="Cost by day">` and `<PageHeader title="Workflow runs">` —
  both strings stay in a **single element** (`App.test:28,42`).
- `right` = the shared `<Segmented>` range control.
- **Container width:** `max-w-page` (64rem) for `#/cost` — the *same* width it
  has today, since `max-w-5xl` is also 64rem; the rename is only so both pages
  stop reaching into Tailwind's `n-xl` scale. `max-w-board` (86rem) for
  `#/workflows` — 8 columns need the width (up from `max-w-6xl`/72rem).
  Both `px-6 pb-16`.
- Tables run **full-bleed to the container edges** — no wrapper card.
- **Hard constraint:** `<PageHeader>` must introduce **no `<button>` whose
  accessible name contains "cost"** — `CostDailyPage.test:34` and
  `WorkflowsPage.test:75` do `getByRole("button", { name: /cost/i })` expecting
  the *Cost column header*. `← Dashboard` is an `<a>`; the title is a `<span>`.
  Likewise the `<Segmented>` buttons must have accessible names of exactly
  `7d` / `14d` / `30d` / `All` (`/^all$/i`).

### 3.3 Shared primitives to extract

New file `src/web/components/primitives.tsx` (plus `StatusGlyph.tsx`). This is
the audit's highest-value target: the uppercase micro-label idiom alone occurs
**12 times across 9 files** today (`Lane` ×2, `CostBreakdown` ×2,
`WorkflowsPage` ×2, and once each in `ActivityFeed`, `CostDailyPage`,
`CostPanel`, `TodosSection`, `ToolStats`, `WorkflowsSection`).

| Primitive | Shape | Used by |
|---|---|---|
| `ROW_BASE` (exported string) | `-mx-1.5 rounded-md px-1.5 transition-colors duration-quick ease-quad hover:bg-surface-2` | every list row; needed as a raw string for `<li>` rows |
| `<ListRow>` | `<div>` wrapper over `ROW_BASE` with `tone`, `className`, `style`, `onClick`, `data-*` passthrough | `SessionCard`, `TodoCard`, `WorkflowRunCard` |
| `<SectionHeader>` | optional caret (SVG, `aria-hidden`) + optional `leading` slot + label + optional count + optional `right` slot; renders `<button aria-expanded>` **when `onToggle` is given**, else a `<span>`, and the caret renders only in the button form | `TodosSection`, `WorkflowsSection`, `ToolStats`, `CostBreakdown`, `ActivityFeed` (no caret, no count — `leading` is the live ping dot), `CostPanel` (no caret, no count) |
| `<StatusGlyph>` | §2 | `SessionCard`, `Column`, `AppBar`, `TodoCard`, `DoneDialog`, `WorkflowRunCard`, `WorkflowsPage` |
| `<MeterRow>` | `h-6` row, neutral proportional bar, fixed numeric slots | `ToolStats`, `CostBreakdown` |
| `<Segmented>` | joined button group | `CostDailyPage`, `WorkflowsPage` range controls |
| `<PageHeader>` | §3.2 | `CostDailyPage`, `WorkflowsPage` |
| `<Chip>` | `inline-flex items-center rounded-sm px-1 font-mono text-3xs`, `tone: "neutral" \| "working"`, `round?: boolean`, **plus `title` and `data-*` passthrough** | `wf` badge, `structure unavailable` ×2, AppBar workflows count |

`Lane` does **not** use `<SectionHeader>` — its header is a bare label + hint
with no caret, count or glyph, and §4.3 gives its markup verbatim.

**`<Chip>` tones.** `neutral` = `bg-surface-3 text-ink-3` (that is what
`--surface-3` is for, per §1.1: "chips, controls, meter bars");
`working` = `bg-working/[0.12] text-working`, and `round` swaps `rounded-sm` for
`rounded-full px-1.5` (the AppBar workflows count, §4.1). `title` passthrough is
**load-bearing**: `title="owns a live workflow run"` is pinned by K13 and by
`SessionCard.test:50,55` / `Board.test:60`, and `data-*` passthrough carries
Phase 0's `data-testid="wf-badge"`.

**`<ListRow tone>` replaces, never appends.** `tone="attention"` must *swap*
`hover:bg-surface-2` out of the emitted class list rather than adding
`hover:bg-attention/[0.08]` after it. Both classes have identical specificity, so
the winner is decided by the order Tailwind emits them into the stylesheet, not
by the order they appear in `className` — appending would make the tint a
coin-flip.

**`<SectionHeader>` accessible-name contract.** The caret becomes a 10px SVG
chevron with `aria-hidden`, so accessible names lose the `▸`/`▾` prefix:
`"▸ ★ Todos (5)"` → `"★ Todos (5)"`. Every role query in the suite is a regex
(`/Todos/`, `/Workflows \(2\)/`, `/Tool usage/`, `/research/`) and still matches.

**Rail alignment — decided: option (a), the `<Rail>` slot primitive.** The
design's premise is one rail at `x = --rail` (1.25rem) that "every leading
glyph, checkbox, caret and second-line indent" lands on, but the classes
specified in §4, taken on their own, do not produce that. With `ROW_BASE`'s
`-mx-1.5 px-1.5` putting row content at `x = 0`, a plain per-row `gap-*`
between the leading mark and the first text element would put line-1 text at
*leading-mark width + gap* — a figure that varies by mark size:

| Row | Leading mark | Gap | Line-1 text x (plain gap, not chosen) | Line-2 `pl-rail` |
|---|---|---|---|---|
| session / workflow (§4.4, §4.9) | glyph `h-3.5` (14px) | `gap-2` (8px) | 22px | 20px |
| todo (§4.6) | checkbox `h-4` (16px) | `gap-2.5` (10px) | 26px | — |
| activity / meter (§4.13, §3.3) | dot `h-1.5` (6px) | `gap-2` (8px) | 14px | 20px |

The chosen mechanism closes this by wrapping every leading mark in a
`<Rail>` — `<span className="flex w-rail shrink-0 items-center
justify-center">` — and dropping the gap before the first text element, so
every row's line-1 text starts at exactly `--rail` (20px) regardless of
whether the mark is a 14px glyph, a 16px checkbox or a 6px dot. Second lines
and sub-lists indent with `pl-rail`. This is one rule applied uniformly across
all six rail-bearing surfaces — `SessionCard`, `TodoCard`, `WorkflowRunCard`,
`ActivityFeed` rows, `MeterRow`, and the `Column` group header. See the
implementation plan's D1 for the exact row markup.

**`<MeterRow>` unified grid** — this is what makes the two sidebar panels
visibly one system:

```tsx
<MeterRow frac={n} leading={<dot/>} label="Bash" a={<>{calls}</>} b={<>avg 1.2s</>} />
```

`h-6 relative isolate flex items-center gap-2 -mx-1.5 rounded-md px-1.5 font-mono text-2xs`
· bar `absolute inset-y-[0.125rem] left-0 -z-10 rounded bg-bar` at
`Math.max(6, …)%` (math unchanged) · `label` `min-w-0 flex-1 truncate text-ink-2 font-medium`
· slot `a` `w-14 shrink-0 text-right tabular-nums text-ink-3` · slot `b`
`w-16 shrink-0 text-right tabular-nums text-ink-4`.

Widths unify ToolStats' `w-9/w-16` and CostBreakdown's `w-14/w-12` to `w-14/w-16`.
Verified to fit at 11px mono: `$12.50` ≈ 40px in 56px; `avg 1.2s` ≈ 53px in 64px.

---

## 4. Component treatments

### 4.1 `AppBar`

```
sticky top-0 z-20 h-12 -mx-6 flex items-center gap-4 px-6
bg-surface-0/[0.72] backdrop-blur-[20px] border-b border-hairline border-border-weak
```

(No bottom margin — today's `mb-2` goes; the gap is owned by the body wrapper's
`mt-3` plus each section's `mt-6`, §3.1.)

- **Brand:** `<span className="h-2.5 w-2.5 rounded-sm bg-accent"/>` — the inline
  `boxShadow` glow ring is **deleted** (pure decoration). Wordmark
  `<span className="text-sm font-semibold tracking-tight text-ink">agent-monitor</span>`
  (`App.test:35` does `findByText("agent-monitor")`).
- **Divider:** `<span className="h-4 w-px bg-border-weak"/>` — the Linear
  separator idiom, used twice in this bar and nowhere else.
- **Counts:** the three bordered `bg-chip` pills are deleted. Each becomes:

  ```tsx
  <span key={`w-${n}`} data-testid="appbar-count-working"
        className={`am-count inline-flex items-center gap-1.5 text-xs ${tone}`}>
    <StatusGlyph kind="working" animate={false} />
    <span>{n} {label}</span>          {/* ← MUST stay one element */}
  </span>
  ```

  `gap-4` between groups. **`AppBar.test:27-29` does `getByText("1 working")`** —
  the inner span is a hard boundary (K14).
  Tone is the hierarchy: `text-ink-2` when `n > 0`, `text-ink-4` when `n === 0`,
  so zero states recede on their own.
  **One escalation:** when `needsYou > 0` that group alone gets
  `text-attention bg-attention/[0.08] rounded-full px-2 py-0.5`. It is the only
  chrome-level alarm in the app.
  `am-count` stays on the wrapper, still keyed only on the count value — **never**
  the 1Hz clock (§5.5).
- **Controls (`ml-auto flex items-center gap-1`):** nav links and toggles all
  become `h-7 px-2.5 rounded-md` **ghost** buttons —
  `bg-transparent border-transparent text-ink-3 hover:bg-surface-2 hover:text-ink transition-colors duration-quick ease-quad`.
  The uniform `h-9 border bg-muted` pill treatment is dropped; that is what made
  the chrome as loud as the content. `$` and `⚙` render `text-2xs text-ink-4`.
  The workflows count badge → `<Chip tone="working" round>{workflows.length}</Chip>`
  (`rounded-full bg-working/[0.14] px-1.5 text-2xs tabular-nums text-working`).
- **A−/A+ segmented:** `h-7 rounded-md border-hairline border-border` with a
  `w-px bg-border` divider — the one control that keeps a border, because it is a
  joined pair. `A−` at `text-xs`, `A+` at `text-sm`, both `px-2.5`,
  `disabled:opacity-40`.
- All `aria-label`s (`Toggle theme`, `Toggle motion`, `Decrease text size`,
  `Increase text size`), `aria-pressed`, `title`s and visible words (`Cost`,
  `Workflows`, `Motion`, `Dark`/`Light`, `A−`, `A+`) are preserved **verbatim at
  every breakpoint** — nothing is hidden behind an icon (K13, K14).
- `data-press` is applied to the Motion/Theme/nav ghost buttons **only** — not
  the A−/A+ pair (R12).

### 4.2 Degraded-format banner

```
h-8 flex items-center gap-2 rounded-md px-2.5
border-hairline border-attention/25 bg-attention/[0.07] text-2xs text-attention
```

Exact string preserved (`⚠ workflow data looks off — Claude Code may have changed
format`), `(state.workflows_degraded ?? 0) > 0` guard preserved (K9), and it
moves to the very **top of `main`** (no top margin — it is first).

Together with the `needs_you` row tint these are the **only two tinted surfaces
in the entire app** — which is precisely why they work.

### 4.3 `Lane` / `Column`

**`Lane`** keeps `(label, hint, children)` (K16). Header restyled bare — the
`rounded-full border bg-chip` hint pill is deleted:

```tsx
<section className="mt-6">
  <div className="mb-2 flex flex-wrap items-baseline gap-2.5">
    <span className="text-2xs font-semibold uppercase tracking-caps text-ink-3">{label}</span>
    <span className="text-2xs text-ink-4">{hint}</span>
  </div>
  <div>{children}</div>          {/* was: grid grid-cols-1 sm:grid-cols-3 gap-3 */}
</section>
```

**`Column`** keeps `(title, count, dot, children)` — **name and arity preserved**
(K16). One documented narrowing: **`dot` changes type from `string` (a Tailwind
class such as `"bg-working"`) to `Session["status"]`** (`"working"` etc.), because
the leading mark is now a `StatusGlyph` kind rather than a background class.
Verified safe: `grep` confirms `Lane.tsx` is imported by `Board.tsx` **only**, and
no test file imports `Lane` or `Column`. `SESSION_COLS` in `Board.tsx` updates its
`dot` values in the same commit.

```tsx
<div data-testid={`session-group-${dot}`}>
  <div className="sticky top-12 z-10 -mx-1.5 flex h-7 items-center gap-2 bg-surface-0 px-1.5
                  border-b border-hairline border-border-weak">
    <StatusGlyph kind={GLYPH[dot]} animate={false} className={HEADER_TONE[dot]} />
    <span className="text-2xs font-semibold uppercase tracking-caps text-ink-3">{title}</span>
    <span className="text-2xs tabular-nums text-ink-4">{count}</span>
  </div>
  <div className="pt-1">{children}</div>
</div>
```

`GLYPH` and `HEADER_TONE` are two small `Record<Session["status"], …>` maps local
to `Lane.tsx`, transcribed from §2.4's session table — they are the only place
the session-status → glyph/colour mapping lives outside `SessionCard`.

Colour is spent on the glyph; the label stays neutral. Group titles stay exactly
`Working`, `Needs you`, `Idle / done`. The bordered `rounded-xl bg-card/50 p-2.5`
column box and the `bg-chip` count pill are deleted.

### 4.4 `SessionCard` → session row

Props unchanged (K16). Root:

```tsx
<ListRow
  data-testid="session-row" data-status={s.status}
  tone={s.status === "needs_you" ? "attention" : "default"}
  className="am-fade-in relative py-1.5"
  style={{ viewTransitionName: `vt-s-${s.id}` }}   /* K18 — rows still FLIP between groups */
>
```

**Deleted outright:** the 3px `borderLeft` inline style (the redundancy the glyph
replaces), the `border`/`bg-card`/`shadow-card`/`shadow-card-hover`, the visible
status dot + `Working`/`Needs you` label line, and the `attention_reason` callout
box.

**Added:** `<span className="sr-only">{st.label}</span>` carrying the existing
`STATUS[s.status].label` verbatim, so removing the visual label does not remove
status from the accessibility tree. It goes on **every** session row, including
the compact idle one. Safe against `SessionCard.test:41`, which asserts on
`container.textContent` (sr-only text counts): the four labels are `Working`,
`Needs you`, `Idle`, `Ended` — none contains `tok`.

**`needs_you` tint.** Instead of a callout box, the **whole row** is tinted
`bg-attention/[0.05]`, `hover:bg-attention/[0.08]`. A tinted row is louder than a
3px border and stays flat. It is the only tinted row surface in the app.

**Working / needs-you — two lines:**

```
line 1  flex items-center gap-2:
  [rail] <StatusGlyph kind=… className=…/>
  <span className="text-sm font-medium text-ink">{s.project}</span>      ← own element (Board.test:24)
  {wf && <Chip tone="working" title="owns a live workflow run">wf</Chip>} ← title is test-pinned
  <span className="min-w-0 flex-1 truncate text-sm text-ink-3">{task}</span> ← own element (Board.test:25)
  ml-auto:
    {branch && <span className="text-2xs font-mono text-ink-4">⎇ {s.branch}</span>}   ← ONE element
    {cost   && <span className="text-2xs font-mono tabular-nums text-ink-4">
                 {formatUsd(cost.costUsd)} · {formatTokens(cost.tokens)} tok</span>}  ← ONE element
    <span className="w-14 text-right text-2xs font-mono tabular-nums text-ink-4">{ago(...)}</span>

line 2  pl-rail, text-2xs font-mono:
  working, active_tool:  <span aria-hidden className="am-spin inline-block">⟳</span>
                         <span className="truncate">{prettyTool(s.active_tool)}…</span>  ← "Bash…" ONE element
  working, latestTool:   <span aria-hidden>▸</span>
                         <span className="truncate">{prettyTool(latestTool)}
                           {latestDetail && <span className="text-working/60"> · {latestDetail}</span>}</span>
  needs_you:             <span className="text-attention">⚠ {s.attention_reason}</span>  ← ONE element
```

`{task}` is today's expression unchanged: `s.current_task ?? s.current_intent ??
"—"`. The `needs_you` line keeps today's `s.attention_reason && s.status ===
"needs_you"` guard, so a needs-you session with a null reason renders no second
line rather than a bare `⚠`.

Four element boundaries here are **hard test contracts** and must not be
flattened:

| Literal | Test |
|---|---|
| `⎇ feat/x` (and *absent* when `branch == null`) | `SessionCard.test:15,19` |
| `Bash…` | `SessionCard.test:23` |
| `$1.24 · 312K tok` | `SessionCard.test:36` |
| `⚠ Run migration?` | `Board.test:26` |

Also: `SessionCard.test:41` asserts `container.textContent` does **not** contain
`"tok"` when no cost — no literal "tok" label may be introduced anywhere in the
row.

**Shimmer.** The `h-0.5 rounded-full` element becomes a 1px absolutely-positioned
underline at the row's bottom, spanning rail→right:

```tsx
{isWorking && <span aria-hidden
  className="am-shimmer absolute bottom-0 left-rail right-0 h-px bg-working/[0.14]"/>}
```

**Idle / ended — one line, `py-1`, ~26px:** hollow-ring glyph in `ink-4`,
`{project}` `text-xs text-ink-2`, `{task}` `text-xs text-ink-4 truncate`, cost
(`formatUsd` only — no `· … tok` suffix, as the §3.1 sketch shows) and
`ago` right-aligned at `ink-4`. No tool line, no shimmer, no branch. Same
information, a third of the weight — this is how a 12-session idle backlog stops
dominating the board without adding a new collapse control.

### 4.5 `TodosSection`

- Header (`<SectionHeader>`): caret + `★ Todos ({open.length})` (test-pinned via
  `/Todos/`) + `ml-auto` slot containing:
  - the hint `✓ to complete · ✕ to delete` — exact string, now bare
    `text-2xs text-ink-4`, chip border gone;
  - **`✓ Done ({done.length}) →` moved up into the header**, still a real
    `<button>` with `data-testid="todos-done-link"`, `text-2xs font-semibold
    text-ink-4 hover:text-ink`. `TodosSection.test:42` clicks it;
    `Board.test:29` and `TodosSection.test:23` match its text. Moving it out of
    the `{!collapsed && …}` branch means it now renders while collapsed — no test
    depends on it being hidden (`TodosSection.test:33-37` asserts only that
    `open1` disappears).
- **The `columns-1 sm:columns-2 xl:columns-3` masonry is deleted.** Todos are
  list-shaped; a single column of rows is what makes them scannable down the left
  edge. `break-inside-avoid` on `TodoCard` goes with it.
- **The scroller keeps `max-h-[40vh] overflow-y-auto` on the same element**
  (K7) and gains `data-testid="todos-scroller"`. The row title must remain a
  descendant of that exact node.
- Empty state: `Nothing open. 🎉` — exact string, bordered box deleted, now a bare
  `text-xs text-ink-4 py-3` line.

### 4.6 `TodoCard` → todo row

```
group flex items-center gap-2.5 -mx-1.5 rounded-md px-1.5 py-1.5 cursor-pointer
hover:bg-surface-2 transition-colors duration-quick ease-quad
```

- **Mark-done button in the rail:** `<button className="am-check inline-flex h-4 w-4
  shrink-0 items-center justify-center text-ink-4 hover:text-done"
  aria-label="Mark done" title="Mark done">` containing
  `<StatusGlyph kind="todo"/>`. The literal `✓` character is removed from the
  button (no test asserts it; `getByLabelText("Mark done")` is the contract).
  Both `stopPropagation` handlers (`onPointerDown`, `onClick`) are preserved
  verbatim. The ad-hoc `focus-visible:ring-done/50` is dropped in favour of the
  global ring (§1.4).
- Title: `text-sm font-medium text-ink truncate max-w-[46%]` — changed from
  `line-clamp-2`, because one-line rows want truncation. **Not test-pinned**
  (only the *note* is).
- Note: **keeps `line-clamp-1`** on the note element (K15,
  `TodoCard.test:52`), plus `min-w-0 flex-1 text-xs text-ink-4`. Gains
  `data-testid="note"`.
- Meta, right-aligned: `→ {for_who}` stays **one element**
  (`Board.test:28` matches `"→ Maria"`) at `text-2xs font-medium text-attention`;
  `⎇ {branch}` and `{origin_project}` at `text-2xs text-ink-4`.
- Delete → progressive disclosure:
  `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-quick`.
  **Stays in the DOM** with `aria-label="Delete"` and `title="Delete"` — opacity
  does not affect `getByLabelText` (`TodoCard.test:45`). Now uses `--danger`:
  `hover:border-danger/40 hover:bg-danger/[0.12] hover:text-danger`, retiring the
  app's only un-tokenized colour. Keeps the `✕` character.
- **No `.cursor-grab` anywhere** (K15 — the test asserts its absence).
- `viewTransitionName: vt-t-${t.id}` preserved (K18).

### 4.7 `TodoModal` / `DoneDialog`

Stay native `<dialog>` with the same imperative ref + `useEffect` wiring (K11).

- Panel: `m-auto w-[min(35rem,100vw-2rem)] rounded-xl border-hairline border-border
  bg-surface-1 p-0 text-ink shadow-pop`.
- Backdrop, in `styles.css` (replaces the `backdrop:bg-black/50` utility so it is
  theme-aware): `dialog::backdrop { background: hsl(var(--surface-0) / .6);
  backdrop-filter: blur(3px); }`.
- Title `text-base font-semibold`; meta `text-xs text-ink-3`; links
  `text-accent hover:text-accent-hover`; `Close` button keeps `aria-label="Close"`.
- `DoneDialog` rows reuse the todo-row primitive: `<StatusGlyph kind="ended"
  className="text-done"/>`, title `text-sm font-medium text-ink line-clamp-1`
  (unchanged), **no strikethrough**. `divide-y divide-border` → nothing (rows
  separate by rhythm).
  **`DoneDialog.test:15` does `getAllByText(/^(old|new|mid)$/)` and asserts DOM
  order** — the title must stay its own element and the sort must stay
  newest-first.
- Prev/Next become `h-6` ghost buttons; the pagination string `1–10 of 12` stays
  one element (`DoneDialog.test:23`); `viewTransitionName: "vt-donelist"` on the
  list wrapper preserved (K18), as is the `runViewTransition` wrapping of page
  changes (K3).

### 4.8 `WorkflowsSection`

Keeps `return null` on zero live runs (K8), the `max-h-[40vh] overflow-y-auto`
cap (K7), the 1Hz `useNow()` tick, and the per-run `usePersistedToggle` keyed by
`run_id` (K10).

Header (`<SectionHeader>`): caret + `⚙ Workflows ({n})` — exact string,
`getByRole("button", {name:/Workflows \(2\)/})` — + `history →` at `ml-auto`,
`text-2xs text-ink-4 hover:text-ink`.

### 4.9 `WorkflowRunCard` → workflow row

`mb-2 rounded-lg border bg-card p-3 shadow-card` → `<ListRow className="py-1.5"
data-testid="wf-run-row">`.

```
line 1  flex items-center gap-2:
  [rail] <StatusGlyph kind={statusGlyphKind(label)} className={statusClass(label)}/>
  <button aria-expanded={!collapsed} className="text-sm font-medium text-ink">
     <Chevron/> {title}                                  ← still the aria-expanded button
  </button>
  <span className="text-2xs font-mono text-ink-4">{w.project} · {w.branch ?? "—"}</span>  ← ONE element
  <span data-status-known={String(statusKnown(label))}
        className={`text-2xs font-medium ${statusClass(label)}`}>{label}</span>
  {!w.schema_ok && <Chip>structure unavailable</Chip>}   ← exact string
  <span className="ml-auto text-2xs font-mono tabular-nums text-ink-3">{elapsed}</span>

line 2  pl-rail, text-2xs font-mono flex gap-2:
  <span className="text-ink-4">{w.phase ? `Phase ${i}/${t} · ${title}`
                                        : "phases resolve on completion"}</span>  ← ONE element
  <span className="text-ink">{formatUsd(w.costUsd)}</span>                        ← ONE element
  <span className="text-ink-4">{formatTokens(w.tokens)} tok</span>                ← ONE element

line 3  pl-rail (only when w.phase):
  <div className="h-0.5 rounded bg-surface-3">
    <div className="h-full rounded bg-working/50" style={{width: `${pct}%`}}/>    ← NO transition
  </div>
```

Seven literals are test-pinned here: `research`, `alpha · feat/x`, `$1.25`,
`512K tok`, `phases resolve on completion`, `Phase 2/4 · Judge`,
`structure unavailable`, and the `data-status-known` attribute
(`WorkflowRunCard.test:27-62`). The chip borders come off; the element boundaries
do not move.

**The phase bar** is the one graphical element spent on this section. It is
derived entirely from `w.phase` (already optional-guarded, already rendered as
text — K9), its width is a **static inline style with no transition**, and it
gives the loudest section the "how far along" read that a text label can't.

**Agent rows (expanded):** indented to `pl-10` — the rail again, one level in.
`h-6 flex items-center gap-2 font-mono text-2xs`: state dot (`AGENT_DOT`,
`animate-pulse` → `am-pulse`), `{a.label ?? a.agent_id}` `text-ink-2 truncate`
(`WorkflowRunCard.test:52` matches `ad673b79`), model `text-ink-4`, tokens
`tabular-nums text-ink-4 w-14 text-right`, `▸ {last_tool}` `text-working/70 truncate`.

**Caret:** `▸`/`▾` → a 10px SVG chevron rotating 90° over `duration-base`. Safe:
the caret is already `aria-hidden`, so `getByRole("button", {name:/research/})`
is unaffected.

### 4.10 `ToolStats`

Keeps `return null` when `total === 0` (K8), the top-8 slice, and the persisted
collapse (K10).

- Header: caret + `Σ Tool usage ({total})` — exact string; the `Σ` drops to
  `text-ink-4` so it recedes into the label instead of shouting.
- Rows become `<MeterRow>`: leading `toolDot()` dot, label `prettyTool(s.tool)`
  (own element — `ToolStats.test:17,19`), slot `a` = `{s.calls}` (own element —
  `ToolStats.test:18`), slot `b` = `avg {formatDur(s.avgMs)}` or `""`.
- **The proportional bar goes neutral:** `bg-primary/10` → `bg-bar`
  (= `--surface-3`). The sidebar stops competing with the board for accent
  colour, which is the single biggest hierarchy win in the restyle.
- `overflow-hidden` on the row is dropped: the bar's width is a **percentage of
  the row**, so it cannot overflow horizontally, and `inset-y-[0.125rem]` insets
  it vertically — there is nothing left to clip.

### 4.11 `CostPanel`

Keeps `return null` when `liveTotalUsd === 0 && todayUsd === 0` (K8) — no shell,
no header, zero footprint.

- Header: `$ Session cost` + the `API-equiv` note at `ml-auto` as bare
  `text-3xs text-ink-4` **with its `title` attribute intact** (K13); chip
  background removed.
- Body becomes a **2-up readout** — the one place a number is allowed to be
  bigger:

```tsx
<div className="grid grid-cols-2 gap-3">
  <div><div className="text-2xs text-ink-4">today</div>
       <div data-testid="cost-today"
            className="text-base font-mono font-medium tabular-nums slashed-zero text-ink">
         {formatUsd(cost.todayUsd)}</div></div>
  <div><div className="text-2xs text-ink-4">live total</div>
       <div data-testid="cost-live-total"
            className="text-base font-mono tabular-nums slashed-zero text-ink-3">
         {formatUsd(cost.liveTotalUsd)}</div></div>
</div>
```

`today` reads primary, `live total` one step back. **Labels stay the exact
strings `today` and `live total` in their own elements, and values in their own
elements** — `CostPanel.test:23-26` does `getByText("live total")` and
`getByText("$3.71")` separately.

- Per-model rows below: `h-5 font-mono text-2xs`, model `text-ink-4 truncate`,
  cost `tabular-nums text-ink-4` (`CostPanel.test:27-28`: `Opus 4.8`, `$10.90`).

### 4.12 `CostBreakdown`

Keeps `return null` on empty `byProject` and the `?? []` version-skew fallbacks
(K8, K9).

- Header: caret + `≣ Cost breakdown` — exact; `≣` dimmed to `ink-4`.
- Group labels (`by project`, `by branch`) → `h-5 text-3xs uppercase tracking-caps text-ink-4`.
- Rows use the **identical `<MeterRow>`** as ToolStats — same neutral `bg-bar`,
  same `h-6`, same right-aligned numeric slots — so the two sidebar panels
  visibly share one grid. `a` = `formatUsd`, `b` = `formatTokens`
  (`CostBreakdown.test:25-33`: `alpha`, `$12.50`, `1.2M`, `alpha · main`, `beta · —`).
- `+{n} more` → `text-3xs text-ink-4`.

### 4.13 `ActivityFeed`

Keeps `max-h-[calc(100vh-8rem)]` (K7) and the `useFeedLimit` select.

- Header: the live dot (accent, `am-ping` ring replacing `animate-ping`) + `⚡ Live
  activity` — **the `⚡` must stay in the same text run as the label**
  (`Board.test:35` does `getByText("⚡ Live activity")`).
- Select: `h-6 rounded-md border-hairline border-border bg-transparent pl-2 pr-6
  text-2xs text-ink-3`, custom 10px chevron kept,
  `aria-label="Number of tool calls to show"` preserved (K13).
- **Rows lose their card entirely** — `rounded-lg border border-border bg-card/60
  shadow-card` → `ROW_BASE` + `py-1`. No dividers, no `space-y-2` (→ `space-y-0`).
  This is the largest single noise reduction in the app: ~20 boxes become 20 lines.
- Line 1: tool dot (rail-aligned) · `prettyTool(a.tool)` `text-2xs font-mono
  font-medium text-ink` · `formatDur(a.dur)` `tabular-nums text-ink-4` · `ml-auto`
  `ago(a.at)` `tabular-nums text-ink-4`. Line 2: `pl-rail`, detail
  `text-ink-3 truncate flex-1`, project `text-ink-4`.
  (`ActivityFeed.test`: `Bash`, `Read`, `oxygenrx` ×2, `Board.tsx`,
  `navigate_page`, `1.2s` — each its own element.)
- Craft detail: the scroller gets a bottom fade so the feed ends instead of being
  guillotined, applied as an inline style with **both** properties set to the
  **same** value (React does not auto-prefix `maskImage`):

  ```ts
  const FADE = "linear-gradient(to bottom,#000 calc(100% - 1.5rem),transparent)";
  style={{ WebkitMaskImage: FADE, maskImage: FADE }}
  ```

  (rem, not `24px`, so the fade scales with the ladder — §1.7.)
- Empty state: `Waiting for tool activity…` — exact string, bordered box deleted,
  now a centered `text-2xs text-ink-4 py-6` line.
- `am-row-in` retuned (§5.2); per-row `viewTransitionName = vt-a-${a.id}`
  preserved (K18); the stagger drops to `Math.min(i,6) * 16` ms.

### 4.14 `WorkflowsPage` + `CostDailyPage` tables

One shared treatment, both pages.

- `table w-full border-collapse font-mono text-xs` (12px, up from 11px — these are
  reading surfaces, not chrome).
- `thead th`: `sticky top-12 z-10 h-8 bg-surface-0 border-b border-border`, inner
  button `text-2xs uppercase tracking-caps text-ink-4 hover:text-ink`, sort caret
  `▲`/`▼` at 10px on the active column only. `aria-sort` preserved (K13).
  **Deviation:** the design's `bg-surface-0/92 backdrop-blur` on `thead` is
  replaced with an **opaque** `bg-surface-0`. Two stacked blur layers per page
  (PageHeader + thead) is exactly the paint cost R6 rules out; the board's group
  headers made the same call.
- `tbody tr`: `h-8 border-b border-border-weak hover:bg-surface-2` — the
  `border-border/50` alpha hack is retired for a real token. **No vertical rules,
  no zebra striping.** Row dividers use a **plain 1px `border-b`, not
  `border-hairline`** — R8: `0.5px` inside `border-collapse: collapse` can vanish
  at some zoom levels.
- `td`: `px-2 py-[0.3125rem]`. First text column `text-ink font-medium`; other
  text columns `text-ink-3`; numerics `text-right tabular-nums slashed-zero`, with
  money at `text-ink` and tokens at `text-ink-4`.
- Totals row: `border-t border-border` (full strength, not weak) +
  `bg-surface-1 font-semibold text-ink`. **`data-testid="wf-totals"` preserved**
  (K13). It stays the **last** `<tr>` in `<tbody>` and no `<tr>` may be inserted
  before the data rows — `WorkflowsPage.test:76` / `CostDailyPage.test:35` index
  `getAllByRole("row")[1]` as the first data row.
- Expanded detail row (`WorkflowsPage`): `bg-surface-1` (was `bg-card/40`). Phase
  group titles `text-3xs uppercase tracking-caps text-ink-4` (exact strings
  `Phase 1 · Explore`, `unphased` — `WorkflowsPage.test:93,95`); agent lines
  `h-6 flex gap-3 text-2xs`. Add a 1px vertical hairline at the rail x-offset
  connecting agents under their phase — the rail, one more time, now as a tree.
- **Add a disclosure caret** to the Workflow-name cell (10px SVG, `aria-hidden`,
  rotates when open) so the clickable rows finally show they're clickable. It goes
  *inside* the existing cell — the column count and the 8-`<td>` totals row are
  untouched. **The caret must be an SVG with no text content**:
  `WorkflowsPage.test:92` does `fireEvent.click(await findByText("research"))`,
  which resolves to the `<td>` by its text content.
- Footer note `format last verified on {v}` — exact string, `text-2xs text-ink-4`.
- Range control → shared `<Segmented>`:
  `h-7 inline-flex items-center gap-0.5 rounded-md border-hairline border-border p-0.5`,
  each item `h-[1.375rem] px-2.5 rounded text-xs text-ink-3`, active
  `bg-surface-3 text-ink`. Keeps the existing `range === w` ternary and the
  `7d`/`14d`/`30d`/`All` labels verbatim.
- Data rows gain `data-testid="wf-row"` / `data-testid="cost-row"` (§6.1).

### 4.15 `workflowStatus.ts` recolour

Two mappings are semantically wrong and the new `--danger` token fixes them:

```ts
const WF_STATUS_CLASS: Record<string, string> = {
  completed: "text-done",       // was text-working — completed is not running
  running:   "text-working",
  failed:    "text-danger",     // was text-attention — attention means YOU are needed;
  killed:    "text-danger",     //                     danger means it broke
  orphaned:  "text-ink-4",      // was text-muted-foreground
  settled:   "text-ink-4",
};
export function statusClass(label: string): string {
  return WF_STATUS_CLASS[label] ?? "text-ink-4";   // was text-muted-foreground/70
}
```

`statusKnown()` and the display-hint-never-a-validator contract are untouched
(K12). **Verified: no test asserts on `statusClass()`'s return value**, so this
lands with no test change (§6.3).

### 4.16 Empty / error / loading

All copy preserved verbatim: `Loading…`, `Couldn't load cost data.`,
`Couldn’t load workflow runs.`, `No usage in this window.`,
`No workflow runs in this window.`, `Waiting for tool activity…`,
`Nothing open. 🎉`, `No completed todos yet.`.

**Byte-level warning (verified with `cat -A`):** the two "couldn't" strings do
**not** match. `CostDailyPage.tsx:93` uses an ASCII `'` (`Couldn't load cost
data.`); `WorkflowsPage.tsx:149` uses U+2019 (`Couldn’t load workflow runs.`).
Both tests match on `/couldn.t load/i`, so both pass either way — which is
exactly why an implementer "tidying" one to match the other would be an
undetected copy change. Leave each file's byte as it is.

- Page-level: `py-16 text-center text-sm text-ink-3`, with
  `role="status" aria-live="polite"` **added to the loading branch only**.
- **No skeletons** — deliberate: these fetches hit `127.0.0.1` and resolve in
  milliseconds, so a skeleton would flash and read as jank. Linear reaches for
  skeletons because it is over a network; we aren't.
- Section-level: a single dim line, never a bordered shell — consistent with the
  zero-footprint contract (K8).

---

## 5. Motion

### 5.1 The gate (unchanged, non-negotiable — K6)

Every keyframe animation stays behind the `.am-anim` ancestor selector.
`useMotion` still toggles `html.am-anim` (default ON). `index.html`'s third
bootstrap script is untouched. `canViewTransition()` still requires **both**
browser support and `am-anim`. The deliberate override of OS
`prefers-reduced-motion` stays, **with its explanatory comment intact** — this is
a single-user dashboard where motion is a feature.

### 5.2 Retuned curves and durations

Linear's `ease-out-quad` — fast and resolving — replaces the current springy
overshoot. Full replacement for `styles.css` lines 47–116:

```css
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

.am-anim .am-spin  { animation: am-spin 1.4s linear infinite; }
.am-anim .am-pulse { animation: am-pulse 2s var(--ease) infinite; }
.am-anim .am-ping  { animation: am-ping 1.8s var(--ease) infinite; }

/* NB: no `position: relative` here. §4.4's shimmer element is `absolute` (so it
   is already a containing block for ::after), and this file's plain rules are
   emitted *after* `@tailwind utilities` — at equal specificity a bare
   `.am-shimmer { position: relative }` would win over Tailwind's `.absolute`
   and pull the underline out of the row's bottom edge. */
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

::view-transition-group(*) {
  animation-duration: var(--t-move);
  animation-timing-function: var(--ease-move);
}
::view-transition-old(root), ::view-transition-new(root) { animation: none; }
```

Deltas from today: `am-row-in` 0.36s spring + 1.4s flash → 160ms quad + 600ms
flash; `am-fade-in` 0.4s/8px → 160ms/4px; `am-count` 1.22→0.96 bounce → a 1.06
whisper; `am-pop` drops its `translateY`; `am-shimmer` 1.6s @ .65 alpha → 2s @
.45 (slower and dimmer because at 2–3 concurrent working rows the current sweep
is busy); view transitions 0.34s → 280ms.

### 5.3 The three animations that currently bypass the Motion toggle

**This is the one real fidelity fix in the redesign.** Turning Motion off today
leaves all three of these spinning, because they are stock Tailwind utilities and
Tailwind's `animate-*` classes carry no `.am-anim` ancestor requirement.

| # | Site | Today | Ships as | Motion-off fallback |
|---|---|---|---|---|
| 1 | `SessionCard.tsx:65` — the `⟳` active-tool glyph | `animate-spin` | `am-spin` (also used by `<StatusGlyph kind="working">`) | glyph shows a static 3/4-arc at 1–2 o'clock; the `⟳` character sits still — still reads "in progress" |
| 2 | `SessionCard.tsx:52` status dot **(element deleted)** and `WorkflowRunCard.tsx:8` `AGENT_DOT.running` | `animate-pulse` | `am-pulse` | dot renders solid at full opacity |
| 3 | `ActivityFeed.tsx:16` — the live ping ring | `animate-ping` | `am-ping` | no animation runs, so the ring stays at `scale(1)` — exactly the dot's own size — and sits behind the solid accent dot, i.e. reads as just the dot |

After this change, `grep -rn "animate-" src/web/` must return **zero** hits. That
grep is the acceptance check.

**Fallbacks are designed, not degraded.** Each motion-off state is a legible
static state chosen on purpose, which is why `am-ping`'s ring starts at
`opacity:1` inside the keyframe rather than relying on a base style.

### 5.4 Hover / press

- Rows, links and ghost buttons: `transition-colors duration-quick ease-quad`
  (100ms). **Row hover is the only thing that transitions on a row.**
- Ghost buttons get `data-press` (§5.2). **Not** the A−/A+ pair and **not** the
  `<Segmented>` items — a 3% scale on a joined 28px control reads as wobble
  (R12). If it still feels wrong on any control, drop the attribute; nothing
  depends on it.

### 5.5 Two hard rules the ticking data imposes

1. **Only `transform`, `opacity`, `background-color`, `border-color` and `color`
   may transition.** Never `width`, `height`, `padding`, `margin`, or
   `top`/`left`. This is why the new workflow phase bar's `width` is a plain
   inline style with **no** transition — it is fed by the 5s `workflows` channel
   and must not animate layout.
2. **Nothing may transition on a value driven by `useNow()`.** All ticking text
   (`ago()`, `formatDuration()`, elapsed timers, token counts) renders with no
   transition and no keyed remount. `am-count` stays keyed only on session/todo
   counts, never on the clock.

### 5.6 View-transition discipline (preserved exactly — K3)

`runViewTransition` wraps only post-first-paint SSE `state` commits and
`DoneDialog` pagination. The 5s `workflows` channel keeps its plain `setState`
with its explanatory comment. First paint stays plain. Layout-shape changes get
FLIP; token-count ticks do not. `App.tsx` and `viewTransition.ts` are not edited.

---

## 6. Test-coupling strategy

The suite is **23 test files / 111 tests** (`bun run web:test`, green on `main`
today). It has **86 `getByText` / 18 `findByText` / 9 `queryByText`** calls,
**10 `getByRole`** (plus 1 `queryByRole`), **5 `getByLabelText`**, **2
`getByTitle`** (plus 1 `queryByTitle`), three assertions on Tailwind class
strings, and exactly **one** `data-testid` (`wf-totals`). Almost nothing is
insulated from markup change. This is the dominant risk in the whole redesign.

### 6.1 Phase 0 — retrofit `data-testid` **before** any restyle

A standalone first commit that changes **no styling**: it only adds attributes
and re-points the three *structural* selectors. `bun run web:test` must be green
before and after with no other diff.

| `data-testid` | Element | Replaces |
|---|---|---|
| `todos-scroller` | `TodosSection` open-list scroller | `getByText("open1").closest('[class*="overflow-y-auto"]')` — the `className` assertion on `max-h-[40vh]` **stays** (K7) |
| `todos-done-link` | the `✓ Done (n) →` button | the `getByText(/Done \(1\)/)` *click* (the text *assertions* stay) |
| `session-group-{status}` | `Column` wrapper | nothing today — enables group-membership assertions after the kanban→list change |
| `session-row` (+ `data-status`) | `SessionCard` root | nothing today |
| `wf-badge` | `SessionCard` wf badge | nothing — `title="owns a live workflow run"` is **kept** and its three assertions (`SessionCard.test:50,55`, `Board.test:60`) are left alone |
| `appbar-count-{working,needs-you,todo}` | `AppBar` `Count` wrapper | nothing — `getByText("1 working")` stays |
| `cost-today`, `cost-live-total` | `CostPanel` value elements | nothing — `getByText("$3.71")` stays |
| `wf-run-row` | `WorkflowRunCard` root | nothing |
| `wf-row` | `WorkflowsPage` data `<tr>` | `getAllByRole("row")[1]` |
| `cost-row` | `CostDailyPage` data `<tr>` | `getAllByRole("row")[1]` |
| `note` | `TodoCard` note element | `getByText("a clamped note")` in the `line-clamp-1` assertion |
| `wf-totals` | **exists — do not touch** | — |

**Rule: test-ids are additive.** Every existing text / `aria-label` / `title`
selector must keep working after Phase 0. Only selectors that are *structural*
(`closest()`, `.className`, positional row index) are migrated — those are the
ones a restyle legitimately invalidates. Copy assertions are the product
contract and stay exactly as they are.

### 6.2 Load-bearing literals — the exhaustive list

**Exact strings that must render, and the element boundary they need.** "ONE
element" means the entire string must be the text content of a single element.

| String | Boundary | Test |
|---|---|---|
| `agent-monitor` | own element | `App.test:35` |
| `1 working` / `1 needs you` / `1 to do` | `{n} {label}` **ONE** span | `AppBar.test:27-29` |
| `Cost`, `Workflows`, `Motion`, `Dark`/`Light`, `A−`, `A+` | visible at every breakpoint | K14 |
| `browns` (project) | own element | `Board.test:24` |
| `Refactor (1/3 done)` (task) | own element | `Board.test:25` |
| `⚠ Run migration?` | **ONE** element | `Board.test:26` |
| `⎇ feat/x` | **ONE**; absent when `branch == null` | `SessionCard.test:15,19` |
| `Bash…` | **ONE** | `SessionCard.test:23` |
| `$1.24 · 312K tok` | **ONE** | `SessionCard.test:36` |
| (no `tok` anywhere) when `cost` is undefined | whole subtree | `SessionCard.test:41` |
| `Hand off spec`, `→ Maria` | own / **ONE** | `Board.test:27-28` |
| `✓ to complete · ✕ to delete` | **ONE** | K14 |
| `✓ Done (n) →` | **ONE**, on a `<button>` | `TodosSection.test:23,42`, `Board.test:29` |
| `Nothing open. 🎉` | **ONE** | K14 |
| `No completed todos yet.` | **ONE** | `DoneDialog.test:33` |
| `1–10 of 12`, `Prev`, `Next` | own | `DoneDialog.test:23,25` |
| `⚡ Live activity` | `⚡` in the **same text run** as the label | `Board.test:35` |
| `Waiting for tool activity…` | **ONE** | `ActivityFeed.test:55` |
| `1.2s` (a bare `formatDur`) | own element | `ActivityFeed.test:50` |
| `Σ Tool usage (511)` | matched by `/Tool usage \(511\)/` | `ToolStats.test:16` |
| `Bash`, `492`, `navigate_page` | own elements | `ToolStats.test:17-19` |
| `live total`, `today`, `$3.71`, `$12.40`, `Opus 4.8`, `$10.90` | six separate elements | `CostPanel.test:23-28` |
| `alpha`, `$12.50`, `1.2M`, `alpha · main`, `beta · —` | own elements | `CostBreakdown.test:25-33` |
| `⚙ Workflows (n)` | on a `<button>`, matched by `/Workflows \(1\)/` | `Board.test:59`, `App.test:57`, `WorkflowRunCard.test:82` |
| `research`, `wf_abc`, `spec-plan`, `map-codebase` | own elements | `WorkflowRunCard.test:27,35,67,84` |
| `alpha · feat/x` | **ONE** | `WorkflowRunCard.test:28` |
| `$1.25`, `512K tok` | two elements | `WorkflowRunCard.test:29-30` |
| `phases resolve on completion`, `Phase 2/4 · Judge` | **ONE** each | `WorkflowRunCard.test:42,47` |
| `structure unavailable` | **ONE** (both sites) | `WorkflowRunCard.test:62` |
| `ad673b79`, `a2` (agent-id fallback) | own elements | `WorkflowRunCard.test:52`, `WorkflowsPage.test:96` |
| `Cost by day`, `Workflow runs` | own elements | `App.test:28,42` |
| `Jun 16 14:03`, `Jun 16`, `3m 5s`, `$9.00`, `$11.00`, `3` | own cells | `WorkflowsPage.test:49-68`, `CostDailyPage.test:23-27` |
| `—` (null branch cell) | own cell, ≥1 occurrence | `CostDailyPage.test:25` |
| `Phase 1 · Explore`, `unphased`, `Sonnet 5` | own elements | `WorkflowsPage.test:93-97` |
| `format last verified on 2.1.226` | matched by regex | `WorkflowsPage.test:115` |
| `Loading…`, `Couldn't load cost data.`, `Couldn't load workflow runs.`, `No usage in this window.`, `No workflow runs in this window.` | own elements | `CostDailyPage.test:51,57`, `WorkflowsPage.test:103,109` |
| `⚠ workflow data looks off — Claude Code may have changed format` | matched by `/workflow data looks off/i` | `Board.test:65` |
| `7d`, `14d`, `30d`, `All` | accessible name **exactly** `All` for `/^all$/i` | `CostDailyPage.test:44`, `WorkflowsPage.test:85` |
| `Cost` column header | a `<button>` whose name matches `/cost/i`, **and no other button on the page may match** | `CostDailyPage.test:34`, `WorkflowsPage.test:75` |

**Attributes:** `aria-label` × {`Toggle theme`, `Toggle motion`, `Mark done`,
`Delete`, `Close`, `Decrease text size`, `Increase text size`, `Number of tool
calls to show`}; `title="owns a live workflow run"`; the API-equiv `title`;
`aria-expanded` on all **five** disclosures (`TodosSection`, `WorkflowsSection`,
`ToolStats`, `CostBreakdown`, `WorkflowRunCard` — the `WorkflowsPage` expandable
`<tr>` has never had one and does not gain one here, §10.1);
`aria-pressed` on the Motion button;
`aria-sort` on every sortable `<th>`; `data-status-known` on both status-label
sites; `data-testid="wf-totals"`.

**Class strings:** `max-h-[40vh]` on the todos scroller; `line-clamp-1` on the
TodoCard note; the *absence* of any `.cursor-grab` element.

**Structural:** `getAllByRole("row")[1]` must be the first data row on both
tables (totals row stays last in `<tbody>`).

### 6.3 Expected test edits, per component

| Component | Change | Test impact |
|---|---|---|
| `AppBar` | count pills → glyph + span; controls → ghost | **none** if the inner `{n} {label}` span survives — Phase 0 adds testids as insurance |
| `Lane`/`Column` | 3-col grid → grouped list, reorder | **none** (no test imports them; `Board.test` queries only text) |
| `SessionCard` | card → row, status label removed, tint | **none** if the four literals in §6.2 keep their boundaries |
| `TodosSection` | masonry → list; `Done` link into header | **none**; Phase 0 re-points the two structural selectors |
| `TodoCard` | `✓` char → `StatusGlyph`; danger token | **none** (`aria-label` is the contract) |
| `DoneDialog` | glyph rows, ghost pager | **none** |
| `WorkflowsSection` / `WorkflowRunCard` | card → row, phase bar | **none** |
| `ToolStats` / `CostBreakdown` | `<MeterRow>`, neutral bars | **none** |
| `CostPanel` | list → 2-up grid | **none** if labels and values stay in separate elements |
| `ActivityFeed` | cards → lines, mask | **none** |
| `CostDailyPage` / `WorkflowsPage` | `<PageHeader>`, `<Segmented>`, caret in name cell | **none**; Phase 0 re-points `rows[1]` |
| `workflowStatus.ts` | recolour | **none** — verified: no test reads `statusClass()` |

**Expected net test churn: three selector re-points in Phase 0, and nothing
else.** If any *other* test needs editing during the restyle, that is a signal
the change crossed a contract in §6.2 — stop and re-read the row, don't edit the
test.

### 6.4 Order of work

Run `bun run web:test` **after every component**, not at the end. Budget roughly
a day for lockstep test work even though the expected churn is small — the value
is in catching a boundary violation on the component that caused it.

---

## 7. Risk register

| # | Risk | Severity | Mitigation (binding) |
|---|---|---|---|
| **R1** | **Test-copy coupling.** 86 `getByText` calls, one `data-testid`. Most likely breakers: moving `✓ Done (n) →` into the header, removing the AppBar count-pill wrapper, restructuring `CostPanel` into a 2-up grid, and the `Lane` 3-column → grouped-list change. | High | §6.1 Phase 0 retrofit lands **before** any restyle; §6.2 is the checklist; `bun run web:test` after each component. |
| **R2** | **Vertical growth.** A single-column grouped session list is taller than the 3-column kanban when sessions are evenly spread (9 sessions × 3 cols ≈ 360px today vs ≈ 384px as rows). The `text-xs`/`text-2xs` line-height additions (§1.9) add to this. Compact one-line idle rows plus sessions-first more than pay for it in the common lopsided case (1 working / 0 needs-you / 8 idle), but a 20-session day is longer. | High | **Measure at 1440×900 before merging** (§8, V4) with a hard gate. Escape hatch if it fails: cap the Idle group with its own inner scroll — but that is a **new affordance**, so it ships as a follow-up, never as part of the restyle. |
| **R3** | `workflowStatus.ts` recolour is a semantic change, not just visual. | Low | **Resolved during design**: grep-verified that no test asserts `statusClass()`'s output; only `data-status-known` is pinned. Lands as specified (§4.15). |
| **R4** | **Separation rests entirely on hover + rail + rhythm** once per-row borders and shadows are gone. At the 22px text-size setting with 15+ rows this can smear. | Medium | Verify at **all five** ladder steps (§8, V2). Fallback if it smears: `divide-y divide-border-weak` on the **Idle group only** — the densest, lowest-signal list. |
| **R5** | **Sticky-offset arithmetic.** Group headers use `top-12`, the bar `h-12`, the aside `top-14` — all rem, so at 22px root the bar is 66px and the offsets follow. But `max-h-[calc(100vh-8rem)]` on `ActivityFeed` mixes a viewport unit with a rem-derived assumption. | Medium | Check for header overlap and feed clipping explicitly at **14px and 22px** (§8, V2). `max-h-[calc(100vh-8rem)]` may not be changed (K7). |
| **R6** | **Two stacked `backdrop-blur` layers** on a page that re-renders at 1Hz is a real paint cost. | Medium | **Already mitigated in this spec**: board group headers and table `<thead>` are **opaque** `bg-surface-0`, not blurred — only the app bar / page header blurs. If profiling still shows jank (§8, V5), drop the bar's blur to a solid `bg-surface-0` at 100%. |
| **R7** | **Keyboard-unreachable rows.** The clickable `<tr>` in `WorkflowsPage` and the click-only `<div>` session/todo rows take no focus and are not in §1.4's `:where(a,button,select,summary,input,[tabindex])` list — so the new global ring **cannot** appear on them. Giving every real control a crisp ring makes the rows' silence on Tab the obvious remaining gap. | Medium | **Pre-existing a11y gap**, neither introduced nor worsened here — and note the ring does *not* accidentally start outlining `<tr>`s. Converting rows to buttons is a functional change and is **out of scope**. Filed as a follow-up (§10). The `sr-only` status label on session rows (§4.4) is the one a11y improvement that *is* in scope, because it is purely additive. |
| **R8** | **`--hairline: 0.5px` at 2dppx** can disappear inside `border-collapse: collapse` tables at some zoom levels. | Medium | **Rule**: `border-hairline` is for panel and control edges **only**. Table row dividers use a plain 1px `border-b border-border-weak` (§4.14). Verified per §8, V3. |
| **R9** | **`font-feature-settings: "cv01","ss03"`** is a no-op without Inter (verified absent), but a *partial* Inter install can produce inconsistent numerals between the sans and mono stacks. | Low | Scope it to `:root` (§1.3) and verify the AppBar counts against the table numerics side by side (§8, V6). |
| **R10** | **`mask-image`** on the ActivityFeed scroller needs the `-webkit-` prefix and can clip the custom scrollbar thumb in some Chromium versions. | Low | Ship behind a quick visual check (§8, V7). It is pure garnish and **the first thing to cut** if it misbehaves. |
| **R11** | **Overriding `sm` (14→13) and `base` (16→15)** silently reflows every existing usage. | Medium | §1.9 enumerates **all 22 sites** with their disposition. Re-run the grep after the sweep: `grep -rn "text-sm\|text-base\|text-lg\|text-xl" src/web/` must match that table exactly. |
| **R12** | The scale-on-press micro-interaction reads as wobble on the joined 28px A−/A+ pair. | Low | `data-press` is applied **selectively** (§5.4) — not on A−/A+, not on `<Segmented>`. If it feels wrong anywhere else, drop the attribute; the design does not depend on it. |
| **R13** | **`fontWeight.medium: 510` would render bold** on the actual shipping font (FreeSans, Regular+Bold only), because CSS weight matching for >500 searches upward. | High | **Resolved during design**: `medium` is **not** overridden (§1.5). Only `semibold: 590` and `bold: 680` are set, both of which already resolve to 700 on static faces exactly as today's 600/700 do. |
| **R14** | **Tailwind opacity modifiers outside the default scale** (`/8`, `/12`, `/14`, `/72`) silently produce **no class at all**, so the surface renders fully opaque (or, for a backdrop, hard). Confirmed by a throwaway build against this repo's own `tailwindcss`: `bg-black/72` emits nothing, `bg-black/[0.72]` emits correctly. | Medium | §1.8 rule: the default scale is multiples of 5, so **any alpha that is not a multiple of 5 must be bracketed**. Acceptance: `grep -ranE "/[0-9]*[1-46-9]\b" src/web/` returns nothing (that pattern matches exactly the non-multiples of 5, one or two digits, and leaves `/25`, `/70`, `/100` alone). |

---

## 8. Verification strategy

Nothing is "done" until every check below has been **run** and its output read.

### 8.1 Automated gates (must all pass, in this order)

```
bun run web:test        # 23 files / 111 tests — green before Phase 0, after Phase 0, and after each component
bun run typecheck       # tsc on both tsconfigs
bun run web:build       # vite build must succeed (catches an invalid Tailwind class only via visual, so also V1)
bun test tests/         # server suite — must be untouched; proves scope discipline
git diff --exit-code src/web/api.ts src/web/App.tsx src/web/viewTransition.ts \
                     src/web/index.html src/web/useTheme.ts src/web/useTextSize.ts \
                     src/web/useMotion.ts src/web/useNow.ts src/web/useHashRoute.ts \
                     src/web/usePersistedToggle.ts src/web/useFeedLimit.ts \
                     src/web/types.ts src/web/tools.ts src/web/cost.ts src/web/time.ts
```

(That file list is exactly §9's "not touched" list, so the two cannot drift.)

> **Every grep below must pass `-a` (`--binary-files=text`).** Verified on
> `main`: `src/web/components/CostBreakdown.tsx` contains a literal NUL byte at
> offset 2483 — it is deliberate, a `\x00` separator inside the branch-row React
> key (`` `${b.project}\x00${b.branch ?? ""}` ``) — which makes `grep` classify
> the file as binary and **silently skip it**. Without `-a`, `grep -rn
> "bg-primary/10\|text-\[10px\]\|muted-foreground/\|tracking-wider" src/web/`
> reports zero hits for that file *today*, i.e. every acceptance grep below would
> pass green while `CostBreakdown` still carries the old classes. **Decided:
> swap** — the implementation plan's Task 9 replaces the `\x00` separator with a
> printable, collision-proof one as part of its restyle (see §10). Every grep
> in this file keeps `-a` regardless; it is required until Task 9 lands and
> harmless after.

| Grep | Expected |
|---|---|
| `grep -ran "animate-" src/web/` | **0 hits** (§5.3 acceptance) |
| `grep -ran "dark:" src/web/` | **0 hits** (K5; already 0 today) |
| `grep -ran "red-400\|shadow-card\|bg-primary/10\|border-border/50\|tracking-wide\|text-\[10px\]\|text-\[0.65rem\]" src/web/` | **0 hits** (§1.9; matches `shadow-card` and `shadow-card-hover` both) |
| `grep -n "card:" tailwind.config.js` | **0 hits** — the `boxShadow.card` key is dropped, not just unreferenced (§1.9) |
| `grep -ran "muted-foreground/" src/web/` | **0 hits** (32 today, §1.9) |
| `grep -ran "cursor-grab" src/web/` | **0 hits** (K15; already 0 today) |
| `grep -ran "max-h-\[40vh\]" src/web/` | exactly **2 hits** (TodosSection, WorkflowsSection — K7) |
| `grep -ran "max-h-\[calc(100vh-8rem)\]" src/web/` | exactly **1 hit** (K7) |
| `grep -ran "prefers-reduced-motion" src/web/` | exactly **3 hits** — the comments in `useMotion.ts`, `viewTransition.ts` and `styles.css` all survive (K6) |
| `grep -ranE "\[[0-9]+px\]" src/web/components/` | only `backdrop-blur-[20px]` ×2 (AppBar, PageHeader — §1.7) |
| `grep -ranE "/[0-9]*[1-46-9]\b" src/web/` | **0 hits** — no unbracketed off-scale opacity modifier (R14; already 0 today) |

### 8.2 Real-browser verification

Run the dev server (`bun run web:dev` → `http://127.0.0.1:5317`, which proxies
`/api` and `/events` to the live server on `127.0.0.1:4317`, so the board renders
**real live data**, not fixtures). Drive it with the Chrome DevTools MCP.

**V1 — the visual matrix.** 18 screenshots minimum:

| axis | values |
|---|---|
| route | `#/`, `#/cost`, `#/workflows` |
| theme | dark (default), light (via the **Theme button**, not devtools — this also exercises the toggle) |
| text size | 14px (A− ×1), 16px (default), 22px (A+ ×3) |

At **1440×900**. Then repeat `#/` alone at **1280×800** and **390×844** to
confirm the `lg:` grid stacks and the sidebar hairline drops.

For each: `take_screenshot` + `list_console_messages` (must be empty of errors).

**V2 — the text-size ladder extremes** (R4, R5). At 14px and 22px, on `#/`:
- No sticky group header overlaps the app bar or a row (`evaluate_script`:
  compare each `[data-testid^="session-group-"] > div:first-child`
  `getBoundingClientRect().top` against the app-bar height).
- The ActivityFeed scroller is not clipped and its scrollbar reaches its end.
- Rows in the Idle group are still visually separable — if they smear, apply the
  R4 fallback and re-shoot.
- On `#/workflows`, `thead th` stays pinned at exactly the page-header height.

**V3 — hairline at sub-pixel** (R8). At 1dppx, force the 2dppx branch:
```js
document.documentElement.style.setProperty('--hairline','0.5px')
```
This is the *worst* case (a 0.5px border on a 1-device-pixel display).
Screenshot the sidebar hairline, the app-bar bottom border, the segmented
control and both tables. **Gate: no border disappears.** Table row dividers are
plain 1px and must be unaffected — if they *do* change, a `border-hairline` leaked
into a table.

**V4 — vertical growth gate** (R2). The hard one; run it before merging.
1. On `main`, at 1440×900, `#/`: record `main.scrollHeight`, the session count
   by status, and whether the first session row is within the first 900px.
2. On the branch, same viewport, same live data (take both measurements within
   the same minute so the SSE snapshot is comparable): record the same three.
3. **Gate:** branch `main.scrollHeight` ≤ `1.10 ×` baseline, **and** the first
   session row is above the fold on the branch whenever it was on the baseline.
4. Also run the pathological case by temporarily rendering `Board` against a
   20-session fixture in a scratch route or a vitest DOM dump — if the gate fails
   only there, that is the R2 follow-up, not a blocker.

**V5 — paint cost** (R6). `performance_start_trace` on `#/`, let it run **20s**
of live SSE ticking (at least one 60s `state` commit is not guaranteed in 20s, so
also trigger one by touching a todo), `performance_stop_trace`.
**Gate:** no long task > 50ms attributable to paint/composite; no layout
thrash from the phase bar. If it fails, drop the app bar's `backdrop-blur` for a
solid `bg-surface-0`.

**V6 — typography on the real fallback** (R9, §1.6). Side-by-side screenshot of
the AppBar counts and a `#/workflows` numeric column at 16px. Confirm: numerals
are consistent between sans and mono; the negative tracking at `text-base`
doesn't look cramped on FreeSans; `font-medium` row titles are **visibly lighter
than** `font-semibold` headers (the R13 check — if they look identical and bold,
the `medium: 510` override crept back in).

**V7 — mask + scrollbar** (R10). Scroll the ActivityFeed to the bottom.
Confirm the fade renders and the custom scrollbar thumb is not clipped. If it is,
delete the mask.

**V8 — Motion off.** Click the Motion button. Then:
- `evaluate_script`: `document.documentElement.classList.contains('am-anim')` → `false`.
- `getAnimations()` on `document` returns **an empty array** — this is the
  §5.3 acceptance in the browser, and the thing that is broken today.
- Screenshot `#/` and confirm the working glyph shows its static arc, agent dots
  are solid, and the ActivityFeed ping ring is gone but its solid dot remains.
- Reload with Motion off and confirm no flash (the `index.html` bootstrap, K4).

**V9 — colour contrast.** With devtools, sample the computed colour of each ink
step against `--surface-0` and `--surface-1`, in **both** themes.
**Gate:** `text-1`/`text-2`/`text-3`/`text-4` all ≥ **4.5:1**; `accent`,
`working`, `attention`, `done`, `danger` as *text* on `surface-0` all ≥ **4.5:1**.
The token comments in §1.1 are the design's estimates — **re-measure, don't trust
them.** Any step that fails gets its L% adjusted in `styles.css` and the whole
matrix re-shot.

**V10 — theme/size/motion persistence.** Reload after each toggle and confirm
`localStorage` holds `am-theme`, `am-text-size`, `am-motion` and that the
pre-paint scripts apply them with no flash (K4).

---

## 9. Ship order and files touched

Each step is independently green (`web:test` + `typecheck` + `web:build`) and
independently reviewable. **Do not batch.**

| # | Step | Files |
|---|---|---|
| 0 | **`data-testid` retrofit + selector re-points. No styling.** | 9 components (`AppBar`, `CostDailyPage`, `CostPanel`, `Lane`, `SessionCard`, `TodoCard`, `TodosSection`, `WorkflowRunCard`, `WorkflowsPage`), 4 test files (`TodosSection`, `TodoCard`, `WorkflowsPage`, `CostDailyPage`) |
| 1 | Token layer + Tailwind config + global CSS: §1.1 ramps, §1.2 aliases, §1.3 non-colour tokens, §1.4 focus + scrollbars, §5.2 keyframes, plus the `.am-check` reveal rule (§2.2) and the theme-aware `dialog::backdrop` (§4.7). Aliases mean the app still renders correctly with old class names. | `styles.css`, `tailwind.config.js` |
| 2 | `StatusGlyph.tsx` + `primitives.tsx`. Not yet wired in. | 2 new files |
| 3 | `AppBar` | `AppBar.tsx` |
| 4 | `Board` layout + `Lane`/`Column` + degraded banner (the reorder and the grid→list change land together) | `Board.tsx`, `Lane.tsx` |
| 5 | `SessionCard` | `SessionCard.tsx` |
| 6 | `TodosSection` + `TodoCard` | 2 files |
| 7 | `TodoModal` + `DoneDialog` | 2 files |
| 8 | `WorkflowsSection` + `WorkflowRunCard` + `workflowStatus.ts` | 3 files |
| 9 | `ToolStats` + `CostPanel` + `CostBreakdown` + `ActivityFeed`; `CostBreakdown`'s NUL key separator is swapped (§10.5) and the now-consumerless `shadow-card` token comes out of `tailwind.config.js` (§1.9) | 4 files + `tailwind.config.js` trim |
| 10 | `PageHeader`/`Segmented` wiring: `CostDailyPage` + `WorkflowsPage` | 2 files |
| 11 | **§8 full verification pass** — all of V1–V10, both themes, ladder extremes | — |

**Not touched, and diff-verified so (§8.1):** `api.ts`, `App.tsx`,
`viewTransition.ts`, `index.html`, `useTheme.ts`, `useTextSize.ts`,
`useMotion.ts`, `useNow.ts`, `useHashRoute.ts`, `usePersistedToggle.ts`,
`useFeedLimit.ts`, `types.ts`, `tools.ts`, `cost.ts`, `time.ts`, and everything
under `src/server/`, `src/cli/`, `src/mcp/`.

---

## 10. Accepted risks and follow-ups (out of scope, filed on purpose)

1. **Keyboard reachability of rows.** Session rows, todo rows and `WorkflowsPage`
   `<tr>`s are click-only. The global focus ring makes this *visible* without
   making it *worse*. Converting them to real controls changes behaviour and
   belongs in its own spec (R7).
2. **Idle-group inner scroll.** If V4 fails only on a 20-session day, capping the
   Idle group is the answer — but it is a new affordance, so it ships separately
   (R2).
3. **Shipping Inter.** The type scale, tracking and `font-feature-settings` were
   designed for Inter Variable, which is not installed. Self-hosting a subset
   woff2 would deliver the intended typography, at the cost of a binary asset in
   the repo. Deliberately deferred; nothing in this design depends on it (§1.6).
4. **The superseded 2026-06-14 spec.** It still reads "Status: Implemented —
   merged to `main` (2026-06-14)". This change does not leave that dangling:
   the implementation plan's final task adds one `Superseded by` line under
   its status, pointing at this document, and commits that edit on its own
   (separately from the redesign itself, since the two documents' lifecycles
   are unrelated).
5. **The NUL byte in `CostBreakdown.tsx` — decided: swap.** The `\x00` key
   separator (§8.1) is valid, intentional code, but it costs every future
   `grep` over `src/web/` unless `-a` is passed. Task 9 of the implementation
   plan swaps it for a printable, collision-proof separator that is still
   plain text — e.g. `JSON.stringify([b.project, b.branch])`, or a `'␟'`
   literal — as part of its restyle of `CostBreakdown.tsx`; that task already
   rewrites the file, so the swap is folded in rather than filed separately.
   Every acceptance grep keeps `-a` (D7) through Task 9; once the swap lands,
   `-a` stops being load-bearing but stays harmless to keep passing.
