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
