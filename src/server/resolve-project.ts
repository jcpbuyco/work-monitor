import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname } from "node:path";
import { projectFromCwd } from "./derive.ts";

const execFileP = promisify(execFile);

export interface RepoInfo {
  project: string;
  branch: string | null;
}

const TTL_MS = 60_000;
// cwd → resolved info. The repo is immutable per path but the branch can change via
// `git checkout`, so entries expire after the TTL — keeping git off the per-event hot
// path (the activity heartbeat hits the cache) while staying reasonably fresh.
const cache = new Map<string, { info: RepoInfo; at: number }>();

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
 * Resolve a working directory to its repo name and current branch via git, so a git
 * worktree reports its repo (e.g. `oxygenrx-frontend`) rather than the branch directory
 * the cwd basename gives, plus the checked-out branch. Falls back to `{ basename, null }`
 * for non-git paths (or when git is unavailable / the path is gone).
 */
export async function resolveRepoInfo(cwd: string): Promise<RepoInfo> {
  if (!cwd) return { project: "unknown", branch: null };
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

  let info: RepoInfo = { project: projectFromCwd(cwd), branch: null };
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"],
      { timeout: 1000 }
    );
    const [commonDir = "", abbrevRef = ""] = stdout.split("\n").map((l) => l.trim());
    const project = repoNameFromGitDir(commonDir) || info.project;
    let branch: string | null = null;
    if (abbrevRef && abbrevRef !== "HEAD") {
      branch = abbrevRef;
    } else if (abbrevRef === "HEAD") {
      // detached HEAD — fall back to the short SHA
      try {
        const { stdout: sha } = await execFileP("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], { timeout: 1000 });
        branch = sha.trim() || null;
      } catch {
        branch = null;
      }
    }
    info = { project, branch };
  } catch {
    // not a git repo, git missing, or the path is gone — keep the basename fallback
  }

  cache.set(cwd, { info, at: Date.now() });
  return info;
}
