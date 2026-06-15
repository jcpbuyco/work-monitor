#!/usr/bin/env sh
# Forward a Claude Code hook event to am-server. Arg $1 = event type.
# Reads the hook JSON from stdin, POSTs it, and detaches so it never blocks Claude.
type="$1"
payload=$(cat)
port="${AM_PORT:-4317}"
( curl -s -m 1 -X POST "http://127.0.0.1:${port}/events?type=${type}" \
    -H 'content-type: application/json' \
    -d "$payload" >/dev/null 2>&1 & ) >/dev/null 2>&1
exit 0
