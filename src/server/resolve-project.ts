import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname } from "node:path";
import { projectFromCwd } from "./derive.ts";

const execFileP = promisify(execFile);

// cwd → resolved project name. A given path's repo never changes, so memoize
// permanently — this keeps git off the hot path (one resolution per session cwd,
// even though the activity heartbeat fires an event on every tool use).
const cache = new Map<string, string>();

/** Derive the repo name from git's common dir, handling worktrees / bare layouts. */
export function repoNameFromGitDir(commonDir: string): string {
  const trimmed = (commonDir ?? "").replace(/\/+$/, "");
  if (!trimmed) return "";
  let name = basename(trimmed);
  // Normal repo: `<repo>/.git`; .bare worktree host: `<repo>/.bare` → use the parent.
  if (name === ".git" || name === ".bare") name = basename(dirname(trimmed));
  // Classic bare repo: `<repo>.git` → strip the suffix.
  return name.replace(/\.git$/, "");
}

/**
 * Resolve the project name for a working directory. Uses `git --git-common-dir`
 * so a git **worktree** reports its repo (e.g. `oxygenrx-frontend`) rather than the
 * branch directory the cwd basename would give. Falls back to the path basename
 * when the path isn't a git repo (or git is unavailable / the path is gone).
 */
export async function resolveProjectName(cwd: string): Promise<string> {
  if (!cwd) return "unknown";
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;

  let name = projectFromCwd(cwd);
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeout: 1000 }
    );
    const repo = repoNameFromGitDir(stdout.trim());
    if (repo) name = repo;
  } catch {
    // not a git repo, git missing, or the path is gone — keep the basename fallback
  }

  cache.set(cwd, name);
  return name;
}
