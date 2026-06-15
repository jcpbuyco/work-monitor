import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoNameFromGitDir, resolveRepoInfo } from "../src/server/resolve-project.ts";

describe("repoNameFromGitDir", () => {
  it("returns the repo dir name when the common dir IS the repo (bare-style worktree host)", () => {
    expect(repoNameFromGitDir("/home/x/projects/oxygenrx-frontend")).toBe("oxygenrx-frontend");
  });
  it("uses the parent when the common dir is a .git subdir (normal repo)", () => {
    expect(repoNameFromGitDir("/home/x/projects/work-monitor/.git")).toBe("work-monitor");
  });
  it("uses the parent when the common dir is a .bare subdir", () => {
    expect(repoNameFromGitDir("/home/x/projects/myrepo/.bare")).toBe("myrepo");
  });
  it("strips a trailing .git from a classic bare repo dir", () => {
    expect(repoNameFromGitDir("/home/x/projects/repo.git")).toBe("repo");
  });
  it("returns empty for an empty input", () => {
    expect(repoNameFromGitDir("")).toBe("");
  });
});

describe("resolveRepoInfo", () => {
  let dir: string;
  let repo: string;
  let worktree: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wm-wt-"));
    repo = join(dir, "myproj");
    const G = (...args: string[]) =>
      execFileSync("git", args, { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    G("init", "-q", repo);
    G("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
    worktree = join(repo, "feature", "my-branch");
    G("-C", repo, "worktree", "add", "-q", "-b", "feature/my-branch", worktree);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves a worktree's cwd to the repo name and its branch", async () => {
    expect(await resolveRepoInfo(worktree)).toEqual({ project: "myproj", branch: "feature/my-branch" });
  });
  it("resolves a normal repo cwd to the repo name with a non-empty branch", async () => {
    const info = await resolveRepoInfo(repo);
    expect(info.project).toBe("myproj");
    expect(typeof info.branch).toBe("string");
    expect((info.branch ?? "").length).toBeGreaterThan(0);
  });
  it("falls back to { basename, null } for a non-git path", async () => {
    expect(await resolveRepoInfo("/no/such/dir/foobar")).toEqual({ project: "foobar", branch: null });
  });
});
