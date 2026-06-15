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

export function mergeHooks(settings: Settings, hookPath: string): Settings & { hooks: Record<string, HookGroup[]> } {
  const out: Settings & { hooks: Record<string, HookGroup[]> } = {
    ...settings,
    hooks: { ...(settings.hooks ?? {}) },
  };
  for (const [event, type, matcher] of HOOK_EVENTS) {
    const cmd = command(hookPath, type);
    const groups = [...(out.hooks[event] ?? [])];
    // Dedupe by exact command so re-running setup is idempotent, while still
    // allowing several am-hook entries on one event (e.g. two PostToolUse hooks).
    const already = groups.some((g) => g.hooks?.some((h) => h.command === cmd));
    if (!already) {
      groups.push({ matcher, hooks: [{ type: "command", command: cmd }] });
    }
    out.hooks[event] = groups;
  }
  return out;
}
