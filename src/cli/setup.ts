import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mergeHooks } from "./settings-merge.ts";
import { PORT } from "../server/config.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bunPath = process.execPath; // path to bun
const settingsPath = join(homedir(), ".claude", "settings.json");
const hookPath = join(projectRoot, "src", "hooks", "wm-hook.sh");

function step(msg: string) {
  console.log(`\x1b[36m▸\x1b[0m ${msg}`);
}

function installService() {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const tmpl = readFileSync(join(projectRoot, "src", "cli", "wm-server.service.tmpl"), "utf8");
  const unit = tmpl
    .replaceAll("__BUN__", bunPath)
    .replaceAll("__PROJECT__", projectRoot)
    .replaceAll("__PORT__", String(PORT));
  writeFileSync(join(unitDir, "wm-server.service"), unit);
  step(`Wrote systemd unit to ${join(unitDir, "wm-server.service")}`);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", "wm-server.service"]);
    step("Enabled + started wm-server.service");
  } catch (e) {
    console.warn("Could not enable service automatically:", String(e));
    console.warn("Run: systemctl --user enable --now wm-server.service");
  }
}

function mergeSettings() {
  let settings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    settings = raw.trim() ? JSON.parse(raw) : {};
    copyFileSync(settingsPath, settingsPath + ".wm-backup");
    step(`Backed up settings to ${settingsPath}.wm-backup`);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }
  const merged = mergeHooks(settings, hookPath);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  step("Merged work-monitor hooks into ~/.claude/settings.json");
}

function registerMcp() {
  try {
    execFileSync("claude", [
      "mcp", "add", "--scope", "user", "--transport", "http",
      "work-monitor", `http://127.0.0.1:${PORT}/mcp`,
    ], { stdio: "inherit" });
    step("Registered work-monitor MCP server (user scope)");
  } catch (e) {
    console.warn("Could not register MCP automatically:", String(e));
    console.warn(`Run: claude mcp add --scope user --transport http work-monitor http://127.0.0.1:${PORT}/mcp`);
  }
}

function main() {
  console.log("Setting up work-monitor...\n");
  installService();
  mergeSettings();
  registerMcp();
  console.log(`\n\x1b[32m✓ Done.\x1b[0m Open http://127.0.0.1:${PORT} and pin the tab.`);
  console.log("New Claude Code sessions will report automatically. Restart any open sessions to load the hooks + MCP.");
}

main();
