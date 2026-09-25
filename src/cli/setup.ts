import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mergeHooks, mergeCodexHooks, mergeCursorMcp, configTomlHasHooksEnabled } from "./settings-merge.ts";
import { PORT } from "../server/config.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bunPath = process.execPath; // path to bun
const hookPath = join(projectRoot, "src", "hooks", "am-hook.sh");

/** Everything setup shells out to, factored out so tests can inject a stub
 *  and never invoke a REAL `codex`/`claude`/`systemctl` binary - several of
 *  these mutate real user-global state (`codex mcp add`, `claude mcp add`,
 *  a systemd unit) that must never run against the actual dev machine just
 *  because it happens to have those CLIs installed. */
export type ExecFn = typeof execFileSync;

export interface SetupEnv {
  /** Overridable so every path below (`~/.claude`, `~/.codex`, `~/.cursor`,
   *  the systemd user dir) resolves under an injected temp directory in
   *  tests instead of the real home. */
  home: string;
  exec: ExecFn;
}

export function defaultSetupEnv(): SetupEnv {
  return { home: homedir(), exec: execFileSync };
}

function pathsFor(home: string) {
  return {
    unitDir: join(home, ".config", "systemd", "user"),
    settingsPath: join(home, ".claude", "settings.json"),
    codexHome: join(home, ".codex"),
    codexHooksPath: join(home, ".codex", "hooks.json"),
    codexConfigTomlPath: join(home, ".codex", "config.toml"),
    cursorHome: join(home, ".cursor"),
    cursorMcpPath: join(home, ".cursor", "mcp.json"),
  };
}

function step(msg: string) {
  console.log(`\x1b[36m▸\x1b[0m ${msg}`);
}

/** Parses a config file that might already exist, tolerating "absent" and
 *  "empty" as `{}`. On malformed JSON, warns and returns null (meaning "skip
 *  this file entirely") instead of throwing - an uncaught parse error here
 *  would abort every step still to come (Cursor's setup, MCP registration,
 *  ...) over one pre-existing bad file, and silently overwriting whatever the
 *  user had there would be worse. */
function tryReadJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`  Warning: ${path} is not valid JSON (${(e as Error).message}) - leaving it untouched.`);
    return null;
  }
}

export function installService(env: SetupEnv) {
  const { unitDir } = pathsFor(env.home);
  mkdirSync(unitDir, { recursive: true });
  const tmpl = readFileSync(join(projectRoot, "src", "cli", "am-server.service.tmpl"), "utf8");
  const unit = tmpl
    .replaceAll("__BUN__", bunPath)
    .replaceAll("__PROJECT__", projectRoot)
    .replaceAll("__PORT__", String(PORT));
  writeFileSync(join(unitDir, "am-server.service"), unit);
  step(`Wrote systemd unit to ${join(unitDir, "am-server.service")}`);
  try {
    env.exec("systemctl", ["--user", "daemon-reload"]);
    env.exec("systemctl", ["--user", "enable", "am-server.service"]);
    // restart (not `enable --now`) so a re-run picks up a changed unit/path
    // even when the service is already running.
    env.exec("systemctl", ["--user", "restart", "am-server.service"]);
    step("Enabled + (re)started am-server.service");
  } catch (e) {
    console.warn("Could not enable service automatically:", String(e));
    console.warn("Run: systemctl --user enable --now am-server.service");
  }
}

export function mergeSettings(env: SetupEnv) {
  const { settingsPath } = pathsFor(env.home);
  const settings = tryReadJsonFile(settingsPath);
  if (settings === null) return;
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, settingsPath + ".am-backup");
    step(`Backed up settings to ${settingsPath}.am-backup`);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }
  const merged = mergeHooks(settings, hookPath);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  step("Merged agent-monitor hooks into ~/.claude/settings.json");
}

