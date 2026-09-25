import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeSettings,
  setupCodex,
  setupCursor,
  cleanupLegacy,
  registerMcp,
  type ExecFn,
  type SetupEnv,
} from "../src/cli/setup.ts";

// Every test here runs against a throwaway HOME and a stub `exec` that never
// shells out - setupCodex/setupCursor/cleanupLegacy otherwise call `codex`,
// `claude` and `systemctl` for real, and this dev machine may well have all
// three installed. Asserting on `calls` instead of a real subprocess is also
// what actually lets these tests run deterministically in CI.
function stubExec(): { exec: ExecFn; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const exec = ((file: string, args: string[] = []) => {
    calls.push({ file, args });
    return Buffer.from("");
  }) as ExecFn;
  return { exec, calls };
}

function throwingExec(): ExecFn {
  return (() => {
    throw new Error("not found");
  }) as ExecFn;
}

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function tmpHome(): string {
  dir = mkdtempSync(join(tmpdir(), "am-setup-"));
  return dir;
}

function env(home: string, exec: ExecFn = throwingExec()): SetupEnv {
  return { home, exec };
}

describe("mergeSettings (Claude ~/.claude/settings.json)", () => {
  it("creates settings.json fresh when ~/.claude does not exist yet", () => {
    const home = tmpHome();
    mergeSettings(env(home));
    const settingsPath = join(home, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("am-hook.sh");
  });

  it("backs up an existing settings.json and preserves a foreign hook entry", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settingsPath = join(home, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "herdr-hook.sh" }] }] } })
    );

    mergeSettings(env(home));

    expect(existsSync(settingsPath + ".am-backup")).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const stopCmds = settings.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain("herdr-hook.sh");
    expect(stopCmds.some((c: string) => c.includes("am-hook.sh"))).toBe(true);
  });

  it("warns and leaves a malformed settings.json untouched instead of throwing", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settingsPath = join(home, ".claude", "settings.json");
    writeFileSync(settingsPath, "{not json");

    expect(() => mergeSettings(env(home))).not.toThrow();
    expect(readFileSync(settingsPath, "utf8")).toBe("{not json"); // untouched
    expect(existsSync(settingsPath + ".am-backup")).toBe(false); // never backed up a file it didn't merge
  });
});

describe("setupCodex (~/.codex)", () => {
  it("does nothing when ~/.codex does not exist", () => {
    const home = tmpHome();
    setupCodex(env(home));
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("merges hooks.json, backs it up, and preserves a foreign (e.g. herdr) hook entry", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const hooksPath = join(home, ".codex", "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "herdr-hook.sh" }] }] } })
    );

    setupCodex(env(home));

    expect(existsSync(hooksPath + ".am-backup")).toBe(true);
    const merged = JSON.parse(readFileSync(hooksPath, "utf8"));
    const cmds = merged.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(cmds).toContain("herdr-hook.sh");
    expect(cmds.some((c: string) => c.includes("am-hook.sh") && c.endsWith(" codex"))).toBe(true);
  });

  it("prints config.toml guidance and skips MCP registration gracefully when the codex CLI is not found", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    expect(() => setupCodex(env(home, throwingExec()))).not.toThrow();
  });

  it("attempts to register the Codex MCP server via the injected exec (never a real subprocess)", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const { exec, calls } = stubExec();

    setupCodex(env(home, exec));

    expect(calls.some((c) => c.file === "codex" && c.args.includes("--version"))).toBe(true);
    expect(calls.some((c) => c.file === "codex" && c.args[0] === "mcp" && c.args.includes("agent-monitor"))).toBe(true);
  });

  it("warns and leaves a malformed hooks.json untouched instead of throwing, and setup continues past it", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const hooksPath = join(home, ".codex", "hooks.json");
    writeFileSync(hooksPath, "{not json");

    expect(() => setupCodex(env(home))).not.toThrow();
    expect(readFileSync(hooksPath, "utf8")).toBe("{not json");
  });
});

describe("setupCursor (~/.cursor)", () => {
  it("does nothing when ~/.cursor does not exist", () => {
    const home = tmpHome();
    setupCursor(env(home));
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  it("merges mcp.json, backs it up, preserves other configured servers, and writes no hooks.json", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const mcpPath = join(home, ".cursor", "mcp.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { url: "http://example.com/mcp" } } }));

    setupCursor(env(home));

    expect(existsSync(mcpPath + ".am-backup")).toBe(true);
    const merged = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(merged.mcpServers.other).toEqual({ url: "http://example.com/mcp" });
    expect(merged.mcpServers["agent-monitor"].url).toContain("/mcp");
    expect(existsSync(join(home, ".cursor", "hooks.json"))).toBe(false);
  });

  it("creates mcp.json fresh (no backup) when ~/.cursor exists but has no mcp.json yet", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });

    setupCursor(env(home));

    const mcpPath = join(home, ".cursor", "mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
    expect(existsSync(mcpPath + ".am-backup")).toBe(false);
  });

  it("warns and leaves a malformed mcp.json untouched instead of throwing", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const mcpPath = join(home, ".cursor", "mcp.json");
    writeFileSync(mcpPath, "{not json");

    expect(() => setupCursor(env(home))).not.toThrow();
    expect(readFileSync(mcpPath, "utf8")).toBe("{not json");
  });
});

describe("setupCursor: am-cursor shim", () => {
  const shim = (home: string) => join(home, ".local", "bin", "am-cursor");

  it("installs an executable shim that runs the repo's am-cursor.ts", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    setupCursor(env(home));
    const text = readFileSync(shim(home), "utf8");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain("src/cli/am-cursor.ts");
    expect(text).toContain('"$@"');
    expect(statSync(shim(home)).mode & 0o111).not.toBe(0);
  });

  it("replaces its own shim on re-run but never a foreign am-cursor", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    setupCursor(env(home));
    setupCursor(env(home)); // idempotent re-run
    expect(readFileSync(shim(home), "utf8")).toContain("src/cli/am-cursor.ts");

    writeFileSync(shim(home), "#!/bin/sh\necho mine\n");
    setupCursor(env(home));
    expect(readFileSync(shim(home), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });
});

describe("cleanupLegacy", () => {
  it("is best-effort: an exec that always throws never propagates", () => {
    const home = tmpHome();
    expect(() => cleanupLegacy(env(home, throwingExec()))).not.toThrow();
  });

  it("removes a legacy systemd unit file if present, via the injected exec only", () => {
    const home = tmpHome();
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "wm-server.service"), "[Unit]\n");
    const { exec } = stubExec();

    cleanupLegacy(env(home, exec));

    expect(existsSync(join(unitDir, "wm-server.service"))).toBe(false);
  });
});

describe("registerMcp (Claude)", () => {
  it("skips `claude mcp add` when the server is already registered", () => {
    const { exec, calls } = stubExec(); // `mcp get` succeeds -> already registered
    registerMcp(env(tmpHome(), exec));
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["mcp get"]);
  });

  it("adds the server when `claude mcp get` reports it missing", () => {
    const calls: string[][] = [];
    const exec = ((file: string, args: string[] = []) => {
      calls.push(args);
      if (args[1] === "get") throw new Error("No MCP server found");
      return Buffer.from("");
    }) as ExecFn;
    registerMcp(env(tmpHome(), exec));
    expect(calls.map((a) => a.slice(0, 2).join(" "))).toEqual(["mcp get", "mcp add"]);
  });
});
