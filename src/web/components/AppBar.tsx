import type { State } from "../types.ts";
import { useTheme } from "../useTheme.ts";
import { useTextSize } from "../useTextSize.ts";
import { useMotion } from "../useMotion.ts";

function Count({ dotClass, label, n }: { dotClass: string; label: string; n: number }) {
  return (
    <span className="am-count inline-flex items-center gap-2 rounded-full border border-border bg-chip px-2.5 py-1 text-xs text-muted-foreground">
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      <span>{n} {label}</span>
    </span>
  );
}

export function AppBar({ state }: { state: State }) {
  const { theme, toggle } = useTheme();
  const { inc, dec, canInc, canDec } = useTextSize();
  const { on: motionOn, toggle: toggleMotion } = useMotion();
  const working = state.sessions.filter((s) => s.status === "working").length;
  const needsYou = state.sessions.filter((s) => s.status === "needs_you").length;
  const todoCount = state.todos.filter((t) => t.status === "todo").length;

  return (
    <header className="sticky top-0 z-10 -mx-4 mb-2 flex flex-wrap items-center gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-2 font-semibold tracking-tight text-foreground">
        <span
          className="h-2.5 w-2.5 rounded-[3px] bg-primary"
          style={{ boxShadow: "0 0 0 3px hsl(var(--primary) / 0.18)" }}
        />
        agent-monitor
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Count key={`w-${working}`} dotClass="bg-working" label="working" n={working} />
        <Count key={`n-${needsYou}`} dotClass="bg-attention" label="needs you" n={needsYou} />
        <Count key={`t-${todoCount}`} dotClass="bg-attention" label="to do" n={todoCount} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <div className="inline-flex h-9 items-center overflow-hidden rounded-lg border border-border bg-muted text-muted-foreground">
          <button
            type="button"
            onClick={dec}
            disabled={!canDec}
            aria-label="Decrease text size"
            className="flex h-full items-center px-2.5 text-sm leading-none transition hover:text-foreground disabled:opacity-40"
          >
            A−
          </button>
          <span className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={inc}
            disabled={!canInc}
            aria-label="Increase text size"
            className="flex h-full items-center px-2.5 text-base leading-none transition hover:text-foreground disabled:opacity-40"
          >
            A+
          </button>
        </div>
        <button
          type="button"
          onClick={toggleMotion}
          aria-label="Toggle motion"
          aria-pressed={motionOn}
          title={motionOn ? "Animations on" : "Animations off"}
          className={`inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-muted px-3 text-sm leading-none transition hover:text-foreground ${
            motionOn ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          <span aria-hidden="true">{motionOn ? "✨" : "⊘"}</span>
          <span>Motion</span>
        </button>
        <button
          type="button"
          onClick={toggle}
          aria-label="Toggle theme"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-muted px-3 text-sm leading-none text-muted-foreground transition hover:text-foreground"
        >
          <span aria-hidden="true">{theme === "dark" ? "☾" : "☀"}</span>
          <span>{theme === "dark" ? "Dark" : "Light"}</span>
        </button>
      </div>
    </header>
  );
}
