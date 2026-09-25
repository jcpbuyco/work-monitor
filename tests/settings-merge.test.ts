import { describe, it, expect } from "bun:test";
import {
  mergeHooks,
  mergeHookFile,
  mergeCodexHooks,
  mergeCursorMcp,
  configTomlHasHooksEnabled,
  HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
} from "../src/cli/settings-merge.ts";

const HOOK = "/abs/src/hooks/am-hook.sh";

describe("mergeHooks", () => {
  it("creates a hooks key when absent, one entry per event", () => {
    const out = mergeHooks({}, HOOK);
    for (const [evt] of HOOK_EVENTS) {
      expect(out.hooks[evt]).toBeDefined();
      const cmd = out.hooks[evt][0].hooks[0].command;
      expect(cmd).toContain("am-hook.sh");
    }
  });

  it("preserves unrelated existing hooks", () => {
    const existing = {
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command" as const, command: "other.sh" }] }] },
    };
    const out = mergeHooks(existing, HOOK);
    const stopCmds = out.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain("other.sh");
    expect(stopCmds.some((c: string) => c.includes("am-hook.sh"))).toBe(true);
  });

  it("is idempotent - re-merging does not duplicate our entries", () => {
    const once = mergeHooks({}, HOOK);
    const twice = mergeHooks(once, HOOK);
    const stopWm = twice.hooks.Stop.flatMap((g: any) => g.hooks)
      .filter((h: any) => h.command.includes("am-hook.sh"));
    expect(stopWm.length).toBe(1);
  });

  it("uses the TodoWrite matcher for PostToolUse", () => {
    const out = mergeHooks({}, HOOK);
    expect(out.hooks.PostToolUse[0].matcher).toBe("TodoWrite");
  });

  it("adds a PostToolUse activity heartbeat (matcher '') alongside todo_update", () => {
    const post = mergeHooks({}, HOOK).hooks.PostToolUse;
    const activity = post.find((g: any) => g.hooks.some((h: any) => h.command.endsWith(" activity")));
    expect(activity).toBeDefined();
    expect(activity!.matcher).toBe("");
    expect(post.some((g: any) => g.hooks.some((h: any) => h.command.endsWith(" todo_update")))).toBe(true);
  });

  it("is idempotent for both PostToolUse hooks (no duplicates on re-merge)", () => {
    const twice = mergeHooks(mergeHooks({}, HOOK), HOOK);
    const wm = twice.hooks.PostToolUse
      .flatMap((g: any) => g.hooks)
      .filter((h: any) => h.command.includes("am-hook.sh"));
    expect(wm.length).toBe(2);
  });

  it("prunes stale entries from a renamed hook script (e.g. wm-hook.sh)", () => {
    const stale = {
      hooks: {
        PostToolUse: [{ matcher: "", hooks: [{ type: "command" as const, command: "/old/path/src/hooks/wm-hook.sh activity" }] }],
        Stop: [
          { matcher: "", hooks: [{ type: "command" as const, command: "/old/path/src/hooks/wm-hook.sh stop" }] },
          { matcher: "", hooks: [{ type: "command" as const, command: "keep-me.sh" }] },
        ],
      },
    };
    const out = mergeHooks(stale, HOOK);
    const all = Object.values(out.hooks).flatMap((gs: any) => gs.flatMap((g: any) => g.hooks.map((h: any) => h.command)));
    expect(all.some((c: string) => c.includes("wm-hook.sh"))).toBe(false); // stale gone
    expect(all.some((c: string) => c.includes("am-hook.sh"))).toBe(true); // current present
    expect(all).toContain("keep-me.sh"); // unrelated hook preserved
  });
});

