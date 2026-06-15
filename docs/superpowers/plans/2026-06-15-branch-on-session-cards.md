# Branch on session cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface each session's git branch on its card so two worktrees of the same repo are distinguishable.

**Architecture:** Extend the server's cwd→repo resolver to also return the branch (one git call, 60s-TTL cache), add a `branch` column threaded through `Session`/`store`/`http`, and render a `⎇ {branch}` chip on `SessionCard`. Server and web have separate `Session` types so the change splits cleanly; `reduceEvent` stays pure (resolution happens in the HTTP layer).

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `node:child_process` (git), React + Vite + Tailwind, Bun test (server) + Vitest (web).

**Spec:** `docs/superpowers/specs/2026-06-15-branch-on-session-cards-design.md`

---

## Task 1: Resolver returns repo **and** branch

**Files:**
- Modify: `src/server/resolve-project.ts`, `tests/resolve-project.test.ts`, `src/server/http.ts`

- [ ] **Step 1: Rewrite the test to drive `resolveRepoInfo`**

Replace the whole `tests/resolve-project.test.ts` with:
```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/resolve-project.test.ts`
Expected: FAIL — `resolveRepoInfo` is not exported from `resolve-project.ts`.

- [ ] **Step 3: Rewrite `resolve-project.ts` to export `resolveRepoInfo`**

Replace the whole `src/server/resolve-project.ts` with:
```ts
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
```
(`resolveProjectName` is removed — its only caller, `http.ts`, is updated in Step 5.)

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/resolve-project.test.ts`
Expected: PASS (8 tests). The worktree test confirms `branch: "feature/my-branch"`.

- [ ] **Step 5: Point `http.ts` at `resolveRepoInfo`**

In `src/server/http.ts`, change the import:
```ts
import { resolveProjectName } from "./resolve-project.ts";
```
to:
```ts
import { resolveRepoInfo } from "./resolve-project.ts";
```
and change the override in the `/events` handler:
```ts
        // Refine the project name from git so a worktree reports its repo, not the
        // branch directory the cwd basename gives (reduceEvent stays pure).
        if (event.cwd) patch.project = await resolveProjectName(event.cwd);
```
to:
```ts
        // Refine the project name from git so a worktree reports its repo, not the
        // branch directory the cwd basename gives (reduceEvent stays pure).
        if (event.cwd) patch.project = (await resolveRepoInfo(event.cwd)).project;
```

- [ ] **Step 6: Run the full server suite + typecheck**

Run: `bun run test` — Expected: all pass (the existing `http.test.ts` session_start still resolves `project: "browns"` via the fallback).
Run: `bun run typecheck` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/server/resolve-project.ts tests/resolve-project.test.ts src/server/http.ts
git commit -m "feat(server): resolveRepoInfo returns repo + branch (one git call, TTL cache)"
```

---

## Task 2: `branch` data model + wiring

**Files:**
- Modify: `src/server/types.ts`, `src/server/db.ts`, `src/server/store.ts`, `src/server/http.ts`, `tests/store.test.ts`, `tests/http.test.ts`

- [ ] **Step 1: Add `branch` to the failing tests**

(a) In `tests/store.test.ts`, change the import line `import { openDb } from "../src/server/db.ts";` to:
```ts
import { Database } from "bun:sqlite";
import { openDb, migrate } from "../src/server/db.ts";
```
and add these two tests inside the `describe("Store sessions", ...)` block:
```ts
  it("stores and updates the session branch", () => {
    store.applyEvent("s1", { project: "p", cwd: "/x", status: "working", last_activity_at: 1000 }, 1000);
    expect(store.getSession("s1")!.branch).toBeNull();
    store.applyEvent("s1", { branch: "feat/x", last_activity_at: 2000 }, 2000);
    expect(store.getSession("s1")!.branch).toBe("feat/x");
  });

  it("idempotently adds the sessions.branch column to a pre-existing table", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const has = () => (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).filter((c) => c.name === "branch").length;
    expect(has()).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(has()).toBe(1);
  });
```

(b) In `tests/http.test.ts`, in the "ingests a session_start and surfaces it in /api/state" test, add a branch assertion after the status assertion:
```ts
    expect(state.sessions[0].status).toBe("working");
    expect(state.sessions[0].branch).toBeNull();
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/store.test.ts tests/http.test.ts`
Expected: FAIL — `branch` is not a column / not on the type yet.

- [ ] **Step 3: Add `branch` to the types**

