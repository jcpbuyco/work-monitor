# Branch on session cards

**Date:** 2026-06-15
**Status:** Approved design — ready for implementation plan
**Scope:** Server session derivation + data model + the `SessionCard`. No change to todos, hooks, or the MCP surface.

## Motivation

After the worktree project-name fix (`dc65003`), a session reports its **repo** (e.g. `oxygenrx-frontend`) rather than the branch directory. The downside: two sessions in two worktrees of the same repo now show the same project name and are indistinguishable on the board. Surfacing the **git branch** on each session card disambiguates them (and is useful context generally).

## Decisions (settled during brainstorming)

- **Always show** the branch when known, as a `⎇ {branch}` chip matching the todo cards.
- **Detached HEAD** → show the short SHA.
- Branch is derived server-side from the session's cwd via git, **cached per cwd with a 60s TTL** (the repo is immutable per path, but the branch can change via `git checkout`, so a short TTL keeps it fresh without putting git on the per-event hot path).

## 1. Derivation (`src/server/resolve-project.ts`)

Replace the project-only resolution with a combined one:

```ts
export async function resolveRepoInfo(cwd: string): Promise<{ project: string; branch: string | null }>
```

- One `git` call returns the common-dir + branch + short SHA, e.g.
  `git -C <cwd> rev-parse --path-format=absolute --git-common-dir --abbrev-ref HEAD --short HEAD`
  → three output lines: `<commonDir>`, `<abbrevRef>`, `<shortSha>`. (If that combined invocation is unreliable on the target git version, fall back to two `rev-parse` calls — the implementer verifies the exact form.)
- `project = repoNameFromGitDir(commonDir)` (existing helper) — falls back to `projectFromCwd(cwd)` if empty.
- `branch = abbrevRef !== "HEAD" ? abbrevRef : shortSha` (i.e. the named branch, or the short SHA when detached).
- On any git failure / non-git path → `{ project: projectFromCwd(cwd), branch: null }`.
- **Cache:** `Map<cwd, { project: string; branch: string | null; at: number }>` with a 60s TTL — return the cached entry when `Date.now() - at < 60_000`, otherwise re-derive and refresh. (Project re-derives to the same value; branch refreshes.)
- Keep `resolveProjectName(cwd)` as a thin wrapper: `(await resolveRepoInfo(cwd)).project`. `repoNameFromGitDir` is unchanged.

## 2. Data model (server)

- **`src/server/types.ts`:** add `branch: string | null` to `Session`; add `branch?: string | null` to `SessionPatch`.
- **`src/server/db.ts`:** add `branch TEXT` to the `CREATE TABLE sessions` block (fresh DBs), and an **idempotent migration** for existing DBs (in `migrate()`, after the `CREATE TABLE` block):
  ```ts
  const sessionCols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === "branch")) {
    db.exec("ALTER TABLE sessions ADD COLUMN branch TEXT;");
  }
  ```
- **`src/server/store.ts`:** add `branch` to `SESSION_COLS`; include `$branch` (default `null`) in the `applyEvent` INSERT; add `"branch"` to the `applyEvent` UPDATE field-key list.
- **`src/server/http.ts`:** in the `/events` handler, replace the single project override with both fields:
  ```ts
  if (event.cwd) {
    const info = await resolveRepoInfo(event.cwd);
    patch.project = info.project;
    patch.branch = info.branch;
  }
  ```

## 3. Web

- **`src/web/types.ts`:** add `branch: string | null` to `Session`.
- **`src/web/components/SessionCard.tsx`:** when `s.branch` is set, render `⎇ {s.branch}` as a `text-2xs text-muted-foreground/70` line just above the `ago` timestamp (reusing the todo cards' `⎇` glyph for consistency). Omit when null.

## 4. Testing

- **`tests/resolve-project.test.ts`:** keep the `repoNameFromGitDir` unit tests. Update the integration tests to `resolveRepoInfo`:
  - worktree cwd → `{ project: "myproj", branch: "feature/my-branch" }` (the worktree is created with `-b feature/my-branch`, so assert that exact branch).
  - normal repo cwd → `project: "myproj"` and `branch` a non-empty string (don't hardcode `main`/`master` — the default branch is git-config-dependent).
  - non-git path → `{ project: "foobar", branch: null }`.
- **`tests/store.test.ts`:** a session round-trips `branch` (apply an event patch with `branch`, assert `getSession().branch`); a migration test — create a `sessions` table **without** the `branch` column (old schema) in a fresh in-memory db, run `migrate`, assert the column now exists (`PRAGMA table_info`) and a second `migrate` is a no-op.
- **`tests/http.test.ts`:** the existing `session_start` test (cwd `/x/browns`, not a git repo) now also yields `branch: null`; assert `project` unchanged (`browns`) and `branch` null.
- **Web:** add `branch: null` to the session fixtures in `web-tests/Board.test.tsx` and `web-tests/AppBar.test.tsx` (the field is now required on the `Session` type). Add a `SessionCard` test (`web-tests/SessionCard.test.tsx`): a session with `branch: "feat/x"` renders `⎇ feat/x`; a session with `branch: null` renders no `⎇`.

## 5. Non-goals / edges

- Detached HEAD shows the short SHA (not a named branch). Branch freshness is bounded by the 60s TTL (acceptable for worktrees, where the branch is stable per cwd). No extra git on the event hot path beyond the TTL refresh. No todo/MCP/hook changes, no new dependencies. **Picking this up needs a server restart** (new derivation + the `branch` column migration); existing session rows gain a branch on their next event.

## Files touched

- Server: `src/server/{resolve-project,types,db,store,http}.ts`
- Web: `src/web/types.ts`, `src/web/components/SessionCard.tsx`
- Tests: `tests/{resolve-project,store,http}.test.ts`, `web-tests/{Board,AppBar,SessionCard}.test.tsx`