describe("mergeHookFile (§4.6 generalization) / mergeCodexHooks", () => {
  it("mergeHooks(settings, hookPath) is exactly mergeHookFile with the Claude table and no harness arg", () => {
    expect(mergeHooks({}, HOOK)).toEqual(mergeHookFile({}, HOOK, HOOK_EVENTS));
  });

  it("appends the harness arg to every command when given", () => {
    const out = mergeHookFile({}, HOOK, [["SessionStart", "session_start", ""]], "codex");
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe(`${HOOK} session_start codex`);
  });

  it("sets a per-hook timeout from the table's optional 4th element", () => {
    const out = mergeHookFile({}, HOOK, [["SessionStart", "session_start", "", 5]]);
    expect(out.hooks.SessionStart[0].hooks[0].timeout).toBe(5);
  });

  it("omits timeout entirely when the table row does not specify one (Claude's own table)", () => {
    const out = mergeHooks({}, HOOK);
    expect(out.hooks.Stop[0].hooks[0]).not.toHaveProperty("timeout");
  });

  it("mergeCodexHooks: maps PermissionRequest to notification, with the codex harness arg and a 5s timeout", () => {
    const out = mergeCodexHooks({}, HOOK);
    expect(out.hooks.PermissionRequest[0].hooks[0].command).toBe(`${HOOK} notification codex`);
    expect(out.hooks.PermissionRequest[0].hooks[0].timeout).toBe(5);
    for (const [event] of CODEX_HOOK_EVENTS) expect(out.hooks[event]).toBeDefined();
  });

  it("mergeCodexHooks uses matcher '*' (the only shape the research verified live), never Claude's ''", () => {
    const out = mergeCodexHooks({}, HOOK);
    for (const [event] of CODEX_HOOK_EVENTS) {
      expect(out.hooks[event][0].matcher).toBe("*");
    }
  });

  it("mergeCodexHooks is idempotent - re-merging does not duplicate entries", () => {
    const twice = mergeCodexHooks(mergeCodexHooks({}, HOOK), HOOK);
    const stop = twice.hooks.Stop.flatMap((g: any) => g.hooks).filter((h: any) => h.command.includes("am-hook.sh"));
    expect(stop.length).toBe(1);
  });

  it("mergeCodexHooks prunes a stale (renamed-script) entry the same way mergeHooks does", () => {
    const stale = {
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command" as const, command: "/old/src/hooks/wm-hook.sh stop codex" }] }] },
    };
    const out = mergeCodexHooks(stale, HOOK);
    const cmds = out.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(cmds.some((c: string) => c.includes("wm-hook.sh"))).toBe(false);
    expect(cmds).toContain(`${HOOK} stop codex`);
  });

  it("mergeCodexHooks preserves a foreign hook entry (e.g. herdr) untouched", () => {
    const existing = { hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command" as const, command: "herdr-hook.sh" }] }] } };
    const out = mergeCodexHooks(existing, HOOK);
    const cmds = out.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(cmds).toContain("herdr-hook.sh");
    expect(cmds.some((c: string) => c.includes("am-hook.sh"))).toBe(true);
  });
});

describe("mergeCursorMcp (§4.6)", () => {
  it("adds the agent-monitor server to an empty config", () => {
    const out = mergeCursorMcp({}, 4317);
    expect(out).toEqual({ mcpServers: { "agent-monitor": { url: "http://127.0.0.1:4317/mcp" } } });
  });

  it("preserves other configured servers untouched", () => {
    const existing = { mcpServers: { other: { url: "http://example.com/mcp" } } };
    const out = mergeCursorMcp(existing, 4317) as any;
    expect(out.mcpServers.other).toEqual({ url: "http://example.com/mcp" });
    expect(out.mcpServers["agent-monitor"].url).toBe("http://127.0.0.1:4317/mcp");
  });

  it("re-merging overwrites only our own entry, not others", () => {
    const once = mergeCursorMcp({ mcpServers: { other: { url: "x" } } }, 4317);
    const twice = mergeCursorMcp(once, 4400) as any;
    expect(twice.mcpServers.other).toEqual({ url: "x" });
    expect(twice.mcpServers["agent-monitor"].url).toBe("http://127.0.0.1:4400/mcp");
  });

  it("preserves unrelated top-level keys in the config file", () => {
    const out = mergeCursorMcp({ someOtherSetting: true }, 4317) as any;
    expect(out.someOtherSetting).toBe(true);
  });
});

describe("configTomlHasHooksEnabled (§4.6)", () => {
  it("is true when hooks = true sits under [features]", () => {
    expect(configTomlHasHooksEnabled("[features]\nhooks = true\n")).toBe(true);
  });

  it("is false when hooks is absent", () => {
    expect(configTomlHasHooksEnabled("[features]\nmulti_agent = true\n")).toBe(false);
  });

  it("is false when the config file has no [features] section at all", () => {
    expect(configTomlHasHooksEnabled("model = \"gpt-5.5\"\n")).toBe(false);
  });

  it("is false when hooks = true sits under an unrelated section", () => {
    expect(configTomlHasHooksEnabled("[other]\nhooks = true\n")).toBe(false);
  });

  it("is false for an empty file", () => {
    expect(configTomlHasHooksEnabled("")).toBe(false);
  });

  it("does not get confused by a later section after [features]", () => {
    expect(configTomlHasHooksEnabled("[features]\nmulti_agent = true\n\n[other]\nhooks = true\n")).toBe(false);
  });

  it("tolerates extra whitespace around the value", () => {
    expect(configTomlHasHooksEnabled("[features]\n  hooks   =   true  \n")).toBe(true);
  });

  it("ignores a trailing comment on the key line", () => {
    expect(configTomlHasHooksEnabled("[features]\nhooks = true # on\n")).toBe(true);
  });

  it("ignores a trailing comment on the section header line", () => {
    expect(configTomlHasHooksEnabled("[features] # x\nhooks=true\n")).toBe(true);
  });

  it("accepts the top-level dotted form (features.hooks = true), Codex's own -c/--enable docs' shape", () => {
    expect(configTomlHasHooksEnabled("features.hooks = true\n")).toBe(true);
  });

  it("does not treat a bare 'hooks = true' under an unrelated section as the dotted form", () => {
    expect(configTomlHasHooksEnabled("[other]\nhooks = true\n")).toBe(false);
  });
});
