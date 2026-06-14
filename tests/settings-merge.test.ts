import { describe, it, expect } from "bun:test";
import { mergeHooks, HOOK_EVENTS } from "../src/cli/settings-merge.ts";

const HOOK = "/abs/src/hooks/wm-hook.sh";

describe("mergeHooks", () => {
  it("creates a hooks key when absent, one entry per event", () => {
    const out = mergeHooks({}, HOOK);
    for (const [evt] of HOOK_EVENTS) {
      expect(out.hooks[evt]).toBeDefined();
      const cmd = out.hooks[evt][0].hooks[0].command;
      expect(cmd).toContain("wm-hook.sh");
    }
  });

  it("preserves unrelated existing hooks", () => {
    const existing = {
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command" as const, command: "other.sh" }] }] },
    };
    const out = mergeHooks(existing, HOOK);
    const stopCmds = out.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain("other.sh");
    expect(stopCmds.some((c: string) => c.includes("wm-hook.sh"))).toBe(true);
  });

  it("is idempotent — re-merging does not duplicate our entries", () => {
    const once = mergeHooks({}, HOOK);
    const twice = mergeHooks(once, HOOK);
    const stopWm = twice.hooks.Stop.flatMap((g: any) => g.hooks)
      .filter((h: any) => h.command.includes("wm-hook.sh"));
    expect(stopWm.length).toBe(1);
  });

  it("uses the TodoWrite matcher for PostToolUse", () => {
    const out = mergeHooks({}, HOOK);
    expect(out.hooks.PostToolUse[0].matcher).toBe("TodoWrite");
  });
});