export function registerMcp(env: SetupEnv) {
  // `claude mcp add` fails when the server already exists, which read as a
  // setup failure on every re-run.
  try {
    env.exec("claude", ["mcp", "get", "agent-monitor"], { stdio: "ignore" });
    step("agent-monitor MCP server already registered (user scope)");
    return;
  } catch {
    // Not registered yet (or no `claude` binary): try adding it below.
  }
  try {
    env.exec(
      "claude",
      ["mcp", "add", "--scope", "user", "--transport", "http", "agent-monitor", `http://127.0.0.1:${PORT}/mcp`],
      { stdio: "inherit" }
    );
    step("Registered agent-monitor MCP server (user scope)");
  } catch (e) {
    console.warn("Could not register MCP automatically:", String(e));
    console.warn(`Run: claude mcp add --scope user --transport http agent-monitor http://127.0.0.1:${PORT}/mcp`);
  }
}

// --- Codex (§4.6) -----------------------------------------------------

function mergeCodexHooksFile(env: SetupEnv) {
  const { codexHooksPath } = pathsFor(env.home);
  const settings = tryReadJsonFile(codexHooksPath);
  if (settings === null) return;
  if (existsSync(codexHooksPath)) {
    copyFileSync(codexHooksPath, codexHooksPath + ".am-backup");
    step(`Backed up Codex hooks to ${codexHooksPath}.am-backup`);
  }
  const merged = mergeCodexHooks(settings, hookPath);
  writeFileSync(codexHooksPath, JSON.stringify(merged, null, 2) + "\n");
  step("Merged agent-monitor hooks into ~/.codex/hooks.json");
}

function checkCodexConfigToml(env: SetupEnv) {
  const { codexConfigTomlPath } = pathsFor(env.home);
  const text = existsSync(codexConfigTomlPath) ? readFileSync(codexConfigTomlPath, "utf8") : "";
  if (configTomlHasHooksEnabled(text)) {
    step("Codex hooks already enabled (~/.codex/config.toml)");
    return;
  }
  console.warn("\n  Codex hooks are not enabled yet. Add this to ~/.codex/config.toml:\n");
  console.warn("    [features]");
  console.warn("    hooks = true\n");
}

function printCodexHookTrustGuidance() {
  console.warn(
    "  Codex requires hook trust: the next INTERACTIVE `codex` run will ask to trust the new hooks.\n" +
      "  `codex exec` only runs hooks that have already been trusted (or pass --dangerously-bypass-hook-trust)."
  );
}

function registerCodexMcp(env: SetupEnv) {
  try {
    env.exec("codex", ["--version"], { stdio: "ignore" });
  } catch {
    console.warn("  Codex CLI not found on PATH - to register the MCP server manually, run:");
    console.warn(`    codex mcp add agent-monitor --url http://127.0.0.1:${PORT}/mcp`);
    return;
  }
  try {
    env.exec("codex", ["mcp", "add", "agent-monitor", "--url", `http://127.0.0.1:${PORT}/mcp`], {
      stdio: "inherit",
    });
    step("Registered agent-monitor MCP server for Codex");
  } catch (e) {
    console.warn("Could not register the Codex MCP server automatically:", String(e));
    console.warn(`  Run: codex mcp add agent-monitor --url http://127.0.0.1:${PORT}/mcp`);
  }
}

export function setupCodex(env: SetupEnv) {
  const { codexHome } = pathsFor(env.home);
  if (!existsSync(codexHome)) return;
  console.log("\nCodex CLI detected (~/.codex exists):");
  mergeCodexHooksFile(env);
  checkCodexConfigToml(env);
  printCodexHookTrustGuidance();
  registerCodexMcp(env);
}

// --- Cursor (§4.6) ------------------------------------------------------
// No hooks file is written for Cursor: `cursor-agent` already parses
// `~/.claude/settings.json`/`.claude/settings.local.json` through its own
// Claude-compat layer and runs those SAME `am-hook.sh` commands, so writing
// native `.cursor/hooks.json` entries too would double-deliver every event.