In `src/server/types.ts`, in the `Session` interface add `branch` after `attention_reason`:
```ts
  attention_reason: string | null;
  branch: string | null;
```
and in the `SessionPatch` interface add it after `attention_reason`:
```ts
  attention_reason?: string | null;
  branch?: string | null;
```

- [ ] **Step 4: Add the `branch` column + migration in `db.ts`**

In `src/server/db.ts`, inside the `CREATE TABLE IF NOT EXISTS sessions (...)` block, add `branch TEXT,` after the `attention_reason TEXT,` line:
```sql
      attention_reason TEXT,
      branch TEXT,
```
and, after the closing `` ); `` of the `db.exec(\`...\`)` template (i.e. right before the existing `// Idempotent: remap legacy hand-off statuses...` line), add:
```ts
  // Idempotent: add the sessions.branch column to pre-existing DBs.
  const sessionCols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === "branch")) {
    db.exec("ALTER TABLE sessions ADD COLUMN branch TEXT;");
  }
```

- [ ] **Step 5: Thread `branch` through `store.ts`**

In `src/server/store.ts`:
(a) Add `branch` to `SESSION_COLS` (after `attention_reason`):
```ts
const SESSION_COLS =
  "id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, branch, started_at, last_activity_at, ended_at";
```
(b) In `applyEvent`'s INSERT, add the column, the value placeholder, and the param. Replace:
```ts
        .query(
          `INSERT INTO sessions (id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, started_at, last_activity_at, ended_at)
           VALUES ($id, $project, $cwd, $transcript_path, $status, $current_task, $current_intent, $attention_reason, $started_at, $last_activity_at, $ended_at)`
        )
        .run({
          $id: sessionId,
          $project: patch.project ?? "unknown",
          $cwd: patch.cwd ?? "",
          $transcript_path: patch.transcript_path ?? null,
          $status: patch.status ?? "working",
          $current_task: patch.current_task ?? null,
          $current_intent: patch.current_intent ?? null,
          $attention_reason: patch.attention_reason ?? null,
          $started_at: now,
          $last_activity_at: patch.last_activity_at ?? now,
          $ended_at: patch.ended_at ?? null,
        });
```
with:
```ts
        .query(
          `INSERT INTO sessions (id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, branch, started_at, last_activity_at, ended_at)
           VALUES ($id, $project, $cwd, $transcript_path, $status, $current_task, $current_intent, $attention_reason, $branch, $started_at, $last_activity_at, $ended_at)`
        )
        .run({
          $id: sessionId,
          $project: patch.project ?? "unknown",
          $cwd: patch.cwd ?? "",
          $transcript_path: patch.transcript_path ?? null,
          $status: patch.status ?? "working",
          $current_task: patch.current_task ?? null,
          $current_intent: patch.current_intent ?? null,
          $attention_reason: patch.attention_reason ?? null,
          $branch: patch.branch ?? null,
          $started_at: now,
          $last_activity_at: patch.last_activity_at ?? now,
          $ended_at: patch.ended_at ?? null,
        });
```
(c) In the UPDATE-path key list, add `"branch"` after `"attention_reason"`:
```ts
      "current_intent",
      "attention_reason",
      "branch",
      "last_activity_at",
```

- [ ] **Step 6: Set `patch.branch` in `http.ts`**

In `src/server/http.ts`, replace the override block:
```ts
        // Refine the project name from git so a worktree reports its repo, not the
        // branch directory the cwd basename gives (reduceEvent stays pure).
        if (event.cwd) patch.project = (await resolveRepoInfo(event.cwd)).project;
```
with:
```ts
        // Refine project + branch from git so a worktree reports its repo (not the
        // branch directory the cwd basename gives) and its checked-out branch.
        if (event.cwd) {
          const info = await resolveRepoInfo(event.cwd);
          patch.project = info.project;
          patch.branch = info.branch;
        }
```

- [ ] **Step 7: Run the full server suite + typecheck**

Run: `bun run test` — Expected: all pass (the new branch round-trip + migration tests, the http branch assertion).
Run: `bun run typecheck` — Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/server tests/store.test.ts tests/http.test.ts
git commit -m "feat(server): persist + expose session branch (column, migration, store, http)"
```

---

## Task 3: Show the branch on `SessionCard`

**Files:**
- Modify: `src/web/types.ts`, `src/web/components/SessionCard.tsx`, `web-tests/Board.test.tsx`, `web-tests/AppBar.test.tsx`
- Create: `web-tests/SessionCard.test.tsx`

- [ ] **Step 1: Write the failing SessionCard test**

Create `web-tests/SessionCard.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import type { Session } from "../src/web/types.ts";

