import { useState } from "react";
import type { State, LiveWorkflow } from "../types.ts";
import { useTheme } from "../useTheme.ts";
import { useTextSize } from "../useTextSize.ts";
import { useMotion } from "../useMotion.ts";
import { ago } from "../time.ts";
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
  pending = false,
  hideBelowSm = false,
}: {
  testId: string;
  kind: GlyphKind;
  label: string;
  n: number;
  escalate?: boolean;
  /** §5.2: before the first `/api/state` response, a count is UNKNOWN, not
   *  zero - showing "0 needs you" while the server just hasn't answered yet
   *  is exactly the confident-wrong-zero this dashboard exists to avoid. */
  pending?: boolean;
  /** §5.2 phone-overflow finding fix: the least essential count (to do -
   *  already covered by the Todos section on the board itself) drops out
   *  below `sm` entirely, rather than trying to visually squeeze it - three
   *  counts plus the brand and the overflow toggle simply do not fit a 390px
   *  header at once. A whole element hidden by CSS, never a duplicated text
   *  node, so it changes nothing about what `textContent` reads at either
   *  width. */
  hideBelowSm?: boolean;
}) {
  // Tone IS the hierarchy: a zero count recedes on its own, with no branch in
  // the markup. The one escalation in the whole app is a non-zero needs-you -
  // and pending can never escalate, since an unknown count isn't a known one.
  const tone =
    escalate && !pending && n > 0
      ? "rounded-full bg-attention/[0.08] px-2 py-0.5 text-attention"
      : !pending && n > 0
        ? "text-ink-2"
        : "text-ink-4";
  const display = hideBelowSm ? "hidden sm:inline-flex" : "inline-flex";
  return (
    <span
      data-testid={testId}
      className={`am-count ${display} shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${tone}`}
    >
      <StatusGlyph kind={kind} animate={false} />
      <span>{pending ? "…" : n} {label}</span>
    </span>
  );
}

/** One nav link, active-highlighted against the current hash route (§5.2). */
function NavLink({ href, active, icon, children }: { href: string; active: boolean; icon: string; children: string }) {
  return (
    <a
      href={href}
      data-press
      aria-current={active ? "page" : undefined}
      className={`${GHOST} ${active ? "bg-surface-2 text-ink" : "text-ink-3"}`}
    >
      <span aria-hidden="true" className="text-2xs text-ink-4">{icon}</span>
      <span>{children}</span>
    </a>
  );
}

