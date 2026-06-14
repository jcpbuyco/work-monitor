# work-monitor — Dashboard UI Redesign (shadcn-inspired)

**Date:** 2026-06-14
**Status:** Approved design — ready for implementation plan
**Scope:** `src/web/` only (styling + light structure). No backend, API, MCP, hook, or data-model changes.

## Goal

Give the dashboard a polished, intentional "shadcn look" — modern spacing, typography, consistent components, and subtle depth — without restructuring the two-lane kanban information architecture. The driving priority is **visual polish / professional feel**, not new functionality.

## Decisions (settled during brainstorming)

1. **shadcn depth:** Adopt the shadcn *aesthetic and theming pattern* hand-rolled in Tailwind v3. **No new dependencies** — no shadcn CLI, no Radix. We replicate shadcn's CSS-variable token system and card/badge styling directly.
2. **Theming:** Ship **both light and dark** palettes with a user-facing toggle (persisted; respects system preference; no flash on load).
3. **Layout scope:** **Restyle + light structure.** Keep the two-lane × three-column layout exactly. Add a proper top app bar (brand, live counts, theme toggle) and tighten the visual rhythm. Keep it responsive for the v2 phone goal.
4. **Palette:** Neutral base = **slate**; brand/primary accent = **violet**, used only for chrome (brand mark, theme toggle, focus rings, drop-target highlight). Kept distinct from the blue "working" status.
5. **Density:** **Comfortable** (roomy spacing).
6. **Status color semantics are unchanged** — only retuned for both themes: working = blue, needs-you / to-hand-off = amber, handed-off = indigo, done = emerald, idle/ended = muted slate.

## Architecture

### Token layer (`src/web/styles.css`)

Replace the current two-line stylesheet with a token layer using HSL CSS variables. Define light values under `:root` and dark overrides under `html.dark`. Channel-only HSL values (e.g. `222 26% 5%`) so Tailwind can apply opacity via `hsl(var(--x) / <alpha>)`.

Token set:

| Token | Role |
|---|---|
| `--background` | page background |
| `--card` / `--card-hover` | card surface + hover surface |
| `--muted` / `--muted-foreground` | secondary surfaces / secondary text |
| `--foreground` | primary text |
| `--border` | borders, dividers |
| `--chip` | count chips / hint pills |
| `--shadow` / `--shadow-a` | shadow color + alpha (so shadows soften in light mode) |
| `--primary` | brand accent (violet) |
| `--working` `--attention` `--handed` `--done` `--idle` | semantic status colors |

Approved values (from the validated mockup — implementer may fine-tune by ±a few % for contrast):

```
:root  (light)                      html.dark
--background: 210 30% 98%           222 26% 5%
--card:       0 0% 100%             222 20% 8.5%
--card-hover: 214 32% 97%           222 18% 11%
--muted:      214 24% 94%           222 16% 15%
--muted-foreground: 220 12% 42%     220 12% 60%
--foreground: 222 34% 12%           210 22% 95%
--border:     214 22% 86%           222 16% 16%
--chip:       214 24% 92%           222 16% 16%
--shadow:     220 40% 30%; a:0.08   0 0% 0%; a:0.35
--primary:    258 82% 56%           258 90% 67%
--working:    213 88% 50%           213 90% 62%
--attention:  35 92% 46%            38 94% 58%
--handed:     245 70% 58%           246 84% 70%
--done:       152 55% 38%           152 58% 48%
--idle:       220 10% 55%           220 10% 55%
```

### Tailwind config mapping

Extend `tailwind.config` `theme.extend.colors` to map semantic class names to the tokens, so components use `bg-card`, `text-muted-foreground`, `border-border`, `bg-chip`, `text-primary`, `text-working`, etc., instead of hardcoded `slate-*`. Use the `hsl(var(--token) / <alpha-value>)` form so opacity utilities work. Enable `darkMode: 'class'`.

### Theme toggle (`useTheme` hook)

- New `src/web/useTheme.ts`: reads initial theme from `localStorage["wm-theme"]`, falling back to `window.matchMedia('(prefers-color-scheme: dark)')`. Exposes `{ theme, toggle }`. Applies/removes the `dark` class on `document.documentElement` and writes the choice back to `localStorage`.
- **No-flash:** a tiny inline script in `index.html` `<head>` sets the `dark` class from `localStorage`/system preference *before* first paint.

## Components (restyle — same props, same data)

- **`App` / app bar (new structure in `Board` or a new `AppBar.tsx`):** sticky top bar with a violet brand mark + "work-monitor", live count chips derived from current state (e.g. "2 working · 1 needs you · 2 to hand off"), and the theme toggle on the right. Reflows cleanly on narrow screens.
- **`Lane`:** keep label + hint; restyle hint as a token-based pill. Columns move to a 3-col CSS grid that collapses to 1 col on mobile (preserves current `flex-col` mobile behavior).
- **`Column`:** token-based card surface, uppercase muted label with a leading status **dot**, count chip. Drop-target highlight uses a **violet** ring (replaces the amber ring).
- **`SessionCard`:** project title, a **status dot + label** (working dots gently pulse), task/intent in muted text, "needs you" attention reason rendered as an **amber callout** (bg + border tint, not just colored text), relative timestamp. Keeps the left-accent border colored by status.
- **`TodoCard`:** title + delete affordance (delete reveals/strengthens on hover), note, and the existing meta line (`→ for_who` in amber, `⎇ branch`, `origin_project` muted). Left-accent border colored to match its column's status. Drag behavior unchanged.

Consistent type scale across cards: `font-medium`/`semibold` titles, `text-muted-foreground` bodies, `text-xs` meta.

## Data flow

Unchanged. Components receive the same `State` (`sessions`, `todos`) and call the same `api.ts` functions. Drag still dispatches `patchTodo` via `resolveDrop`. The redesign is presentational plus the isolated `useTheme` hook.

## Error handling

No new error surfaces. Theme read/write is wrapped so a missing/blocked `localStorage` falls back to system preference without throwing.

## Testing

- Existing `web-tests/Board.test.tsx` smoke test must still pass (DOM structure/roles preserved; update only if class-based assertions break — prefer role/text queries). `web-tests/drag.test.ts` is unaffected.
- Add `web-tests/useTheme.test.ts`: default resolution (localStorage > system), `toggle` flips the `dark` class on the root element, and the choice persists to `localStorage`.
- Manual: verify both themes, the no-flash load, and responsive reflow at a phone width.

## Non-goals (explicitly out of scope)

- No new dependencies (no shadcn CLI / Radix).
- No information-architecture change — the two-lane × three-column layout stays.
- No backend, REST, MCP, hook, or data-model changes.
- Intra-column drag-**reorder** (`position`) remains deferred (unchanged from v1).
- No changes to status semantics or the set of statuses.

## Files touched

- `src/web/styles.css` — token layer (rewrite)
- `tailwind.config.*` — token color mapping + `darkMode: 'class'`
- `src/web/index.html` — no-flash inline theme script
- `src/web/useTheme.ts` — new hook
- `src/web/App.tsx` / `src/web/components/Board.tsx` — app bar + theme wiring
- `src/web/components/{Lane,SessionCard,TodoCard}.tsx` — restyle
- Tests: new `web-tests/useTheme.test.ts`; adjust `web-tests/Board.test.tsx` only if needed