function mergeCursorMcpFile(env: SetupEnv) {
  const { cursorHome, cursorMcpPath } = pathsFor(env.home);
  const existing = tryReadJsonFile(cursorMcpPath);
  if (existing === null) return;
  if (existsSync(cursorMcpPath)) {
    copyFileSync(cursorMcpPath, cursorMcpPath + ".am-backup");
    step(`Backed up Cursor MCP config to ${cursorMcpPath}.am-backup`);
  } else {
    mkdirSync(cursorHome, { recursive: true });
  }
  const merged = mergeCursorMcp(existing, PORT);
  writeFileSync(cursorMcpPath, JSON.stringify(merged, null, 2) + "\n");
  step("Merged agent-monitor MCP server into ~/.cursor/mcp.json");
}

export function setupCursor(env: SetupEnv) {
  const { cursorHome } = pathsFor(env.home);
  if (!existsSync(cursorHome)) return;
  console.log("\nCursor CLI detected (~/.cursor exists):");
  mergeCursorMcpFile(env);
  step("No ~/.cursor/hooks.json written - Cursor already delivers events via its Claude-compat hook layer.");
  installAmCursorShim(env);
}

/** Marks a file at ~/.local/bin/am-cursor as ours, so a re-run may replace it
 *  and a same-named file from anything else is never touched. */
const SHIM_MARKER = "# agent-monitor am-cursor shim";

/** Cursor writes no token usage anywhere; `am-cursor` (src/cli/am-cursor.ts)
 *  wraps headless cursor-agent runs to capture it. */
function installAmCursorShim(env: SetupEnv) {
  const binDir = join(env.home, ".local", "bin");
  const shimPath = join(binDir, "am-cursor");
  if (existsSync(shimPath) && !readFileSync(shimPath, "utf8").includes(SHIM_MARKER)) {
    console.warn(`  ${shimPath} exists and is not ours - left untouched.`);
    return;
  }
  mkdirSync(binDir, { recursive: true });
  const script = join(projectRoot, "src", "cli", "am-cursor.ts");
  writeFileSync(shimPath, `#!/bin/sh\n${SHIM_MARKER}\nexec "${bunPath}" run "${script}" "$@"\n`);
  chmodSync(shimPath, 0o755);
  step(`Installed ${shimPath}`);
  console.log("  Cursor records no token usage locally. Run headless sessions as `am-cursor -p ...`");
  console.log("  instead of `cursor-agent -p ...` to capture their tokens (interactive runs pass straight through).");
}

/** One-time migration: supersede a pre-rename work-monitor install. Stale
 *  hook entries are pruned automatically by mergeHooks; here we drop the old
 *  systemd unit + MCP registration so a single `bun run setup` fully cleans up.
 *  All best-effort - fresh installs have nothing to remove. */
export function cleanupLegacy(env: SetupEnv) {
  try {
    env.exec("systemctl", ["--user", "disable", "--now", "wm-server.service"], { stdio: "ignore" });
  } catch {}
  const oldUnit = join(pathsFor(env.home).unitDir, "wm-server.service");
  if (existsSync(oldUnit)) {
    try {
      rmSync(oldUnit);
      step("Removed legacy wm-server.service");
    } catch {}
  }
  try {
    env.exec("claude", ["mcp", "remove", "work-monitor", "--scope", "user"], { stdio: "ignore" });
    step("Removed legacy work-monitor MCP registration");
  } catch {}
}

function main() {
  const env = defaultSetupEnv();
  console.log("Setting up agent-monitor...\n");
  cleanupLegacy(env);
  installService(env);
  mergeSettings(env);
  registerMcp(env);
  setupCodex(env);
  setupCursor(env);
  console.log(`\n\x1b[32m✓ Done.\x1b[0m Open http://127.0.0.1:${PORT} and pin the tab.`);
  console.log("New Claude Code sessions will report automatically. Restart any open sessions to load the hooks + MCP.");
  console.log("Codex/Cursor sessions report automatically too, once their own hooks/trust prompts (above) are in place.");
}

// Guarded so importing this module (e.g. from tests, to exercise setupCodex/
// setupCursor/mergeSettings against an injected temp home) never runs the
// real installer as a side effect of the import itself.
if (import.meta.main) main();