export function AppBar({
  state,
  workflows = [],
  /** §5.2: which hash route is current, for the active nav highlight. Defaults
   *  to the board so every existing call site (and every other page that
   *  hasn't started passing it yet) still renders sensibly. */
  route = "#/",
  /** §5.2: false before the first state arrives - counts render "…" instead
   *  of a confident (and possibly wrong) zero. */
  ready = true,
  /** §5.2 finding fix: false once the SSE stream has been silent past its
   *  staleness window - renders the "Reconnecting…" bar. Lives on the shared
   *  AppBar (every route mounts one, off the same App-level subscription)
   *  rather than on Board alone, so the Cost and Workflows pages surface the
   *  exact same warning instead of looking falsely healthy while stale. */
  connected = true,
  lastMessageAt = null,
}: {
  state: State;
  workflows?: LiveWorkflow[];
  route?: string;
  ready?: boolean;
  connected?: boolean;
  lastMessageAt?: number | null;
}) {
  const { theme, toggle } = useTheme();
  const { inc, dec, canInc, canDec } = useTextSize();
  const { on: motionOn, toggle: toggleMotion } = useMotion();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const working = state.sessions.filter((s) => s.status === "working").length;
  const needsYou = state.sessions.filter((s) => s.status === "needs_you").length;
  const todoCount = state.todos.filter((t) => t.status === "todo").length;

  // Rendered twice (desktop cluster, phone overflow panel) so the two layouts
  // never fight over the same DOM node - see the component doc below.
  const controls = (
    <>
      <NavLink href="#/cost" active={route === "#/cost"} icon="$">Cost</NavLink>
      {/* Grouped in their own flex row: the phone overflow panel stacks
          `controls`' top-level children vertically, and without this wrapper
          the count chip fell to a row of its own under a bare "Workflows"
          link instead of sitting beside it. */}
      <div className="flex items-center gap-1.5">
        <NavLink href="#/workflows" active={route === "#/workflows"} icon="⚙">
          Workflows
        </NavLink>
        {workflows.length > 0 && (
          <Chip data-testid="appbar-wf-count" tone="working" round size="2xs" className="tabular-nums">
            {workflows.length}
          </Chip>
        )}
      </div>

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
      <button type="button" data-press onClick={toggle} aria-label="Toggle theme" className={`${GHOST} text-ink-3`}>
        <span aria-hidden="true" className="text-2xs">{theme === "dark" ? "☾" : "☀"}</span>
        <span>{theme === "dark" ? "Dark" : "Light"}</span>
      </button>
    </>
  );

  return (
    <>
    <header className="sticky top-0 z-20 -mx-3 flex h-12 items-center gap-2 border-b-hairline border-border-weak bg-surface-0/[0.72] px-3 backdrop-blur-[20px] sm:-mx-6 sm:gap-4 sm:px-6">
      <a
        href="#/"
        data-press
        aria-current={route === "#/" ? "page" : undefined}
        className={`flex shrink-0 items-center gap-2 rounded-md transition-colors duration-quick ease-quad ${route === "#/" ? "text-ink" : "text-ink"}`}
      >
        {/* the inline boxShadow glow ring is deleted — pure decoration */}
        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm bg-accent" />
        {/* §5.2 phone-overflow finding fix: `whitespace-nowrap` - without it,
            a flex row this tight lets the browser shrink the text below its
            own max-content width and wrap "agent-monitor" at the hyphen
            ("agent-" / "monitor" on two lines), clipped by the fixed 48px
            header. */}
        <span className="whitespace-nowrap text-sm font-semibold tracking-tight">agent-monitor</span>
      </a>

      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border-weak" />

      <div className="flex min-w-0 items-center gap-2 sm:gap-4">
        {/* keyed on the COUNT only — never on the 1Hz clock (§5.5) */}
        <Count key={`w-${working}`} testId="appbar-count-working" kind="working" label="working" n={working} pending={!ready} />
        <Count
          key={`n-${needsYou}`}
          testId="appbar-count-needs-you"
          kind="needs_you"
          label="needs you"
          n={needsYou}
          escalate
          pending={!ready}
        />
        <Count
          key={`t-${todoCount}`}
          testId="appbar-count-todo"
          kind="todo"
          label="to do"
          n={todoCount}
          pending={!ready}
          hideBelowSm
        />
      </div>

      {/* Desktop: every control inline. Phone (< sm): collapsed behind a
          single "⋯" toggle (§5.2) - the SAME controls render a second time,
          conditionally, in the panel below; they never coexist unless the
          panel is actually open, so no test (or screen reader, thanks to the
          CSS `hidden` this relies on in a real browser) ever sees a dupe. */}
      <div className="ml-auto hidden items-center gap-1 sm:flex">{controls}</div>

      <div className="relative ml-auto sm:hidden">
        <button
          type="button"
          data-press
          onClick={() => setOverflowOpen((v) => !v)}
          aria-label="More controls"
          aria-expanded={overflowOpen}
          className={`${GHOST} text-ink-3`}
        >
          <span aria-hidden="true">⋯</span>
        </button>
        {overflowOpen && (
          <div
            data-testid="appbar-overflow-panel"
            className="absolute right-0 top-full z-30 mt-1 flex w-48 flex-col items-stretch gap-1 rounded-md border-hairline border-border bg-surface-1 p-1.5 shadow-pop"
          >
            {controls}
          </div>
        )}
      </div>
    </header>
    {/* §5.2 finding fix: was Board-only, so the Cost and Workflows pages -
        which share this exact SSE connection through the same App-level
        subscription - never showed the same "data may be stale" warning.
        Living here instead means every route that mounts an AppBar gets it
        for free. */}
    {!connected && (
      <div
        data-testid="reconnecting-bar"
        className="mt-2 flex h-7 items-center gap-2 rounded-md border-hairline border-attention/25 bg-attention/[0.07] px-2.5 text-2xs text-attention"
      >
        Reconnecting… data may be stale (last update {lastMessageAt != null ? ago(lastMessageAt) : "unknown"})
      </div>
    )}
    </>
  );
}