const base: Session = {
  id: "s1", project: "myrepo", status: "working", current_task: null,
  current_intent: null, attention_reason: null, branch: null,
  started_at: 0, last_activity_at: Date.now(),
};

describe("SessionCard", () => {
  it("shows the branch when present", () => {
    render(<SessionCard s={{ ...base, branch: "feat/x" }} />);
    expect(screen.getByText("⎇ feat/x")).toBeDefined();
  });
  it("omits the branch when null", () => {
    render(<SessionCard s={base} />);
    expect(screen.queryByText(/⎇/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run web-tests/SessionCard.test.tsx`
Expected: FAIL — `Session` has no `branch` (type) and/or `⎇ feat/x` is not rendered.

- [ ] **Step 3: Add `branch` to the web `Session` type**

In `src/web/types.ts`, add `branch` to `Session` after `attention_reason`:
```ts
  attention_reason: string | null;
  branch: string | null;
```

- [ ] **Step 4: Render the branch chip in `SessionCard.tsx`**

In `src/web/components/SessionCard.tsx`, add a branch line immediately **before** the timestamp `<div>`. Replace:
```tsx
      <div className="mt-2 text-2xs text-muted-foreground/70">{ago(s.last_activity_at)}</div>
```
with:
```tsx
      {s.branch && <div className="mt-2 text-2xs text-muted-foreground/70">⎇ {s.branch}</div>}
      <div className="mt-2 text-2xs text-muted-foreground/70">{ago(s.last_activity_at)}</div>
```

- [ ] **Step 5: Run the SessionCard test to verify it passes**

Run: `bunx vitest run web-tests/SessionCard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Add `branch: null` to the other session fixtures**

The web `Session` type now requires `branch`, so update the fixtures that construct sessions:

In `web-tests/Board.test.tsx`, add `branch: null,` to each of the two session objects in the `sessions` array (the `"browns"` and `"love-island"` sessions).

In `web-tests/AppBar.test.tsx`, add `branch: null,` to each of the two session objects in the `sessions` array (the `"a"` and `"b"` sessions).

- [ ] **Step 7: Run the full web suite + typecheck + build**

Run: `bun run web:test` — Expected: all pass (SessionCard, Board, AppBar, the rest).
Run: `bun run typecheck` — Expected: clean.
Run: `bun run web:build` — Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/web web-tests
git commit -m "feat(web): show the git branch on session cards"
```

---

## Task 4: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `bun run test` → all server tests pass.
Run: `bun run web:test` → all web tests pass.
Run: `bun run typecheck` → clean (both tsconfigs).
Run: `bun run web:build` → build succeeds.

- [ ] **Step 2: Real-path sanity check**

Run:
```bash
bun -e 'import { resolveRepoInfo } from "./src/server/resolve-project.ts";
console.log(await resolveRepoInfo("/home/lunatic/projects/work/browns/oxygenrx-frontend/feat/scheduled-prescription-events"));'
```
Expected: `{ project: "oxygenrx-frontend", branch: "feat/scheduled-prescription-events" }` (if that worktree path still exists; otherwise `{ project: "scheduled-prescription-events", branch: null }` from the fallback — fine, the path is just gone).

- [ ] **Step 3: Note for the user (no code)**

The change needs a **server restart** (`systemctl --user restart wm-server.service`) to load the new derivation + run the `branch` column migration. Existing session rows gain a branch on their next event.

---

## Self-Review Notes (already applied)

- **Spec coverage:** derivation `resolveRepoInfo` + TTL cache + detached-HEAD short SHA (Task 1); `branch` type/column/migration/store/http wiring (Task 2); web type + `SessionCard` chip + fixtures (Task 3); tests for each (resolveRepoInfo, branch round-trip + idempotent migration, http branch, SessionCard show/omit); verification (Task 4). Non-goals respected: todos/MCP/hooks untouched, no new deps.
- **Type consistency:** `RepoInfo { project: string; branch: string | null }` returned by `resolveRepoInfo` and consumed in `http.ts`; `Session.branch` / `SessionPatch.branch` are `string | null` on both server and web; `SESSION_COLS`, the INSERT columns, and the UPDATE key list all include `branch`.
- **No broken intermediate:** Task 1 removes `resolveProjectName` and updates its only caller (`http.ts`) in the same task. Task 2 adds `branch` across server only (web has its own `Session`, untouched until Task 3). Task 3's required-field addition is paired with the fixture updates in the same task.
- **Placeholder scan:** every step has complete code/commands; the one conditional in Task 4 Step 2 (path may be gone) states both expected outcomes explicitly.
