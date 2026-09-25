#!/usr/bin/env sh
# Forward a hook event to am-server. Arg $1 = event type, arg $2 (optional) =
# harness ("codex" - Claude and Cursor never pass this; §4.2). Reads the hook
# JSON from stdin, POSTs it, and detaches so it never blocks the calling CLI.
# Stays POSIX sh (no bashisms) and prints NOTHING on stdout: Cursor's hook
# executor treats empty stdout as "continue", so this script doubles as a
# harmless no-op observer hook for Cursor's own Claude-compat layer too.
type="$1"
harness="$2"
payload=$(cat)
port="${AM_PORT:-4317}"
# §4.2: each query param goes through curl's own `--url-query` (real
# percent-encoding, not string concatenation) rather than hand-built `qs=...`
# interpolation - `set --` (POSIX, no arrays needed) builds up curl's
# argument list a piece at a time so an optional param is simply omitted
# rather than conditionally spliced into a query string. `pcc`/`pcx` stamp
# the calling session's own id (Claude Code / Codex) so a child harness
# process (a Bash `codex exec`/`cursor-agent` call, or a nested `claude`
# session) can be linked back to its parent without a cwd/timing heuristic.
set -- -s -m 1 -X POST "http://127.0.0.1:${port}/events" \
  --url-query "type=${type}" \
  -H 'content-type: application/json' \
  -d "$payload"
if [ -n "$harness" ]; then
  set -- "$@" --url-query "harness=${harness}"
fi
if [ -n "$CLAUDE_CODE_SESSION_ID" ]; then
  set -- "$@" --url-query "pcc=${CLAUDE_CODE_SESSION_ID}"
fi
if [ -n "$CODEX_THREAD_ID" ]; then
  set -- "$@" --url-query "pcx=${CODEX_THREAD_ID}"
fi
( curl "$@" >/dev/null 2>&1 & ) >/dev/null 2>&1
exit 0
