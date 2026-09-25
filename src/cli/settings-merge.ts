// [event, wm_event_type, matcher, timeoutSeconds?]
export type HookEventRow = [event: string, wmType: string, matcher: string, timeoutSeconds?: number];

export const HOOK_EVENTS: HookEventRow[] = [
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

/** §4.6: Codex's `hooks.json` has the identical shape (`matcher` + nested
 *  `hooks[]`) but its own event-name vocabulary, and needs the harness arg
 *  (`am-hook.sh <type> codex`) so am-server can tell a Codex event from a
 *  Claude one without waiting on `transcript_path` to show up. `PermissionRequest`
 *  maps to the generic `notification` type - `harness/codex.ts`'s normalizer
 *  supplies the human-readable message that event's own payload lacks.
 *  Codex's own `SessionEnd` hook timeout is hard-clamped to 3s regardless of
 *  what is requested (research finding); 5s is requested everywhere else, per
 *  spec. Matcher is `"*"`, not Claude's `""`: the research's live `codex exec`
 *  verification (real hook trust, real fired events end to end) only ever
 *  confirmed `"*"` - it never established that an EMPTY matcher is even
 *  accepted by Codex's own hook-config parser, let alone that it behaves like
 *  Claude's "matches everything" convention there. */
export const CODEX_HOOK_EVENTS: HookEventRow[] = [
  ["SessionStart", "session_start", "*", 5],
  ["UserPromptSubmit", "prompt", "*", 5],
  ["PreToolUse", "tool_start", "*", 5],
  ["PostToolUse", "activity", "*", 5],
  ["PermissionRequest", "notification", "*", 5],
  ["Stop", "stop", "*", 5],
  ["SessionEnd", "session_end", "*", 5],
];

interface HookCmd { type: "command"; command: string; timeout?: number }
interface HookGroup { matcher?: string; hooks: HookCmd[] }
interface Settings { hooks?: Record<string, HookGroup[]>; [k: string]: unknown }

function command(hookPath: string, type: string, harnessArg?: string): string {
  return harnessArg ? `${hookPath} ${type} ${harnessArg}` : `${hookPath} ${type}`;
}

/** A command is one of ours — a hook script under `src/hooks/` (the current
 *  `am-hook.sh` or a pre-rename `wm-hook.sh`). Matching lets us prune stale
 *  entries on re-merge instead of only ever appending. Matches regardless of
 *  any trailing harness argument (`am-hook.sh tool_start codex`), since the
 *  script path + a following space is all this needs to identify. */
const OUR_HOOK_RE = /[/\\]src[/\\]hooks[/\\][\w.-]*-hook\.sh(\s|$)/;

/** §4.6: `mergeHooks` generalized to merge ANY hook-config file sharing
 *  Claude Code's `{hooks: {<Event>: [{matcher, hooks: [{type, command,
 *  timeout?}]}]}}` shape - used for both `~/.claude/settings.json` (via
 *  `mergeHooks` below) and Codex's `~/.codex/hooks.json`. `harnessArg`, when
 *  given, is appended to every command (`am-hook.sh <type> <harnessArg>`) so
 *  the server can identify the harness before any payload-shape signal is
 *  available (§4.2's detection order). Foreign entries (an unrelated tool's
 *  hooks, e.g. herdr) are always preserved untouched; only OUR entries
 *  (`OUR_HOOK_RE`) are pruned and re-added, so re-running setup supersedes a
 *  previous install instead of piling duplicates on. */
export function mergeHookFile(
  settings: Settings,
  hookPath: string,
  table: HookEventRow[],
  harnessArg?: string
): Settings & { hooks: Record<string, HookGroup[]> } {
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
  for (const [event, type, matcher, timeout] of table) {
    const cmd = command(hookPath, type, harnessArg);
    const groups = [...(out.hooks[event] ?? [])];
    const already = groups.some((g) => g.hooks?.some((h) => h.command === cmd));
    if (!already) {
      const hook: HookCmd = timeout !== undefined ? { type: "command", command: cmd, timeout } : { type: "command", command: cmd };
      groups.push({ matcher, hooks: [hook] });
    }
    out.hooks[event] = groups;
  }
  return out;
}

export function mergeHooks(settings: Settings, hookPath: string): Settings & { hooks: Record<string, HookGroup[]> } {
  return mergeHookFile(settings, hookPath, HOOK_EVENTS);
}

/** §4.6: `am-hook.sh <type> codex` entries for `~/.codex/hooks.json`. */
export function mergeCodexHooks(settings: Settings, hookPath: string): Settings & { hooks: Record<string, HookGroup[]> } {
  return mergeHookFile(settings, hookPath, CODEX_HOOK_EVENTS, "codex");
}

/** §4.6: merge `{"mcpServers":{"agent-monitor":{"url":...}}}` into an existing
 *  `~/.cursor/mcp.json`, preserving every other configured server untouched. */
export function mergeCursorMcp(existing: Record<string, unknown>, port: number): Record<string, unknown> {
  const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  return {
    ...existing,
    mcpServers: { ...servers, "agent-monitor": { url: `http://127.0.0.1:${port}/mcp` } },
  };
}

/** A '#' can only ever be a genuine TOML comment marker in either shape this
 *  reads (`[section]` / `key = true`) - neither ever legitimately contains
 *  one - so a plain split is safe without a real TOML tokenizer. */
function stripTomlComment(line: string): string {
  const i = line.indexOf("#");
  return i === -1 ? line : line.slice(0, i);
}

/** §4.6: does `~/.codex/config.toml` already enable hooks (`hooks = true`
 *  under `[features]`, or the equivalent top-level dotted form
 *  `features.hooks = true` that Codex's own `-c`/`--enable` docs use)? A
 *  tiny, deliberately non-general TOML read - just enough to answer this one
 *  question without a TOML parsing dependency, and never used to rewrite the
 *  file (setup only ever PRINTS guidance when this is false, per spec - it
 *  does not edit `config.toml`). */
export function configTomlHasHooksEnabled(text: string): boolean {
  let inFeatures = false;
  for (const rawLine of text.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inFeatures = header[1].trim() === "features";
      continue;
    }
    if (inFeatures && /^hooks\s*=\s*true$/.test(line)) return true;
    if (/^features\.hooks\s*=\s*true$/.test(line)) return true;
  }
  return false;
}
