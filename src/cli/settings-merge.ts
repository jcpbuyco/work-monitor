// [event, wm_event_type, matcher]
export const HOOK_EVENTS: [string, string, string][] = [
  ["SessionStart", "session_start", ""],
  ["UserPromptSubmit", "prompt", ""],
  // Fires BEFORE a tool runs → marks the session's currently-active tool.
  ["PreToolUse", "tool_start", ""],
  ["PostToolUse", "todo_update", "TodoWrite"],
  // Heartbeat on every tool use so a session actively working (Bash/Edit/Agent/…)
  // keeps reporting "working" and isn't swept to idle. Keep AFTER the TodoWrite
  // entry so PostToolUse[0] stays the richer todo_update hook.
  ["PostToolUse", "activity", ""],
  ["Notification", "notification", ""],
  ["Stop", "stop", ""],
  ["SessionEnd", "session_end", ""],
];

interface HookCmd { type: "command"; command: string }
interface HookGroup { matcher?: string; hooks: HookCmd[] }
interface Settings { hooks?: Record<string, HookGroup[]>; [k: string]: unknown }

function command(hookPath: string, type: string): string {
  return `${hookPath} ${type}`;
}

/** A command is one of ours — a hook script under `src/hooks/` (the current
 *  `am-hook.sh` or a pre-rename `wm-hook.sh`). Matching lets us prune stale
 *  entries on re-merge instead of only ever appending. */
const OUR_HOOK_RE = /[/\\]src[/\\]hooks[/\\][\w.-]*-hook\.sh(\s|$)/;

export function mergeHooks(settings: Settings, hookPath: string): Settings & { hooks: Record<string, HookGroup[]> } {
  const out: Settings & { hooks: Record<string, HookGroup[]> } = {
    ...settings,
    hooks: { ...(settings.hooks ?? {}) },
  };

  // Prune our own hook entries first (including stale ones from a renamed
  // script), so re-running setup supersedes a previous install instead of
  // piling duplicate/dead entries on. Unrelated user hooks are left untouched.
  for (const event of Object.keys(out.hooks)) {
    const kept = (out.hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !OUR_HOOK_RE.test(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) out.hooks[event] = kept;
    else delete out.hooks[event];
  }

  // (Re-)add the current hook entries.
  for (const [event, type, matcher] of HOOK_EVENTS) {
    const cmd = command(hookPath, type);
    const groups = [...(out.hooks[event] ?? [])];
    const already = groups.some((g) => g.hooks?.some((h) => h.command === cmd));
    if (!already) {
      groups.push({ matcher, hooks: [{ type: "command", command: cmd }] });
    }
    out.hooks[event] = groups;
  }
  return out;
}
